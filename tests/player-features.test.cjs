const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const Module=require('node:module');
const root=path.resolve(__dirname,'../.test-data/player-features');
const originalLoad=Module._load;
Module._load=function(name,...args){if(name==='electron')return {app:{getPath:()=>root},nativeImage:{createFromBuffer:()=>({isEmpty:()=>false,getSize:()=>({width:64})})}};return originalLoad.call(this,name,...args);};
const digest=s=>crypto.createHash('sha256').update(s).digest('hex');
const cache=require('../dist-electron/services/verificationCache');
const pack=require('../dist-electron/services/packService');
const published=require('../dist-electron/services/publishedPackService');
const content=require('../dist-electron/services/clientContentService');
const shaders=require('../dist-electron/services/shaderService');
const prefs=require('../dist-electron/services/preferences');
const paths=require('../dist-electron/services/installPaths');
const definition=require('../dist-electron/config').packDefinition;
const catalog=require('../pack/client-options.json');
const zip=async(file,entries)=>{const z=new(require('yazl').ZipFile)();for(const [n,v]of Object.entries(entries))z.addBuffer(Buffer.from(v),n);z.end();const chunks=[];for await(const c of z.outputStream)chunks.push(c);await fs.writeFile(file,Buffer.concat(chunks));};
test('verification cache invalidates a same-size edit even if mtime is restored',async()=>{
 await fs.mkdir(root,{recursive:true});const file=path.join(root,'hash.txt');await fs.writeFile(file,'abc');
 await cache.withVerificationSession(false,async()=>assert.equal(await cache.verifiedHash(file),digest('abc')));
 const before=await fs.stat(file);await new Promise(r=>setTimeout(r,30));await fs.writeFile(file,'abd');await fs.utimes(file,before.atime,before.mtime);
 await cache.withVerificationSession(false,async()=>assert.equal(await cache.verifiedHash(file),digest('abd')));
});
test('full repair bypasses cached hashes',async()=>{
 const file=path.join(root,'repair.txt');await fs.writeFile(file,'repair');await cache.withVerificationSession(false,()=>cache.verifiedHash(file));
 const store=path.join(root,'cache/verified-files-v1.json');const saved=JSON.parse(await fs.readFile(store));saved.entries['sha256:'+file].digest='0'.repeat(64);await fs.writeFile(store,JSON.stringify(saved));
 await cache.withVerificationSession(true,async()=>assert.equal(await cache.verifiedHash(file),digest('repair')));
});
test('selective extraction writes only the requested resources',async()=>{
 const archive=path.join(root,'selected.zip'),stage=path.join(root,'selected-stage');
 await zip(archive,{'overrides/config/new.json':'new','overrides/config/other.json':'untouched','overrides/datapacks/data.txt':'data'});
 await pack.extractOverrides(archive,stage,()=>{},true,new Set(['config/new.json']));
 assert.equal(await fs.readFile(path.join(stage,'config/new.json'),'utf8'),'new');await assert.rejects(fs.access(path.join(stage,'config/other.json')));await assert.rejects(fs.access(path.join(stage,'datapacks/data.txt')));
});
test('personal config edits do not download or re-extract the archive on successive launches',async()=>{
 const instance=paths.getMinecraftInstanceDir();await fs.mkdir(path.join(instance,'config'),{recursive:true});
 await fs.writeFile(path.join(instance,'config/custom.json'),'my settings');
 await fs.writeFile(path.join(instance,'.licaris-managed.json'),JSON.stringify({revision:'pack-old',files:[{path:'config/custom.json',size:8,sha256:digest('original')}]}));
 const archiveUrl='https://github.com/fraiyee14minecraft-dot/licaris/releases/download/pack-fixture/overrides.zip';
 const manifest={schemaVersion:1,id:definition.id,version:definition.version,minecraftVersion:definition.minecraftVersion,fabricLoaderVersion:definition.fabricLoaderVersion,revision:'pack-personal',files:[],overrideFiles:[{path:'config/custom.json',size:7,sha256:digest('updated')}],archive:{url:archiveUrl,size:10,sha256:'a'.repeat(64)}};
 const bytes=Buffer.from(JSON.stringify(manifest));const url='https://github.com/fraiyee14minecraft-dot/licaris/releases/download/pack-personal/manifest.json';const pointer={schemaVersion:1,revision:manifest.revision,manifestUrl:url,sha256:digest(bytes)};
 await fs.rm(path.join(root,'cache',`manifest-${digest(bytes)}.json`),{force:true});
 const original=global.fetch;let downloads=0,manifestRequests=0;
 global.fetch=async u=>{if(String(u)===published.stableUrl)return new Response(JSON.stringify(pointer));if(String(u)===url){manifestRequests++;return new Response(bytes);}downloads++;throw Error('Unexpected resource download');};
 try{await cache.withVerificationSession(false,()=>published.installPublishedPack(()=>{}));await cache.withVerificationSession(false,()=>published.installPublishedPack(()=>{}));assert.equal(downloads,0);assert.equal(manifestRequests,1);assert.equal(await fs.readFile(path.join(instance,'config/custom.json'),'utf8'),'my settings');}finally{global.fetch=original;}
});
test('only audited optional client mods are removable; changed dependencies lock the catalog',async()=>{
 const rules=await content.clientRules(),manifest={files:catalog.mods};
 assert.equal(content.canDisable(rules.find(r=>r.id==='fallingleaves'),manifest),true);
 for(const id of ['betterf3','autorun','iris'])assert.equal(content.canDisable(rules.find(r=>r.id===id),manifest),true,id);
 for(const id of ['sodium','modmenu','prism','searchables','euphoria_patcher'])assert.equal(content.canDisable(rules.find(r=>r.id===id),manifest),false,id);
 assert.equal(content.canDisable(rules.find(r=>r.id==='fallingleaves'),{files:[...manifest.files,{path:'mods/new-dependent.jar',sha256:'a'.repeat(64)}]}),false);
});
test('optional preferences survive sync while server files and required dependencies remain',async()=>{
 await fs.writeFile(path.join(root,'client-mods.json'),JSON.stringify({version:1,disabled:['fallingleaves','sodium','cobblemon']}));
 const manifest={files:catalog.mods,overrideFiles:[]};const filtered=await content.filterOptionalMods(manifest);
 assert.equal(filtered.files.length,manifest.files.length-1);
 assert.ok(!filtered.files.some(f=>f.path.toLowerCase().includes('fallingleaves')));assert.ok(filtered.files.some(f=>f.path.includes('sodium-fabric')));assert.ok(filtered.files.some(f=>f.path.toLowerCase().includes('abes-hutts-cobblemon')));
 const unchanged=await content.filterOptionalMods(manifest);assert.deepEqual(unchanged,filtered);
});
test('Iris selection preserves other options and handles disabling and Unicode filenames',()=>{
 const input='# Personal\nmaxShadowRenderDistance=8\nenableShaders=true\nshaderPack=old.zip\ncolorSpace=SRGB\n';
 const enabled=shaders.updateIrisProperties(input,'Belle lumière.zip');assert.match(enabled,/maxShadowRenderDistance=8/);assert.match(enabled,/colorSpace=SRGB/);assert.match(enabled,/shaderPack=Belle lumi\\u00e8re.zip/);assert.equal((enabled.match(/enableShaders=/g)||[]).length,1);
 const disabled=shaders.updateIrisProperties(enabled,null);assert.match(disabled,/enableShaders=false/);assert.match(disabled,/shaderPack=\n/);
 for(const bad of ['../evil.zip','C:/file.zip','shader\nother=true','a\\b.zip','CON.zip'])assert.throws(()=>shaders.validateShaderName(bad));
});
test('launcher behavior validates values and does not permit preference injection',()=>{
 const base={ramGb:4,serverHost:'example.net',serverPort:25565,microsoftClientId:''};for(const b of ['keep','minimize','close'])assert.equal(prefs.validatePreferences({...base,launchBehavior:b}).launchBehavior,b);
 assert.throws(()=>prefs.validatePreferences({...base,launchBehavior:'--execute'}));
});
