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
 const body=`Licaris ${pkg.version} adopte une interface Pokémon bleue : trois illustrations au choix, une navigation avec icônes et un accueil centré sur Jouer. Le lien Immersive Studio et son logo se trouvent directement en bas de la barre latérale. Les mentions techniques, le bouton Découvrir le modpack et l’onglet Liens ont été retirés de l’interface.

Les shaders se choisissent dans une galerie de huit aperçus, filtrables par Fluidité, Équilibré ou Cinématique : MakeUp Ultra Fast, Complementary Reimagined, BSL, Solas, Miniature, Photon, Complementary Unbound et Bliss. Le Setup et l’icône Windows reprennent ce nouvel habillage.

La mise à jour s’installe automatiquement à l’ouverture depuis un launcher installé en version 0.5.2 ou ultérieure. Les comptes, skins, mods clients, shaders et réglages existants restent conservés. La version Portable reste à remplacer manuellement. Depuis 0.5.1 ou antérieure, utiliser une dernière fois le bouton de mise à jour ou le nouveau Setup.

Aucun changement du modpack ni du serveur n’est nécessaire. Les nouveaux shaders sont facultatifs et s’installent individuellement.

Validation : 36 tests automatisés, contrôle des six vues Electron et de l’accueil en 900 × 680, chargement des huit aperçus, filtres et téléchargement vérifié des nouveaux shaders. Aucun lancement de Minecraft effectué.`;
 release??=await jsonRequest(`${apiBase}/releases`,'POST',{tag_name:tag,name:`Licaris · Launcher ${pkg.version}`,draft:true,body,make_latest:'false'});
 for(const name of names){console.log(`Envoi : ${name}`);await upload(release,name,path.join(folder,name));}
 await jsonRequest(`${apiBase}/releases/${release.id}`,'PATCH',{draft:false,make_latest:'true'});
 console.log(`Launcher publié : https://github.com/${repository}/releases/tag/${tag}`);
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
