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
 const body=`Licaris ${pkg.version} installe automatiquement les mises à jour du launcher au démarrage, puis se relance. Le téléchargement affiche sa progression ; aucun bouton d’installation ni assistant Setup n’est nécessaire pour les mises à jour suivantes.

Une partie ou une opération déjà en cours se termine avant l’installation. Une panne réseau ne bloque pas le launcher : la vérification reprend à la prochaine ouverture, avec possibilité de réessayer après une erreur.

Les comptes Microsoft, les skins, les shaders, les réglages et le catalogue du modpack sont conservés. Aucun changement du serveur n’est nécessaire.

Depuis une version 0.5.1 ou antérieure, utiliser une dernière fois le bouton Installer la mise à jour du launcher, ou ouvrir le nouveau Setup. Les versions précédentes ne peuvent pas appliquer rétroactivement cette nouvelle logique. Pour les mises à jour automatiques, utiliser l’installation Setup ; la version Portable reste à remplacer manuellement.

Validation : 36 tests automatisés, dont installation silencieuse, relance, mise en attente, cache, erreurs et délais réseau ; contrôle de l’interface Electron et des exécutables. Aucun lancement de Minecraft effectué pour cette livraison.`;
 release??=await jsonRequest(`${apiBase}/releases`,'POST',{tag_name:tag,name:`Licaris · Launcher ${pkg.version}`,draft:true,body,make_latest:'false'});
 for(const name of names){console.log(`Envoi : ${name}`);await upload(release,name,path.join(folder,name));}
 await jsonRequest(`${apiBase}/releases/${release.id}`,'PATCH',{draft:false,make_latest:'true'});
 console.log(`Launcher publié : https://github.com/${repository}/releases/tag/${tag}`);
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
