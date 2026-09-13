import {createHash} from 'node:crypto';
import {createReadStream,createWriteStream} from 'node:fs';
import {mkdir,readdir,readFile,writeFile,lstat,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {pipeline} from 'node:stream/promises';
import yazl from 'yazl';
import {apiBase,repository,request,jsonRequest,upload,putPointer} from './github.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=path.join(root,'Modpack à publier');
const output=path.join(root,'.publication');
const dirs=['mods','resourcepacks','shaderpacks','config','datapacks','emotes','polymer'];
export async function hashFile(file){const h=createHash('sha256');for await(const b of createReadStream(file))h.update(b);return h.digest('hex');}
async function scan(folder,prefix=''){
 const result=[];
 for(const entry of (await readdir(folder,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
  const relative=prefix?`${prefix}/${entry.name}`:entry.name;
  if(entry.name.startsWith('.')||/\.(log|bak|tmp|part)$/i.test(entry.name))continue;
  if(/[\\:\x00]/.test(entry.name)||/[. ]$/.test(entry.name))throw new Error(`Nom de fichier invalide : ${relative}`);
  const file=path.join(folder,entry.name);const info=await lstat(file);
  if(info.isSymbolicLink())throw new Error(`Lien symbolique refusé : ${relative}`);
  if(info.isDirectory())result.push(...await scan(file,relative));
  else if(info.isFile())result.push({path:relative,size:info.size,sha256:await hashFile(file),local:file});
 }
 return result;
}
async function bundle(files,destination){
 const zip=new yazl.ZipFile();
 const done=pipeline(zip.outputStream,createWriteStream(destination));
 for(const f of files)zip.addFile(f.local,`overrides/${f.path}`,{mtime:new Date('2000-01-01T00:00:00Z'),mode:0o100644,compress:true,forceDosTimestamp:true});
 zip.end();await done;
}
async function finalize(release,manifestFile){
 const manifest=JSON.parse(await readFile(manifestFile,'utf8'));
 if(manifest.revision!==release.tag_name)throw new Error('La publication à reprendre ne correspond pas au manifest local.');
 const url=`https://github.com/${repository}/releases/download/${manifest.revision}/manifest.json`;
 const expected=await hashFile(manifestFile);let verified=false,lastStatus=0;
 for(let attempt=0;attempt<8;attempt++){
  const response=await fetch(url+`?verify=${Date.now()}`,{signal:AbortSignal.timeout(120000)});
  lastStatus=response.status;
  if(response.ok){const hash=createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');if(hash!==expected)throw new Error('Vérification du manifeste distant échouée.');verified=true;break;}
  console.log(`GitHub prépare les liens de téléchargement (HTTP ${response.status})…`);
  await new Promise(resolve=>setTimeout(resolve,2500));
 }
 if(!verified)throw new Error(`Manifest temporairement inaccessible (HTTP ${lastStatus}). Canal stable inchangé. Relancez avec --resume.`);
 await putPointer('stable.json',{schemaVersion:1,revision:manifest.revision,manifestUrl:url,sha256:expected},`Publier le modpack ${manifest.revision}`);
 await writeFile(path.join(output,'last-manifest.json'),JSON.stringify(manifest));
 await writeFile(path.join(output,'result.json'),JSON.stringify({ok:true,revision:manifest.revision,release:`https://github.com/${repository}/releases/tag/${manifest.revision}`,files:manifest.files.length+manifest.overrideFiles.length},null,2));
 console.log(`Publication terminée : https://github.com/${repository}/releases/tag/${manifest.revision}`);console.log('Les joueurs recevront la mise à jour avant leur prochaine partie.');
}
async function main(){
 await mkdir(output,{recursive:true});
 // Atomic lock prevents simultaneous publishers from moving the stable pointer over one another.
 const lock=await import('node:fs/promises').then(fs=>fs.open(path.join(output,'publishing.lock'),'wx')).catch(()=>{throw new Error('Une publication est déjà en cours.');});
 try{
 console.log(`Publication Licaris → ${repository}`);
 if(process.argv.includes('--resume')){const active=JSON.parse(await readFile(path.join(output,'active-release.json'),'utf8'));await finalize(await request(`${apiBase}/releases/${active.id}`),path.join(output,'manifest.json'));return;}
 const all=[];for(const dir of dirs){const folder=path.join(source,dir);if(await stat(folder).catch(()=>null))all.push(...await scan(folder,dir));}
 if(all.filter(f=>f.path.startsWith('mods/')&&f.path.endsWith('.jar')).length<1)throw new Error('Le dossier mods est vide. Publication refusée.');
 const base=JSON.parse(await readFile(path.join(root,'pack/pack-lock.json'),'utf8'));
 const baseline=new Map(base.files.map(f=>[f.sha256,f]));
 let previous=null;
 try{previous=JSON.parse(await readFile(path.join(output,'last-manifest.json'),'utf8'));}catch{}
 if(previous){for(const f of [...previous.files,previous.archive]){if(f.url.includes('/releases/download/untagged-'))f.url=f.url.replace(/\/releases\/download\/untagged-[^/]+\//,`/releases/download/${previous.revision}/`);}}
 const known=new Map([...(previous?.files||[]),...base.files].map(f=>[f.sha256,f]));
 const contentId=createHash('sha256').update(JSON.stringify(all.map(({path,size,sha256})=>({path,size,sha256})))).digest('hex');
 if(previous?.contentId===contentId && !process.argv.includes('--force')){console.log('Aucune modification depuis la dernière publication.');return;}
 const stamp=new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d+Z$/,'Z');
 const revision=`pack-${stamp}`;
 const separate=all.filter(f=>f.path.startsWith('mods/') || (['resourcepacks','shaderpacks'].includes(f.path.split('/')[0]) && /\.zip$/i.test(f.path))); 
 const separatePaths=new Set(separate.map(f=>f.path));
 const overrides=all.filter(f=>!separatePaths.has(f.path));
 console.log(`${separate.length} fichiers de mods/packs ; ${overrides.length} fichiers de configuration et données.`);
 const archiveFile=path.join(output,'overrides.zip');
 const overrideMetadata=overrides.map(({path,size,sha256})=>({path,size,sha256}));
 const sameOverrides=previous && JSON.stringify(previous.overrideFiles)===JSON.stringify(overrideMetadata);
 if(!sameOverrides)await bundle(overrides,archiveFile);
 const archiveHash=sameOverrides?previous.archive.sha256:await hashFile(archiveFile);const archiveSize=sameOverrides?previous.archive.size:(await stat(archiveFile)).size;
 const uploads=separate.filter(f=>!known.has(f.sha256));
 console.log(`${uploads.length} fichiers nouveaux à héberger sur GitHub.`);
 const manifest={...base,schemaVersion:1,revision,contentId,publishedAt:new Date().toISOString(),files:[],overrideFiles:overrideMetadata,archive:{size:archiveSize,sha256:archiveHash,url:''}};
 if(process.argv.includes('--dry-run')){await writeFile(path.join(output,'preview.json'),JSON.stringify({revision,contentId,files:all.length,newUploads:uploads.length,archiveSize},null,2));console.log('Préparation vérifiée, aucune publication distante.');return;}
 const release=await jsonRequest(`${apiBase}/releases`,'POST',{tag_name:revision,name:`Licaris · Modpack ${revision.slice(5)}`,body:`Cobblemon Academy 2.0 ${base.version}. Distribution privée Licaris. Cette release contient les fichiers du modpack ; installez le launcher depuis la dernière release du launcher.`,draft:true,make_latest:'false'});
 await writeFile(path.join(output,'active-release.json'),JSON.stringify({id:release.id,tag:revision},null,2));
 for(const f of separate){
  let url=known.get(f.sha256)?.url;
  if(!url){console.log(`Envoi : ${f.path}`);const asset=await upload(release,`${f.sha256.slice(0,16)}-${path.basename(f.path)}`,f.local);url=`https://github.com/${repository}/releases/download/${revision}/${encodeURIComponent(asset.name)}`;}
  manifest.files.push({path:f.path,size:f.size,sha256:f.sha256,url});
 }
 if(previous?.archive.sha256===archiveHash)manifest.archive.url=previous.archive.url;
 else {console.log('Envoi des configurations et datapacks…');await upload(release,'overrides.zip',archiveFile);manifest.archive.url=`https://github.com/${repository}/releases/download/${revision}/overrides.zip`;}
 const manifestFile=path.join(output,'manifest.json');await writeFile(manifestFile,JSON.stringify(manifest));
 const asset=await upload(release,'manifest.json',manifestFile);
 await jsonRequest(`${apiBase}/releases/${release.id}`,'PATCH',{draft:false,make_latest:'false'});
 await finalize({...release,tag_name:revision},manifestFile);
 }finally{await lock.close();await import('node:fs/promises').then(fs=>fs.unlink(path.join(output,'publishing.lock')));}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
