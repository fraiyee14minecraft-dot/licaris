'use strict';
const $ = id => document.getElementById(id);
const api = window.cobblemon;
let current = null, busy = false, running = false;
let logLines = [];
let selectedRam = 8;
function view(name) {
  for (const section of document.querySelectorAll('.view')) section.hidden = section.id !== `view-${name}`;
  for (const nav of document.querySelectorAll('[data-view]')) {
    const active=nav.dataset.view === name; nav.classList.toggle('active', active);
    active ? nav.setAttribute('aria-current','page') : nav.removeAttribute('aria-current');
  }
  $('page-title').textContent = {play:'Jouer',settings:'Réglages',logs:'Journal'}[name];
}
function notice(result) {
  if (!result?.message) return;
  $('notice').hidden=false; $('notice').textContent=result.message;
  $('notice').classList.toggle('error', result.ok === false);
}
async function invoke(channel, input) {
  try { const result=await api.invoke(channel,input); if(result?.ok === false) notice(result); return result; }
  catch(error) { const result={ok:false,message:error.message}; notice(result); return result; }
}
function renderButtons() {
  const signed=current?.auth?.state === 'signed-in';
  const installed=current?.installed;
  $('play-button').textContent=running ? 'Minecraft est ouvert' : busy ? 'Préparation en cours…' : !installed ? 'Installer le modpack  ↓' : !signed ? 'Se connecter pour jouer  ↗' : 'Jouer ensemble  ↗';
  for(const id of ['play-button','repair','account','logout','device-login','switch-account']) $(id).disabled=busy||running;
  for(const element of $('settings-form').querySelectorAll('input,select,button')) element.disabled=busy||running||(element.name==='ram' && Number(element.value)>current.totalRamGb-2);
  $('logout').hidden=!signed;
  $('install-label').textContent=installed ? 'PRÊT POUR LE DÉPART' : 'PREMIÈRE ESCALE';
  $('launch-heading').textContent=installed ? 'Votre aventure vous attend.' : 'On prépare votre sac ?';
  $('launch-help').textContent=installed ? 'Le pack est installé. Il sera vérifié avant chaque lancement.' : 'Le launcher installe Minecraft, Fabric, Java et le modpack.';
}
function renderAccount(auth) {
  if(!auth) return;
  if(current) current.auth=auth;
  $('account-label').textContent=auth.state === 'signed-in' ? (auth.minecraftName || auth.username || 'Mon compte') : auth.state === 'signing-in' ? 'Connexion en cours…' : 'Connexion Microsoft';
  const signed=auth.state === 'signed-in';
  $('account-state').textContent=signed ? 'Connecté' : 'Non connecté';
  $('account-detail').textContent=signed ? `Vous jouez avec ${auth.minecraftName || auth.username || 'votre compte Minecraft'}.` : 'Connectez le compte qui possède Minecraft Java Edition.';
  $('switch-account').textContent=signed ? 'Changer de compte' : 'Choisir un compte Microsoft';
  renderButtons();
}
function renderMemory(total) {
  $('ram-choices').replaceChildren();
  for(const ram of [4,6,8,10,12,16]) {
    const label=document.createElement('label');
    const radio=document.createElement('input');radio.type='radio';radio.name='ram';radio.value=ram;radio.checked=ram===selectedRam;radio.disabled=ram>total-2;
    const text=document.createElement('span');text.textContent=`${ram} Go`;
    radio.addEventListener('change',()=>{selectedRam=ram;$('ram-selected').textContent=`${ram} Go`;});
    label.append(radio,text);$('ram-choices').append(label);
  }
  $('ram-selected').textContent=`${selectedRam} Go`;
}
async function refresh(fillForm=true) {
  const result=await invoke('state');
  if(!result.settings) return;
  current=result; busy=result.busy; running=result.running;
  $('pack-name').textContent=current.pack.label;
  $('pack-version').textContent=current.pack.version;
  $('pack-edition').textContent=current.pack.edition;
  $('pack-sidebar').textContent=current.pack.name.toUpperCase();
  $('runtime-label').textContent=`MINECRAFT ${current.pack.minecraftVersion} · FABRIC ${current.pack.fabricLoaderVersion} · JAVA 21`;
  $('ram-label').textContent=`${current.settings.ramGb} Go`;
  if(fillForm) {
    selectedRam=current.settings.ramGb;
    renderMemory(current.totalRamGb);
    $('ram-help').textContent=`Votre ordinateur dispose de ${current.totalRamGb} Go. 6 à 8 Go conviennent pour ce pack ; gardez de la mémoire pour Windows.`;
    $('server-host').value=current.settings.serverHost;
    $('server-port').value=current.settings.serverPort;
  }
  renderAccount(current.auth); renderButtons();
}
async function checkServer() {
  $('refresh-server').disabled=true;
  $('server-label').textContent='Vérification…';
  const result=await invoke('server-status');
  $('server-label').textContent=result.state === 'online' ? `En ligne · ${result.onlinePlayers ?? '?'} joueur(s)` : result.state === 'offline' ? 'Hors ligne ou injoignable' : 'Adresse à renseigner';
  $('server-label').title=current?.settings.serverHost || 'Ajoutez l’adresse dans les réglages.';
  $('refresh-server').disabled=false;
}
async function login(method='browser') {
  if(!current?.settings.microsoftClientId) {
    view('settings');
    notice({ok:false,message:'La connexion Microsoft n’est pas disponible. Contactez l’organisateur du launcher.'}); return;
  }
  notice(await invoke('login',method)); await refresh(false);
}
function appendLog(entry) {
  logLines.push(`[${new Date(entry.timestamp).toLocaleTimeString('fr-FR')}] ${entry.message}`);
  logLines=logLines.slice(-400); $('log-content').textContent=logLines.join('\n');
  $('log-content').scrollTop=$('log-content').scrollHeight;
}
for(const button of document.querySelectorAll('[data-view]')) button.addEventListener('click',()=>view(button.dataset.view));
$('account').addEventListener('click',()=>current?.auth?.state === 'signed-in' ? view('settings') : login());
$('play-button').addEventListener('click',async()=>{
  if(current?.installed && current.auth.state !== 'signed-in') { await login(); return; }
  $('progress-wrap').hidden=false; $('notice').hidden=true;
  notice(await invoke(current?.installed ? 'play' : 'install')); await refresh(false);
});
$('settings-form').addEventListener('submit',async event=>{
  event.preventDefault();
  notice(await invoke('save-settings',{serverHost:$('server-host').value,serverPort:Number($('server-port').value),ramGb:selectedRam}));
  await refresh(false); await checkServer();
});
$('repair').addEventListener('click',async()=>{view('play');$('progress-wrap').hidden=false;notice(await invoke('install'));await refresh(false);});
$('edit-settings').addEventListener('click',()=>view('settings'));
$('refresh-server').addEventListener('click',checkServer);
$('game-folder').addEventListener('click',()=>invoke('open-folder','game'));
$('logs-folder').addEventListener('click',()=>invoke('open-folder','logs'));
$('pack-link').addEventListener('click',()=>invoke('open-pack'));
$('launcher-update').addEventListener('click',()=>invoke('install-launcher-update'));
$('window-minimize').addEventListener('click',()=>invoke('window-minimize'));
$('window-close').addEventListener('click',()=>invoke('window-close'));
$('switch-account').addEventListener('click',async()=>{notice(await invoke('switch-account'));await refresh(false);});
$('logout').addEventListener('click',async()=>{notice(await invoke('logout'));await refresh(false);});
$('device-login').addEventListener('click',()=>login('device'));
if(api) {
  api.on('launcher-update',()=>{$('launcher-update').hidden=false;});
  api.on('busy',value=>{busy=value;renderButtons();});
  api.on('running',value=>{running=value;renderButtons();});
  api.on('auth',auth=>{renderAccount(auth);notice({ok:auth.state !== 'error',message:auth.message});});
  api.on('notice',notice);
  api.on('log',appendLog);
  api.on('progress',p=>{$('progress-wrap').hidden=false;$('progress-message').textContent=p.message;$('progress').value=p.percent;$('progress-value').textContent=`${Math.round(p.percent)} %`;});
  void (async()=>{await refresh();const logs=await invoke('logs');if(Array.isArray(logs))logs.forEach(appendLog);await checkServer();await invoke('ui-ready');})();
} else {
  notice({ok:false,message:'Ouvrez Cobblemon Launcher avec son exécutable pour installer le pack et jouer.'});
  $('play-button').disabled=true;
}
