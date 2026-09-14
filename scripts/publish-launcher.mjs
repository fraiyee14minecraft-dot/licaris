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
 const body=`Licaris ${pkg.version} rétablit le logo Licaris original en haut de la navigation, dans le Setup et sur l’icône Windows. Le logo reste lisible en petite fenêtre.

Les trois ambiances Pokémon, les huit shaders et l’interface bleue sont conservés. Cette correction arrive par la mise à jour automatique du launcher installé ; la version Portable se remplace manuellement. Aucun changement du modpack ou du serveur n’est nécessaire.

Validation : tests automatisés et contrôle visuel de l’interface Electron en fenêtre normale et en 900 × 680. Aucun lancement de Minecraft.`;
 release??=await jsonRequest(`${apiBase}/releases`,'POST',{tag_name:tag,name:`Licaris · Launcher ${pkg.version}`,draft:true,body,make_latest:'false'});
 for(const name of names){console.log(`Envoi : ${name}`);await upload(release,name,path.join(folder,name));}
 await jsonRequest(`${apiBase}/releases/${release.id}`,'PATCH',{draft:false,make_latest:'true'});
 console.log(`Launcher publié : https://github.com/${repository}/releases/tag/${tag}`);
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
