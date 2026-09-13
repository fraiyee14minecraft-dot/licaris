import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as nbt from "prismarine-nbt";
import { launcherRuntimeConfig } from "../config";
import { writeLauncherLog } from "./logService";

interface MinecraftServerEntry {
  name: string;
  ip: string;
  icon?: string;
  acceptTextures?: number;
  hidden?: number;
}

export async function ensureServerInMultiplayerList(instanceDir: string): Promise<void> {
  const serversFile = path.join(instanceDir, "servers.dat");
  await writeLauncherLog("[server-list] Vérification de servers.dat.");
  await writeLauncherLog(`[server-list] Chemin du servers.dat utilise: ${serversFile}`);

  const servers = await readServersDat(serversFile);
  const officialServer = launcherRuntimeConfig.officialServer;
  const targetName = officialServer.name;
  const targetAddress = officialServer.addressForMinecraftList;
  const legacyAddressWithPort = `${officialServer.host}:${officialServer.port}`;
  const legacyAddresses = [
    officialServer.host,
    legacyAddressWithPort
  ];
  await writeLauncherLog(`[server-list] Adresse serveur Minecraft utilisee: ${targetAddress}`);
  const matchingIndexes = servers
    .map((server, index) => ({ server, index }))
    .filter(
      ({ server }) =>
        normalizeServerValue(server.ip) === normalizeServerValue(targetAddress) ||
        legacyAddresses.some((address) => normalizeServerValue(server.ip) === normalizeServerValue(address)) ||
        normalizeServerValue(server.name) === normalizeServerValue(targetName)
    )
    .map(({ index }) => index);

  if (matchingIndexes.length === 0) {
    servers.push({
      name: targetName,
      ip: targetAddress
    });

    await writeServersDat(serversFile, servers);
    await writeLauncherLog(`[server-list] Serveur officiel ajoute: ${targetName} (${targetAddress}).`);
    return;
  }

  const primaryIndex = matchingIndexes[0];
  const primaryServer = servers[primaryIndex];
  const previousName = primaryServer.name;
  const previousAddress = primaryServer.ip;
  const duplicateIndexes = new Set(matchingIndexes.slice(1));
  const deduplicatedServers = servers.filter((_server, index) => !duplicateIndexes.has(index));
  const hadLegacyAddressWithPort = matchingIndexes.some(
    (index) => normalizeServerValue(servers[index].ip) === normalizeServerValue(legacyAddressWithPort)
  );

  if (hadLegacyAddressWithPort) {
    await writeLauncherLog("[server-list] Ancienne adresse avec port detectee, correction en cours.");
  }

  primaryServer.name = targetName;
  primaryServer.ip = targetAddress;

  await writeServersDat(serversFile, deduplicatedServers);

  if (
    normalizeServerValue(previousName) === normalizeServerValue(targetName) &&
    normalizeServerValue(previousAddress) === normalizeServerValue(targetAddress) &&
    duplicateIndexes.size === 0
  ) {
    await writeLauncherLog(`[server-list] Serveur officiel déjà présent : ${targetName} (${targetAddress}).`);
    return;
  }

  await writeLauncherLog(
    `[server-list] Serveur officiel mis à jour : ${previousName} (${previousAddress}) -> ${targetName} (${targetAddress}). Doublons supprimés : ${duplicateIndexes.size}.`
  );
}

function normalizeServerValue(value: string): string {
  return value.trim().toLowerCase().replace(/[’‘`´]/g, "'");
}

async function readServersDat(serversFile: string): Promise<MinecraftServerEntry[]> {
  if (!(await pathExists(serversFile))) {
    return [];
  }

  try {
    const buffer = await readFile(serversFile);
    const { parsed } = await nbt.parse(buffer);
    const simplified = nbt.simplify(parsed) as { servers?: MinecraftServerEntry[] };

    return Array.isArray(simplified.servers) ? simplified.servers : [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeLauncherLog(`[server-list] Erreur de lecture de servers.dat: ${message}`);
    throw new Error(
      `Impossible de lire servers.dat. Supprime le fichier ou repare l'installation. Detail: ${message}`
    );
  }
}

async function writeServersDat(serversFile: string, servers: MinecraftServerEntry[]): Promise<void> {
  await mkdir(path.dirname(serversFile), { recursive: true });

  const root: nbt.NBT = {
    name: "",
    type: "compound",
    value: {
      servers: {
        type: "list",
        value: {
          type: "compound",
          value: servers.map(toServerCompound)
        }
      }
    }
  };

  try {
    const uncompressed = nbt.writeUncompressed(root, "big");
    await writeFile(serversFile, uncompressed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeLauncherLog(`[server-list] Erreur d'ecriture de servers.dat: ${message}`);
    throw error;
  }
}

function toServerCompound(server: MinecraftServerEntry): nbt.Compound["value"] {
  const compound: nbt.Compound["value"] = {
    name: {
      type: "string",
      value: server.name
    },
    ip: {
      type: "string",
      value: server.ip
    }
  };

  if (server.icon) {
    compound.icon = {
      type: "string",
      value: server.icon
    };
  }

  if (server.acceptTextures !== undefined) {
    compound.acceptTextures = {
      type: "byte",
      value: server.acceptTextures
    };
  }

  if (server.hidden !== undefined) {
    compound.hidden = {
      type: "byte",
      value: server.hidden
    };
  }

  return compound;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
