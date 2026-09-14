import type { autoUpdater } from 'electron-updater';

type Driver = Pick<typeof autoUpdater, 'on' | 'autoDownload' | 'autoInstallOnAppQuit' | 'allowDowngrade' | 'checkForUpdates' | 'quitAndInstall'>;
export type LauncherUpdateState = {
  phase: 'checking' | 'downloading' | 'ready' | 'deferred' | 'installing' | 'current' | 'error' | 'unavailable';
  blocking: boolean;
  message: string;
  percent?: number;
  version?: string;
  retryable?: boolean;
};
type Options = {
  driver: Driver;
  supported: boolean;
  busy: () => boolean;
  gameRunning: () => Promise<boolean>;
  changed: (state: LauncherUpdateState) => void;
  log: (message: string) => void;
  checkTimeoutMs?: number;
  downloadTimeoutMs?: number;
  retryIntervalMs?: number;
};

/** Owns startup updates independently of the renderer and player operations. */
export class LauncherUpdates {
  private value: LauncherUpdateState;
  private ready = false;
  private inFlight = false;
  private installingCheck = false;
  private started = false;
  private disposed = false;
  private watchdog?: NodeJS.Timeout;
  private retryTimer?: NodeJS.Timeout;

  constructor(private options: Options) {
    this.value = options.supported
      ? {phase:'checking', blocking:true, message:'Recherche d’une mise à jour du launcher…'}
      : {phase:'unavailable', blocking:false, message:''};
    if (!options.supported) return;
    const driver = options.driver;
    driver.autoDownload = true;
    // Installation is controlled here so quitting never interrupts a running game.
    driver.autoInstallOnAppQuit = false;
    driver.allowDowngrade = false;
    driver.on('update-available', info => {
      if (this.disposed || this.ready) return;
      this.set({phase:'downloading', blocking:true, version:info.version, percent:0,
        message:`Téléchargement de Licaris ${info.version}… Installation automatique à suivre.`});
      this.watch(this.options.downloadTimeoutMs ?? 120000);
    });
    driver.on('download-progress', progress => {
      if (this.disposed || this.ready) return;
      this.set({...this.value, phase:'downloading', blocking:true, retryable:false,
        percent:Math.max(0, Math.min(100, progress.percent)), message:'Téléchargement de la mise à jour… Installation automatique à suivre.'});
      this.watch(this.options.downloadTimeoutMs ?? 120000);
    });
    driver.on('update-not-available', () => {
      if (this.disposed || this.ready) return;
      this.clearWatch();
      this.set({phase:'current', blocking:false, message:'Votre launcher est à jour.'});
    });
    driver.on('update-downloaded', info => {
      if (this.disposed || this.value.phase === 'installing') return;
      this.clearWatch();
      this.ready = true;
      this.set({phase:'ready', blocking:true, version:info.version, percent:100, message:'Mise à jour prête. Préparation du redémarrage…'});
      void this.resume();
    });
    driver.on('error', error => this.fail(error));
  }

  snapshot(): LauncherUpdateState { return {...this.value}; }
  get blocking() { return this.value.blocking; }

  async start() {
    if (!this.options.supported || this.disposed || this.started) return;
    this.started = true;
    await this.check();
  }

  async retry() {
    if (!this.options.supported || this.disposed || this.inFlight || this.value.phase !== 'error') return;
    if (this.ready) await this.resume();
    else await this.check();
  }

  private async check() {
    this.inFlight = true;
    this.set({phase:'checking', blocking:true, message:'Recherche d’une mise à jour du launcher…'});
    this.watch(this.options.checkTimeoutMs ?? 20000);
    try {
      const result = await this.options.driver.checkForUpdates();
      if (result?.downloadPromise) await result.downloadPromise;
      if (!result && this.value.phase === 'checking') {
        this.clearWatch();
        this.set({phase:'current', blocking:false, message:'Aucune mise à jour disponible.'});
      }
    } catch (error) { this.fail(error); }
    finally {
      this.inFlight = false;
      if (this.value.phase === 'error') this.set({...this.value, retryable:true});
    }
  }

  /** Re-check after a file operation or a game ends, including games from an earlier launcher process. */
  async resume() {
    if (!this.ready || this.disposed || this.installingCheck || this.value.phase === 'installing') return;
    this.installingCheck = true;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = undefined; }
    try {
      if (this.options.busy() || await this.options.gameRunning() || this.options.busy()) {
        this.set({...this.value, phase:'deferred', blocking:false, retryable:false,
          message:'Mise à jour prête. Elle s’installera automatiquement après la fermeture du jeu ou la fin de l’opération en cours.'});
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => { this.retryTimer = undefined; void this.resume(); }, this.options.retryIntervalMs ?? 10000);
        this.retryTimer.unref();
        return;
      }
      if (this.disposed) return;
      this.set({...this.value, phase:'installing', blocking:true, retryable:false,
        message:'Installation de la mise à jour… Le launcher va se fermer et se rouvrir automatiquement.'});
      this.watch(15000);
      // electron-updater 6.x: silent NSIS install + relaunch, with no setup wizard.
      this.options.driver.quitAndInstall(true, true);
    } catch (error) { this.fail(error); }
    finally { this.installingCheck = false; }
  }

  dispose() {
    this.disposed = true;
    this.clearWatch();
    if (this.retryTimer) clearTimeout(this.retryTimer);
  }

  private set(value: LauncherUpdateState) {
    if (this.disposed) return;
    this.value = value;
    this.options.changed(this.snapshot());
  }

  private fail(error: unknown) {
    if (this.disposed) return;
    const installing = this.value.phase === 'installing';
    this.clearWatch();
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = undefined; }
    this.options.log(`[launcher-update] ${error instanceof Error ? error.message : String(error)}`);
    this.set({phase:'error', blocking:false, retryable:!this.inFlight,
      message:installing ? 'L’installation de la mise à jour a échoué. Vous pouvez réessayer ou récupérer le Setup dans les téléchargements.'
        : 'La mise à jour n’a pas pu aboutir. Vous pouvez utiliser le launcher et réessayer ; elle sera vérifiée à la prochaine ouverture.'});
  }

  private clearWatch() { if (this.watchdog) { clearTimeout(this.watchdog); this.watchdog = undefined; } }
  private watch(ms: number) {
    this.clearWatch();
    this.watchdog = setTimeout(() => this.fail(new Error('Délai de mise à jour dépassé.')), ms);
    this.watchdog.unref();
  }
}
