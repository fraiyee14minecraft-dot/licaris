import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, lstat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as yauzl from 'yauzl';
import { getLauncherDataDir, getMinecraftInstanceDir } from './installPaths';

export interface PackFile { path: string; url: string; size: number; sha256: string }
export interface PackLock { id:string; version: string; minecraftVersion: string; fabricLoaderVersion: string; archive: Omit<PackFile, 'path'>; files: PackFile[] }
export type Progress = (message: string, percent: number) => void;
export function readPackLock(): Promise<PackLock> {
  return readFile(path.join(__dirname, '../../pack/pack-lock.json'), 'utf8').then(JSON.parse);
}
export function safePath(root: string, relative: string): string {
  if (!relative || relative.includes('\\') || relative.includes(':') || relative.includes('\0') || relative.startsWith('/') || relative.split('/').some(p => p === '..' || p === '.' || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(p))) {
    throw new Error(`Chemin de fichier refusé : ${relative}`);
  }
  const target = path.resolve(root, relative);
  if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error('Chemin hors de l’instance.');
  return target;
}
async function rejectLinks(root: string, target: string): Promise<void> {
  let current = target;
  while (current.length >= path.resolve(root).length) {
    const info = await lstat(current).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
    if (info?.isSymbolicLink()) throw new Error('Lien symbolique refusé dans les fichiers gérés.');
    if (current === path.resolve(root)) break;
    current = path.dirname(current);
  }
}
export async function hashFile(file: string, knownSize?:number): Promise<string> {
  if(knownSize !== undefined && knownSize <= 1024*1024) return createHash('sha256').update(await readFile(file)).digest('hex');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export async function matches(file: string, expected: {size: number; sha256: string}): Promise<boolean> {
  try { return (await stat(file)).size === expected.size && await hashFile(file) === expected.sha256; }
  catch (e: any) { if (e.code === 'ENOENT') return false; throw e; }
}
function assertDownloadUrl(value: string): void {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !(url.hostname.endsWith('.forgecdn.net') || value.startsWith('https://github.com/fraiyee14minecraft-dot/licaris/releases/download/') || url.hostname === 'release-assets.githubusercontent.com') || url.username || url.password) throw new Error('Source du pack non autorisée.');
}
export async function download(file: Omit<PackFile, 'path'>, destination: string): Promise<void> {
  assertDownloadUrl(file.url);
  if (await matches(destination, file)) return;
  await mkdir(path.dirname(destination), {recursive:true});
  const temporary = destination + '.part';
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(file.url, {signal: AbortSignal.timeout(180_000)});
      if (!response.ok || !response.body) throw new Error(`Téléchargement impossible (HTTP ${response.status}).`);
      assertDownloadUrl(response.url);
      let bytes = 0;
      const limit = new Transform({transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        callback(bytes > file.size ? new Error('Téléchargement plus grand que prévu.') : null, chunk);
      }});
      await pipeline(Readable.fromWeb(response.body as any), limit, createWriteStream(temporary));
      if (!await matches(temporary, file)) throw new Error('Le fichier téléchargé ne correspond pas au pack (SHA-256).');
      await rename(temporary, destination);
      return;
    } catch (error) { lastError = error; await rm(temporary, {force:true}); }
  }
  throw lastError;
}

export async function extractOverrides(archive: string, instance: string, onCount?: (count:number, total:number) => void, overwrite = false): Promise<number> {
  // Buffer-backed random access avoids Electron's ASAR filesystem wrapper when
  // reading a large external archive. Keep a strict compressed-size limit.
  if ((await stat(archive)).size > 512 * 1024 ** 2) throw new Error('Archive compressée trop volumineuse.');
  const archiveBytes = await readFile(archive);
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.fromBuffer(archiveBytes, {lazyEntries:true, autoClose:true}, (err, value) => err || !value ? reject(err) : resolve(value)));
  let count = 0;
  let totalBytes = 0;
  return new Promise((resolve, reject) => {
    zip.on('error', reject);
    zip.on('end', () => resolve(count));
    zip.on('entry', (entry: yauzl.Entry) => {
      void (async () => {
        if (count % 200 === 0) onCount?.(count, zip.entryCount);
        if (!entry.fileName.startsWith('overrides/') || entry.fileName.endsWith('/')) { zip.readEntry(); return; }
        const relative = entry.fileName.slice('overrides/'.length);
        const target = safePath(instance, relative);
        if (((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000) throw new Error('Lien symbolique refusé dans le pack.');
        totalBytes += entry.uncompressedSize;
        if (totalBytes > 4 * 1024 ** 3 || entry.uncompressedSize > 512 * 1024 ** 2) throw new Error('Archive trop volumineuse.');
        await rejectLinks(instance, target);
        // Preserve personal options, configuration and saves during repair.
        const exists = await stat(target).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
        if (exists && !overwrite && !relative.startsWith('mods/')) { count++; zip.readEntry(); return; }
        await mkdir(path.dirname(target), {recursive:true});
        const stream = await new Promise<Readable>((res, rej) => zip.openReadStream(entry, (err, value) => err || !value ? rej(err) : res(value)));
        const temporary = target + '.part';
        try { await pipeline(stream, createWriteStream(temporary)); await rename(temporary, target); }
        catch (error) { await rm(temporary, {force:true}); throw error; }
        count++;
        zip.readEntry();
      })().catch(error => { zip.close(); reject(error); });
    });
    zip.readEntry();
  });
}
export async function installPack(progress: Progress): Promise<void> {
  const {launcherRuntimeConfig}=await import('../config');
  if(launcherRuntimeConfig.distributionEnabled) { await (await import('./publishedPackService')).installPublishedPack(progress); return; }
  const lock = await readPackLock();
  const instance = getMinecraftInstanceDir();
  const archive = path.join(getLauncherDataDir(), 'cache', `${lock.id}-${lock.version}.zip`);
  progress('Récupération du pack officiel…', 2);
  await download(lock.archive, archive);
  progress('Préparation des configurations du pack…', 6);
  await mkdir(instance, {recursive:true});
  await extractOverrides(archive, instance, (count,total) => progress(`Configurations et ressources : ${count} fichiers`, 6 + 2*count/total));
  let next = 0, complete = 0;
  let failure: unknown;
  await Promise.all(Array.from({length:4}, async () => {
    while (next < lock.files.length && !failure) {
      const file = lock.files[next++];
      try {
        const destination = safePath(instance, file.path);
        await rejectLinks(instance, destination);
        await download(file, destination);
        complete++;
        progress(`Fichiers du pack : ${complete}/${lock.files.length}`, 8 + 90 * complete / lock.files.length);
      } catch (error) { failure = new Error(`${file.path} : ${error instanceof Error ? error.message : error}`); }
    }
  }));
  if (failure) throw failure;
  await writeFile(path.join(instance, '.launcher-pack-installed.json'), JSON.stringify({version:lock.version, installedAt:new Date().toISOString()}));
  progress('Modpack vérifié.', 100);
}
