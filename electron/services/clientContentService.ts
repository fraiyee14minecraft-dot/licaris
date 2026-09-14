import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import path from 'node:path';
import {getLauncherDataDir} from './installPaths';
import type {PublishedPack} from './publishedPackService';
import {createHash} from 'node:crypto';
type Rule={id:string;name:string;description:string;path:string;sha256:string;requiredBy:string[]};
const catalogFile=path.join(__dirname,'../../pack/client-options.json');
const preferencesFile=()=>path.join(getLauncherDataDir(),'client-mods.json');
// These components are controlled by the pack's artwork/configuration even when
// other mods do not declare a hard Fabric dependency on them.
const protectedIds=new Set(['bhmenu','desiredservers','euphoria_patcher','polytone','resourcepackoverrides','particle_core']);
let catalog:{entries:Rule[];modsFingerprint:string}|undefined;
export async function clientRules():Promise<Rule[]>{catalog??=JSON.parse(await readFile(catalogFile,'utf8'));return catalog!.entries;}
export function modsFingerprint(manifest:PublishedPack):string{return createHash('sha256').update(manifest.files.filter(f=>f.path.startsWith('mods/')).map(f=>f.path+':'+f.sha256).sort().join('\n')).digest('hex');}
async function disabledIds():Promise<Set<string>>{
 const value=await readFile(preferencesFile(),'utf8').then(JSON.parse).catch((e:any)=>{if(e.code==='ENOENT')return {};throw e;});
 if(value.disabled!==undefined&&(!Array.isArray(value.disabled)||!value.disabled.every((id:unknown)=>typeof id==='string')))throw new Error('Préférences de mods invalides.');
 return new Set(value.disabled||[]);
}
export function canDisable(rule:Rule,manifest:PublishedPack):boolean{
 return catalog?.modsFingerprint===modsFingerprint(manifest)&&!protectedIds.has(rule.id)&&rule.requiredBy.length===0&&manifest.files.some(f=>f.path===rule.path&&f.sha256===rule.sha256);
}
export async function filterOptionalMods(manifest:PublishedPack):Promise<PublishedPack>{
 const [rules,disabled]=await Promise.all([clientRules(),disabledIds()]);
 const omitted=new Set(rules.filter(r=>disabled.has(r.id)&&canDisable(r,manifest)).map(r=>r.path));
 return {...manifest,files:manifest.files.filter(f=>!omitted.has(f.path))};
}
export async function listClientMods(manifest?:PublishedPack){
 manifest??=await (await import('./publishedPackService')).fetchPublishedPack();
 const [rules,disabled]=await Promise.all([clientRules(),disabledIds()]);
 return rules.filter(r=>manifest!.files.some(f=>f.path===r.path)).map(r=>({id:r.id,name:r.name,description:r.description,optional:canDisable(r,manifest!),enabled:!disabled.has(r.id)||!canDisable(r,manifest!),reason:r.requiredBy.length?'Nécessaire à '+r.requiredBy.join(', '):protectedIds.has(r.id)?'Composant du pack':'Version non validée pour la désactivation'}));
}
export async function setClientMod(input:any){
 if(typeof input?.id!=='string'||typeof input?.enabled!=='boolean')throw new Error('Choix de mod invalide.');
 const manifest=await (await import('./publishedPackService')).fetchPublishedPack();
 const rule=(await clientRules()).find(r=>r.id===input.id);
 if(!rule||!canDisable(rule,manifest))throw new Error('Ce mod est requis par le pack ou une dépendance.');
 const disabled=await disabledIds();input.enabled?disabled.delete(rule.id):disabled.add(rule.id);
 await mkdir(getLauncherDataDir(),{recursive:true});await writeFile(preferencesFile()+'.tmp',JSON.stringify({version:1,disabled:[...disabled].sort()}));await rename(preferencesFile()+'.tmp',preferencesFile());
 return {ok:true,message:'Choix enregistré. Il sera appliqué à la prochaine préparation du jeu.',mods:await listClientMods(manifest)};
}
