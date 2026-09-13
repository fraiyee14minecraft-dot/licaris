import { app } from "electron";
import path from "node:path";
import { packDefinition } from '../config';

export function getLauncherDataDir(): string {
  return app.getPath("userData");
}

export function getMinecraftInstanceDir(): string {
  return path.join(getLauncherDataDir(), 'instances', `${packDefinition.id}-${packDefinition.version}`);
}

export function getLogsDir(): string {
  return path.join(getLauncherDataDir(), "logs");
}

export function getAvatarCacheDir(): string {
  return path.join(getLauncherDataDir(), "cache", "avatars");
}

export function getSkinsDir(): string {
  return path.join(getLauncherDataDir(), "skins");
}

export function getSettingsFile(): string {
  return path.join(getLauncherDataDir(), "settings.json");
}

export function getGpuRecoveryStateFile(): string {
  return path.join(getLauncherDataDir(), "gpu-recovery.json");
}

export function getAuthSessionFile(): string {
  return path.join(getLauncherDataDir(), "auth-session.json");
}

export function getLauncherAccessStateFile(): string {
  return path.join(getLauncherDataDir(), "launcher-access-state.json");
}

export function getManagedContentPreferencesFile(): string {
  return path.join(getLauncherDataDir(), "managed-content.json");
}

export function getModpackStateFile(): string {
  return path.join(getLauncherDataDir(), "modpack-state.json");
}

export function getMinecraftProcessStateFile(): string {
  return path.join(getLauncherDataDir(), "minecraft-process.json");
}

export function getMinecraftSessionHistoryFile(): string {
  return path.join(getLauncherDataDir(), "diagnostics", "minecraft-sessions.jsonl");
}

export function getSkinsStateFile(): string {
  return path.join(getLauncherDataDir(), "skins-state.json");
}

export function getShadersStateFile(): string {
  return path.join(getLauncherDataDir(), "shaders-state.json");
}
