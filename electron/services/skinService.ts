import {dialog,nativeImage} from 'electron';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,rename,stat,rm} from 'node:fs/promises';
import path from 'node:path';
import {getSkinsDir} from './installPaths';
import {getAuthenticatedSession} from './authService';
type Skin={id:string;name:string;model:'classic'|'slim'};
const stateFile=()=>path.join(getSkinsDir(),'library.json');
const profileUrl='https://api.minecraftservices.com/minecraft/profile';
const skinCache=new Map<string,{time:number;skin:any}>();
const inflight=new Map<string,Promise<any>>();
export function validateSkinPng(bytes:Buffer):void{
 if(bytes.length>1024*1024||bytes.length<24||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||bytes.readUInt32BE(16)!==64||![32,64].includes(bytes.readUInt32BE(20)))throw new Error('Choisissez un skin PNG de 64 × 64 ou 64 × 32 pixels.');
 const img=nativeImage.createFromBuffer(bytes);if(img.isEmpty()||img.getSize().width!==64||img.getSize().height!==bytes.readUInt32BE(20))throw new Error('Image PNG illisible.');
}
function model(value:any):'classic'|'slim'{if(!['classic','slim'].includes(value))throw new Error('Modèle de skin invalide.');return value;}
function skinFile(id:string){if(!/^[a-f0-9]{64}$/.test(id))throw new Error('Skin invalide.');return path.join(getSkinsDir(),id+'.png');}
async function library():Promise<Skin[]>{
 const v=await readFile(stateFile(),'utf8').then(JSON.parse).catch((e:any)=>{if(e.code==='ENOENT')return [];throw e;});
 if(!Array.isArray(v)||v.some(s=>!s||!(/^[a-f0-9]{64}$/).test(s.id)||typeof s.name!=='string'||!['classic','slim'].includes(s.model)))throw new Error('Bibliothèque de skins invalide.');return v;
}
async function save(items:Skin[]){await mkdir(getSkinsDir(),{recursive:true});await writeFile(stateFile()+'.tmp',JSON.stringify(items));await rename(stateFile()+'.tmp',stateFile());}
async function hydrate(s:Skin){const bytes=await readFile(skinFile(s.id));validateSkinPng(bytes);return {...s,url:'data:image/png;base64,'+bytes.toString('base64')};}
async function limitedBytes(r:Response,limit:number){if(!r.ok||!r.body)throw new Error(`Image Minecraft indisponible (HTTP ${r.status}).`);let size=0;const chunks=[];for await(const c of r.body as any){size+=c.length;if(size>limit)throw new Error('Image trop volumineuse.');chunks.push(Buffer.from(c));}return Buffer.concat(chunks);}
export async function accountSkin(refresh=false):Promise<any>{
 const session=await getAuthenticatedSession();if(!session)return null;
 const id=session.minecraft.profile.id,hit=skinCache.get(id);if(!refresh&&hit&&Date.now()-hit.time<120000)return hit.skin;
 if(inflight.has(id))return inflight.get(id);
 const pending=(async()=>{
  const response=await fetch(profileUrl,{headers:{Authorization:`Bearer ${session.minecraft.accessToken}`},signal:AbortSignal.timeout(15000),redirect:'error'});
  if(!response.ok)throw new Error(`Profil Minecraft indisponible (HTTP ${response.status}).`);
  const profile:any=await response.json();const active=profile.skins?.find((s:any)=>s.state==='ACTIVE')||profile.skins?.[0];if(!active?.url)return null;
  const url=new URL(active.url);if(url.hostname!=='textures.minecraft.net'||!/^\/texture\/[a-f0-9]+$/i.test(url.pathname)||url.username||url.password)throw new Error('Texture Minecraft refusée.');
  url.protocol='https:';const bytes=await limitedBytes(await fetch(url,{signal:AbortSignal.timeout(15000),redirect:'error'}),1024*1024);validateSkinPng(bytes);
  const result={id,name:profile.name,model:active.variant?.toLowerCase()==='slim'?'slim':'classic',url:'data:image/png;base64,'+bytes.toString('base64')};skinCache.set(id,{time:Date.now(),skin:result});return result;
 })();inflight.set(id,pending);try{return await pending;}finally{inflight.delete(id);}
}
export async function listSkins(){
 const saved=[];for(const s of await library()){try{saved.push(await hydrate(s));}catch{}}
 let current=null,warning='';try{current=await accountSkin();}catch(e:any){warning=e.message;}
 return {saved,current,warning};
}
export async function importSkin(input:any){
 const selectedModel=model(input?.model);const selected=await dialog.showOpenDialog({title:'Importer un skin Minecraft',properties:['openFile'],filters:[{name:'Skin PNG',extensions:['png']}]});
 if(selected.canceled||!selected.filePaths.length)return {ok:true,canceled:true};
 if((await stat(selected.filePaths[0])).size>1024*1024)throw new Error('Le skin dépasse 1 Mo.');
 const bytes=await readFile(selected.filePaths[0]);validateSkinPng(bytes);
 const id=createHash('sha256').update(bytes).digest('hex'),items=await library();
 if(!items.some(s=>s.id===id)){await mkdir(getSkinsDir(),{recursive:true});await writeFile(skinFile(id),bytes);items.unshift({id,name:path.basename(selected.filePaths[0],'.png').slice(0,80),model:selectedModel});await save(items);}
 return {ok:true,message:'Skin ajouté à votre bibliothèque.',id,...await listSkins()};
}
export async function applySkin(input:any){
 const selectedModel=model(input?.model),item=(await library()).find(s=>s.id===input?.id);if(!item)throw new Error('Skin introuvable.');
 const session=await getAuthenticatedSession();if(!session)throw new Error('Connectez votre compte Microsoft pour appliquer ce skin.');
 const bytes=await readFile(skinFile(item.id));validateSkinPng(bytes);
 const form=new FormData();form.append('variant',selectedModel);form.append('file',new Blob([new Uint8Array(bytes)],{type:'image/png'}),'skin.png');
 const response=await fetch(profileUrl+'/skins',{method:'POST',headers:{Authorization:`Bearer ${session.minecraft.accessToken}`},body:form,signal:AbortSignal.timeout(30000),redirect:'error'});
 if(!response.ok)throw new Error(`Minecraft a refusé le changement de skin (HTTP ${response.status}).`);
 skinCache.delete(session.minecraft.profile.id);const items=await library();items.find(s=>s.id===item.id)!.model=selectedModel;await save(items);
 return {ok:true,message:'Skin appliqué à votre compte Minecraft.',...await listSkins()};
}
export async function deleteSkin(id:unknown){const items=await library(),item=items.find(s=>s.id===id);if(!item)throw new Error('Skin introuvable.');await save(items.filter(s=>s.id!==id));await rm(skinFile(item.id),{force:true});return {ok:true,message:'Skin retiré de la bibliothèque locale.',...await listSkins()};}
