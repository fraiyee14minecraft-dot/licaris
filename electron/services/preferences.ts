import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { getSettingsFile } from './installPaths';
import { launcherRuntimeConfig, setServer } from '../config';
export interface Preferences {ramGb: number; serverHost: string; serverPort: number; microsoftClientId: string}
export function validatePreferences(input: any): Preferences {
  const host = String(input?.serverHost ?? '').trim().replace(/^\[|\]$/g, '');
  const port = Number(input?.serverPort);
  const ram = Number(input?.ramGb);
  const id = String(input?.microsoftClientId ?? '').trim();
  if (host && !net.isIP(host) && !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host)) throw new Error('Saisis un hôte sans protocole ni port.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Le port doit être compris entre 1 et 65535.');
  if (![4,6,8,10,12,16].includes(ram) || ram > Math.floor(os.totalmem() / 1024 ** 3) - 2) throw new Error('Choisis une quantité de RAM qui laisse au moins 2 Go à Windows.');
  if (id && !/^[a-z0-9-]{8,64}$/i.test(id)) throw new Error('Identifiant d’application Microsoft invalide.');
  return {ramGb:ram, serverHost:host, serverPort:port, microsoftClientId:id};
}
export function applyPreferences(settings: Preferences): void {
  launcherRuntimeConfig.microsoftClientId = settings.microsoftClientId;
  setServer(settings.serverHost, settings.serverPort);
}
export async function readPreferences(): Promise<Preferences> {
  try {
    const saved = JSON.parse(await readFile(getSettingsFile(), 'utf8'));
    // Fill the previously empty server setting without replacing a custom address.
    if (!String(saved.serverHost ?? '').trim()) {
      saved.serverHost = launcherRuntimeConfig.officialServer.host;
      saved.serverPort = launcherRuntimeConfig.officialServer.port;
    }
    saved.microsoftClientId = launcherRuntimeConfig.microsoftClientId;
    return validatePreferences(saved);
  }
  catch (e: any) {
    if (e.code !== 'ENOENT') throw new Error(`Réglages invalides : ${e.message}`);
    return {ramGb:Math.floor(os.totalmem()/1024**3) >= 10 ? 8 : 4, serverHost:launcherRuntimeConfig.officialServer.host,
      serverPort:launcherRuntimeConfig.officialServer.port, microsoftClientId:launcherRuntimeConfig.microsoftClientId};
  }
}
export async function savePreferences(input: unknown): Promise<Preferences> {
  const settings = validatePreferences(input);
  await mkdir(path.dirname(getSettingsFile()), {recursive:true});
  await writeFile(getSettingsFile()+'.tmp', JSON.stringify(settings, null, 2));
  await rename(getSettingsFile()+'.tmp', getSettingsFile());
  applyPreferences(settings);
  return settings;
}
