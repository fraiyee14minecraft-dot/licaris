import net from "node:net";
import type { OfficialServerStatus } from "../types/launcher";
import { launcherRuntimeConfig } from "../config";
import { writeLauncherLog } from "./logService";

interface MinecraftStatusResponse {
  version?: {
    name?: string;
    protocol?: number;
  };
  players?: {
    max?: number;
    online?: number;
  };
  description?: unknown;
}

interface MinecraftPingResult {
  host: string;
  port: number;
  latencyMs: number;
  onlinePlayers?: number;
  maxPlayers?: number;
  versionName?: string;
  protocolVersion?: number;
}

interface ServerPingTarget {
  host: string;
  port: number;
  label: string;
}

const SERVER_PING_TIMEOUT_MS = 6000;
const MINECRAFT_STATUS_PROTOCOL_VERSION = 767;

export async function getOfficialServerStatus(): Promise<OfficialServerStatus> {
  const { host, port } = launcherRuntimeConfig.officialServer.addressForPing;
  const checkedAt = new Date().toISOString();
  await writeLauncherLog(`[server-status] Ping launcher utilise: ${host}:${port}`);
  const targets: ServerPingTarget[] = [
    {
      host,
      port,
      label: "adresse officielle"
    }
  ];

  const failures: string[] = [];

  for (const target of targets) {
    const address = `${target.host}:${target.port}`;
    await writeLauncherLog(`[server-status] Ping serveur: ${address} (${target.label}) via Minecraft Status Protocol.`);

    try {
      const result = await pingMinecraftStatus(target.host, target.port);
      const playersLabel = formatPlayers(result.onlinePlayers, result.maxPlayers);

      await writeLauncherLog(
        `[server-status] Resultat du ping: OK ${address}. Temps de reponse: ${result.latencyMs}ms. Joueurs: ${playersLabel}. Version: ${result.versionName ?? "inconnue"}. Protocol: ${result.protocolVersion ?? "inconnu"}.`
      );

      return {
        state: "online",
        message: buildOnlineMessage(result),
        host: result.host,
        port: result.port,
        checkedAt,
        latencyMs: result.latencyMs,
        onlinePlayers: result.onlinePlayers,
        maxPlayers: result.maxPlayers
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      failures.push(`${address}: ${detail}`);
      await writeLauncherLog(`[server-status] Echec du ping serveur: ${address}. Erreur exacte: ${detail}`);
    }
  }

  const error = failures.join(" | ");
  await writeLauncherLog(`[server-status] Serveur injoignable. Détails : ${error}`);

  return {
    state: "offline",
    message: "Ping Minecraft indisponible",
    host,
    port,
    checkedAt,
    error
  };
}

function buildOnlineMessage(result: MinecraftPingResult): string {
  const players = formatPlayers(result.onlinePlayers, result.maxPlayers);

  if (players !== "non indique") {
    return `Serveur en ligne - ${players} joueur(s)`;
  }

  return "Serveur en ligne";
}

function formatPlayers(onlinePlayers: number | undefined, maxPlayers: number | undefined): string {
  if (onlinePlayers !== undefined && maxPlayers !== undefined) {
    return `${onlinePlayers}/${maxPlayers}`;
  }

  if (onlinePlayers !== undefined) {
    return `${onlinePlayers}`;
  }

  return "non indique";
}

function pingMinecraftStatus(host: string, port: number): Promise<MinecraftPingResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const socket = new net.Socket();
    let buffer = Buffer.alloc(0);
    let settled = false;

    function finish(error?: Error, response?: MinecraftStatusResponse): void {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy();

      if (error) {
        reject(error);
        return;
      }

      const latencyMs = Date.now() - startedAt;

      resolve({
        host,
        port,
        latencyMs,
        onlinePlayers: response?.players?.online,
        maxPlayers: response?.players?.max,
        versionName: response?.version?.name,
        protocolVersion: response?.version?.protocol
      });
    }

    socket.setTimeout(SERVER_PING_TIMEOUT_MS);
    socket.once("connect", () => {
      socket.write(buildStatusHandshakePacket(host, port));
      socket.write(buildPacket(0x00));
    });
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      try {
        const packet = tryReadPacket(buffer);

        if (!packet) {
          return;
        }

        const response = parseStatusResponsePacket(packet);
        finish(undefined, response);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once("timeout", () => {
      finish(new Error(`Timeout ${SERVER_PING_TIMEOUT_MS}ms pendant le ping Minecraft Status Protocol`));
    });
    socket.once("error", (error) => {
      finish(error);
    });
    socket.connect(port, host);
  });
}

function buildStatusHandshakePacket(host: string, port: number): Buffer {
  const hostBuffer = Buffer.from(host, "utf8");
  const portBuffer = Buffer.alloc(2);
  portBuffer.writeUInt16BE(port);

  return buildPacket(
    0x00,
    encodeVarInt(MINECRAFT_STATUS_PROTOCOL_VERSION),
    encodeVarInt(hostBuffer.length),
    hostBuffer,
    portBuffer,
    encodeVarInt(1)
  );
}

function buildPacket(packetId: number, ...payloadParts: Buffer[]): Buffer {
  const payload = Buffer.concat([encodeVarInt(packetId), ...payloadParts]);
  return Buffer.concat([encodeVarInt(payload.length), payload]);
}

function parseStatusResponsePacket(packet: Buffer): MinecraftStatusResponse {
  const packetId = readRequiredVarInt(packet, 0);

  if (packetId.value !== 0x00) {
    throw new Error(`Packet status inattendu: ${packetId.value}`);
  }

  const stringLength = readRequiredVarInt(packet, packetId.nextOffset);
  const jsonStart = stringLength.nextOffset;
  const jsonEnd = jsonStart + stringLength.value;

  if (packet.length < jsonEnd) {
    throw new Error("Packet status incomplet: JSON tronque.");
  }

  const rawJson = packet.subarray(jsonStart, jsonEnd).toString("utf8");

  try {
    return JSON.parse(rawJson) as MinecraftStatusResponse;
  } catch (error) {
    throw new Error(`Reponse status Minecraft JSON invalide: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function tryReadPacket(buffer: Buffer): Buffer | null {
  const packetLength = readVarInt(buffer, 0);

  if (!packetLength) {
    return null;
  }

  const packetStart = packetLength.nextOffset;
  const packetEnd = packetStart + packetLength.value;

  if (buffer.length < packetEnd) {
    return null;
  }

  return buffer.subarray(packetStart, packetEnd);
}

function readRequiredVarInt(buffer: Buffer, offset: number): { value: number; nextOffset: number } {
  const result = readVarInt(buffer, offset);

  if (!result) {
    throw new Error("VarInt Minecraft incomplet.");
  }

  return result;
}

function readVarInt(buffer: Buffer, offset: number): { value: number; nextOffset: number } | null {
  let value = 0;
  let position = 0;
  let nextOffset = offset;

  while (true) {
    if (nextOffset >= buffer.length) {
      return null;
    }

    const currentByte = buffer[nextOffset];
    value |= (currentByte & 0x7f) << (position * 7);
    nextOffset += 1;

    if ((currentByte & 0x80) === 0) {
      return {
        value,
        nextOffset
      };
    }

    position += 1;

    if (position > 5) {
      throw new Error("VarInt Minecraft trop long.");
    }
  }
}

function encodeVarInt(value: number): Buffer {
  const bytes: number[] = [];
  let currentValue = value >>> 0;

  while (true) {
    if ((currentValue & ~0x7f) === 0) {
      bytes.push(currentValue);
      break;
    }

    bytes.push((currentValue & 0x7f) | 0x80);
    currentValue >>>= 7;
  }

  return Buffer.from(bytes);
}
