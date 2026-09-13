import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,rm,lstat,readdir} from 'node:fs/promises';
import path from 'node:path';
import {download,extractOverrides,hashFile,safePath,type PackFile,type Progress,readPackLock} from './packService';
import {getLauncherDataDir,getMinecraftInstanceDir} from './installPaths';
import {writeLauncherLog} from './logService';
export const stableUrl='https://raw.githubusercontent.com/fraiyee14minecraft-dot/licaris/main/distribution/stable.json';
const releasePrefix='https://github.com/fraiyee14minecraft-dot/licaris/releases/download/';
type Entry={path:string;size:number;sha256:string};
export interface PublishedPack {schemaVersion:1;id:string;version:string;minecraftVersion:string;fabricLoaderVersion:string;revision:string;files:PackFile[];overrideFiles:Entry[];archive:Omit<PackFile,'path'>}
export function validatePublishedPack(value:any):PublishedPack {
 if(value?.schemaVersion!==1||!/^pack-[a-zA-Z0-9-]+$/.test(value.revision)||!Array.isArray(value.files)||!Array.isArray(value.overrideFiles)||value.files.length+value.overrideFiles.length>60000)throw new Error('Manifest Licaris invalide.');
 const seen=new Set<string>();
 for(const [entries,roots] of [[value.files,['mods','resourcepacks','shaderpacks']],[value.overrideFiles,['config','datapacks','emotes','polymer','resourcepacks','shaderpacks']]] as const){
  for(const f of entries){
   safePath('C:/validation',f.path);const key=f.path.toLowerCase();
   if(!(roots as readonly string[]).includes(f.path.split('/')[0])||seen.has(key)||!Number.isSafeInteger(f.size)||f.size<0||f.size>512*1024**2||!/^[a-f0-9]{64}$/.test(f.sha256))throw new Error('Entrée de manifest invalide ou en doublon.');
   seen.add(key);
   if(f.url){const u=new URL(f.url);if(u.protocol!=='https:'||u.username||u.password||!(u.hostname.endsWith('.forgecdn.net')||f.url.startsWith(releasePrefix)))throw new Error('Source de mise à jour refusée.');}
  }
 }
 if(!value.archive?.url?.startsWith(releasePrefix)||!/^[a-f0-9]{64}$/.test(value.archive.sha256)||!Number.isSafeInteger(value.archive.size)||value.archive.size<1||value.archive.size>512*1024**2)throw new Error('Archive de mise à jour invalide.');
 return value;
}
async function boundedFetch(url:string,limit:number):Promise<Buffer>{
 const r=await fetch(url,{signal:AbortSignal.timeout(120000),headers:{'Cache-Control':'no-cache'}});
 if(!r.ok||!r.body)throw new Error(`Mise à jour Licaris inaccessible (HTTP ${r.status}).`);
 const chunks:Buffer[]=[];let count=0;
 for await(const chunk of r.body as any){count+=chunk.length;if(count>limit){await r.body.cancel().catch(()=>{});throw new Error('Manifest trop volumineux.');}chunks.push(Buffer.from(chunk));}
 return Buffer.concat(chunks);
}
export async function fetchPublishedPack():Promise<PublishedPack>{
 const pointer=JSON.parse((await boundedFetch(stableUrl,16*1024)).toString('utf8'));
 if(pointer.schemaVersion!==1||!pointer.manifestUrl?.startsWith(releasePrefix)||!/^[a-f0-9]{64}$/.test(pointer.sha256))throw new Error('Canal de publication invalide.');
 const bytes=await boundedFetch(pointer.manifestUrl,32*1024**2);
 if(createHash('sha256').update(bytes).digest('hex')!==pointer.sha256)throw new Error('Le manifest distant ne correspond pas à son empreinte.');
 const manifest=validatePublishedPack(JSON.parse(bytes.toString('utf8')));
 const base=await readPackLock();
 if(manifest.id!==base.id||manifest.version!==base.version||manifest.minecraftVersion!==base.minecraftVersion||manifest.fabricLoaderVersion!==base.fabricLoaderVersion)throw new Error('Cette version du pack exige une mise à jour du launcher.');
 if(manifest.revision!==pointer.revision)throw new Error('Révision distante incohérente.');
 return manifest;
}
async function exists(file:string){try{return await lstat(file);}catch(e:any){if(e.code==='ENOENT')return null;throw e;}}
async function refuseLinks(root:string,target:string,checked=new Set<string>()){
 let current=target;let targetInfo:Awaited<ReturnType<typeof exists>>=null;
 while(current.length>=root.length){
  if(current!==target&&checked.has(current))break;
  const info=await exists(current);if(current===target)targetInfo=info;
  if(info?.isSymbolicLink())throw new Error('Lien symbolique refusé dans les fichiers du jeu.');
  if(info?.isDirectory())checked.add(current);
  if(current===root)break;current=path.dirname(current);
 }
 return targetInfo;
}
type Observation={exists:boolean;sha:string|null};
interface Operation {relative:string;hadOriginal:boolean;staged?:string}
interface Journal {backup:string;operations:Operation[]}
export async function recoverTransaction(instance:string,journalFile:string):Promise<void>{
 const saved=await readFile(journalFile,'utf8').catch((e:any)=>{if(e.code==='ENOENT')return null;throw e;});if(!saved)return;
 const j=JSON.parse(saved) as Journal;
 const allowed=path.join(getLauncherDataDir(),'backups')+path.sep;
 if(!path.resolve(j.backup).startsWith(allowed))throw new Error('Journal de restauration invalide.');
 for(const op of [...j.operations].reverse()){
  const target=safePath(instance,op.relative),backup=safePath(j.backup,op.relative);await refuseLinks(instance,target);await refuseLinks(j.backup,backup);
  if(await exists(backup)){await rm(target,{force:true});await mkdir(path.dirname(target),{recursive:true});await rename(backup,target);}
  else if(!op.hadOriginal)await rm(target,{force:true});
 }
 await rm(journalFile,{force:true});
}
export async function applyPreparedPack(manifest:PublishedPack,instance:string,stage:string,progress:Progress,observed=new Map<string,Observation>()):Promise<void>{
 const journalFile=path.join(getLauncherDataDir(),'update-transaction.json');
 await recoverTransaction(instance,journalFile);
 const stateFile=path.join(instance,'.licaris-managed.json');
 const previous=JSON.parse(await readFile(stateFile,'utf8').catch((e:any)=>{if(e.code==='ENOENT')return 'null';throw e;})) as {files:Entry[]}|null;
 const previousMap=new Map((previous?.files||[]).map(f=>[f.path,f]));
 const entries=[...manifest.files,...manifest.overrideFiles];const wanted=new Set(entries.map(f=>f.path));
 const ops:Operation[]=[];let preserved=0;const checked=new Set<string>();
 for(const f of entries){
  const target=safePath(instance,f.path);
  let observation=observed.get(f.path);
  if(!observation){const info=await refuseLinks(instance,target,checked);if(info&&!info.isFile())throw new Error(`Un dossier occupe le chemin ${f.path}.`);observation={exists:!!info,sha:info?await hashFile(target,info.size):null};}
  const info=observation.exists;const actual=observation.sha;
  if(actual===f.sha256)continue;
  const prior=previousMap.get(f.path);
  if(f.path.startsWith('config/')&&info&&prior&&actual!==prior.sha256){preserved++;continue;}
  ops.push({relative:f.path,hadOriginal:!!info,staged:safePath(stage,f.path)});
 }
 // Mods are authoritative. Extra jars are moved to a dated backup, never discarded.
 const mods=await readdir(path.join(instance,'mods')).catch((e:any)=>{if(e.code==='ENOENT')return [];throw e;});
 const retire=new Set([...mods.filter(n=>n.endsWith('.jar')).map(n=>`mods/${n}`),...previousMap.keys()]);
 for(const relative of retire){
  if(wanted.has(relative))continue;const target=safePath(instance,relative);await refuseLinks(instance,target);const info=await exists(target);if(!info?.isFile())continue;
  const prior=previousMap.get(relative);if(relative.startsWith('config/')&&prior&&await hashFile(target)!==prior.sha256){preserved++;continue;}
  ops.push({relative,hadOriginal:true});
 }
 const backup=path.join(getLauncherDataDir(),'backups',`${manifest.revision}-${Date.now()}`);
 const stagedState=path.join(stage,'.licaris-managed.json');
 await writeFile(stagedState,JSON.stringify({revision:manifest.revision,files:entries.map(({path,size,sha256})=>({path,size,sha256}))}));
 ops.push({relative:'.licaris-managed.json',hadOriginal:!!await exists(stateFile),staged:stagedState});
 const journal:Journal={backup,operations:ops};
 await writeFile(journalFile,JSON.stringify(journal));
 try{
  for(let i=0;i<ops.length;i++){
   const op=ops[i],target=safePath(instance,op.relative);
   if(op.hadOriginal){const destination=safePath(backup,op.relative);await mkdir(path.dirname(destination),{recursive:true});await rename(target,destination);}
   if(op.staged){await mkdir(path.dirname(target),{recursive:true});await rename(op.staged,target);}
   if(i%200===0)progress(`Application de la mise à jour : ${i+1}/${ops.length}`,90+9*(i+1)/ops.length);
  }
  await rm(journalFile,{force:true});
 }catch(error){await recoverTransaction(instance,journalFile);throw error;}
 await writeLauncherLog(`[update] ${manifest.revision}: ${ops.length} changements, ${preserved} configurations personnelles conservées.`);
}
export async function installPublishedPack(progress:Progress):Promise<void>{
 progress('Recherche des mises à jour Licaris…',1);
 const instance=getMinecraftInstanceDir();await mkdir(instance,{recursive:true});
 await recoverTransaction(instance,path.join(getLauncherDataDir(),'update-transaction.json'));
 const manifest=await fetchPublishedPack();const observed=new Map<string,Observation>();const checked=new Set<string>();
 const stage=path.join(getLauncherDataDir(),'staging',manifest.revision);await mkdir(stage,{recursive:true});
 let next=0,complete=0,failure:unknown;
 await Promise.all(Array.from({length:4},async()=>{
  while(next<manifest.files.length&&!failure){const f=manifest.files[next++];try{
   const target=safePath(instance,f.path);const info=await refuseLinks(instance,target,checked);const sha=info?await hashFile(target,info.size):null;observed.set(f.path,{exists:!!info,sha});
   if(sha!==f.sha256)await download(f,safePath(stage,f.path));
   complete++;progress(`Vérification des mods : ${complete}/${manifest.files.length}`,3+40*complete/manifest.files.length);
  }catch(e){failure=new Error(`${f.path} : ${e instanceof Error?e.message:String(e)}`);}}
 }));if(failure)throw failure;
 const archive=path.join(getLauncherDataDir(),'cache',`${manifest.archive.sha256}.zip`);
 const changedOverrides=[];
 for(const f of manifest.overrideFiles){const target=safePath(instance,f.path);const info=await refuseLinks(instance,target,checked);const sha=info?await hashFile(target,info.size):null;observed.set(f.path,{exists:!!info,sha});if(sha!==f.sha256)changedOverrides.push(f);}
 if(changedOverrides.length){
  progress('Téléchargement des configurations et datapacks…',45);await download(manifest.archive,archive);
  await extractOverrides(archive,stage,(n,total)=>progress(`Préparation des ressources : ${n} fichiers`,50+30*n/total),true);
  for(const f of manifest.overrideFiles){const staged=safePath(stage,f.path);if(!await exists(staged)||await hashFile(staged,f.size)!==f.sha256)throw new Error(`Ressource invalide : ${f.path}`);}
 }
 await applyPreparedPack(manifest,instance,stage,progress,observed);
 await writeFile(path.join(instance,'.launcher-pack-installed.json'),JSON.stringify({version:manifest.version,revision:manifest.revision,installedAt:new Date().toISOString()}));
 progress('Modpack Licaris à jour.',100);
}
