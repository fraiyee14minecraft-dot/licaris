import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat,readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import path from 'node:path';
import {getLauncherDataDir} from './installPaths';
type RecordEntry={size:number;mtime:number;ctime:number;ino:number;digest:string;checked:number};
type Session={force:boolean;entries:Record<string,RecordEntry>;hits:number;hashed:number};
const sessions=new AsyncLocalStorage<Session>();
export async function withVerificationSession<T>(force:boolean,action:()=>Promise<T>):Promise<T>{
 const file=path.join(getLauncherDataDir(),'cache','verified-files-v1.json');
 const saved=await readFile(file,'utf8').then(JSON.parse).catch(()=>null);
 const session:Session={force,entries:Object.assign(Object.create(null),saved?.version===1?saved.entries:{}),hits:0,hashed:0};
 return sessions.run(session,async()=>{
  const value=await action();
  await mkdir(path.dirname(file),{recursive:true});
  await writeFile(file+'.tmp',JSON.stringify({version:1,entries:session.entries}));await rename(file+'.tmp',file);
  const {writeLauncherLog}=await import('./logService');
  await writeLauncherLog(`[verification] ${session.hashed} fichiers relus, ${session.hits} empreintes réutilisées.`);
  return value;
 });
}
export async function verifiedHash(file:string,algorithm:'sha256'|'sha1'='sha256'):Promise<string>{
 const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink())throw new Error('Fichier régulier attendu pour la vérification.');
 const session=sessions.getStore(),key=algorithm+':'+path.resolve(file),old=session?.entries[key];
 // An unchanged file can reuse a recent verified hash. Size alone never suffices;
 // ctime also catches edits followed by restoring the modification timestamp.
 if(session&&!session.force&&old&&old.size===info.size&&old.mtime===info.mtimeMs&&old.ctime===info.ctimeMs&&old.ino===info.ino&&Date.now()-old.checked<24*3600_000){session.hits++;return old.digest;}
 const hash=createHash(algorithm);
 if(info.size<=1024*1024)hash.update(await readFile(file));else for await(const chunk of createReadStream(file))hash.update(chunk);
 const digest=hash.digest('hex');
 const after=await lstat(file);
 if(after.size!==info.size||after.mtimeMs!==info.mtimeMs||after.ctimeMs!==info.ctimeMs)throw new Error('Fichier modifié pendant sa vérification.');
 if(session){session.hashed++;session.entries[key]={size:info.size,mtime:info.mtimeMs,ctime:info.ctimeMs,ino:info.ino,digest,checked:Date.now()};}
 return digest;
}
