# Licaris — Cobblemon Launcher

Launcher Windows pour jouer ensemble à **Cobblemon Academy 2.0**.

## Télécharger

Récupérez le Setup ou la version Portable dans les [releases du launcher](https://github.com/fraiyee14minecraft-dot/licaris/releases/latest).

- **Setup** : installe le launcher et permet de recevoir ses mises à jour.
- **Portable** : fonctionne sans installation ; les nouvelles versions de l’exécutable se téléchargent manuellement.

## Jouer

1. Ouvrir le launcher.
2. Choisir le compte Microsoft qui possède Minecraft Java Edition.
3. Installer le modpack, puis lancer le jeu.

Le launcher prépare Java, Minecraft et Fabric, puis vérifie le modpack avant chaque partie. Les réglages permettent de choisir la mémoire et de changer de compte Microsoft.

## Modpack

Base : **Cobblemon Academy 2.0, version 2.6.0**, Minecraft **1.21.1**, Fabric **0.18.1**, Java **21**.

Les versions du modpack sont publiées séparément des versions du launcher. Les téléchargements sont vérifiés par SHA-256.

## Développement

Après clonage, copier `launcher-config.example.json` vers `launcher-config.json` et renseigner votre configuration dans cette copie locale, exclue de Git.

```sh
npm ci
npm test
npm start
```

Construction Windows : `npm run dist`.

Les accès d’administration, sessions de joueurs et configurations locales ne doivent pas être ajoutés au dépôt.
