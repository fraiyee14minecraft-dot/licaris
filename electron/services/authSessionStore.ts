import { safeStorage } from "electron";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getAuthSessionFile } from "./installPaths";

export interface StoredAuthSession {
  microsoft: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  };
  minecraft: {
    accessToken: string;
    expiresAt: number;
    profile: {
      id: string;
      name: string;
    };
  };
  savedAt: string;
}

interface EncryptedSessionFile {
  version: 1;
  encrypted: string;
}

export async function readAuthSession(): Promise<StoredAuthSession | null> {
  try {
    const raw = await readFile(getAuthSessionFile(), "utf8");
    const payload = JSON.parse(raw) as EncryptedSessionFile;

    if (payload.version !== 1 || !payload.encrypted) {
      return null;
    }

    const decrypted = safeStorage.decryptString(Buffer.from(payload.encrypted, "base64"));
    return JSON.parse(decrypted) as StoredAuthSession;
  } catch {
    return null;
  }
}

export async function saveAuthSession(session: StoredAuthSession): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Stockage sécurisé indisponible pour la session Microsoft.");
  }

  const sessionFile = getAuthSessionFile();
  const encrypted = safeStorage.encryptString(JSON.stringify(session)).toString("base64");
  const payload: EncryptedSessionFile = {
    version: 1,
    encrypted
  };

  await mkdir(path.dirname(sessionFile), { recursive: true });
  await writeFile(sessionFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export async function clearAuthSession(): Promise<void> {
  await rm(getAuthSessionFile(), { force: true });
}
