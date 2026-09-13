import { readFileSync } from 'node:fs';
import path from 'node:path';

const publicConfig = JSON.parse(readFileSync(path.join(__dirname, '..', 'launcher-config.json'), 'utf8'));
export const packDefinition = JSON.parse(readFileSync(path.join(__dirname, '..', 'pack/pack-lock.json'), 'utf8')) as {
  id:string; label:string; edition:string; name:string; version:string; minecraftVersion:string; fabricLoaderVersion:string; source:string;
};
if (!/^[a-z0-9-]+$/.test(packDefinition.id) || !/^[a-zA-Z0-9._-]+$/.test(packDefinition.version)) throw new Error('Identifiant de pack invalide.');
export const launcherRuntimeConfig = {
  launcherName: 'Cobblemon Launcher',
  distributionEnabled: publicConfig.distributionEnabled === true,
  minecraftVersion: packDefinition.minecraftVersion,
  fabricLoaderVersion: packDefinition.fabricLoaderVersion,
  microsoftClientId: String(publicConfig.microsoftClientId || ''),
  officialServer: {
    name: 'Cobblemon entre amis', host: String(publicConfig.serverHost || ''), port: Number(publicConfig.serverPort || 25565),
    addressForMinecraftList: '', addressForPing: {host: '', port: 25565}
  },
  javaRuntime: {
    version: 21,
    windowsX64: publicConfig.javaRuntime?.windowsX64 ?? {url: 'https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jre/hotspot/normal/eclipse', sha256: ''},
    macArm64: {url: 'https://api.adoptium.net/v3/binary/latest/21/ga/mac/aarch64/jre/hotspot/normal/eclipse', sha256: ''}
  }
};
export function setServer(host: string, port: number): void {
  const server = launcherRuntimeConfig.officialServer;
  server.host = host; server.port = port;
  server.addressForPing = {host, port};
  server.addressForMinecraftList = host ? `${host.includes(':') ? `[${host}]` : host}:${port}` : '';
}
setServer(launcherRuntimeConfig.officialServer.host, launcherRuntimeConfig.officialServer.port);
