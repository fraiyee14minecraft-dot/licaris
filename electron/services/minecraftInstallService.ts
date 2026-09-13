import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import nodeOs from "node:os";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { launcherRuntimeConfig } from "../config";
import type { LauncherSyncProgress, LauncherSyncProgressHandler } from "../types/launcher";
import type { StoredAuthSession } from "./authSessionStore";
import { writeLauncherLog } from "./logService";

export const MINECRAFT_FABRIC_NOT_READY_MESSAGE =
  "Minecraft/Fabric doit \u00eatre pr\u00e9par\u00e9 avant le lancement.";

const VERSION_MANIFEST_URL = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const FABRIC_LOADER_LIST_URL = `https://meta.fabricmc.net/v2/versions/loader/${launcherRuntimeConfig.minecraftVersion}`;

export interface MinecraftRuntimeLayout {
  vanillaVersionJson: string;
  vanillaClientJar: string;
  fabricVersionJson: string;
  fabricVersionId: string;
  checkedLibraries: number;
  assetsRoot: string;
  assetIndexId: string;
  nativesDir: string;
  classpathEntries: string[];
  mainClass: string;
}

export interface MinecraftLaunchPlan {
  mainClass: string;
  args: string[];
  classpathEntries: string[];
}

interface VersionManifest {
  versions?: Array<{
    id?: string;
    url?: string;
  }>;
}

interface MinecraftVersionJson {
  id?: string;
  type?: string;
  inheritsFrom?: string;
  mainClass?: string;
  jar?: string;
  libraries?: MinecraftLibrary[];
  arguments?: {
    game?: MinecraftArgument[];
    jvm?: MinecraftArgument[];
  };
  minecraftArguments?: string;
  assetIndex?: {
    id?: string;
    url?: string;
    sha1?: string;
    size?: number;
  };
  downloads?: {
    client?: DownloadArtifact;
  };
}

type MinecraftArgument =
  | string
  | {
      rules?: MinecraftRule[];
      value?: string | string[];
    };

interface MinecraftRule {
  action?: "allow" | "disallow";
  os?: {
    name?: string;
    arch?: string;
    version?: string;
  };
  features?: Record<string, boolean>;
}

interface MinecraftLibrary {
  name?: string;
  rules?: MinecraftRule[];
  natives?: Record<string, string>;
  extract?: {
    exclude?: string[];
  };
  downloads?: {
    artifact?: DownloadArtifact;
    classifiers?: Record<string, DownloadArtifact>;
  };
  url?: string;
}

interface DownloadArtifact {
  path?: string;
  url?: string;
  sha1?: string;
  size?: number;
}

interface FabricLoaderEntry {
  loader?: {
    version?: string;
    stable?: boolean;
  };
}

interface AssetIndex {
  objects?: Record<
    string,
    {
      hash?: string;
      size?: number;
    }
  >;
}

interface NativeJar {
  path: string;
  exclude: string[];
}

interface PreparedVersion {
  versionJsonPath: string;
  clientJarPath: string;
  version: MinecraftVersionJson;
}

interface PreparedFabric {
  versionId: string;
  versionJsonPath: string;
  version: MinecraftVersionJson;
}

interface PreparedLibraries {
  classpathEntries: string[];
  nativeJars: NativeJar[];
  checkedLibraries: number;
}

interface RuleFeatures {
  is_demo_user: boolean;
  has_custom_resolution: boolean;
  has_quick_plays_support: boolean;
  is_quick_play_singleplayer: boolean;
  is_quick_play_multiplayer: boolean;
  is_quick_play_realms: boolean;
}

const RULE_FEATURES: RuleFeatures = {
  is_demo_user: false,
  has_custom_resolution: false,
  has_quick_plays_support: false,
  is_quick_play_singleplayer: false,
  is_quick_play_multiplayer: false,
  is_quick_play_realms: false
};

export function isMinecraftFabricNotReadyError(error: unknown): boolean {
  return error instanceof Error && error.message === MINECRAFT_FABRIC_NOT_READY_MESSAGE;
}

export async function verifyMinecraftAndFabricReady(instanceDir: string): Promise<MinecraftRuntimeLayout> {
  const failures: string[] = [];

  await writeLauncherLog(`[launch] Vérification Minecraft ${launcherRuntimeConfig.minecraftVersion}.`);
  await writeLauncherLog("[launch] Vérification Fabric.");

  const modsDir = path.join(instanceDir, "mods");
  const configDir = path.join(instanceDir, "config");
  await requireDirectory(modsDir, "dossier mods", failures);
  await requireDirectory(configDir, "dossier config", failures);

  const vanillaVersionJson = path.join(
    instanceDir,
    "versions",
    launcherRuntimeConfig.minecraftVersion,
    `${launcherRuntimeConfig.minecraftVersion}.json`
  );
  const vanillaClientJar = path.join(
    instanceDir,
    "versions",
    launcherRuntimeConfig.minecraftVersion,
    `${launcherRuntimeConfig.minecraftVersion}.jar`
  );
  const vanillaVersion = await readVersionJson(vanillaVersionJson, "Minecraft Vanilla", failures);

  if (vanillaVersion) {
    await writeLauncherLog(`[launch] Version Minecraft trouvee: ${vanillaVersionJson}`);

    if (vanillaVersion.id !== launcherRuntimeConfig.minecraftVersion) {
      failures.push(
        `Minecraft Vanilla: version attendue ${launcherRuntimeConfig.minecraftVersion}, version trouvee ${
          vanillaVersion.id ?? "inconnue"
        }`
      );
    }

    if (!vanillaVersion.downloads?.client) {
      failures.push("Minecraft Vanilla: informations client manquantes dans le JSON de version.");
    }
  } else {
    await writeLauncherLog("[launch] Version Minecraft manquante.");
  }

  await requireFile(vanillaClientJar, "client Minecraft Vanilla", failures);

  const fabricVersion = await findFabricVersion(instanceDir);

  if (!fabricVersion) {
    await writeLauncherLog("[launch] Fabric manquant.");
    failures.push(
      `Fabric: aucune version Fabric pour Minecraft ${launcherRuntimeConfig.minecraftVersion} trouvee dans ${path.join(
        instanceDir,
        "versions"
      )}.`
    );
  } else {
    await writeLauncherLog(`[launch] Fabric trouve: ${fabricVersion.versionJson}`);
  }

  let checkedLibraries = 0;
  let assetIndexId = vanillaVersion?.assetIndex?.id ?? "";
  const assetsRoot = path.join(instanceDir, "assets");
  let nativesDir = "";
  let classpathEntries: string[] = [];
  let mainClass = "";

  if (vanillaVersion?.assetIndex?.id) {
    const assetIndexPath = path.join(assetsRoot, "indexes", `${vanillaVersion.assetIndex.id}.json`);
    await requireFile(assetIndexPath, `asset index ${vanillaVersion.assetIndex.id}`, failures);
  } else if (vanillaVersion) {
    failures.push("Minecraft Vanilla: assetIndex manquant dans le JSON de version.");
  }

  if (fabricVersion) {
    const fabricJson = fabricVersion.version;

    if (fabricJson.inheritsFrom !== launcherRuntimeConfig.minecraftVersion) {
      failures.push(
        `Fabric: inheritsFrom attendu ${launcherRuntimeConfig.minecraftVersion}, valeur trouvee ${
          fabricJson.inheritsFrom ?? "absente"
        }.`
      );
    }

    if (!fabricJson.mainClass?.toLowerCase().includes("fabric")) {
      failures.push(`Fabric: mainClass invalide ou absente (${fabricJson.mainClass ?? "absente"}).`);
    } else {
      mainClass = fabricJson.mainClass;
    }

    const vanillaLibraries = vanillaVersion?.libraries ?? [];
    const fabricLibraries = fabricJson.libraries ?? [];
    const vanillaLibraryPaths = await verifyLibraries(instanceDir, vanillaLibraries, "Minecraft Vanilla", failures);
    const fabricLibraryPaths = await verifyLibraries(instanceDir, fabricLibraries, "Fabric", failures);
    checkedLibraries += vanillaLibraryPaths.length + fabricLibraryPaths.length;
    classpathEntries = [...vanillaLibraryPaths, ...fabricLibraryPaths, vanillaClientJar];

    nativesDir = path.join(instanceDir, "versions", fabricVersion.versionId, "natives");
    await requireDirectory(nativesDir, "dossier natives", failures);
  }

  if (failures.length > 0) {
    await writeLauncherLog("[launch] Minecraft/Fabric runtime check failed.");

    for (const failure of failures) {
      await writeLauncherLog(`[launch] Runtime missing: ${failure}`);
    }

    throw new Error(MINECRAFT_FABRIC_NOT_READY_MESSAGE);
  }

  await writeLauncherLog(`[launch] Minecraft ready: ${vanillaVersionJson}`);
  await writeLauncherLog(`[launch] Minecraft client jar ready: ${vanillaClientJar}`);
  await writeLauncherLog(`[launch] Fabric ready: ${fabricVersion?.versionJson}`);
  await writeLauncherLog(`[launch] Libraries ready: ${checkedLibraries}`);
  await writeLauncherLog(`[launch] Assets ready: ${assetIndexId}`);
  await writeLauncherLog(`[launch] Natives ready: ${nativesDir}`);
  await writeLauncherLog(`[launch] Runtime folders ready: ${modsDir}, ${configDir}`);

  return {
    vanillaVersionJson,
    vanillaClientJar,
    fabricVersionJson: fabricVersion?.versionJson ?? "",
    fabricVersionId: fabricVersion?.versionId ?? "",
    checkedLibraries,
    assetsRoot,
    assetIndexId,
    nativesDir,
    classpathEntries,
    mainClass
  };
}

export async function prepareMinecraftAndFabric(
  instanceDir: string,
  onProgress?: LauncherSyncProgressHandler
): Promise<MinecraftRuntimeLayout> {
  await writeLauncherLog("[prepare] Préparation de Minecraft/Fabric…");
  emitRuntimeProgress(onProgress, "check", 0, 8, "Préparation de Minecraft/Fabric…");

  await ensureRuntimeDirectories(instanceDir);
  await writeLauncherLog(`[prepare] Instance directory ready: ${instanceDir}`);

  emitRuntimeProgress(onProgress, "check", 1, 8, "Vérification Minecraft…");
  const vanilla = await ensureVanillaMinecraft(instanceDir);

  emitRuntimeProgress(onProgress, "check", 2, 8, "Vérification Fabric…");
  const fabric = await ensureFabricLoader(instanceDir);

  emitRuntimeProgress(onProgress, "copy", 3, 8, "Téléchargement des libraries…");
  const libraries = await ensureLibraries(instanceDir, vanilla.version, fabric.version);

  emitRuntimeProgress(onProgress, "copy", 4, 8, "Téléchargement des assets…");
  await ensureAssets(instanceDir, vanilla.version, onProgress);

  emitRuntimeProgress(onProgress, "copy", 6, 8, "Préparation des natives…");
  const nativesDir = await prepareNatives(instanceDir, fabric.versionId, libraries.nativeJars);

  emitRuntimeProgress(onProgress, "check", 7, 8, "Vérification finale Minecraft/Fabric…");
  const runtime = await verifyMinecraftAndFabricReady(instanceDir);

  emitRuntimeProgress(onProgress, "done", 8, 8, "Minecraft/Fabric pr\u00eat au lancement.");
  await writeLauncherLog(`[prepare] Natives préparées : ${nativesDir}`);
  await writeLauncherLog("[prepare] Minecraft/Fabric prêt au lancement.");

  return runtime;
}

export async function buildMinecraftLaunchPlan(
  instanceDir: string,
  authSession: StoredAuthSession,
  runtime: MinecraftRuntimeLayout,
  javaMemoryArgs: string[]
): Promise<MinecraftLaunchPlan> {
  const vanillaVersion = await readRequiredVersionJson(runtime.vanillaVersionJson, "Minecraft Vanilla");
  const fabricVersion = await readRequiredVersionJson(runtime.fabricVersionJson, "Fabric");
  const classpath = runtime.classpathEntries.join(path.delimiter);
  const variables = buildLaunchVariables(instanceDir, authSession, runtime, classpath);
  const jvmArgs = [
    ...javaMemoryArgs,
    ...resolveMinecraftArguments([...(vanillaVersion.arguments?.jvm ?? []), ...(fabricVersion.arguments?.jvm ?? [])], variables)
  ];
  const gameArgs = resolveGameArguments(vanillaVersion, fabricVersion, variables);
  const officialServerArgs = buildOfficialServerArguments();
  const mainClass = fabricVersion.mainClass ?? vanillaVersion.mainClass;

  if (!mainClass) {
    throw new Error("Classe principale Minecraft/Fabric introuvable.");
  }

  if (!jvmArgs.includes("-cp") && !jvmArgs.includes("-classpath")) {
    jvmArgs.push("-cp", classpath);
  }

  if (!jvmArgs.some((arg) => arg.startsWith("-Djava.library.path="))) {
    jvmArgs.push(`-Djava.library.path=${runtime.nativesDir}`);
  }

  return {
    mainClass,
    args: [...jvmArgs, mainClass, ...gameArgs, ...officialServerArgs],
    classpathEntries: runtime.classpathEntries
  };
}

function buildOfficialServerArguments(): string[] {
  const { host, port } = launcherRuntimeConfig.officialServer.addressForPing;
  if (!host) return [];
  return ['--quickPlayMultiplayer', `${host.includes(':') ? `[${host}]` : host}:${port}`];
}

async function ensureRuntimeDirectories(instanceDir: string): Promise<void> {
  await mkdir(instanceDir, { recursive: true });
  await mkdir(path.join(instanceDir, "versions"), { recursive: true });
  await mkdir(path.join(instanceDir, "libraries"), { recursive: true });
  await mkdir(path.join(instanceDir, "assets", "indexes"), { recursive: true });
  await mkdir(path.join(instanceDir, "assets", "objects"), { recursive: true });
  await mkdir(path.join(instanceDir, "mods"), { recursive: true });
  await mkdir(path.join(instanceDir, "config"), { recursive: true });
}

async function ensureVanillaMinecraft(instanceDir: string): Promise<PreparedVersion> {
  const versionDir = path.join(instanceDir, "versions", launcherRuntimeConfig.minecraftVersion);
  const versionJsonPath = path.join(versionDir, `${launcherRuntimeConfig.minecraftVersion}.json`);
  const clientJarPath = path.join(versionDir, `${launcherRuntimeConfig.minecraftVersion}.jar`);
  await mkdir(versionDir, { recursive: true });

  let version = await readVersionJson(versionJsonPath, "Minecraft Vanilla", []);

  if (!version || version.id !== launcherRuntimeConfig.minecraftVersion || !version.downloads?.client) {
    await writeLauncherLog("[prepare] Version Minecraft manquante ou invalide. Téléchargement des métadonnées.");
    version = await downloadVanillaVersionJson();
    await writeJsonFile(versionJsonPath, version);
  } else {
    await writeLauncherLog(`[prepare] Version Minecraft trouvee: ${versionJsonPath}`);
  }

  if (!version.downloads?.client?.url) {
    throw new Error("Metadata Minecraft invalide: URL du client absente.");
  }

  await downloadFileIfNeeded(version.downloads.client, clientJarPath, "client Minecraft");

  return {
    versionJsonPath,
    clientJarPath,
    version
  };
}

async function downloadVanillaVersionJson(): Promise<MinecraftVersionJson> {
  const manifest = await getJson<VersionManifest>(VERSION_MANIFEST_URL);
  const versionEntry = manifest.versions?.find((version) => version.id === launcherRuntimeConfig.minecraftVersion);

  if (!versionEntry?.url) {
    throw new Error(`Version Minecraft ${launcherRuntimeConfig.minecraftVersion} introuvable dans le manifest Mojang.`);
  }

  return getJson<MinecraftVersionJson>(versionEntry.url);
}

async function ensureFabricLoader(instanceDir: string): Promise<PreparedFabric> {
  const existingFabric = await findFabricVersion(instanceDir);

  if (
    existingFabric &&
    existingFabric.versionId === `fabric-loader-${launcherRuntimeConfig.fabricLoaderVersion}-${launcherRuntimeConfig.minecraftVersion}` &&
    existingFabric.version.inheritsFrom === launcherRuntimeConfig.minecraftVersion &&
    existingFabric.version.mainClass?.toLowerCase().includes("fabric")
  ) {
    await writeLauncherLog(`[prepare] Fabric trouve: ${existingFabric.versionJson}`);

    return {
      versionId: existingFabric.versionId,
      versionJsonPath: existingFabric.versionJson,
      version: existingFabric.version
    };
  }

  await writeLauncherLog("[prepare] Fabric manquant ou invalide. Installation Fabric.");
  const loaderVersion = launcherRuntimeConfig.fabricLoaderVersion;

  if (!loaderVersion) {
    throw new Error(`Aucun Fabric Loader disponible pour Minecraft ${launcherRuntimeConfig.minecraftVersion}.`);
  }

  const profileUrl = `https://meta.fabricmc.net/v2/versions/loader/${launcherRuntimeConfig.minecraftVersion}/${loaderVersion}/profile/json`;
  const fabricProfile = await getJson<MinecraftVersionJson>(profileUrl);
  const versionId = fabricProfile.id ?? `fabric-loader-${loaderVersion}-${launcherRuntimeConfig.minecraftVersion}`;
  const versionDir = path.join(instanceDir, "versions", versionId);
  const versionJsonPath = path.join(versionDir, `${versionId}.json`);

  await mkdir(versionDir, { recursive: true });
  await writeJsonFile(versionJsonPath, {
    ...fabricProfile,
    id: versionId,
    inheritsFrom: fabricProfile.inheritsFrom ?? launcherRuntimeConfig.minecraftVersion
  });
  await writeLauncherLog(`[prepare] Fabric installé : ${versionJsonPath}`);

  return {
    versionId,
    versionJsonPath,
    version: {
      ...fabricProfile,
      id: versionId,
      inheritsFrom: fabricProfile.inheritsFrom ?? launcherRuntimeConfig.minecraftVersion
    }
  };
}

async function ensureLibraries(
  instanceDir: string,
  vanillaVersion: MinecraftVersionJson,
  fabricVersion: MinecraftVersionJson
): Promise<PreparedLibraries> {
  const libraries = [...(vanillaVersion.libraries ?? []), ...(fabricVersion.libraries ?? [])];
  const classpathEntries: string[] = [];
  const nativeJars: NativeJar[] = [];
  let checkedLibraries = 0;
  let downloadedLibraries = 0;

  for (const library of libraries) {
    if (!isAllowedByRules(library.rules)) {
      continue;
    }

    const artifact = getLibraryArtifact(library);

    if (artifact) {
      const artifactPath = artifact.path;

      if (!artifactPath) {
        continue;
      }

      checkedLibraries += 1;
      const targetPath = path.join(instanceDir, "libraries", ...artifactPath.split("/"));
      const downloaded = await downloadFileIfNeeded(artifact, targetPath, `library ${library.name ?? artifactPath}`);
      downloadedLibraries += downloaded ? 1 : 0;
      classpathEntries.push(targetPath);
    }

    const nativeArtifact = getNativeArtifact(library);

    if (nativeArtifact) {
      const nativeArtifactPath = nativeArtifact.path;

      if (!nativeArtifactPath) {
        continue;
      }

      checkedLibraries += 1;
      const targetPath = path.join(instanceDir, "libraries", ...nativeArtifactPath.split("/"));
      const downloaded = await downloadFileIfNeeded(
        nativeArtifact,
        targetPath,
        `native library ${library.name ?? nativeArtifactPath}`
      );
      downloadedLibraries += downloaded ? 1 : 0;
      nativeJars.push({
        path: targetPath,
        exclude: library.extract?.exclude ?? ["META-INF/"]
      });
    }
  }

  await writeLauncherLog(
    `[prepare] Libraries checked: ${checkedLibraries}. Downloaded/repaired: ${downloadedLibraries}.`
  );

  return {
    classpathEntries: [...new Set(classpathEntries)],
    nativeJars,
    checkedLibraries
  };
}

async function ensureAssets(
  instanceDir: string,
  version: MinecraftVersionJson,
  onProgress?: LauncherSyncProgressHandler
): Promise<void> {
  const assetIndex = version.assetIndex;

  if (!assetIndex?.id || !assetIndex.url) {
    throw new Error("Minecraft assetIndex manquant dans le JSON de version.");
  }

  const assetsRoot = path.join(instanceDir, "assets");
  const indexPath = path.join(assetsRoot, "indexes", `${assetIndex.id}.json`);
  await downloadFileIfNeeded(
    {
      path: `assets/indexes/${assetIndex.id}.json`,
      url: assetIndex.url,
      sha1: assetIndex.sha1,
      size: assetIndex.size
    },
    indexPath,
    `asset index ${assetIndex.id}`
  );

  const index = JSON.parse(await readFile(indexPath, "utf8")) as AssetIndex;
  const objects = [...new Map(Object.values(index.objects ?? {}).filter(object => object.hash).map(object => [object.hash, object])).values()];
  let checkedAssets = 0;
  let downloadedAssets = 0;
  let nextAsset = 0;
  let assetFailure: unknown;
  await Promise.all(Array.from({length:4}, async () => {
    while (nextAsset < objects.length && !assetFailure) {
    const object = objects[nextAsset++];
    try {
    const hash = object.hash as string;
    const targetPath = path.join(assetsRoot, "objects", hash.slice(0, 2), hash);
    const downloaded = await downloadFileIfNeeded(
      {
        path: `assets/objects/${hash.slice(0, 2)}/${hash}`,
        url: `https://resources.download.minecraft.net/${hash.slice(0, 2)}/${hash}`,
        sha1: hash,
        size: object.size
      },
      targetPath,
      `asset ${hash}`,
      true
    );
    downloadedAssets += downloaded ? 1 : 0;
    checkedAssets += 1;

    if (downloaded || checkedAssets === objects.length || checkedAssets % 50 === 0) {
      emitRuntimeProgress(
        onProgress,
        "copy",
        checkedAssets,
        Math.max(objects.length, 1),
        `Téléchargement des assets ${checkedAssets}/${objects.length}`
      );
    }
    } catch (error) { assetFailure = error; }
    }
  }));
  if (assetFailure) throw assetFailure;

  await writeLauncherLog(`[prepare] Assets checked: ${checkedAssets}. Downloaded/repaired: ${downloadedAssets}.`);
}

async function prepareNatives(instanceDir: string, fabricVersionId: string, nativeJars: NativeJar[]): Promise<string> {
  const nativesDir = path.join(instanceDir, "versions", fabricVersionId, "natives");

  await writeLauncherLog(`[prepare] Preparation natives. Native jars: ${nativeJars.length}.`);
  await rm(nativesDir, { recursive: true, force: true });
  await mkdir(nativesDir, { recursive: true });

  for (const nativeJar of nativeJars) {
    await extractZip(nativeJar.path, nativesDir, nativeJar.exclude);
  }

  await writeFile(path.join(nativesDir, ".prepared"), new Date().toISOString(), "utf8");
  return nativesDir;
}

async function verifyLibraries(
  instanceDir: string,
  libraries: MinecraftLibrary[],
  label: string,
  failures: string[]
): Promise<string[]> {
  const libraryPaths: string[] = [];

  for (const library of libraries) {
    if (!isAllowedByRules(library.rules)) {
      continue;
    }

    const artifact = getLibraryArtifact(library);

    if (!artifact) {
      continue;
    }

    const artifactPath = artifact.path;

    if (!artifactPath) {
      continue;
    }

    const libraryPath = path.join(instanceDir, "libraries", ...artifactPath.split("/"));
    libraryPaths.push(libraryPath);
    await requireFile(libraryPath, `${label} library ${library.name ?? artifactPath}`, failures);
  }

  return libraryPaths;
}

async function findFabricVersion(
  instanceDir: string
): Promise<{ versionId: string; versionJson: string; version: MinecraftVersionJson } | null> {
  const versionsDir = path.join(instanceDir, "versions");

  if (!(await pathExists(versionsDir))) {
    return null;
  }

  const entries = await readdir(versionsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const versionId = entry.name;
    if (versionId !== `fabric-loader-${launcherRuntimeConfig.fabricLoaderVersion}-${launcherRuntimeConfig.minecraftVersion}`) continue;
    const normalizedVersionId = versionId.toLowerCase();

    if (
      !normalizedVersionId.includes("fabric") ||
      !normalizedVersionId.includes(launcherRuntimeConfig.minecraftVersion)
    ) {
      continue;
    }

    const versionJson = path.join(versionsDir, versionId, `${versionId}.json`);
    const version = await readVersionJson(versionJson, `Fabric ${versionId}`, []);

    if (version) {
      return {
        versionId,
        versionJson,
        version
      };
    }
  }

  return null;
}

async function readRequiredVersionJson(filePath: string, label: string): Promise<MinecraftVersionJson> {
  const version = await readVersionJson(filePath, label, []);

  if (!version) {
    throw new Error(`${label}: fichier version manquant ou invalide: ${filePath}`);
  }

  return version;
}

async function readVersionJson(
  filePath: string,
  label: string,
  failures: string[]
): Promise<MinecraftVersionJson | null> {
  if (!(await pathExists(filePath))) {
    failures.push(`${label}: fichier version manquant ${filePath}.`);
    return null;
  }

  try {
    return JSON.parse(await readFile(filePath, "utf8")) as MinecraftVersionJson;
  } catch (error) {
    failures.push(`${label}: JSON invalide ${filePath}: ${error instanceof Error ? error.message : String(error)}.`);
    return null;
  }
}

function buildLaunchVariables(
  instanceDir: string,
  authSession: StoredAuthSession,
  runtime: MinecraftRuntimeLayout,
  classpath: string
): Record<string, string> {
  return {
    auth_player_name: authSession.minecraft.profile.name,
    version_name: runtime.fabricVersionId,
    game_directory: instanceDir,
    assets_root: runtime.assetsRoot,
    assets_index_name: runtime.assetIndexId,
    auth_uuid: authSession.minecraft.profile.id,
    auth_access_token: authSession.minecraft.accessToken,
    clientid: "",
    auth_xuid: "",
    user_type: "msa",
    version_type: launcherRuntimeConfig.launcherName,
    natives_directory: runtime.nativesDir,
    launcher_name: launcherRuntimeConfig.launcherName,
    launcher_version: "0.1.0",
    classpath,
    library_directory: path.join(instanceDir, "libraries"),
    classpath_separator: path.delimiter,
    quickPlayPath: path.join(instanceDir, "quickPlay")
  };
}

function resolveGameArguments(
  vanillaVersion: MinecraftVersionJson,
  fabricVersion: MinecraftVersionJson,
  variables: Record<string, string>
): string[] {
  const modernArgs = [
    ...(vanillaVersion.arguments?.game ?? []),
    ...(fabricVersion.arguments?.game ?? [])
  ];

  if (modernArgs.length > 0) {
    return resolveMinecraftArguments(modernArgs, variables);
  }

  if (vanillaVersion.minecraftArguments) {
    return vanillaVersion.minecraftArguments.split(/\s+/).filter(Boolean).map((arg) => replaceVariables(arg, variables));
  }

  return [];
}

function resolveMinecraftArguments(args: MinecraftArgument[], variables: Record<string, string>): string[] {
  const resolvedArgs: string[] = [];

  for (const arg of args) {
    if (typeof arg === "string") {
      resolvedArgs.push(replaceVariables(arg, variables));
      continue;
    }

    if (!isAllowedByRules(arg.rules)) {
      continue;
    }

    const values = Array.isArray(arg.value) ? arg.value : [arg.value].filter(Boolean);

    for (const value of values) {
      if (value) {
        resolvedArgs.push(replaceVariables(value, variables));
      }
    }
  }

  return resolvedArgs;
}

function replaceVariables(value: string, variables: Record<string, string>): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, key: string) => variables[key] ?? "");
}

function getLibraryArtifact(library: MinecraftLibrary): DownloadArtifact | null {
  if (library.downloads?.artifact?.path && library.downloads.artifact.url) {
    return library.downloads.artifact;
  }

  if (library.url && library.name) {
    const artifactPath = getMavenArtifactPath(library.name);

    return {
      path: artifactPath,
      url: joinUrl(library.url, artifactPath)
    };
  }

  return null;
}

function getNativeArtifact(library: MinecraftLibrary): DownloadArtifact | null {
  const nativeKey = getNativeClassifierKey(library);

  if (!nativeKey) {
    return null;
  }

  const artifact = library.downloads?.classifiers?.[nativeKey];

  if (artifact?.path && artifact.url) {
    return artifact;
  }

  return null;
}

function getNativeClassifierKey(library: MinecraftLibrary): string | null {
  const osName = getMinecraftOsName();
  const nativeTemplate = library.natives?.[osName];

  if (!nativeTemplate) {
    return null;
  }

  return nativeTemplate.replace("${arch}", process.arch === "ia32" ? "32" : "64");
}

function getMavenArtifactPath(name: string): string {
  const [group, artifact, version, classifier] = name.split(":");

  if (!group || !artifact || !version) {
    throw new Error(`Coordonnees Maven invalides: ${name}`);
  }

  const fileName = `${artifact}-${version}${classifier ? `-${classifier}` : ""}.jar`;
  return `${group.replace(/\./g, "/")}/${artifact}/${version}/${fileName}`;
}

function isAllowedByRules(rules: MinecraftRule[] | undefined): boolean {
  if (!rules || rules.length === 0) {
    return true;
  }

  let allowed = false;

  for (const rule of rules) {
    if (!ruleMatches(rule)) {
      continue;
    }

    allowed = rule.action === "allow";
  }

  return allowed;
}

function ruleMatches(rule: MinecraftRule): boolean {
  if (rule.os && !osMatches(rule.os)) {
    return false;
  }

  if (rule.features) {
    for (const [feature, expected] of Object.entries(rule.features)) {
      if ((RULE_FEATURES as unknown as Record<string, boolean>)[feature] !== expected) {
        return false;
      }
    }
  }

  return true;
}

function osMatches(os: NonNullable<MinecraftRule["os"]>): boolean {
  if (os.name && os.name !== getMinecraftOsName()) {
    return false;
  }

  if (os.arch && os.arch !== process.arch) {
    return false;
  }

  if (os.version && !new RegExp(os.version).test(nodeOs.release())) {
    return false;
  }

  return true;
}

function getMinecraftOsName(): string {
  if (process.platform === "win32") {
    return "windows";
  }

  if (process.platform === "darwin") {
    return "osx";
  }

  return "linux";
}

async function downloadFileIfNeeded(
  artifact: DownloadArtifact,
  targetPath: string,
  label: string,
  quiet = false
): Promise<boolean> {
  if (!artifact.url) {
    throw new Error(`URL de telechargement manquante pour ${label}.`);
  }

  if (await isFileValid(targetPath, artifact)) {
    return false;
  }

  if (!quiet) {
    await writeLauncherLog(`[prepare] Downloading ${label}: ${artifact.url}`);
  }

  await mkdir(path.dirname(targetPath), { recursive: true });
  const response = await fetch(artifact.url, {signal:AbortSignal.timeout(120_000)});

  if (!response.ok) {
    throw new Error(`Téléchargement impossible (${response.status}) pour ${label} : ${artifact.url}`);
  }

  const tempPath = `${targetPath}.download`;
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(tempPath, bytes);

  if (!(await isFileValid(tempPath, artifact))) {
    await rm(tempPath, { force: true });
    throw new Error(`Fichier telecharge invalide pour ${label}.`);
  }

  await rename(tempPath, targetPath);
  return true;
}

async function isFileValid(filePath: string, artifact: DownloadArtifact): Promise<boolean> {
  if (!(await pathExists(filePath))) {
    return false;
  }

  const fileStats = await stat(filePath);

  if (artifact.size !== undefined && fileStats.size !== artifact.size) {
    return false;
  }

  if (artifact.sha1 && (await hashFile(filePath, "sha1")) !== artifact.sha1) {
    return false;
  }

  return true;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    signal:AbortSignal.timeout(30_000),
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} pendant le telechargement de ${url}`);
  }

  return (await response.json()) as T;
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function extractZip(zipFile: string, targetDir: string, exclude: string[]): Promise<void> {
  const buffer = await readFile(zipFile);
  const endOfCentralDirectory = findEndOfCentralDirectory(buffer);
  const totalEntries = buffer.readUInt16LE(endOfCentralDirectory + 10);
  let centralDirectoryOffset = buffer.readUInt32LE(endOfCentralDirectory + 16);

  for (let index = 0; index < totalEntries; index += 1) {
    if (buffer.readUInt32LE(centralDirectoryOffset) !== 0x02014b50) {
      throw new Error(`Archive native invalide: ${zipFile}`);
    }

    const compressionMethod = buffer.readUInt16LE(centralDirectoryOffset + 10);
    const compressedSize = buffer.readUInt32LE(centralDirectoryOffset + 20);
    const fileNameLength = buffer.readUInt16LE(centralDirectoryOffset + 28);
    const extraLength = buffer.readUInt16LE(centralDirectoryOffset + 30);
    const commentLength = buffer.readUInt16LE(centralDirectoryOffset + 32);
    const localHeaderOffset = buffer.readUInt32LE(centralDirectoryOffset + 42);
    const fileName = buffer
      .subarray(centralDirectoryOffset + 46, centralDirectoryOffset + 46 + fileNameLength)
      .toString("utf8");

    centralDirectoryOffset += 46 + fileNameLength + extraLength + commentLength;

    if (fileName.endsWith("/") || shouldExcludeZipEntry(fileName, exclude)) {
      continue;
    }

    if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new Error(`Entree native invalide dans ${zipFile}: ${fileName}`);
    }

    const localFileNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localFileNameLength + localExtraLength;
    const compressedData = buffer.subarray(dataStart, dataStart + compressedSize);
    const output =
      compressionMethod === 0
        ? compressedData
        : compressionMethod === 8
          ? inflateRawSync(compressedData)
          : null;

    if (!output) {
      throw new Error(`Compression native non supportee (${compressionMethod}) dans ${zipFile}: ${fileName}`);
    }

    const targetPath = resolveInside(targetDir, fileName);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, output);
  }
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  for (let index = buffer.length - 22; index >= 0; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) {
      return index;
    }
  }

  throw new Error("Archive ZIP native invalide : fin de répertoire introuvable.");
}

function shouldExcludeZipEntry(fileName: string, exclude: string[]): boolean {
  return exclude.some((prefix) => fileName.startsWith(prefix));
}

function resolveInside(rootDir: string, relativePath: string): string {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedPath = path.resolve(resolvedRoot, ...relativePath.split("/"));
  const relative = path.relative(resolvedRoot, resolvedPath);

  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Chemin hors dossier cible refusé : ${relativePath}`);
  }

  return resolvedPath;
}

function joinUrl(baseUrl: string, relativePath: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${relativePath}`;
}

function emitRuntimeProgress(
  onProgress: LauncherSyncProgressHandler | undefined,
  phase: LauncherSyncProgress["phase"],
  current: number,
  total: number,
  message: string
): void {
  const safeTotal = Math.max(total, 1);

  onProgress?.({
    phase,
    current,
    total: safeTotal,
    percent: Math.max(0, Math.min(100, Math.round((current / safeTotal) * 100))),
    message
  });
}

async function requireDirectory(dirPath: string, label: string, failures: string[]): Promise<void> {
  try {
    const stats = await stat(dirPath);

    if (!stats.isDirectory()) {
      failures.push(`${label} : chemin présent, mais ce n’est pas un dossier : ${dirPath}.`);
    }
  } catch {
    failures.push(`${label}: dossier manquant ${dirPath}.`);
  }
}

async function requireFile(filePath: string, label: string, failures: string[]): Promise<void> {
  try {
    const stats = await stat(filePath);

    if (!stats.isFile()) {
      failures.push(`${label} : chemin présent, mais ce n’est pas un fichier : ${filePath}.`);
    }
  } catch {
    failures.push(`${label}: fichier manquant ${filePath}.`);
  }
}

async function hashFile(filePath: string, algorithm: "sha1" | "sha256"): Promise<string> {
  const hash = createHash(algorithm);
  const stream = createReadStream(filePath);

  return new Promise((resolve, reject) => {
    stream.on("data", (chunk: Buffer) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
