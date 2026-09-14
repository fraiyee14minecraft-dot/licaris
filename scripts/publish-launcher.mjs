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
 const body=`Licaris ${pkg.version} ajoute un avatar Minecraft, une bibliothèque de skins avec aperçu 3D, les options de mods clients, la gestion des shaders et les liens utiles dont Immersive Studio.

Les réglages gagnent un bleu plus clair et le choix de garder, réduire ou fermer le launcher au démarrage du jeu. Le bloc de configuration du serveur est retiré. La préparation conserve les configurations personnelles, réutilise les vérifications récentes et extrait seulement les ressources nécessaires.

Les mods nécessaires au serveur et leurs dépendances restent protégés. La modification des fichiers est bloquée pendant une partie. Aucun changement de serveur n’est nécessaire pour cette version du launcher.

Les installations existantes reçoivent la mise à jour via le launcher. Pour une première installation, choisissez le Setup. La version Portable doit être remplacée manuellement.

Validation : tests automatisés, contrôle de l’interface et de l’aperçu 3D, téléchargement et sélection de shader vérifiés. Aucun lancement de Minecraft effectué pour cette livraison.`;
 release??=await jsonRequest(`${apiBase}/releases`,'POST',{tag_name:tag,name:`Licaris · Launcher ${pkg.version}`,draft:true,body,make_latest:'false'});
 for(const name of names){console.log(`Envoi : ${name}`);await upload(release,name,path.join(folder,name));}
 await jsonRequest(`${apiBase}/releases/${release.id}`,'PATCH',{draft:false,make_latest:'true'});
 console.log(`Launcher publié : https://github.com/${repository}/releases/tag/${tag}`);
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
