import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {repository,apiBase,request,jsonRequest,upload} from './github.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function main(){
 const pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
 const folder=path.join(root,'release',pkg.version);
 const names=(await readdir(folder)).filter(n=>n.endsWith('.exe')||n.endsWith('.blockmap')||n==='latest.yml');
 if(!names.includes('latest.yml')||names.filter(n=>n.endsWith('.exe')).length!==2)throw new Error('Construction incomplète. Exécutez npm run dist.');
 const tag=`v${pkg.version}`;
 let release;try{release=await request(`${apiBase}/releases/tags/${tag}`);}catch{}
 if(release&&!release.draft)throw new Error('Cette version est déjà publiée. Augmentez version dans package.json pour publier une nouvelle version.');
 release??=await jsonRequest(`${apiBase}/releases`,'POST',{tag_name:tag,name:`Licaris · Launcher ${pkg.version}`,draft:true,body:'Licaris Launcher : un univers nocturne, des cristaux bleus et des ornements dorés. Installez le Setup pour recevoir les futures mises à jour du launcher. Le portable fonctionne sans installation ; ses mises à jour se récupèrent manuellement. Le modpack Licaris est vérifié et synchronisé avant chaque partie.',make_latest:'false'});
 for(const name of names){console.log(`Envoi : ${name}`);await upload(release,name,path.join(folder,name));}
 await jsonRequest(`${apiBase}/releases/${release.id}`,'PATCH',{draft:false,make_latest:'true'});
 console.log(`Launcher publié : https://github.com/${repository}/releases/tag/${tag}`);
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
