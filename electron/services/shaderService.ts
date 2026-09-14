import {readFile,writeFile,mkdir,rename,readdir,lstat} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {getLauncherDataDir,getMinecraftInstanceDir} from './installPaths';
import {safePath} from './packService';
import {listClientMods} from './clientContentService';
const definitions=[
 {id:'makeup-ultra-fast-shaders',name:'MakeUp · Ultra Fast',group:'light',level:'Fluidité',description:'Des ombres douces, avec la fluidité en priorité.'},
 {id:'complementary-reimagined',name:'Complementary Reimagined',group:'balanced',level:'Équilibré',description:'Toute la beauté des blocs, sous une nouvelle lumière.'},
 {id:'bsl-shaders',name:'BSL Shaders',group:'balanced',level:'Équilibré',description:'Des couleurs douces et une eau lumineuse.'},
 {id:'solas-shader',name:'Solas Shader',group:'cinematic',level:'Cinématique',description:'Des nuits colorées et des ciels spectaculaires.'},
 {id:'miniature-shader',name:'Miniature',group:'light',level:'Fluidité',description:'Une touche de lumière, un rendu tout en simplicité.'},
 {id:'photon-shader',name:'Photon',group:'balanced',level:'Équilibré',description:'Une lumière naturelle et une atmosphère chaleureuse.'},
 {id:'complementary-unbound',name:'Complementary Unbound',group:'cinematic',level:'Cinématique',description:'Des reflets détaillés et des nuages tout en volume.'},
 {id:'bliss-shader',name:'Bliss',group:'cinematic',level:'Cinématique',description:'Des horizons brumeux et des paysages à contempler.'}
].map(d=>({...d,image:`shaders/${d.id}.webp`}));
type ShaderPrefs={selected?:string|null;installed:Record<string,string>};
const prefsFile=()=>path.join(getLauncherDataDir(),'shaders.json');
const shaderDir=()=>path.join(getMinecraftInstanceDir(),'shaderpacks');
async function prefs():Promise<ShaderPrefs>{return readFile(prefsFile(),'utf8').then(JSON.parse).catch((e:any)=>{if(e.code==='ENOENT')return {installed:{}};throw e;});}
async function save(value:ShaderPrefs){await mkdir(getLauncherDataDir(),{recursive:true});await writeFile(prefsFile()+'.tmp',JSON.stringify(value));await rename(prefsFile()+'.tmp',prefsFile());}
async function rejectLinks(target:string){
 const root=path.resolve(getMinecraftInstanceDir());let current=path.resolve(target);
 if(current!==root&&!current.startsWith(root+path.sep))throw new Error('Chemin de shader hors du jeu.');
 while(true){const info=await lstat(current).catch((e:any)=>{if(e.code==='ENOENT')return null;throw e;});if(info?.isSymbolicLink())throw new Error('Lien symbolique de shader refusé.');if(current===root)break;current=path.dirname(current);}
}
export function validateShaderName(value:unknown):string{
 if(typeof value!=='string'||!value||/[\r\n\\/:\0]/.test(value))throw new Error('Nom de shader invalide.');safePath(shaderDir(),value);return value;
}
function propertiesValue(value:string){return value.replace(/[^\x20-\x7e]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));}
export function updateIrisProperties(text:string,selected:string|null):string{
 const replacements:Record<string,string>={enableShaders:selected?'true':'false',shaderPack:selected?propertiesValue(validateShaderName(selected)):''};
 const lines=text.replace(/\r\n/g,'\n').split('\n').filter(line=>!/^\s*(enableShaders|shaderPack)\s*[=:]/.test(line));
 return lines.join('\n').trimEnd()+'\n'+Object.entries(replacements).map(([k,v])=>k+'='+v).join('\n')+'\n';
}
export async function applyShaderPreferences(){
 const saved=await prefs();if(saved.selected===undefined)return;
 if(saved.selected!==null){const name=validateShaderName(saved.selected),target=safePath(shaderDir(),name);await rejectLinks(target);const info=await lstat(target).catch((e:any)=>{if(e.code==='ENOENT')return null;throw e;});if(!info){saved.selected=null;await save(saved);}}
 const file=path.join(getMinecraftInstanceDir(),'config','iris.properties');await rejectLinks(file);await rejectLinks(file+'.tmp');await mkdir(path.dirname(file),{recursive:true});
 const previous=await readFile(file,'utf8').catch((e:any)=>{if(e.code==='ENOENT')return '';throw e;});await writeFile(file+'.tmp',updateIrisProperties(previous,saved.selected));await rename(file+'.tmp',file);
}
export async function listShaders(){
 const saved=await prefs(),files=await readdir(shaderDir(),{withFileTypes:true}).catch((e:any)=>{if(e.code==='ENOENT')return [];throw e;});
 const local:string[]=[];for(const f of files){if(f.isSymbolicLink()||(!f.isDirectory()&&!f.name.toLowerCase().endsWith('.zip')))continue;if(f.isDirectory()&&!await lstat(path.join(shaderDir(),f.name,'shaders')).catch(()=>null))continue;local.push(f.name);}
 const iris=await readFile(path.join(getMinecraftInstanceDir(),'config','iris.properties'),'utf8').catch(()=>'');
 const selected=saved.selected!==undefined?saved.selected:/^enableShaders=false\s*$/m.test(iris)?null:(iris.match(/^shaderPack=(.*)$/m)?.[1]?.trim()||null);
 return {local,selected,catalog:definitions.map(d=>({...d,file:saved.installed?.[d.id],installed:local.includes(saved.installed?.[d.id])}))};
}
export async function selectShader(input:any){
 const selected=input?.file===null?null:validateShaderName(input?.file);
 if(selected){if(!(await listShaders()).local.includes(selected))throw new Error('Ce shader n’est pas installé.');const iris=(await listClientMods()).find(m=>m.id==='iris');if(!iris?.enabled)throw new Error('Activez Iris dans l’onglet Mods clients pour utiliser un shader.');}
 const saved=await prefs();saved.selected=selected;await save(saved);await applyShaderPreferences();return {ok:true,message:selected?'Shader sélectionné pour la prochaine partie.':'Shaders désactivés pour la prochaine partie.',...await listShaders()};
}
export async function installShader(id:unknown){
 const d=definitions.find(x=>x.id===id);if(!d)throw new Error('Shader inconnu.');
 const query=new URLSearchParams({game_versions:JSON.stringify(['1.21.1']),loaders:JSON.stringify(['iris'])});
 const r=await fetch(`https://api.modrinth.com/v2/project/${d.id}/version?${query}`,{headers:{'User-Agent':'Licaris-Launcher/0.6.0'},signal:AbortSignal.timeout(20000)});if(!r.ok)throw new Error(`Catalogue indisponible (HTTP ${r.status}).`);
 const versions:any=await r.json(),v=versions.find((x:any)=>x.version_type==='release'),f=v?.files?.find((x:any)=>x.primary)||v?.files?.[0];
 if(!f||!Number.isSafeInteger(f.size)||f.size<=0||f.size>128*1024*1024||!/^https:\/\/cdn\.modrinth\.com\//.test(f.url)||!/^[a-f0-9]{128}$/.test(f.hashes?.sha512))throw new Error('Version de shader invalide ou indisponible pour Minecraft 1.21.1.');
 const name=validateShaderName(f.filename);if(!name.toLowerCase().endsWith('.zip'))throw new Error('Archive ZIP attendue.');
 const download=await fetch(f.url,{signal:AbortSignal.timeout(120000),redirect:'error'});if(!download.ok||!download.body)throw new Error('Téléchargement du shader impossible.');
 let size=0;const chunks=[];for await(const c of download.body as any){size+=c.length;if(size>f.size)throw new Error('Shader trop volumineux.');chunks.push(Buffer.from(c));}
 const bytes=Buffer.concat(chunks);if(size!==f.size||createHash('sha512').update(bytes).digest('hex')!==f.hashes.sha512||bytes.subarray(0,2).toString()!=='PK')throw new Error('L’archive du shader ne correspond pas à son empreinte.');
 const target=safePath(shaderDir(),name);await rejectLinks(target);await rejectLinks(target+'.part');await mkdir(shaderDir(),{recursive:true});
 await writeFile(target+'.part',bytes);await rename(target+'.part',target);
 const saved=await prefs();saved.installed??={};saved.installed[d.id]=name;await save(saved);
 return {ok:true,message:`${d.name} est installé. Cliquez sur Utiliser pour l’activer.`,...await listShaders()};
}
