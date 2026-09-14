const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const Module=require('node:module');
const root=path.resolve(__dirname,'../.test-data/skin-service');
let session=null,selectedFile;
const originalLoad=Module._load;
Module._load=function(name,...args){
 if(name==='electron')return {app:{getPath:()=>root},dialog:{showOpenDialog:async()=>({canceled:false,filePaths:[selectedFile]})},nativeImage:{createFromBuffer:bytes=>({isEmpty:()=>false,getSize:()=>({width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)})})}};
 if(name==='./authService'&&args[0]?.filename.endsWith('skinService.js'))return {getAuthenticatedSession:async()=>session};
 return originalLoad.call(this,name,...args);
};
const skins=require('../dist-electron/services/skinService');
const identity=id=>({minecraft:{accessToken:'test-token-never-rendered',profile:{id,name:id}}});
// Header fixture: native PNG decoding is covered by the Electron visual smoke.
const png=Buffer.alloc(32);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);png.writeUInt32BE(64,16);png.writeUInt32BE(64,20);
test('avatar cache is per account; imports stay local and applying a skin uses the authenticated account',async()=>{
 await fs.mkdir(root,{recursive:true});selectedFile=path.join(root,'fixture.png');await fs.writeFile(selectedFile,png);
 await fs.writeFile(path.join(root,'skins','library.json'),'[]').catch(async e=>{if(e.code!=='ENOENT')throw e;await fs.mkdir(path.join(root,'skins'));await fs.writeFile(path.join(root,'skins','library.json'),'[]');});
 let profileReads=0,uploads=0,textureUrl='https://textures.minecraft.net/texture/abcdef';const realFetch=global.fetch;
 global.fetch=async(url,options={})=>{
  if(String(url).startsWith('https://textures.minecraft.net/')){assert.equal(options.headers?.Authorization,undefined);return new Response(png);}
  assert.equal(options.headers.Authorization,'Bearer test-token-never-rendered');
  if(options.method==='POST'){uploads++;assert.equal(String(url),'https://api.minecraftservices.com/minecraft/profile/skins');assert.equal(options.body.get('variant'),'slim');assert.equal(options.body.get('file').type,'image/png');return new Response('{}');}
  profileReads++;return new Response(JSON.stringify({name:session.minecraft.profile.name,skins:[{state:'ACTIVE',variant:'SLIM',url:textureUrl}]}));
 };
 try{
  assert.equal(await skins.accountSkin(),null);
  session=identity('account-a');const first=await skins.accountSkin();assert.equal(first.id,'account-a');assert.equal(first.model,'slim');assert.ok(!JSON.stringify(first).includes('test-token'));await skins.accountSkin();assert.equal(profileReads,1);
  session=identity('account-b');assert.equal((await skins.accountSkin()).id,'account-b');assert.equal(profileReads,2);
  const imported=await skins.importSkin({model:'classic'});assert.equal(uploads,0);assert.equal(imported.saved.length,1);
  const applied=await skins.applySkin({id:imported.id,model:'slim'});assert.equal(uploads,1);assert.equal(applied.current.id,'account-b');assert.equal(applied.saved[0].model,'slim');assert.equal(profileReads,3);
  await assert.rejects(skins.applySkin({id:imported.id,model:'injected'}));assert.equal(uploads,1);
  const removed=await skins.deleteSkin(imported.id);assert.equal(removed.saved.length,0);assert.equal(uploads,1);
  textureUrl='https://untrusted.example/texture/abcdef';await assert.rejects(skins.accountSkin(true),/refusée/);
  session=null;assert.equal(await skins.accountSkin(),null);
 }finally{global.fetch=realFetch;session=null;}
});
test('skins reject oversized or incorrectly shaped PNGs',()=>{
 const wide=Buffer.from(png);wide.writeUInt32BE(128,16);assert.throws(()=>skins.validateSkinPng(wide));
 assert.throws(()=>skins.validateSkinPng(Buffer.alloc(1024*1024+1)));assert.throws(()=>skins.validateSkinPng(Buffer.from('not a PNG')));
});
