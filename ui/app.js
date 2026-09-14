'use strict';
const $ = id => document.getElementById(id);
const api = window.cobblemon;
let current = null, busy = false, running = false;
let logLines = [];
let selectedRam = 8;
let activeView='play', mods=[], skinState={saved:[],current:null}, selectedSkin=null, avatarKey='', avatarSequence=0;
function view(name) {
  activeView=name;window.licarisSkin?.visible(name==='skins');
  for (const section of document.querySelectorAll('.view')) section.hidden = section.id !== `view-${name}`;
  for (const nav of document.querySelectorAll('[data-view]')) {
    const active=nav.dataset.view === name; nav.classList.toggle('active', active);
    active ? nav.setAttribute('aria-current','page') : nav.removeAttribute('aria-current');
  }
  $('notice').hidden=true;
  if(name==='skins')void loadSkins();if(name==='mods')void loadMods();if(name==='shaders')void loadShaders();
  $('page-title').textContent = {play:'Jouer',settings:'Réglages',logs:'Journal',skins:'Skins',mods:'Mods clients',shaders:'Shaders',links:'Liens'}[name];
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
  for(const element of $('settings-form').querySelectorAll('input,select,button')) element.disabled=busy||running||(element.name==='ram' && Number(element.value)>(current?.totalRamGb??32)-2);
  for(const element of document.querySelectorAll('.mutation'))element.disabled=busy||running;
  $('apply-skin').disabled=busy||running||!signed||!selectedSkin||selectedSkin.id==='current';
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
  const key=signed?(auth.uuid||auth.minecraftName||auth.username):'';if(key!==avatarKey){avatarKey=key;void refreshAvatar();}
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
  $('launcher-version').textContent=`v${current.version}`;
  if(fillForm) {
    selectedRam=current.settings.ramGb;
    $('launch-behavior').value=current.settings.launchBehavior||'keep';
    renderMemory(current.totalRamGb);
    $('ram-help').textContent=`Votre ordinateur dispose de ${current.totalRamGb} Go. 6 à 8 Go conviennent pour ce pack ; gardez de la mémoire pour Windows.`;
  }
  renderAccount(current.auth); renderButtons();
}
async function checkServer() {
  $('refresh-server').disabled=true;
  $('server-label').textContent='Vérification…';
  const result=await invoke('server-status');
  $('server-label').textContent=result.state === 'online' ? `En ligne · ${result.onlinePlayers ?? '?'} joueur(s)` : result.state === 'offline' ? 'Hors ligne ou injoignable' : 'Configuration en attente';
  $('refresh-server').disabled=false;
}
async function login(method='browser') {
  if(!current?.microsoftConfigured) {
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
function node(tag,className,text){const el=document.createElement(tag);if(className)el.className=className;if(text!==undefined)el.textContent=text;return el;}
function action(text,handler,className='secondary mutation'){const b=node('button',className,text);b.type='button';b.addEventListener('click',handler);return b;}
async function refreshAvatar(){
  const sequence=++avatarSequence;$('account-avatar').hidden=true;$('avatar-fallback').hidden=false;
  if(!avatarKey||!api)return;
  // A missing profile image must not interrupt sign-in or display an error banner.
  try{const skin=await api.invoke('account-avatar');if(!skin?.url||sequence!==avatarSequence)return;const img=new Image();img.src=skin.url;await img.decode();if(sequence!==avatarSequence)return;
    const canvas=$('account-avatar'),ctx=canvas.getContext('2d');ctx.imageSmoothingEnabled=false;ctx.clearRect(0,0,32,32);ctx.drawImage(img,8,8,8,8,0,0,32,32);ctx.drawImage(img,40,8,8,8,0,0,32,32);canvas.hidden=false;$('avatar-fallback').hidden=true;
  }catch{}
}
async function loadMods(){const result=await invoke('client-mods');if(Array.isArray(result)){mods=result;renderMods();}}
function renderMods(){
  const query=$('mod-search').value.toLocaleLowerCase('fr');$('mod-list').replaceChildren();
  $('mods-count').textContent=`${mods.filter(m=>m.optional).length} OPTIONS CLIENTS`;
  for(const m of mods.filter(m=>(m.name+' '+m.description).toLocaleLowerCase('fr').includes(query))){
    const row=node('div','content-row'),copy=node('div','content-copy');copy.append(node('h3','',m.name),node('p','',m.optional?m.description:m.reason));
    if(m.optional){const label=node('label','toggle');const input=node('input');input.type='checkbox';input.checked=m.enabled;input.className='mutation';input.setAttribute('aria-label',m.name);const visual=node('span','toggle-track');label.append(input,visual);row.append(copy,label);
      input.addEventListener('change',async()=>{input.disabled=true;const result=await invoke('set-client-mod',{id:m.id,enabled:input.checked});if(result?.mods)mods=result.mods;renderMods();notice(result);});
    }else row.append(copy,node('span','locked-badge','Requis'));
    $('mod-list').append(row);
  }
  if(!$('mod-list').childElementCount)$('mod-list').append(node('p','muted','Aucun mod ne correspond à votre recherche.'));renderButtons();
}
async function chooseSkin(s){
  selectedSkin=s;$('skin-empty').hidden=!!s;$('skin-preview-name').textContent=s?.name||'Votre personnage';
  if(s){$('skin-model').value=s.model||'classic';await window.licarisSkin?.show(s.url,$('skin-model').value);}else window.licarisSkin?.clear();renderButtons();
}
async function loadSkins(){const result=await invoke('skins');if(!result?.saved)return;skinState=result;renderSkinLibrary();const selected=skinState.saved.find(s=>s.id===selectedSkin?.id)||skinState.current&&{...skinState.current,id:'current'}||skinState.saved[0]||null;await chooseSkin(selected);}
function renderSkinLibrary(){
  $('skin-library').replaceChildren();
  if(skinState.current)$('skin-library').append(action('Mon skin actuel',()=>chooseSkin({...skinState.current,id:'current'}),'secondary'));
  for(const s of skinState.saved){const row=node('div','skin-item');const image=node('img');image.src=s.url;image.alt=s.name;row.append(image,action(s.name,()=>chooseSkin(s),'skin-select'),action('Retirer',async()=>{const result=await invoke('delete-skin',s.id);if(result?.saved){skinState=result;selectedSkin=null;renderSkinLibrary();await chooseSkin(skinState.current?{...skinState.current,id:'current'}:skinState.saved[0]);}notice(result);},'text-button mutation'));$('skin-library').append(row);}
  if(!skinState.saved.length)$('skin-library').append(node('p','muted','Vos skins importés apparaîtront ici.'));
  if(skinState.warning)$('skin-library').append(node('p','muted',skinState.warning));renderButtons();
}
async function loadShaders(){const result=await invoke('shaders');if(result?.catalog)renderShaders(result);}
function renderShaders(data){
  $('shader-current').textContent=data.selected||'Sans shader · priorité à la fluidité';$('shader-local').replaceChildren();$('shader-catalog').replaceChildren();
  for(const file of data.local){const row=node('div','content-row');row.append(node('h3','',file),action(data.selected===file?'Sélectionné':'Utiliser',async()=>{const result=await invoke('select-shader',{file});if(result?.catalog)renderShaders(result);notice(result);}));$('shader-local').append(row);}
  if(!data.local.length)$('shader-local').append(node('p','muted','Installez votre premier shader ci-dessous.'));
  for(const d of data.catalog){const card=node('article','shader-card');card.append(node('span','eyebrow',d.level),node('h3','',d.name),node('p','',d.description),action(d.installed?'Utiliser':'Installer',async()=>{
    const result=await invoke(d.installed?'select-shader':'install-shader',d.installed?{file:d.file}:d.id);if(result?.catalog)renderShaders(result);notice(result);
  }));$('shader-catalog').append(card);}renderButtons();
}
$('mod-search').addEventListener('input',renderMods);
$('refresh-skins').addEventListener('click',async()=>{await loadSkins();await refreshAvatar();});
$('skin-model').addEventListener('change',()=>{if(selectedSkin)void window.licarisSkin?.show(selectedSkin.url,$('skin-model').value);});
$('skin-rotate').addEventListener('click',()=>{$('skin-rotate').setAttribute('aria-pressed',String(window.licarisSkin?.rotate()));});
$('import-skin').addEventListener('click',async()=>{const result=await invoke('import-skin',{model:$('skin-model').value});if(result?.saved){skinState=result;renderSkinLibrary();await chooseSkin(result.saved.find(s=>s.id===result.id));}notice(result);});
$('apply-skin').addEventListener('click',async()=>{if(!selectedSkin)return;const result=await invoke('apply-skin',{id:selectedSkin.id,model:$('skin-model').value});if(result?.saved){skinState=result;renderSkinLibrary();await refreshAvatar();}notice(result);});
$('shader-off').addEventListener('click',async()=>{const result=await invoke('select-shader',{file:null});if(result?.catalog)renderShaders(result);notice(result);});
$('shaders-folder').addEventListener('click',()=>invoke('open-folder','shaders'));
$('copy-diagnostics').addEventListener('click',async()=>notice(await invoke('copy-diagnostics')));
for(const b of document.querySelectorAll('[data-link]'))b.addEventListener('click',()=>invoke('open-link',b.dataset.link));
setInterval(()=>{if(current?.running&&!busy)void refresh(false);},15000);
for(const button of document.querySelectorAll('[data-view]')) button.addEventListener('click',()=>view(button.dataset.view));
$('account').addEventListener('click',()=>current?.auth?.state === 'signed-in' ? view('settings') : login());
$('play-button').addEventListener('click',async()=>{
  if(current?.installed && current.auth.state !== 'signed-in') { await login(); return; }
  $('progress-wrap').hidden=false; $('notice').hidden=true;
  notice(await invoke(current?.installed ? 'play' : 'install')); await refresh(false);
});
$('settings-form').addEventListener('submit',async event=>{
  event.preventDefault();
  notice(await invoke('save-settings',{ramGb:selectedRam,launchBehavior:$('launch-behavior').value}));
  await refresh(false); await checkServer();
});
$('repair').addEventListener('click',async()=>{view('play');$('progress-wrap').hidden=false;notice(await invoke('repair'));await refresh(false);});
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
  api.on('busy',value=>{busy=value;if(!value)$('global-activity').hidden=true;renderButtons();});
  api.on('running',value=>{running=value;renderButtons();});
  api.on('auth',auth=>{renderAccount(auth);if(activeView==='skins')void loadSkins();notice({ok:auth.state !== 'error',message:auth.message});});
  api.on('notice',notice);
  api.on('log',appendLog);
  api.on('progress',p=>{$('global-activity').hidden=p.percent>=100;$('global-activity').textContent=`${p.message} · ${Math.round(p.percent)} %`;$('progress-wrap').hidden=false;$('progress-message').textContent=p.message;$('progress').value=p.percent;$('progress-value').textContent=`${Math.round(p.percent)} %`;});
  void (async()=>{await refresh();const logs=await invoke('logs');if(Array.isArray(logs))logs.forEach(appendLog);await checkServer();await invoke('ui-ready');})();
} else {
  notice({ok:false,message:'Ouvrez Licaris Launcher avec son exécutable pour installer le pack et jouer.'});
  $('play-button').disabled=true;
}
