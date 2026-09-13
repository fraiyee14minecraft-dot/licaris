import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getAvatarCacheDir } from "./installPaths";
import { writeLauncherLog } from "./logService";

interface MinecraftProfileIdentity {
  id: string;
  name: string;
}

export async function getMinecraftAvatarDataUrl(profile: MinecraftProfileIdentity): Promise<string | undefined> {
  const uuid = normalizeMinecraftUuid(profile.id);
  const cacheFile = path.join(getAvatarCacheDir(), `${uuid}.png`);

  await writeLauncherLog(`[avatar] Profil Minecraft récupéré : name=${profile.name}, uuid=${uuid}`);
  await writeLauncherLog(`[avatar] UUID Minecraft : ${uuid}`);

  if (await pathExists(cacheFile)) {
    await writeLauncherLog(`[avatar] Avatar cache utilise: ${cacheFile}`);
    return readAvatarDataUrl(cacheFile);
  }

  for (const avatarUrl of buildAvatarUrls(uuid)) {
    await writeLauncherLog(`[avatar] URL avatar generee: ${avatarUrl}`);

    try {
      const response = await fetch(avatarUrl, {
        headers: {
          Accept: "image/png,image/*"
        }
      });

      if (!response.ok) {
        await writeLauncherLog(`[avatar] Avatar download failed HTTP ${response.status}: ${avatarUrl}`);
        continue;
      }

      const bytes = Buffer.from(await response.arrayBuffer());

      if (bytes.length === 0) {
        await writeLauncherLog(`[avatar] Avatar download empty: ${avatarUrl}`);
        continue;
      }

      await mkdir(path.dirname(cacheFile), { recursive: true });
      await writeFile(cacheFile, bytes);
      await writeLauncherLog(`[avatar] Avatar Minecraft telecharge: ${cacheFile}`);
      return bufferToDataUrl(bytes);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await writeLauncherLog(`[avatar] Avatar download error: ${message}`);
    }
  }

  await writeLauncherLog(`[avatar] Avatar fallback utilise pour ${profile.name}.`);
  return undefined;
}

function buildAvatarUrls(uuid: string): string[] {
  return [
    `https://mc-heads.net/avatar/${uuid}/64`,
    `https://crafatar.com/avatars/${uuid}?size=64&overlay`
  ];
}

async function readAvatarDataUrl(cacheFile: string): Promise<string> {
  return bufferToDataUrl(await readFile(cacheFile));
}

function bufferToDataUrl(buffer: Buffer): string {
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

function normalizeMinecraftUuid(uuid: string): string {
  return uuid.replace(/-/g, "").toLowerCase();
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
