import { app, BrowserWindow, ipcMain, shell, Menu, dialog, clipboard } from 'electron';
import { autoUpdater } from 'electron-updater';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { launcherRuntimeConfig, packDefinition } from './config';
import { getLauncherDataDir, getMinecraftInstanceDir, getLogsDir } from './services/installPaths';
import { readPreferences, savePlayerPreferences, getPlayerSettings, applyPreferences, type Preferences } from './services/preferences';
import { getMicrosoftAuthStatus, getAuthenticatedSession, startMicrosoftLogin, startMicrosoftDeviceCodeLogin, logoutMicrosoft } from './services/authService';
import { sanitizeLogMessage } from './services/logSanitizer';
import { getCurrentSessionLogs, addLogListener, writeLauncherLog } from './services/logService';
import { installPack, readPackLock, type Progress } from './services/packService';
import { ensureJavaRuntime } from './services/javaRuntimeService';
import { prepareMinecraftAndFabric, buildMinecraftLaunchPlan } from './services/minecraftInstallService';
import { ensureServerInMultiplayerList } from './services/serverListService';
import { getOfficialServerStatus } from './services/serverStatusService';
import type { LauncherSyncProgress } from './types/launcher';
import {withVerificationSession} from './services/verificationCache';
import {listClientMods,setClientMod} from './services/clientContentService';
import {accountSkin,listSkins,importSkin,applySkin,deleteSkin} from './services/skinService';
import {listShaders,installShader,selectShader,applyShaderPreferences} from './services/shaderService';
import {isManagedGameRunning,rememberGame,forgetGame} from './services/gameProcessService';
import {LauncherUpdates} from './services/launcherUpdateService';

app.setName('Licaris Launcher');
const testMode = process.argv.includes('--smoke-test') || process.argv.includes('--prepare-test');
app.setPath('userData', testMode ? path.join(__dirname, '..', '.test-data', process.argv.includes('--smoke-test') ? 'smoke' : '') : path.join(app.getPath('appData'), 'CobblemonFriendsLauncher'));
const owned = app.requestSingleInstanceLock();
if (!owned) app.quit();
let window: BrowserWindow | null = null;
let busy = false;
let game: ChildProcess | null = null;
let settings: Preferences;
let rendererReady = false;
let launcherUpdates: LauncherUpdates;
const uiFile = path.join(__dirname, '..', 'ui', 'index.html');
const send = (channel: string, payload: unknown) => { if (window && !window.isDestroyed()) window.webContents.send(channel, payload); };
let reportedProgress=-10;
const progress: Progress = (message, percent) => {
  send('progress', {message, percent});
  if(process.argv.includes('--prepare-test') && percent>=reportedProgress+5){reportedProgress=percent;console.log(`[prepare ${Math.round(percent)}%] ${message}`);}
};
const adapt = (start: number, end: number) => (p: LauncherSyncProgress) => progress(p.message, start+(end-start)*p.percent/100);

async function prepare(force=false) {
 return withVerificationSession(force,async()=>{
  const started=Date.now();
  await installPack((message, percent) => progress(message, percent * .65));
  progress('Installation de Java 21…', 66);
  const java = await ensureJavaRuntime(adapt(66, 75));
  const runtime = await prepareMinecraftAndFabric(getMinecraftInstanceDir(), adapt(75, 99));
  await applyShaderPreferences();
  if (settings.serverHost) await ensureServerInMultiplayerList(getMinecraftInstanceDir());
  await writeFile(path.join(getMinecraftInstanceDir(), '.launcher-ready.json'), JSON.stringify({version:packDefinition.version, checkedAt:new Date().toISOString()}));
  progress('Tout est prêt pour votre prochaine aventure.', 100);
  await writeLauncherLog(`[performance] Préparation terminée en ${((Date.now()-started)/1000).toFixed(1)} s.`);
  return {java, runtime};
 });
}
async function state() {
  const ready = await readFile(path.join(getMinecraftInstanceDir(), '.launcher-ready.json'), 'utf8').then(JSON.parse).catch(() => null);
  return {...getPlayerSettings(settings), pack:packDefinition, auth:await getMicrosoftAuthStatus(), installed:ready?.version === packDefinition.version, running:!!game||await isManagedGameRunning(),
    totalRamGb:Math.floor(os.totalmem()/1024**3), instancePath:getMinecraftInstanceDir(), version:app.getVersion(), busy, launcherUpdate:launcherUpdates.snapshot()};
}
async function exclusive(action: () => Promise<unknown>) {
  if (launcherUpdates.blocking) return {ok:false, message:'Le launcher se met à jour automatiquement. Patientez quelques instants.'};
  if (busy) return {ok:false, message:'Une opération est déjà en cours.'};
  busy = true; send('busy', true);
  try {if(game||await isManagedGameRunning())return {ok:false,message:'Fermez Minecraft avant de modifier ses fichiers ou ses réglages.'};return await action(); }
  catch (error) {
    const message = sanitizeLogMessage(error instanceof Error ? error.message : String(error));
    await writeLauncherLog(`[error] ${message}`);
    return {ok:false, message};
  } finally { busy=false; send('busy', false); if(launcherUpdates.snapshot().phase==='deferred')void launcherUpdates.resume(); }
}
async function play() {
  const auth = await getAuthenticatedSession();
  if (!auth) return {ok:false, message:'Connecte ton compte Microsoft avant de jouer.'};
  const {java, runtime} = await prepare();
  const plan = await buildMinecraftLaunchPlan(getMinecraftInstanceDir(), auth, runtime, ['-Xms2G', `-Xmx${settings.ramGb}G`]);
  const child = spawn(java.executable, plan.args, {cwd:getMinecraftInstanceDir(), windowsHide:true, detached:true, stdio:settings.launchBehavior==='close'?'ignore':['ignore','pipe','pipe']});
  game=child;
  send('running', true);
  child.stdout?.on('data', chunk => { void writeLauncherLog(`[minecraft] ${chunk.toString().trim()}`); });
  child.stderr?.on('data', chunk => { void writeLauncherLog(`[minecraft] ${chunk.toString().trim()}`); });
  child.once('close', code => {
    if(child.pid)void forgetGame(child.pid);
    if (game === child) game=null;
    send('running', false);
    if(launcherUpdates.snapshot().phase==='deferred')void launcherUpdates.resume();
    const message = code === 0 ? 'Partie terminée. À bientôt !' : `Minecraft s’est arrêté (code ${code ?? 'inconnu'}). Consulte le journal.`;
    send('notice', {ok:code === 0, message});
    void writeLauncherLog(`[minecraft] ${message}`);
  });
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  if(child.pid)await rememberGame(child.pid);
  child.unref();
  if(settings.launchBehavior==='minimize')window?.minimize();
  if(settings.launchBehavior==='close')setTimeout(()=>app.quit(),600);
  return {ok:true, message:settings.serverHost ? 'Minecraft démarre et va rejoindre votre serveur…' : 'Minecraft démarre. Contactez l’organisateur pour activer la connexion au serveur.'};
}
function registerIpc() {
  const handle = (name: string, action: (input: any) => unknown) => ipcMain.handle(name, async (event, input) => {
    if (event.sender !== window?.webContents || event.senderFrame?.url !== pathToFileURL(uiFile).href) throw new Error('Source IPC refusée.');
    try { return await action(input); } catch (error) { return {ok:false, message:sanitizeLogMessage(error instanceof Error ? error.message : String(error))}; }
  });
  handle('state', state);
  handle('ui-ready', () => {
    const firstReady = !rendererReady;
    rendererReady=true;
    if (firstReady && !testMode && process.argv.includes('--login')) {
      void exclusive(() => startMicrosoftLogin(status => send('auth', status))).then(result => send('notice', result));
    }
    return {ok:true};
  });
  handle('logs', () => getCurrentSessionLogs().slice(-400));
  handle('save-settings', input => exclusive(async () => {
    settings = await savePlayerPreferences(settings, input);
    return {ok:true, message:'Réglages enregistrés.'};
  }));
  handle('login', method => exclusive(async () => {
    if (!settings.microsoftClientId) return {ok:false, message:'La connexion Microsoft n’est pas disponible. Contactez l’organisateur du launcher.'};
    return (method === 'device' ? startMicrosoftDeviceCodeLogin : startMicrosoftLogin)(status => send('auth', status));
  }));
  handle('switch-account', () => exclusive(async () => {
    await logoutMicrosoft(status => send('auth', status));
    return startMicrosoftLogin(status => send('auth', status));
  }));
  handle('window-minimize', () => { window?.minimize(); return {ok:true}; });
  handle('retry-launcher-update', () => { void launcherUpdates.retry(); return {ok:true}; });
  handle('window-close', () => { window?.close(); return {ok:true}; });
  handle('logout', () => exclusive(() => logoutMicrosoft(status => send('auth', status))));
  handle('install', () => exclusive(async () => { await prepare(); return {ok:true, message:'Installation terminée. Le pack est prêt.'}; }));
  handle('repair', () => exclusive(async () => { await prepare(true); return {ok:true,message:'Vérification complète terminée.'}; }));
  handle('client-mods', () => listClientMods());
  handle('set-client-mod', input => exclusive(()=>setClientMod(input)));
  handle('account-avatar', () => accountSkin());
  handle('skins', () => listSkins());
  handle('import-skin', input => exclusive(()=>importSkin(input)));
  handle('apply-skin', input => exclusive(()=>applySkin(input)));
  handle('delete-skin', input => exclusive(()=>deleteSkin(input)));
  handle('shaders', () => listShaders());
  handle('install-shader', input => exclusive(()=>installShader(input)));
  handle('select-shader', input => exclusive(()=>selectShader(input)));
  handle('copy-diagnostics', async () => {
    const instance=getMinecraftInstanceDir();
    const crashes=(await readdir(path.join(instance,'crash-reports')).catch(()=>[])).filter(n=>/^crash-.*\.txt$/.test(n)).sort().reverse();
    const crash=crashes[0]?await readFile(path.join(instance,'crash-reports',crashes[0]),'utf8').catch(()=>''):'';
    const latest=await readFile(path.join(instance,'logs/latest.log'),'utf8').catch(()=>'');
    const text=[`Licaris ${app.getVersion()} · ${packDefinition.name} ${packDefinition.version}`,crash.slice(0,80000),latest.slice(-60000),...getCurrentSessionLogs().slice(-100).map(l=>l.message)].join('\n\n');
    clipboard.writeText(sanitizeLogMessage(text).split(os.homedir()).join('%USERPROFILE%'));
    return {ok:true,message:'Rapport copié. Les adresses de connexion et jetons connus sont masqués.'};
  });
  handle('open-link', key => {
    const links:Record<string,string>={studio:'https://immersive-studio.fr/'};
    if(typeof key!=='string'||!Object.hasOwn(links,key))throw new Error('Lien inconnu.');return shell.openExternal(links[key]);
  });
  handle('play', () => exclusive(play));
  handle('server-status', async () => {
    if (!settings.serverHost) return {state:'not-configured'};
    const {state, onlinePlayers, maxPlayers, latencyMs} = await getOfficialServerStatus();
    return {state, onlinePlayers, maxPlayers, latencyMs};
  });
  handle('open-folder', async which => {
    const folders:Record<string,string>={logs:getLogsDir(),game:getMinecraftInstanceDir(),mods:path.join(getMinecraftInstanceDir(),'mods'),shaders:path.join(getMinecraftInstanceDir(),'shaderpacks')};
    if(typeof which!=='string'||!Object.hasOwn(folders,which))throw new Error('Dossier inconnu.');const directory=folders[which];
    await mkdir(directory, {recursive:true});
    const error = await shell.openPath(directory);
    return {ok:!error, message:error || 'Dossier ouvert.'};
  });
}
async function createWindow() {
  window = new BrowserWindow({width:1240, height:850, frame:false, minWidth:900, minHeight:680, title:'Licaris Launcher', show:!testMode,
    backgroundColor:'#102744', autoHideMenuBar:true, icon:path.join(__dirname,'../ui/icon.ico'),
    webPreferences:{preload:path.join(__dirname,'preload.js'), contextIsolation:true, nodeIntegration:false, sandbox:true, backgroundThrottling:!testMode}});
  window.webContents.setWindowOpenHandler(() => ({action:'deny'}));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  addLogListener(entry => send('log', entry));
  await window.loadFile(uiFile);
  if (process.argv.includes('--smoke-test')) {
    // Hidden smoke windows must render the same completed frames as visible windows.
    const capture = async (name:string) => {
      await window!.webContents.executeJavaScript(`(async()=>{
        document.getAnimations().forEach(a=>a.finish());
        await Promise.all([...document.querySelectorAll('img')].filter(i=>i.checkVisibility()).map(i=>i.decode()));
        await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      })()`);
      await writeFile(path.join(__dirname, '../.test-data/', name), (await window!.webContents.capturePage()).toPNG());
    };
    await new Promise(resolve => setTimeout(resolve, 1500));
    await window.webContents.executeJavaScript("chooseScene('meteor')");
    await capture('launcher-preview.png');
    await window.webContents.executeJavaScript("document.querySelector('[data-view=settings]').click()");
    await new Promise(resolve => setTimeout(resolve, 300));
    const privacyCheck = await window.webContents.executeJavaScript(`(async () => {
      const state = await window.cobblemon.invoke('state');
      const status = await window.cobblemon.invoke('server-status');
      return {settingsFields:Object.keys(state.settings), statusFields:Object.keys(status),
        serverInputs:!!document.querySelector('#server-host, #server-port'),
        removedServerCard:!document.getElementById('server-configured'),
        version:document.getElementById('launcher-version').textContent,
        markup:document.documentElement.outerHTML};
    })()`);
    if (privacyCheck.settingsFields.join(',') !== 'ramGb,launchBehavior' || !privacyCheck.removedServerCard || privacyCheck.statusFields.some((key:string) => ['host','port','error'].includes(key)) || privacyCheck.serverInputs || (settings.serverHost && privacyCheck.markup.includes(settings.serverHost))) {
      throw new Error('Des coordonnées du serveur sont encore exposées dans l’interface.');
    }
    await capture('settings-preview.png');
    for(const view of ['mods','shaders','skins']){
      await window.webContents.executeJavaScript(`document.querySelector('[data-view=${view}]').click()`);
      await new Promise(resolve=>setTimeout(resolve,view==='mods'?2500:500));
      await capture(`${view}-preview.png`);
    }
    const gallery = await window.webContents.executeJavaScript(`(async()=>{
      view('shaders'); await loadShaders();
      const counts={};
      for(const filter of ['light','balanced','cinematic','all']) {
        document.querySelector('[data-shader-filter='+filter+']').click();
        counts[filter]=document.querySelectorAll('.shader-card').length;
      }
      await Promise.all([...document.querySelectorAll('.shader-cover img')].map(i=>i.decode()));
      return {counts,images:[...document.querySelectorAll('.shader-cover img')].every(i=>i.naturalWidth>0),
        studioOnly:[...document.querySelectorAll('[data-link]')].every(e=>e.dataset.link==='studio'),
        noLinksTab:!document.querySelector('[data-view=links]')};
    })()`);
    if(!gallery.images || !gallery.studioOnly || !gallery.noLinksTab || gallery.counts.all!==8 || gallery.counts.light!==2 || gallery.counts.balanced!==3 || gallery.counts.cinematic!==3) throw new Error('Catalogue visuel ou navigation incomplet.');
    await window.webContents.executeJavaScript("view('play')");
    for(const scene of ['stargazing','ocean','meteor']) {
      await window.webContents.executeJavaScript(`document.querySelector('[data-scene-choice=${scene}]').click()`);
      await capture(`ambience-${scene}.png`);
    }
    window.setSize(900,680);
    await new Promise(resolve=>setTimeout(resolve,250));
    await capture('launcher-small-preview.png');
    const compact = await window.webContents.executeJavaScript(`(()=>{
      const b=document.getElementById('play-button').getBoundingClientRect(), hero=document.querySelector('.hero').getBoundingClientRect();
      return {noHorizontalOverflow:document.documentElement.scrollWidth<=innerWidth,
        playVisible:b.left>=hero.left&&b.right<=hero.right&&b.bottom<=hero.bottom,
        opacity:getComputedStyle(document.getElementById('view-play')).opacity};
    })()`);
    if(!compact.noHorizontalOverflow || !compact.playVisible || compact.opacity!=='1')throw new Error('L’accueil ne tient pas dans la fenêtre minimale.');
    await window.webContents.executeJavaScript("view('shaders')");
    await capture('shaders-small-preview.png');
    for(const name of ['settings','mods','skins','logs']) {
      await window.webContents.executeJavaScript(`view('${name}')`);
      await new Promise(resolve=>setTimeout(resolve,250));
      await capture(`${name}-small-preview.png`);
      if(!await window.webContents.executeJavaScript('document.documentElement.scrollWidth<=innerWidth'))throw new Error(`Débordement horizontal dans ${name}.`);
    }
    window.setSize(1240,850);
    if (!rendererReady) throw new Error('Le renderer ne communique pas avec le processus principal.');
    const updateUi = await window.webContents.executeJavaScript(`(() => {
      document.querySelector('[data-view=play]').click();
      renderLauncherUpdate({phase:'downloading',blocking:true,percent:42,version:'0.5.3',message:'Téléchargement de la mise à jour… Installation automatique à suivre.'});
      const blocked=document.getElementById('play-button').disabled;
      const bannerVisible=!document.getElementById('launcher-update-status').hidden;
      const percent=document.getElementById('launcher-update-progress').value;
      renderLauncherUpdate({phase:'error',blocking:false,retryable:true,message:'La mise à jour n’a pas pu aboutir. Vous pouvez réessayer.'});
      const retryVisible=!document.getElementById('launcher-update-retry').hidden;
      renderLauncherUpdate({phase:'installing',blocking:true,percent:100,message:'Installation de la mise à jour… Le launcher va se fermer et se rouvrir automatiquement.'});
      return {blocked,bannerVisible,percent,retryVisible,noManualInstallButton:!document.getElementById('launcher-update')};
    })()`);
    if(!updateUi.blocked || !updateUi.bannerVisible || updateUi.percent!==42 || !updateUi.retryVisible || !updateUi.noManualInstallButton)throw new Error('Le parcours de mise à jour automatique ne s’affiche pas correctement.');
    await capture('update-preview.png');
    const {markup, ...privacy} = privacyCheck;
    await writeFile(path.join(__dirname,'../.test-data/smoke-result.json'), JSON.stringify({...await state(), rendererReady, privacy, updateUi, gallery, compact}, null, 2));
    app.quit();
  }
}
app.on('second-instance', () => { window?.restore(); window?.show(); window?.focus(); });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => launcherUpdates?.dispose());
app.whenReady().then(async () => {
  if (!owned) return;
  Menu.setApplicationMenu(null);
  await mkdir(getLauncherDataDir(), {recursive:true});
  settings=await readPreferences(); applyPreferences(settings);
  launcherUpdates = new LauncherUpdates({driver:autoUpdater,
    supported:app.isPackaged && !testMode && !process.env.PORTABLE_EXECUTABLE_DIR,
    busy:()=>busy, gameRunning:async()=>!!game || await isManagedGameRunning(),
    changed:value=>send('launcher-update',value), log:message=>{void writeLauncherLog(message);}});
  if (process.argv.includes('--prepare-test')) {
    const started=Date.now();
    await prepare();
    await writeFile(path.join(getLauncherDataDir(), 'prepare-result.json'), JSON.stringify({ok:true, seconds:(Date.now()-started)/1000, files:(await readPackLock()).files.length}));
    app.quit(); return;
  }
  registerIpc(); await createWindow();void launcherUpdates.start();
}).catch(async error => {
  await writeLauncherLog(`[error] ${error.message}`);
    if (!testMode) dialog.showErrorBox('Licaris Launcher', sanitizeLogMessage(error.message));
  app.exit(1);
});
