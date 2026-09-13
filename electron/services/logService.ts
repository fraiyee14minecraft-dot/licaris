import { EventEmitter } from "node:events";
import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";
import type { LauncherLogEntry, LauncherLogLevel, LauncherLogSource } from "../types/launcher";
import { getLogsDir } from "./installPaths";
import { sanitizeLogMessage } from "./logSanitizer";

type LogListener = (entry: LauncherLogEntry) => void;

const logEmitter = new EventEmitter();
const sessionLogs: LauncherLogEntry[] = [];
let nextLogId = 1;

export async function writeLauncherLog(message: string): Promise<void> {
  const entry = createLogEntry(sanitizeLogMessage(message));
  sessionLogs.push(entry);
  logEmitter.emit("entry", entry);

  try {
    const logsDir = getLogsDir();
    const line = formatLogLine(entry);

    await mkdir(logsDir, { recursive: true });
    await Promise.all([
      appendFile(getLauncherLogFile(), line, "utf8"),
      appendFile(getDailyLauncherLogFile(entry.timestamp), line, "utf8")
    ]);
  } catch (error) {
    const detail = sanitizeLogMessage(error instanceof Error ? error.message : String(error));
    console.error(`[logs] Unable to write launcher log: ${detail}`);
  }
}

export function getCurrentSessionLogs(): LauncherLogEntry[] {
  return [...sessionLogs];
}

export function clearDisplayedLogs(): void {
  sessionLogs.length = 0;
}

export function getLauncherLogFile(): string {
  return path.join(getLogsDir(), "launcher.log");
}

export function getDailyLauncherLogFile(timestamp = new Date().toISOString()): string {
  const date = timestamp.slice(0, 10);
  return path.join(getLogsDir(), `launcher-${date}.log`);
}

export function addLogListener(listener: LogListener): () => void {
  logEmitter.on("entry", listener);

  return () => {
    logEmitter.off("entry", listener);
  };
}

function createLogEntry(message: string): LauncherLogEntry {
  return {
    id: nextLogId++,
    timestamp: new Date().toISOString(),
    level: inferLogLevel(message),
    source: inferLogSource(message),
    message
  };
}

function inferLogLevel(message: string): LauncherLogLevel {
  const normalized = normalize(message);

  if (
    /\b(debug|trace)\b/.test(normalized)
  ) {
    return "debug";
  }

  if (
    [
      "error",
      "erreur",
      "failed",
      "failure",
      "impossible",
      "invalid",
      "missing",
      "introuvable",
      "manquant",
      "manquante",
      "blocked",
      "refuse"
    ].some((term) => normalized.includes(term))
  ) {
    return "error";
  }

  if (
    [
      "warn",
      "fallback",
      "hors ligne",
      "unavailable",
      "indisponible",
      "pending",
      "attente"
    ].some((term) => normalized.includes(term))
  ) {
    return "warn";
  }

  if (
    [
      " ok",
      "ready",
      "pret",
      "prêt",
      "started",
      "connecte",
      "connecté",
      "recupere",
      "récupéré",
      "telecharge",
      "téléchargé",
      "installe",
      "installé",
      "a jour"
    ].some((term) => normalized.includes(term))
  ) {
    return "success";
  }

  return "info";
}

function inferLogSource(message: string): LauncherLogSource {
  const normalized = normalize(message);

  if (normalized.startsWith("[minecraft:") || normalized.includes("minecraft process")) {
    return "minecraft";
  }

  if (normalized.startsWith("[auth]") || normalized.includes("microsoft") || normalized.includes("profil minecraft")) {
    return "auth";
  }

  if (normalized.startsWith("[java]")) {
    return "java";
  }

  if (normalized.startsWith("[skin]") || normalized.includes("skin minecraft")) {
    return "skin";
  }

  if (normalized.startsWith("[server]") || normalized.includes("ping serveur")) {
    return "server";
  }

  if (
    normalized.startsWith("[modpack]") ||
    normalized.startsWith("[sync]") ||
    normalized.startsWith("[manifest]") ||
    normalized.includes("modpack") ||
    normalized.includes("sha-256")
  ) {
    return "modpack";
  }

  return "launcher";
}

function formatLogLine(entry: LauncherLogEntry): string {
  return `[${entry.timestamp}] [${entry.level.toUpperCase()}] [${entry.source}] ${entry.message}\n`;
}

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}
