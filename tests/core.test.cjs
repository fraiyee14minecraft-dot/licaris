const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const Module=require('node:module');
const original=Module._load;
Module._load=function(name,...args){if(name==='electron')return {app:{getPath:()=>path.join(__dirname,'../.test-data/unit')}};return original.call(this,name,...args);};
const pack=require('../dist-electron/services/packService');
const prefs=require('../dist-electron/services/preferences');
const installPaths=require('../dist-electron/services/installPaths');
const {packDefinition}=require('../dist-electron/config');
const yauzl=require('yauzl');
const {execFileSync}=require('node:child_process');
test('managed paths reject traversal, absolute paths, alternate streams and Windows device names',()=>{
 for(const name of ['../escape','mods/../../escape','/absolute','C:/secret','mods/file:stream','mods\\evil.jar','mods/CON.jar','mods/file.','mods/NUL'])assert.throws(()=>pack.safePath('C:/safe',name));
 assert.equal(pack.safePath('C:/safe','mods/ok.jar'),path.resolve('C:/safe/mods/ok.jar'));
});
test('profile is isolated by pack identity and release',()=>{
 assert.equal(installPaths.getMinecraftInstanceDir(),path.join(__dirname,'../.test-data/unit/instances',`${packDefinition.id}-${packDefinition.version}`));
});
test('preferences reject malformed addresses, argument injection and invalid memory',()=>{
 const good={ramGb:4,serverHost:'play.example.net',serverPort:25565,microsoftClientId:''};
 assert.equal(prefs.validatePreferences(good).serverHost,'play.example.net');
 for(const bad of [{serverHost:'https://example.net'},{serverHost:'host --demo'},{serverPort:70000},{serverPort:1.5},{ramGb:'8 -jar evil'},{microsoftClientId:'a&redirect_uri=evil'}])assert.throws(()=>prefs.validatePreferences({...good,...bad}));
 assert.equal(prefs.validatePreferences({...good,serverHost:'[::1]'}).serverHost,'::1');
});

test('player settings never expose or overwrite connection details when saving memory',async()=>{
 const config=require('../dist-electron/config').launcherRuntimeConfig;
 const current={ramGb:8,serverHost:'play.example.net',serverPort:25571,microsoftClientId:'test-client-id'};
 const before={...config.officialServer},previousId=config.microsoftClientId;
 const file=installPaths.getSettingsFile();
 try{
  assert.deepEqual(prefs.getPlayerSettings(current),{settings:{ramGb:8},serverConfigured:true,microsoftConfigured:true});
  const saved=await prefs.savePlayerPreferences(current,{ramGb:4,serverHost:'attacker.example',serverPort:12345,microsoftClientId:'replacement-id'});
  assert.deepEqual(saved,{...current,ramGb:4});
  assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),saved);
  assert.deepEqual(prefs.getPlayerSettings({...current,serverHost:'',microsoftClientId:''}),{settings:{ramGb:8},serverConfigured:false,microsoftConfigured:false});
 }finally{Object.assign(config.officialServer,before);config.microsoftClientId=previousId;await fs.rm(file,{force:true});}
});

test('logs and error notices redact configured endpoints, IPs and credentials',()=>{
 const config=require('../dist-electron/config').launcherRuntimeConfig;
 const before={...config.officialServer};
 const {sanitizeLogMessage}=require('../dist-electron/services/logSanitizer');
 try{
  for(const host of ['play.example.net','192.0.2.10','2001:db8::10']){
   config.officialServer.host=host;config.officialServer.port=25571;
   const message=sanitizeLogMessage(`Connexion ${host}:25571 — --quickPlayMultiplayer ${host}:25571 — ECONNREFUSED 192.0.2.11:25571 — port 25571 — access_token=private-value`);
   for(const value of [host,'192.0.2.11','25571','private-value'])assert.ok(!message.includes(value),`Le journal contient encore ${value}`);
   assert.ok(message.includes('ECONNREFUSED'),'Keep the useful error cause');
  }
 }finally{Object.assign(config.officialServer,before);}
});
test('a damaged file of the same size fails SHA-256 validation',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cobblemon-hash-'));
 try{const file=path.join(dir,'mod.jar');await fs.writeFile(file,'abc');const expected={size:3,sha256:crypto.createHash('sha256').update('abc').digest('hex')};assert.equal(await pack.matches(file,expected),true);await fs.writeFile(file,'abd');assert.equal(await pack.matches(file,expected),false);}finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('installer refuses unapproved download sources before network access',async()=>{
 for(const url of ['http://edge.forgecdn.net/file','https://evil.example/file','https://forgecdn.net.evil.example/file'])await assert.rejects(pack.download({url,size:3,sha256:'0'.repeat(64)},'unused'));
});
test('official pack overrides preserve personal configuration during repair',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cobblemon-zip-'));
 try{
  const archive=path.join(__dirname,'../downloads/client-2.6.0.zip');
  // Fixture is a small archive written by Python stdlib; the runtime extractor is used unchanged.
  const fixture=path.join(dir,'fixture.zip');
  execFileSync('python',['-c',"import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],'w'); z.writestr('overrides/config/custom.txt','default'); z.writestr('overrides/mods/bundled.jar','official'); z.writestr('overrides/options.txt','defaults'); z.close()",fixture],{windowsHide:true});
  const instance=path.join(dir,'instance');await fs.mkdir(path.join(instance,'config'),{recursive:true});await fs.writeFile(path.join(instance,'config/custom.txt'),'player');
  await pack.extractOverrides(fixture,instance);
  assert.equal(await fs.readFile(path.join(instance,'config/custom.txt'),'utf8'),'player');
  assert.equal(await fs.readFile(path.join(instance,'mods/bundled.jar'),'utf8'),'official');
  await fs.writeFile(path.join(instance,'mods/bundled.jar'),'broken');await fs.writeFile(path.join(instance,'options.txt'),'personal');
  await pack.extractOverrides(fixture,instance);
  assert.equal(await fs.readFile(path.join(instance,'mods/bundled.jar'),'utf8'),'official');
  assert.equal(await fs.readFile(path.join(instance,'options.txt'),'utf8'),'personal');
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('pack lock pins every entry and contains no conflicting paths',async()=>{
 const lock=await pack.readPackLock();
 assert.equal(lock.id,'academy-2');assert.equal(lock.version,'2.6.0');assert.equal(lock.fabricLoaderVersion,'0.18.1');
 assert.equal(lock.files.length,224);assert.equal(new Set(lock.files.map(f=>f.path.toLowerCase())).size,224);
 for(const entry of lock.files){assert.match(entry.sha256,/^[a-f0-9]{64}$/);assert.ok(entry.size>0);assert.equal(new URL(entry.url).protocol,'https:');pack.safePath('C:/instance',entry.path);}
});

test('Microsoft login always offers account selection and keeps PKCE',()=>{
 const {buildMicrosoftAuthorizeUrl}=require('../dist-electron/services/authService');
 const url=new URL(buildMicrosoftAuthorizeUrl('http://localhost:12345/auth/callback','challenge','state-value'));
 assert.equal(url.origin,'https://login.microsoftonline.com');
 assert.equal(url.searchParams.get('prompt'),'select_account');
 assert.equal(url.searchParams.get('code_challenge_method'),'S256');
 assert.equal(url.searchParams.get('state'),'state-value');
 assert.equal(url.searchParams.get('redirect_uri'),'http://localhost:12345/auth/callback');
});

test('old empty server preferences migrate, custom addresses and RAM survive',async()=>{
 const file=installPaths.getSettingsFile();
 const config=require('../dist-electron/config').launcherRuntimeConfig;
 const before={...config.officialServer};
 await fs.mkdir(path.dirname(file),{recursive:true});
 try {
  config.officialServer.host='192.0.2.10';config.officialServer.port=25565;
  await fs.writeFile(file,JSON.stringify({ramGb:4,serverHost:'',serverPort:25565,microsoftClientId:''}));
  const migrated=await prefs.readPreferences();
  assert.equal(migrated.serverHost,'192.0.2.10');assert.equal(migrated.ramGb,4);
  assert.equal(migrated.microsoftClientId,config.microsoftClientId);
  await fs.writeFile(file,JSON.stringify({...migrated,serverHost:'custom.example',serverPort:25570}));
  const custom=await prefs.readPreferences();
  assert.equal(custom.serverHost,'custom.example');assert.equal(custom.serverPort,25570);
 }finally{Object.assign(config.officialServer,before);await fs.rm(file,{force:true});}
});

test('published manifest rejects unsafe paths, duplicate paths and external sources',()=>{
 const {validatePublishedPack}=require('../dist-electron/services/publishedPackService');
 const entry={path:'mods/test.jar',size:3,sha256:'a'.repeat(64),url:'https://edge.forgecdn.net/test.jar'};
 const good={schemaVersion:1,revision:'pack-test',files:[entry],overrideFiles:[],archive:{url:'https://github.com/fraiyee14minecraft-dot/licaris/releases/download/pack-test/overrides.zip',sha256:'b'.repeat(64),size:100}};
 assert.equal(validatePublishedPack(good).revision,'pack-test');
 for(const files of [[{...entry,path:'../secret'}],[entry,{...entry,path:'mods/TEST.jar'}],[{...entry,url:'https://github.com/attacker/repo/releases/download/x/a.jar'}]])assert.throws(()=>validatePublishedPack({...good,files}));
});

test('mod update rolls back all earlier replacements if a later replacement fails',async()=>{
 const {applyPreparedPack}=require('../dist-electron/services/publishedPackService');
 const base=path.join(__dirname,'../.test-data/unit/transaction-test');const instance=path.join(base,'instance'),stage=path.join(base,'stage');
 await fs.mkdir(path.join(instance,'mods'),{recursive:true});await fs.mkdir(path.join(stage,'mods'),{recursive:true});
 const digest=s=>crypto.createHash('sha256').update(s).digest('hex');
 const manifest={revision:'pack-rollback',files:[{path:'mods/a.jar',sha256:digest('new'),size:3},{path:'mods/b.jar',sha256:digest('new'),size:3}],overrideFiles:[]};
 try{
  await fs.writeFile(path.join(instance,'mods/a.jar'),'old');await fs.writeFile(path.join(instance,'mods/b.jar'),'old');await fs.writeFile(path.join(stage,'mods/a.jar'),'new');
  await assert.rejects(()=>applyPreparedPack(manifest,instance,stage,()=>{}));
  assert.equal(await fs.readFile(path.join(instance,'mods/a.jar'),'utf8'),'old');assert.equal(await fs.readFile(path.join(instance,'mods/b.jar'),'utf8'),'old');
 }finally{assert.ok(path.resolve(base).startsWith(path.resolve(__dirname,'../.test-data')+path.sep));await fs.rm(base,{recursive:true,force:true});}
});

test('mod update preserves edited settings and archives removed mods',async()=>{
 const {applyPreparedPack}=require('../dist-electron/services/publishedPackService');
 const base=path.join(__dirname,'../.test-data/unit/transaction-success');const instance=path.join(base,'instance'),stage=path.join(base,'stage');
 await fs.mkdir(path.join(instance,'mods'),{recursive:true});await fs.mkdir(path.join(instance,'config'),{recursive:true});await fs.mkdir(path.join(stage,'mods'),{recursive:true});
 const digest=s=>crypto.createHash('sha256').update(s).digest('hex');
 const manifest={revision:'pack-success',files:[{path:'mods/a.jar',sha256:digest('new'),size:3}],overrideFiles:[{path:'config/game.json',sha256:digest('updated'),size:7}]};
 try{
  await fs.writeFile(path.join(instance,'mods/a.jar'),'old');await fs.writeFile(path.join(instance,'mods/removed.jar'),'retired');await fs.writeFile(path.join(stage,'mods/a.jar'),'new');
  await fs.writeFile(path.join(instance,'config/game.json'),'personal');await fs.writeFile(path.join(instance,'.licaris-managed.json'),JSON.stringify({files:[{path:'config/game.json',sha256:digest('original'),size:8}]}));
  await applyPreparedPack(manifest,instance,stage,()=>{});
  assert.equal(await fs.readFile(path.join(instance,'mods/a.jar'),'utf8'),'new');assert.equal(await fs.readFile(path.join(instance,'config/game.json'),'utf8'),'personal');
  await assert.rejects(fs.stat(path.join(instance,'mods/removed.jar')));
  const backups=await fs.readdir(path.join(__dirname,'../.test-data/unit/backups'));const latest=backups.filter(n=>n.startsWith('pack-success-')).sort().at(-1);
  assert.equal(await fs.readFile(path.join(__dirname,'../.test-data/unit/backups',latest,'mods/removed.jar'),'utf8'),'retired');
 }finally{assert.ok(path.resolve(base).startsWith(path.resolve(__dirname,'../.test-data')+path.sep));await fs.rm(base,{recursive:true,force:true});}
});
