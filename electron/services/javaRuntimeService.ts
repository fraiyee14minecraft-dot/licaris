import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, chmod, cp, mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { launcherRuntimeConfig } from "../config";
import type { LauncherSyncProgressHandler } from "../types/launcher";
import { getLauncherDataDir } from "./installPaths";
import { writeLauncherLog } from "./logService";

const execFileAsync = promisify(execFile);
const JAVA_RUNTIME_DIR_NAME = "java-21";

interface JavaRuntimePackage {
  archiveName: string;
  archiveType: "zip" | "tar.gz";
  executableName: "java.exe" | "java";
  sha256: string;
  url: string;
}

export interface JavaRuntimeInfo {
  executable: string;
  majorVersion: number;
  versionText: string;
}

export function getJavaRuntimeDir(): string {
  return path.join(getLauncherDataDir(), "runtime", JAVA_RUNTIME_DIR_NAME);
}

export function getJavaExecutablePath(): string {
  return path.join(getJavaRuntimeDir(), "bin", process.platform === "win32" ? "java.exe" : "java");
}

export async function isJavaRuntimeInstalled(): Promise<boolean> {
  return pathExists(getJavaExecutablePath());
}

export async function checkJavaVersion(executable = getJavaExecutablePath()): Promise<JavaRuntimeInfo> {
  const { stdout, stderr } = await execFileAsync(executable, ["-version"], {
    shell: false,
    timeout: 10000,
    windowsHide: true
  });
  const versionText = `${stderr}\n${stdout}`.trim();
  const majorVersion = parseJavaMajorVersion(versionText);

  if (!majorVersion) {
    throw new Error(`Version Java illisible: ${versionText || "sortie vide"}`);
  }

  return {
    executable,
    majorVersion,
    versionText
  };
}

export async function validateJavaRuntime(): Promise<JavaRuntimeInfo> {
  const executable = getJavaExecutablePath();

  if (!(await pathExists(executable))) {
    throw new Error(`Java portable introuvable: ${executable}`);
  }

  const info = await checkJavaVersion(executable);

  if (info.majorVersion !== launcherRuntimeConfig.javaRuntime.version) {
    throw new Error(`Java ${info.majorVersion} détecté, Java ${launcherRuntimeConfig.javaRuntime.version} requis.`);
  }

  if (process.platform === "win32") {
    const javawPath = path.join(path.dirname(executable), "javaw.exe");

    if (!(await pathExists(javawPath))) {
      throw new Error(`javaw.exe introuvable dans le runtime portable: ${javawPath}`);
    }
  }

  return info;
}

export async function ensureJavaRuntime(onProgress?: LauncherSyncProgressHandler): Promise<JavaRuntimeInfo> {
  emitJavaProgress(onProgress, 3, "Vérification de Java 21...");
  await writeLauncherLog(`[java] Vérification de Java 21 portable: ${getJavaExecutablePath()}`);

  try {
    const existingRuntime = await validateJavaRuntime();
    await writeLauncherLog(`Using bundled Java runtime: ${existingRuntime.executable}`);
    emitJavaProgress(onProgress, 100, "Java 21 prêt");
    await writeLauncherLog(`[java] Java 21 portable prêt: ${existingRuntime.executable}. Version: ${existingRuntime.versionText}`);
    return existingRuntime;
  } catch (error) {
    await writeLauncherLog(`[java] Runtime Java portable absent ou invalide: ${formatError(error)}`);
  }

  emitJavaProgress(onProgress, 8, "Java 21 manquant, téléchargement...");

  try {
    const archivePath = await downloadJavaRuntime(onProgress);
    await extractJavaRuntime(archivePath, onProgress);
    const installedRuntime = await validateJavaRuntime();
    await writeLauncherLog(`Using bundled Java runtime: ${installedRuntime.executable}`);
    emitJavaProgress(onProgress, 100, "Java 21 prêt");
    await writeLauncherLog(`[java] Java 21 portable installé: ${installedRuntime.executable}. Version: ${installedRuntime.versionText}`);
    return installedRuntime;
  } catch (error) {
    const message = `Erreur Java : impossible de télécharger ou valider Java 21. ${formatError(error)}`;
    emitJavaProgress(onProgress, 0, message, "error");
    await writeLauncherLog(`[java] ${message}`);
    throw new Error(message);
  }
}

export async function downloadJavaRuntime(onProgress?: LauncherSyncProgressHandler): Promise<string> {
  const runtimePackage = getCurrentJavaRuntimePackage();

  const runtimeRoot = getRuntimeRootDir();
  const downloadsDir = path.join(runtimeRoot, "downloads");
  const archivePath = path.join(downloadsDir, runtimePackage.archiveName);
  const temporaryArchivePath = `${archivePath}.tmp`;

  await mkdir(downloadsDir, { recursive: true });
  await rm(temporaryArchivePath, { force: true });

  await writeLauncherLog(`[java] Téléchargement du runtime Java 21 depuis ${getSafeUrlHost(runtimePackage.url)}.`);
  emitJavaProgress(onProgress, 10, "Java 21 manquant, téléchargement...");

  const response = await fetch(runtimePackage.url, {
    cache: "no-store",
    redirect: "follow"
  });

  if (!response.ok) {
    throw new Error(`Téléchargement Java HTTP ${response.status}`);
  }

  if (!response.body) {
    throw new Error("Téléchargement Java impossible: réponse vide.");
  }

  const totalBytes = Number(response.headers.get("content-length") ?? "0");
  const file = createWriteStream(temporaryArchivePath);
  let downloadedBytes = 0;

  try {
    for await (const chunk of Readable.fromWeb(response.body as never)) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      downloadedBytes += buffer.byteLength;
      file.write(buffer);

      if (totalBytes > 0) {
        const downloadPercent = Math.round((downloadedBytes / totalBytes) * 62);
        emitJavaProgress(onProgress, 10 + downloadPercent, `Téléchargement Java 21 : ${Math.min(100, Math.round((downloadedBytes / totalBytes) * 100))}%`);
      } else {
        emitJavaProgress(onProgress, 35, `Téléchargement Java 21 : ${formatBytes(downloadedBytes)}`);
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      file.end((error?: Error | null) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  if (runtimePackage.sha256) {
    const actualHash = await computeSha256(temporaryArchivePath);

    if (actualHash.toLowerCase() !== runtimePackage.sha256.toLowerCase()) {
      await rm(temporaryArchivePath, { force: true });
      throw new Error("Hash SHA-256 de l'archive Java invalide.");
    }

    await writeLauncherLog("[java] Hash SHA-256 de l'archive Java validé.");
  } else {
    await writeLauncherLog("[java] Aucun hash SHA-256 configuré pour l'archive Java, vérification ignorée.");
  }

  await rename(temporaryArchivePath, archivePath);
  await writeLauncherLog(`[java] Archive Java téléchargée: ${archivePath}`);
  return archivePath;
}

export async function extractJavaRuntime(
  archivePath: string,
  onProgress?: LauncherSyncProgressHandler
): Promise<void> {
  const runtimePackage = getCurrentJavaRuntimePackage();
  assertPathInside(getLauncherDataDir(), archivePath);

  const runtimeRoot = getRuntimeRootDir();
  const temporaryExtractDir = path.join(runtimeRoot, "_extract-java-21");
  const stagingDir = path.join(runtimeRoot, "_staging-java-21");
  const runtimeDir = getJavaRuntimeDir();

  emitJavaProgress(onProgress, 78, "Installation de Java 21...");
  await writeLauncherLog("[java] Extraction du runtime Java 21.");
  await rm(temporaryExtractDir, { recursive: true, force: true });
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(temporaryExtractDir, { recursive: true });

  await extractRuntimeArchive(archivePath, temporaryExtractDir, runtimePackage.archiveType);

  const javaHome = await findJavaHomeInExtractedDir(temporaryExtractDir, runtimePackage.executableName);

  if (!javaHome) {
    throw new Error(`Archive Java invalide: bin/${runtimePackage.executableName} introuvable après extraction.`);
  }

  await cp(javaHome, stagingDir, { recursive: true, force: true });
  const stagingJava = path.join(stagingDir, "bin", runtimePackage.executableName);

  if (process.platform !== "win32") {
    await chmod(stagingJava, 0o755);
  }

  const stagingInfo = await checkJavaVersion(stagingJava);

  if (stagingInfo.majorVersion !== launcherRuntimeConfig.javaRuntime.version) {
    throw new Error(`Archive Java invalide: Java ${stagingInfo.majorVersion} détecté.`);
  }

  assertPathInside(runtimeRoot, runtimeDir);
  await rm(runtimeDir, { recursive: true, force: true });
  await rename(stagingDir, runtimeDir);
  await rm(temporaryExtractDir, { recursive: true, force: true });
  await writeLauncherLog(`[java] Runtime Java extrait dans ${runtimeDir}`);
}

function getCurrentJavaRuntimePackage(): JavaRuntimePackage {
  if (process.platform === "win32" && process.arch === "x64") {
    return {
      archiveName: "java-21-windows-x64.zip",
      archiveType: "zip",
      executableName: "java.exe",
      ...launcherRuntimeConfig.javaRuntime.windowsX64
    };
  }

  if (process.platform === "darwin" && process.arch === "arm64") {
    return {
      archiveName: "java-21-macos-arm64.tar.gz",
      archiveType: "tar.gz",
      executableName: "java",
      ...launcherRuntimeConfig.javaRuntime.macArm64
    };
  }

  throw new Error(
    `Le runtime Java portable automatique n'est pas disponible pour ${process.platform}/${process.arch}. ` +
      "Plateformes prises en charge: Windows x64 et macOS Apple Silicon."
  );
}

async function extractRuntimeArchive(
  archivePath: string,
  destinationDir: string,
  archiveType: JavaRuntimePackage["archiveType"]
): Promise<void> {
  if (archiveType === "tar.gz") {
    await spawnArchiveExtractor("/usr/bin/tar", ["-xzf", archivePath, "-C", destinationDir]);
    return;
  }

  await extractZipArchiveOnWindows(archivePath, destinationDir);
}

async function extractZipArchiveOnWindows(archivePath: string, destinationDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "Expand-Archive -LiteralPath $env:COBBLEMON_JAVA_ARCHIVE -DestinationPath $env:COBBLEMON_JAVA_DEST -Force"
      ],
      {
        env: {
          ...process.env,
          COBBLEMON_JAVA_ARCHIVE: archivePath,
          COBBLEMON_JAVA_DEST: destinationDir
        },
        shell: false,
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true
      }
    );

    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Extraction Java impossible. Code ${code}. ${stderr.trim()}`.trim()));
    });
  });
}

async function spawnArchiveExtractor(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Extraction Java impossible. Code ${code}. ${stderr.trim()}`.trim()));
    });
  });
}

async function findJavaHomeInExtractedDir(
  extractedDir: string,
  executableName: JavaRuntimePackage["executableName"]
): Promise<string | null> {
  const queue = [extractedDir];

  while (queue.length > 0) {
    const currentDir = queue.shift()!;
    const javaExecutable = path.join(currentDir, "bin", executableName);

    if (await pathExists(javaExecutable)) {
      return currentDir;
    }

    for (const entry of await readdir(currentDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        queue.push(path.join(currentDir, entry.name));
      }
    }
  }

  return null;
}

async function computeSha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(filePath));
  return hash.digest("hex");
}

function parseJavaMajorVersion(versionText: string): number | null {
  const legacyMatch = versionText.match(/version\s+"1\.(\d+)/i);

  if (legacyMatch?.[1]) {
    return Number(legacyMatch[1]);
  }

  const modernMatch = versionText.match(/version\s+"(\d+)(?:\.|\")/i);

  if (modernMatch?.[1]) {
    return Number(modernMatch[1]);
  }

  return null;
}

function getRuntimeRootDir(): string {
  return path.join(getLauncherDataDir(), "runtime");
}

function assertPathInside(parentDir: string, targetPath: string): void {
  const relativePath = path.relative(path.resolve(parentDir), path.resolve(targetPath));

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`Chemin runtime refusé: ${targetPath}`);
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function emitJavaProgress(
  onProgress: LauncherSyncProgressHandler | undefined,
  percent: number,
  message: string,
  phase: "check" | "copy" | "done" | "error" = percent >= 100 ? "done" : percent >= 75 ? "copy" : "check"
): void {
  onProgress?.({
    phase,
    current: Math.max(0, Math.min(100, Math.round(percent))),
    total: 100,
    percent: Math.max(0, Math.min(100, Math.round(percent))),
    message
  });
}

function getSafeUrlHost(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return "URL Java configurée";
  }
}

function formatBytes(value: number): string {
  const units = ["o", "Ko", "Mo", "Go"];
  let size = value;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

