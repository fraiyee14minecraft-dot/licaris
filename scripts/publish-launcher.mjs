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
 const body=`Licaris ${pkg.version} actualise le catalogue des options clientes pour le modpack intégrant FTB Chunks 2101.1.22, FTB Teams 2101.1.11 et FTB Library 2101.1.36.

Ces trois mods restent obligatoires. Les options clientes déjà présentes, les skins, les shaders, l’avatar Minecraft et les préférences du joueur sont conservés.

Les mods sont synchronisés avant la prochaine partie. L’administrateur du serveur doit ajouter FTB Chunks et FTB Teams, puis remplacer l’ancienne version de FTB Library par la 2101.1.36.

Les installations existantes reçoivent la mise à jour via le launcher. Pour une première installation, choisissez le Setup. La version Portable doit être remplacée manuellement pour profiter du catalogue actualisé.

Validation : dépendances contrôlées avec Fabric Loader, empreintes client/serveur identiques, tests automatisés et contrôle de l’interface. Aucun lancement de Minecraft effectué pour cette livraison.`;
 release??=await jsonRequest(`${apiBase}/releases`,'POST',{tag_name:tag,name:`Licaris · Launcher ${pkg.version}`,draft:true,body,make_latest:'false'});
 for(const name of names){console.log(`Envoi : ${name}`);await upload(release,name,path.join(folder,name));}
 await jsonRequest(`${apiBase}/releases/${release.id}`,'PATCH',{draft:false,make_latest:'true'});
 console.log(`Launcher publié : https://github.com/${repository}/releases/tag/${tag}`);
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
