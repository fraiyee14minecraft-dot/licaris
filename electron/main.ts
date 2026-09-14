import { app, BrowserWindow, ipcMain, shell, Menu, dialog } from 'electron';
import { autoUpdater } from 'electron-updater';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
let launcherUpdateReady = false;
function checkLauncherUpdate() {
  if (!app.isPackaged || testMode || process.env.PORTABLE_EXECUTABLE_DIR) return;
  autoUpdater.autoDownload=true;autoUpdater.autoInstallOnAppQuit=false;autoUpdater.allowDowngrade=false;
  autoUpdater.on('update-downloaded', () => {launcherUpdateReady=true;send('launcher-update',true);});
  autoUpdater.on('error', error => {void writeLauncherLog(`[launcher-update] ${error.message}`);});
  void autoUpdater.checkForUpdates().catch(error => writeLauncherLog(`[launcher-update] ${error.message}`));
}
const uiFile = path.join(__dirname, '..', 'ui', 'index.html');
const send = (channel: string, payload: unknown) => { if (window && !window.isDestroyed()) window.webContents.send(channel, payload); };
let reportedProgress=-10;
const progress: Progress = (message, percent) => {
  send('progress', {message, percent});
  if(process.argv.includes('--prepare-test') && percent>=reportedProgress+5){reportedProgress=percent;console.log(`[prepare ${Math.round(percent)}%] ${message}`);}
};
const adapt = (start: number, end: number) => (p: LauncherSyncProgress) => progress(p.message, start+(end-start)*p.percent/100);

async function prepare() {
  await installPack((message, percent) => progress(message, percent * .65));
  progress('Installation de Java 21…', 66);
  const java = await ensureJavaRuntime(adapt(66, 75));
  const runtime = await prepareMinecraftAndFabric(getMinecraftInstanceDir(), adapt(75, 99));
  if (settings.serverHost) await ensureServerInMultiplayerList(getMinecraftInstanceDir());
  await writeFile(path.join(getMinecraftInstanceDir(), '.launcher-ready.json'), JSON.stringify({version:packDefinition.version, checkedAt:new Date().toISOString()}));
  progress('Tout est prêt pour votre prochaine aventure.', 100);
  return {java, runtime};
}
async function state() {
  const ready = await readFile(path.join(getMinecraftInstanceDir(), '.launcher-ready.json'), 'utf8').then(JSON.parse).catch(() => null);
  return {...getPlayerSettings(settings), pack:packDefinition, auth:await getMicrosoftAuthStatus(), installed:ready?.version === packDefinition.version, running:!!game,
    totalRamGb:Math.floor(os.totalmem()/1024**3), instancePath:getMinecraftInstanceDir(), version:app.getVersion(), busy};
}
async function exclusive(action: () => Promise<unknown>) {
  if (busy || game) return {ok:false, message:game ? 'Minecraft est déjà ouvert.' : 'Une opération est déjà en cours.'};
  busy = true; send('busy', true);
  try { return await action(); }
  catch (error) {
    const message = sanitizeLogMessage(error instanceof Error ? error.message : String(error));
    await writeLauncherLog(`[error] ${message}`);
    return {ok:false, message};
  } finally { busy=false; send('busy', false); }
}
async function play() {
  const auth = await getAuthenticatedSession();
  if (!auth) return {ok:false, message:'Connecte ton compte Microsoft avant de jouer.'};
  const {java, runtime} = await prepare();
  const plan = await buildMinecraftLaunchPlan(getMinecraftInstanceDir(), auth, runtime, ['-Xms2G', `-Xmx${settings.ramGb}G`]);
  const child = spawn(java.executable, plan.args, {cwd:getMinecraftInstanceDir(), windowsHide:true, detached:true, stdio:['ignore','pipe','pipe']});
  game=child;
  send('running', true);
  child.stdout?.on('data', chunk => { void writeLauncherLog(`[minecraft] ${chunk.toString().trim()}`); });
  child.stderr?.on('data', chunk => { void writeLauncherLog(`[minecraft] ${chunk.toString().trim()}`); });
  child.once('close', code => {
    if (game === child) game=null;
    send('running', false);
    const message = code === 0 ? 'Partie terminée. À bientôt !' : `Minecraft s’est arrêté (code ${code ?? 'inconnu'}). Consulte le journal.`;
    send('notice', {ok:code === 0, message});
    void writeLauncherLog(`[minecraft] ${message}`);
  });
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
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
  handle('install-launcher-update', () => {
    if(busy || game || !launcherUpdateReady) return {ok:false,message:'Terminez l’opération en cours avant de mettre à jour le launcher.'};
    autoUpdater.quitAndInstall(false,true);return {ok:true};
  });
  handle('window-close', () => { window?.close(); return {ok:true}; });
  handle('logout', () => exclusive(() => logoutMicrosoft(status => send('auth', status))));
  handle('install', () => exclusive(async () => { await prepare(); return {ok:true, message:'Installation terminée. Le pack est prêt.'}; }));
  handle('play', () => exclusive(play));
  handle('server-status', async () => {
    if (!settings.serverHost) return {state:'not-configured'};
    const {state, onlinePlayers, maxPlayers, latencyMs} = await getOfficialServerStatus();
    return {state, onlinePlayers, maxPlayers, latencyMs};
  });
  handle('open-folder', async which => {
    const directory = which === 'logs' ? getLogsDir() : getMinecraftInstanceDir();
    await mkdir(directory, {recursive:true});
    const error = await shell.openPath(directory);
    return {ok:!error, message:error || 'Dossier ouvert.'};
  });
  handle('open-pack', () => shell.openExternal(packDefinition.source));
}
async function createWindow() {
  window = new BrowserWindow({width:1240, height:850, frame:false, minWidth:900, minHeight:680, title:'Licaris Launcher', show:!testMode,
    backgroundColor:'#070f20', autoHideMenuBar:true, icon:path.join(__dirname,'../ui/icon.ico'),
    webPreferences:{preload:path.join(__dirname,'preload.js'), contextIsolation:true, nodeIntegration:false, sandbox:true}});
  window.webContents.setWindowOpenHandler(() => ({action:'deny'}));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  addLogListener(entry => send('log', entry));
  await window.loadFile(uiFile);
  if (process.argv.includes('--smoke-test')) {
    await new Promise(resolve => setTimeout(resolve, 1500));
    await writeFile(path.join(__dirname,'../.test-data/launcher-preview.png'), (await window.webContents.capturePage()).toPNG()).catch(error => writeLauncherLog(`[capture] ${error.message}`));
    await window.webContents.executeJavaScript("document.querySelector('[data-view=settings]').click()");
    await new Promise(resolve => setTimeout(resolve, 300));
    const privacyCheck = await window.webContents.executeJavaScript(`(async () => {
      const state = await window.cobblemon.invoke('state');
      const status = await window.cobblemon.invoke('server-status');
      return {settingsFields:Object.keys(state.settings), statusFields:Object.keys(status),
        serverInputs:!!document.querySelector('#server-host, #server-port'),
        serverLabel:document.getElementById('server-configured').textContent,
        version:document.getElementById('launcher-version').textContent,
        markup:document.documentElement.outerHTML};
    })()`);
    if (privacyCheck.settingsFields.join(',') !== 'ramGb' || privacyCheck.statusFields.some((key:string) => ['host','port','error'].includes(key)) || privacyCheck.serverInputs || (settings.serverHost && privacyCheck.markup.includes(settings.serverHost))) {
      throw new Error('Des coordonnées du serveur sont encore exposées dans l’interface.');
    }
    await writeFile(path.join(__dirname,'../.test-data/settings-preview.png'), (await window.webContents.capturePage()).toPNG());
    if (!rendererReady) throw new Error('Le renderer ne communique pas avec le processus principal.');
    const {markup, ...privacy} = privacyCheck;
    await writeFile(path.join(__dirname,'../.test-data/smoke-result.json'), JSON.stringify({...await state(), rendererReady, privacy}, null, 2));
    app.quit();
  }
}
app.on('second-instance', () => { window?.restore(); window?.show(); window?.focus(); });
app.on('window-all-closed', () => app.quit());
app.whenReady().then(async () => {
  if (!owned) return;
  Menu.setApplicationMenu(null);
  await mkdir(getLauncherDataDir(), {recursive:true});
  settings=await readPreferences(); applyPreferences(settings);
  if (process.argv.includes('--prepare-test')) {
    const started=Date.now();
    await prepare();
    await writeFile(path.join(getLauncherDataDir(), 'prepare-result.json'), JSON.stringify({ok:true, seconds:(Date.now()-started)/1000, files:(await readPackLock()).files.length}));
    app.quit(); return;
  }
  registerIpc(); await createWindow();checkLauncherUpdate();
}).catch(async error => {
  await writeLauncherLog(`[error] ${error.message}`);
    if (!testMode) dialog.showErrorBox('Licaris Launcher', sanitizeLogMessage(error.message));
  app.exit(1);
});
