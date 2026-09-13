import { launcherRuntimeConfig } from '../config';

const REDACTED_IP = "[REDACTED_IP]";
const REDACTED_TOKEN = "[REDACTED_TOKEN]";
const REDACTED_USER_DATA = "[USER_DATA]";
const REDACTED_SERVER = "[REDACTED_SERVER]";
const REDACTED_PORT = "[REDACTED_PORT]";
const REDACTED_UUID = "[REDACTED_UUID]";
const REDACTED_EMAIL = "[REDACTED_EMAIL]";
const REDACTED_CHAT = "[CHAT_MESSAGE_REDACTED]";

const SENSITIVE_KEYS = [
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "idToken",
  "id_token",
  "authorizationCode",
  "authorization_code",
  "clientSecret",
  "client_secret",
  "ghToken",
  "gh_token",
  "githubToken",
  "github_token",
  "password",
  "passwd",
  "secret",
  "device_code",
  "user_code"
];

const SENSITIVE_LAUNCH_ARGUMENTS = new Set([
  "--accessToken",
  "--access-token",
  "--uuid",
  "--xuid",
  "--clientId",
  "--client-id",
  "--userProperties",
  "--user-properties"
]);

export function sanitizeLogMessage(message: string): string {
  let sanitized = String(message);

  sanitized = redactSensitiveValue(sanitized);
  sanitized = redactServerAddress(sanitized);
  sanitized = redactIpAddresses(sanitized);
  sanitized = redactIpv6Addresses(sanitized);
  sanitized = redactUuids(sanitized);
  sanitized = redactEmailAddresses(sanitized);
  sanitized = redactChatMessages(sanitized);
  sanitized = redactUserPaths(sanitized);

  return sanitized;
}

export function redactSensitiveValue(value: string): string {
  let sanitized = value;

  sanitized = sanitized.replace(/\bAuthorization\s*[:=]\s*Bearer\s+[A-Za-z0-9._~+/=-]+/giu, `Authorization: Bearer ${REDACTED_TOKEN}`);
  sanitized = sanitized.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, `Bearer ${REDACTED_TOKEN}`);
  sanitized = sanitized.replace(/\bXBL3\.0\s+x=[^\s,;}]+/giu, `XBL3.0 x=${REDACTED_TOKEN}`);

  for (const key of SENSITIVE_KEYS) {
    const escapedKey = escapeRegExp(key);
    sanitized = sanitized.replace(
      new RegExp(`(["']?${escapedKey}["']?\\s*[:=]\\s*)["']?[^"',\\s)}\\]]+["']?`, "giu"),
      `$1${REDACTED_TOKEN}`
    );
  }

  for (const argument of SENSITIVE_LAUNCH_ARGUMENTS) {
    const escapedArgument = escapeRegExp(argument);
    sanitized = sanitized.replace(
      new RegExp(`(${escapedArgument}(?:\\s+|=))(?:"[^"]*"|'[^']*'|\\S+)`, "giu"),
      `$1${REDACTED_TOKEN}`
    );
  }

  sanitized = sanitized.replace(/\bgithub_pat_[A-Za-z0-9_]+/gu, REDACTED_TOKEN);
  sanitized = sanitized.replace(/\bgh[pousr]_[A-Za-z0-9_]+/gu, REDACTED_TOKEN);
  sanitized = sanitized.replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, REDACTED_TOKEN);
  sanitized = sanitized.replace(/\b(xuid)\s*[:=]\s*["']?[^"',\s)}\]]+/giu, `$1=${REDACTED_TOKEN}`);
  sanitized = sanitized.replace(/([?&](?:access_token|refresh_token|id_token|token|key|auth)=)[^&\s]+/giu, `$1${REDACTED_TOKEN}`);
  sanitized = sanitized.replace(/(Property\[name=textures,\s*value=)[^,\]\s]+/giu, `$1${REDACTED_TOKEN}`);
  sanitized = sanitized.replace(/(,\s*signature=)[^\]\s]+/giu, `$1${REDACTED_TOKEN}`);

  return sanitized;
}

export function sanitizeLaunchArgs(args: string[]): string[] {
  return args.map((arg, index) => {
    const previousArg = args[index - 1];

    if (previousArg && SENSITIVE_LAUNCH_ARGUMENTS.has(previousArg)) {
      return REDACTED_TOKEN;
    }

    const [key, value] = arg.split("=", 2);

    if (value !== undefined && SENSITIVE_LAUNCH_ARGUMENTS.has(key)) {
      return `${key}=${REDACTED_TOKEN}`;
    }

    return sanitizeLogMessage(arg);
  });
}

function redactServerAddress(value: string): string {
  const {host, port} = launcherRuntimeConfig.officialServer;
  let sanitized = value;
  if (host) sanitized = sanitized.replace(new RegExp(`${escapeRegExp(host)}(?::\\d{1,5})?`, 'giu'), REDACTED_SERVER);
  if (port) sanitized = sanitized.replace(new RegExp(`\\b${port}\\b`, 'gu'), REDACTED_PORT);
  return sanitized;
}

function redactIpAddresses(value: string): string {
  return value.replace(
    /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?::\d{1,5})?\b/gu,
    REDACTED_IP
  );
}

function redactIpv6Addresses(value: string): string {
  return value
    .replace(/\[[0-9A-F:]{2,}\](?::\d{1,5})?/giu, REDACTED_IP)
    .replace(/(?<![\w:])(?:[0-9A-F]{1,4}:){3,7}[0-9A-F]{0,4}(?![\w:])/giu, REDACTED_IP);
}

function redactUuids(value: string): string {
  return value
    .replace(/\b[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\b/giu, REDACTED_UUID)
    .replace(/\b[0-9A-F]{32}\b/giu, REDACTED_UUID);
}

function redactEmailAddresses(value: string): string {
  return value.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, REDACTED_EMAIL);
}

function redactChatMessages(value: string): string {
  return value
    .split(/\r?\n/u)
    .map((line) => (/\[(?:CHAT|CHAT PREVIEW)\]/iu.test(line) ? REDACTED_CHAT : line))
    .join("\n");
}

function redactUserPaths(value: string): string {
  return value
    .replace(/[A-Za-z]:\\Users\\[^\\\r\n\t ]+/gu, REDACTED_USER_DATA)
    .replace(/[A-Za-z]:\/Users\/[^\/\r\n\t ]+/gu, REDACTED_USER_DATA)
    .replace(/\/Users\/[^\/\r\n\t ]+/gu, REDACTED_USER_DATA)
    .replace(/file:\/\/\/[A-Za-z]:\/Users\/[^\/\r\n\t ]+/gu, `file:///${REDACTED_USER_DATA}`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
