import { shell } from "electron";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { launcherRuntimeConfig } from "../config";
import type { LauncherActionResult, MicrosoftAuthStatus } from "../types/launcher";
import {
  clearAuthSession,
  readAuthSession,
  saveAuthSession,
  type StoredAuthSession
} from "./authSessionStore";
import { getMinecraftAvatarDataUrl } from "./avatarService";
import { writeLauncherLog } from "./logService";

type AuthStatusHandler = (status: MicrosoftAuthStatus) => void;

interface MicrosoftTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval?: number;
  message?: string;
}

interface XboxLiveAuthResponse {
  Token: string;
  DisplayClaims?: {
    xui?: Array<{
      uhs?: string;
    }>;
  };
}

interface MinecraftLoginResponse {
  access_token: string;
  expires_in: number;
}

interface MinecraftEntitlementsResponse {
  items?: Array<{
    name?: string;
  }>;
}

interface MinecraftProfileResponse {
  id: string;
  name: string;
}

interface AuthorizationCodeResult {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

interface LoopbackAuthServer {
  redirectUri: string;
  waitForCode: () => Promise<string>;
  close: () => Promise<void>;
}

class HttpServiceError extends Error {
  constructor(
    public readonly endpoint: string,
    public readonly status: number,
    public readonly detail: string
  ) {
    super(`${endpoint} a répondu HTTP ${status}: ${detail}`);
  }
}

const MICROSOFT_AUTHORIZE_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize";
const MICROSOFT_DEVICE_CODE_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode";
const MICROSOFT_TOKEN_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
const MINECRAFT_LOGIN_WITH_XBOX_URL = "https://api.minecraftservices.com/authentication/login_with_xbox";
const MINECRAFT_PROFILE_URL = "https://api.minecraftservices.com/minecraft/profile";
const MICROSOFT_SCOPES = "XboxLive.signin offline_access";
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const BROWSER_AUTH_TIMEOUT_MS = 5 * 60 * 1000;
const LOOPBACK_HOST = "localhost";
const LOOPBACK_CALLBACK_PATH = "/auth/callback";
const MICROSOFT_NOT_CONFIGURED_MESSAGE = "Connexion Microsoft non configurée en mode développement";
const MINECRAFT_APP_NOT_APPROVED_MESSAGE =
  "Connexion Microsoft réussie, mais l’application du launcher n’est pas encore autorisée par Minecraft Services.\n" +
  "L’organisateur doit faire autoriser l’App ID auprès de Minecraft Services.\n" +
  "Ce n’est pas un problème de compte joueur.";
const MINECRAFT_PROFILE_NOT_FOUND_MESSAGE =
  "Connexion Microsoft réussie, mais aucun profil Minecraft Java n’a été trouvé sur ce compte.\n" +
  "Vérifie que ce compte possède Minecraft Java Edition et qu’un pseudo/profil Java est configuré dans le launcher officiel Minecraft.";

let authenticatedSessionInFlight: Promise<StoredAuthSession | null> | null = null;

export async function getMicrosoftAuthStatus(): Promise<MicrosoftAuthStatus> {
  const session = await getAuthenticatedSession();

  if (!session) {
    return {
      state: "signed-out",
      message: "Non connecté"
    };
  }

  return createSignedInAuthStatus(session);
}

export async function getAuthenticatedSession(): Promise<StoredAuthSession | null> {
  if (authenticatedSessionInFlight) {
    return authenticatedSessionInFlight;
  }

  authenticatedSessionInFlight = loadAuthenticatedSession().finally(() => {
    authenticatedSessionInFlight = null;
  });
  return authenticatedSessionInFlight;
}

async function loadAuthenticatedSession(): Promise<StoredAuthSession | null> {
  const session = await readAuthSession();

  if (!session) {
    return null;
  }

  if (session.minecraft.expiresAt > Date.now() + TOKEN_REFRESH_MARGIN_MS) {
    await writeLauncherLog(`[auth] Stored session reused for ${session.minecraft.profile.name}.`);
    return session;
  }

  try {
    const refreshedSession = await refreshSession(session);
    await saveAuthSession(refreshedSession);
    await writeLauncherLog(`[auth] Session refreshed for ${refreshedSession.minecraft.profile.name}.`);
    return refreshedSession;
  } catch (error) {
    await clearAuthSession();
    await writeLauncherLog(`[auth] Refresh failed. ${formatError(error)}`);
    return null;
  }
}

export async function startMicrosoftLogin(onStatus?: AuthStatusHandler): Promise<LauncherActionResult> {
  try {
    assertMicrosoftClientId();
    emitAuthStatus(onStatus, {
      state: "signing-in",
      message: "Connexion Microsoft ouverte dans votre navigateur..."
    });
    await writeLauncherLog("[auth] Microsoft browser login started.");

    const authorization = await requestAuthorizationCodeWithPkce(onStatus);
    const microsoftToken = await exchangeAuthorizationCodeForToken(authorization);
    await writeLauncherLog("[auth] Microsoft authorization code exchanged.");
    const session = await createSessionFromMicrosoftToken(microsoftToken);

    await saveAuthSession(session);

    const status = await createSignedInAuthStatus(session);

    emitAuthStatus(onStatus, status);
    await writeLauncherLog(`[auth] Microsoft browser login OK for ${session.minecraft.profile.name}.`);

    return {
      ok: true,
      message: status.message
    };
  } catch (error) {
    const message = formatAuthError(error);
    emitAuthStatus(onStatus, {
      state: "error",
      message
    });
    await logAuthError(error, message);

    return {
      ok: false,
      message
    };
  }
}

export async function startMicrosoftDeviceCodeLogin(onStatus?: AuthStatusHandler): Promise<LauncherActionResult> {
  try {
    assertMicrosoftClientId();
    emitAuthStatus(onStatus, {
      state: "signing-in",
      message: "Connexion par code Microsoft en cours"
    });
    await writeLauncherLog("[auth] Microsoft device code fallback login started.");

    const deviceCode = await requestDeviceCode();
    emitAuthStatus(onStatus, {
      state: "signing-in",
      message: `Connexion en cours. Code: ${deviceCode.user_code}`
    });

    await shell.openExternal(deviceCode.verification_uri);
    const microsoftToken = await pollMicrosoftToken(deviceCode, onStatus);
    const session = await createSessionFromMicrosoftToken(microsoftToken);

    await saveAuthSession(session);

    const status = await createSignedInAuthStatus(session);

    emitAuthStatus(onStatus, status);
    await writeLauncherLog(`[auth] Microsoft device code fallback login OK for ${session.minecraft.profile.name}.`);

    return {
      ok: true,
      message: status.message
    };
  } catch (error) {
    const message = formatAuthError(error);
    emitAuthStatus(onStatus, {
      state: "error",
      message
    });
    await logAuthError(error, message);

    return {
      ok: false,
      message
    };
  }
}

async function requestAuthorizationCodeWithPkce(onStatus?: AuthStatusHandler): Promise<AuthorizationCodeResult> {
  const codeVerifier = createPkceCodeVerifier();
  const codeChallenge = createPkceCodeChallenge(codeVerifier);
  const state = createOpaqueToken(32);
  const loopbackServer = await createLoopbackAuthServer(state);

  await writeLauncherLog(`[auth] PKCE challenge generated. Redirect URI: ${loopbackServer.redirectUri}`);

  try {
    const authorizeUrl = buildMicrosoftAuthorizeUrl(loopbackServer.redirectUri, codeChallenge, state);
    await shell.openExternal(authorizeUrl);
    emitAuthStatus(onStatus, {
      state: "signing-in",
      message: "Connexion Microsoft ouverte dans votre navigateur..."
    });

    const code = await loopbackServer.waitForCode();
    await writeLauncherLog("[auth] Microsoft browser callback received.");

    return {
      code,
      codeVerifier,
      redirectUri: loopbackServer.redirectUri
    };
  } finally {
    await loopbackServer.close();
  }
}

export function buildMicrosoftAuthorizeUrl(redirectUri: string, codeChallenge: string, state: string): string {
  const url = new URL(MICROSOFT_AUTHORIZE_URL);
  url.searchParams.set("client_id", launcherRuntimeConfig.microsoftClientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("scope", MICROSOFT_SCOPES);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");

  return url.toString();
}

async function exchangeAuthorizationCodeForToken(authorization: AuthorizationCodeResult): Promise<MicrosoftTokenResponse> {
  return postForm<MicrosoftTokenResponse>(MICROSOFT_TOKEN_URL, {
    grant_type: "authorization_code",
    client_id: launcherRuntimeConfig.microsoftClientId,
    scope: MICROSOFT_SCOPES,
    code: authorization.code,
    redirect_uri: authorization.redirectUri,
    code_verifier: authorization.codeVerifier
  });
}

async function createLoopbackAuthServer(expectedState: string): Promise<LoopbackAuthServer> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let isClosed = false;
  let resolveCode: (code: string) => void = () => undefined;
  let rejectCode: (error: Error) => void = () => undefined;

  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = createServer((request, response) => {
    handleLoopbackCallback(request, response, expectedState, resolveCode, rejectCode);
  });

  const redirectUri = await new Promise<string>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK_HOST, () => {
      server.removeListener("error", reject);
      const address = server.address() as AddressInfo | null;

      if (!address?.port) {
        reject(new Error("Serveur local OAuth indisponible."));
        return;
      }

      resolve(`http://${LOOPBACK_HOST}:${address.port}${LOOPBACK_CALLBACK_PATH}`);
    });
  });

  timeout = setTimeout(() => {
    rejectCode(new Error("Connexion Microsoft expiree. Relance la connexion."));
  }, BROWSER_AUTH_TIMEOUT_MS);

  return {
    redirectUri,
    waitForCode: () => codePromise,
    close: async () => {
      if (timeout) {
        clearTimeout(timeout);
      }

      if (isClosed || !server.listening) {
        return;
      }

      isClosed = true;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  };
}

function handleLoopbackCallback(
  request: IncomingMessage,
  response: ServerResponse,
  expectedState: string,
  resolveCode: (code: string) => void,
  rejectCode: (error: Error) => void
): void {
  const requestUrl = new URL(request.url ?? "/", `http://${LOOPBACK_HOST}`);

  if (requestUrl.pathname !== LOOPBACK_CALLBACK_PATH) {
    sendLoopbackHtml(response, 404, "Page introuvable", "Ce point d'acces est reserve a la connexion Microsoft.");
    return;
  }

  const error = requestUrl.searchParams.get("error");

  if (error) {
    const detail = requestUrl.searchParams.get("error_description") ?? error;
    sendLoopbackHtml(response, 400, "Connexion annulee", "La connexion Microsoft n'a pas ete terminee.");
    rejectCode(new Error(mapMicrosoftOAuthError(error, detail)));
    return;
  }

  const state = requestUrl.searchParams.get("state");

  if (state !== expectedState) {
    sendLoopbackHtml(response, 400, "Connexion refusee", "Le controle de securite OAuth a echoue.");
    rejectCode(new Error("Callback Microsoft refuse: state OAuth invalide."));
    return;
  }

  const code = requestUrl.searchParams.get("code");

  if (!code) {
    sendLoopbackHtml(response, 400, "Connexion incomplete", "Microsoft n'a pas renvoye de code d'autorisation.");
    rejectCode(new Error("Callback Microsoft invalide: code d'autorisation absent."));
    return;
  }

  sendLoopbackHtml(response, 200, "Connexion reussie", "Connexion reussie, vous pouvez retourner au launcher.");
  resolveCode(code);
}

function sendLoopbackHtml(response: ServerResponse, status: number, title: string, message: string): void {
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(`<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(title)}</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #070305; color: #f4e8c8; font-family: system-ui, -apple-system, Segoe UI, sans-serif; }
      main { max-width: 560px; padding: 34px; border: 1px solid rgba(224, 194, 122, .28); border-radius: 18px; background: rgba(18, 13, 9, .82); box-shadow: 0 24px 70px rgba(0,0,0,.55); text-align: center; }
      h1 { margin: 0 0 12px; font-size: 26px; }
      p { margin: 0; color: #b8a98a; line-height: 1.55; }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
    </main>
  </body>
</html>`);
}

function mapMicrosoftOAuthError(error: string, detail: string): string {
  if (error === "access_denied") {
    return "Connexion Microsoft annulee.";
  }

  return `Erreur OAuth Microsoft: ${detail}`;
}

function createPkceCodeVerifier(): string {
  return createOpaqueToken(64);
}

function createPkceCodeChallenge(codeVerifier: string): string {
  return toBase64Url(createHash("sha256").update(codeVerifier).digest());
}

function createOpaqueToken(bytes: number): string {
  return toBase64Url(randomBytes(bytes));
}

function toBase64Url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

export async function logoutMicrosoft(onStatus?: AuthStatusHandler): Promise<LauncherActionResult> {
  await authenticatedSessionInFlight?.catch(() => null);
  await clearAuthSession();
  const status: MicrosoftAuthStatus = {
    state: "signed-out",
    message: "Non connecté"
  };

  emitAuthStatus(onStatus, status);
  await writeLauncherLog("[auth] Microsoft logout.");

  return {
    ok: true,
    message: "Déconnecté."
  };
}

function emitAuthStatus(onStatus: AuthStatusHandler | undefined, status: MicrosoftAuthStatus): void {
  onStatus?.(status);
}

function assertMicrosoftClientId(): void {
  if (!launcherRuntimeConfig.microsoftClientId.trim()) {
    throw new Error(MICROSOFT_NOT_CONFIGURED_MESSAGE);
  }
}

async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  const response = await postForm<DeviceCodeResponse>(MICROSOFT_DEVICE_CODE_URL, {
    client_id: launcherRuntimeConfig.microsoftClientId,
    scope: MICROSOFT_SCOPES
  });

  if (!response.device_code || !response.user_code || !response.verification_uri) {
    throw new Error("Réponse Microsoft device code invalide.");
  }

  return response;
}

async function pollMicrosoftToken(
  deviceCode: DeviceCodeResponse,
  onStatus?: AuthStatusHandler
): Promise<MicrosoftTokenResponse> {
  let intervalSeconds = deviceCode.interval ?? 5;
  const expiresAt = Date.now() + deviceCode.expires_in * 1000;

  while (Date.now() < expiresAt) {
    await delay(intervalSeconds * 1000);

    const response = await fetch(MICROSOFT_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: launcherRuntimeConfig.microsoftClientId,
        device_code: deviceCode.device_code
      })
    });

    const rawBody = await response.text();
    const body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};

    if (response.ok) {
      return body as unknown as MicrosoftTokenResponse;
    }

    const error = String(body.error ?? "");

    if (error === "authorization_pending") {
      emitAuthStatus(onStatus, {
        state: "signing-in",
        message: `Connexion en cours. Code: ${deviceCode.user_code}`
      });
      continue;
    }

    if (error === "slow_down") {
      intervalSeconds += 5;
      continue;
    }

    if (error === "authorization_declined") {
      throw new Error("Connexion Microsoft annulée.");
    }

    if (error === "expired_token") {
      throw new Error("Code Microsoft expiré. Relance la connexion.");
    }

    throw new Error(`Erreur OAuth Microsoft: ${error || rawBody}`);
  }

  throw new Error("Code Microsoft expiré. Relance la connexion.");
}

async function refreshSession(session: StoredAuthSession): Promise<StoredAuthSession> {
  assertMicrosoftClientId();

  const microsoftToken = await postForm<MicrosoftTokenResponse>(MICROSOFT_TOKEN_URL, {
    grant_type: "refresh_token",
    client_id: launcherRuntimeConfig.microsoftClientId,
    scope: MICROSOFT_SCOPES,
    refresh_token: session.microsoft.refreshToken
  });

  if (!microsoftToken.refresh_token) {
    microsoftToken.refresh_token = session.microsoft.refreshToken;
  }

  return createSessionFromMicrosoftToken(microsoftToken);
}

async function createSignedInAuthStatus(session: StoredAuthSession): Promise<MicrosoftAuthStatus> {
  const { profile } = session.minecraft;
  const avatarUrl = await getMinecraftAvatarDataUrl(profile);

  return {
    state: "signed-in",
    message: `Connecté en tant que ${profile.name}`,
    username: profile.name,
    uuid: profile.id,
    avatarUrl,
    minecraftName: profile.name,
    minecraftId: profile.id
  };
}

async function createSessionFromMicrosoftToken(token: MicrosoftTokenResponse): Promise<StoredAuthSession> {
  const xblToken = await authenticateXboxLive(token.access_token);
  const xstsToken = await authorizeXsts(xblToken.Token);
  const userHash = xstsToken.DisplayClaims?.xui?.[0]?.uhs;

  if (!userHash) {
    throw new Error("Réponse Xbox Live invalide: user hash absent.");
  }

  const minecraftLogin = await loginMinecraft(userHash, xstsToken.Token);
  await assertOwnsMinecraftJava(minecraftLogin.access_token);
  const profile = await getMinecraftProfile(minecraftLogin.access_token);
  await writeLauncherLog(`[auth] Profil Minecraft récupéré : name=${profile.name}, uuid=${profile.id}`);
  await writeLauncherLog(`[auth] UUID Minecraft récupéré : ${profile.id}`);

  if (!token.refresh_token) {
    throw new Error("Microsoft n'a pas renvoyé de refresh token.");
  }

  return {
    microsoft: {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: Date.now() + token.expires_in * 1000
    },
    minecraft: {
      accessToken: minecraftLogin.access_token,
      expiresAt: Date.now() + minecraftLogin.expires_in * 1000,
      profile
    },
    savedAt: new Date().toISOString()
  };
}

async function authenticateXboxLive(microsoftAccessToken: string): Promise<XboxLiveAuthResponse> {
  return postJson<XboxLiveAuthResponse>("https://user.auth.xboxlive.com/user/authenticate", {
    Properties: {
      AuthMethod: "RPS",
      SiteName: "user.auth.xboxlive.com",
      RpsTicket: `d=${microsoftAccessToken}`
    },
    RelyingParty: "http://auth.xboxlive.com",
    TokenType: "JWT"
  });
}

async function authorizeXsts(xblToken: string): Promise<XboxLiveAuthResponse> {
  const response = await fetch("https://xsts.auth.xboxlive.com/xsts/authorize", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({
      Properties: {
        SandboxId: "RETAIL",
        UserTokens: [xblToken]
      },
      RelyingParty: "rp://api.minecraftservices.com/",
      TokenType: "JWT"
    })
  });

  const body = await readJsonBody<Record<string, unknown>>(response);

  if (!response.ok) {
    throw new Error(mapXstsError(body));
  }

  return body as unknown as XboxLiveAuthResponse;
}

async function loginMinecraft(userHash: string, xstsToken: string): Promise<MinecraftLoginResponse> {
  return postJson<MinecraftLoginResponse>(MINECRAFT_LOGIN_WITH_XBOX_URL, {
    identityToken: `XBL3.0 x=${userHash};${xstsToken}`
  });
}

async function assertOwnsMinecraftJava(minecraftAccessToken: string): Promise<void> {
  const entitlements = await getMinecraftApi<MinecraftEntitlementsResponse>(
    "https://api.minecraftservices.com/entitlements/mcstore",
    minecraftAccessToken
  );
  const itemNames = entitlements.items?.map((item) => item.name).filter(Boolean) ?? [];
  const ownsJava = itemNames.some((name) => name === "game_minecraft" || name === "product_minecraft");

  if (!ownsJava) {
    throw new Error("Ce compte Microsoft ne possède pas Minecraft Java Edition.");
  }
}

async function getMinecraftProfile(minecraftAccessToken: string): Promise<MinecraftProfileResponse> {
  try {
    return await getMinecraftApi<MinecraftProfileResponse>(MINECRAFT_PROFILE_URL, minecraftAccessToken);
  } catch (error) {
    if (isMinecraftProfileNotFoundError(error)) {
      throw error;
    }

    throw new Error(`${formatError(error)} Impossible de récupérer le profil Minecraft Java.`);
  }
}

async function getMinecraftApi<T>(url: string, minecraftAccessToken: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${minecraftAccessToken}`
    }
  });

  return readCheckedJson<T>(response, url);
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify(body)
  });

  return readCheckedJson<T>(response, url);
}

async function postForm<T>(url: string, body: Record<string, string>): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams(body)
  });

  return readCheckedJson<T>(response, url);
}

async function readCheckedJson<T>(response: Response, url: string): Promise<T> {
  const body = await readJsonBody<Record<string, unknown>>(response);

  if (!response.ok) {
    const detail = body.error_description ?? body.errorMessage ?? body.error ?? JSON.stringify(body);
    throw new HttpServiceError(url, response.status, String(detail));
  }

  return body as T;
}

async function readJsonBody<T>(response: Response): Promise<T> {
  const rawBody = await response.text();

  if (!rawBody) {
    return {} as T;
  }

  return JSON.parse(rawBody) as T;
}

function mapXstsError(body: Record<string, unknown>): string {
  const xerr = Number(body.XErr);

  if (xerr === 2148916233) {
    return "Ce compte Microsoft n'a pas de compte Xbox Live.";
  }

  if (xerr === 2148916235) {
    return "Xbox Live n'est pas disponible dans le pays de ce compte.";
  }

  if (xerr === 2148916236 || xerr === 2148916238) {
    return "Ce compte Microsoft est un compte enfant et doit être autorisé par un parent.";
  }

  if (xerr === 2148916237) {
    return "Ce compte Microsoft doit valider les conditions Xbox Live.";
  }

  return `Erreur Xbox Live/XSTS: ${JSON.stringify(body)}`;
}

function formatAuthError(error: unknown): string {
  if (isMinecraftAppRegistrationError(error)) {
    return MINECRAFT_APP_NOT_APPROVED_MESSAGE;
  }

  if (isMinecraftProfileNotFoundError(error)) {
    return MINECRAFT_PROFILE_NOT_FOUND_MESSAGE;
  }

  const message = formatError(error);

  if (message === MICROSOFT_NOT_CONFIGURED_MESSAGE) {
    return message;
  }

  if (message.includes("Minecraft Java Edition")) {
    return message;
  }

  return `Erreur de connexion: ${message}`;
}

async function logAuthError(error: unknown, userMessage: string): Promise<void> {
  if (isMinecraftAppRegistrationError(error)) {
    await writeLauncherLog("[auth] Login failed. Minecraft Services app registration is not approved.");
    await writeLauncherLog(`[auth] Endpoint: ${error.endpoint}`);
    await writeLauncherLog(`[auth] HTTP status: ${error.status}`);
    await writeLauncherLog(`[auth] Error message: ${error.detail}`);
    await writeLauncherLog("[auth] App ID Minecraft Services en attente de validation.");
    return;
  }

  if (isMinecraftProfileNotFoundError(error)) {
    await writeLauncherLog("[auth] Microsoft login succeeded, but Minecraft Java profile was not found.");
    await writeLauncherLog(`[auth] Endpoint: ${error.endpoint}`);
    await writeLauncherLog(`[auth] HTTP status: ${error.status}`);
    await writeLauncherLog(`[auth] Error message: ${error.detail}`);
    await writeLauncherLog("[auth] Vérifier que le compte possède Minecraft Java Edition et qu'un profil Java est configuré.");
    return;
  }

  await writeLauncherLog(`[auth] Login failed. ${userMessage}`);
}

function isMinecraftAppRegistrationError(error: unknown): error is HttpServiceError {
  return (
    error instanceof HttpServiceError &&
    error.endpoint === MINECRAFT_LOGIN_WITH_XBOX_URL &&
    error.status === 403 &&
    error.detail.toLowerCase().includes("invalid app registration")
  );
}

function isMinecraftProfileNotFoundError(error: unknown): error is HttpServiceError {
  return error instanceof HttpServiceError && error.endpoint === MINECRAFT_PROFILE_URL && error.status === 404;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
