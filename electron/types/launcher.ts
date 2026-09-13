export type LauncherRamGb = 4 | 6 | 8 | 10 | 12 | 16;

export interface LauncherSettings {
  ramGb: LauncherRamGb;
  closeLauncherOnMinecraftStart: boolean;
}

export interface LauncherActionResult {
  notice?: boolean;
  ok: boolean;
  message: string;
}

export interface GpuRecoveryStatus {
  currentMode: "hardware" | "software";
  nextLaunchMode: "hardware" | "software";
  restartRequired: boolean;
  incidentCount: number;
  lastIncidentAt?: string;
  message: string;
}

export type LauncherLogLevel = "info" | "success" | "warn" | "error" | "debug";

export type LauncherLogSource = "launcher" | "minecraft" | "auth" | "modpack" | "server" | "java" | "skin";

export interface LauncherLogEntry {
  id: number;
  timestamp: string;
  level: LauncherLogLevel;
  source: LauncherLogSource;
  message: string;
}

export interface MicrosoftAuthStatus {
  state: "signed-out" | "signing-in" | "signed-in" | "error";
  message: string;
  username?: string;
  uuid?: string;
  avatarUrl?: string;
  minecraftName?: string;
  minecraftId?: string;
}

export type LauncherAccessState =
  | "not-configured"
  | "signed-out"
  | "checking"
  | "authorized"
  | "not-listed"
  | "request-pending"
  | "denied"
  | "unavailable";

export type LauncherAccessCleanupState = "not-required" | "completed" | "pending" | "failed";

export interface LauncherAccessStatus {
  state: LauncherAccessState;
  message: string;
  checkedAt?: string;
  minecraftName?: string;
  minecraftId?: string;
  reason?: string;
  cleanupState?: LauncherAccessCleanupState;
  isOwner?: boolean;
}

export type StaffAccessStatus = "active" | "revoked" | "pending";

export interface StaffAccessEntry {
  minecraftId: string;
  minecraftName: string;
  status: StaffAccessStatus;
  updatedAt: string;
  note?: string;
}

export interface StaffAccessUpdateInput {
  minecraftId: string;
  minecraftName: string;
  status: Exclude<StaffAccessStatus, "pending">;
  note?: string;
}

export interface LauncherErrorReportInput {
  lastErrorMessage?: string;
  authStatus: MicrosoftAuthStatus;
}

export type LauncherErrorSource =
  | "Mise à jour"
  | "Téléchargement"
  | "Connexion Microsoft"
  | "Lancement Minecraft"
  | "Fichier manquant"
  | "Java"
  | "Réseau"
  | "Interface du launcher"
  | "Erreur inconnue";

export interface LauncherErrorDialogPayload {
  id: string;
  timestamp: string;
  title: string;
  userMessage: string;
  source: LauncherErrorSource;
  detail: string;
  technicalMessage: string;
  step?: string;
  action?: string;
  stack?: string;
  launcherVersion: string;
  platform: string;
  logs: string[];
}

export interface LauncherRendererErrorInput {
  source?: LauncherErrorSource;
  step?: string;
  action?: string;
  message: string;
  stack?: string;
}

export type ManagedContentType = "mod" | "resourcepack";

export interface ManagedContentEntry {
  id: string;
  type: ManagedContentType;
  path: string;
  fileName: string;
  name: string;
  version?: string;
  description?: string;
  iconDataUrl?: string;
  enabled: boolean;
  toggleable: boolean;
  optionalReason?: string;
  source: "manifest";
}

export interface ManagedContentPreferenceInput {
  type: ManagedContentType;
  path: string;
  enabled: boolean;
}

export type ShaderPerformance = "Léger" | "Équilibré" | "Élevé";

export interface ShaderCatalogEntry {
  id: string;
  name: string;
  description: string;
  performance: ShaderPerformance;
  projectUrl: string;
  version?: string;
  fileName?: string;
  size?: number;
  installed: boolean;
  updateAvailable: boolean;
  available: boolean;
  error?: string;
}

export interface ShaderInstallInput {
  shaderId: string;
}

export interface ShaderInstallResult extends LauncherActionResult {
  shaders?: ShaderCatalogEntry[];
}

export type LauncherVisualPreviewMode = "install" | "update";

export interface LauncherVisualPreviewInput {
  mode: LauncherVisualPreviewMode;
}

export type SkinModel = "classic" | "slim";

export interface CurrentSkinInfo {
  username?: string;
  uuid?: string;
  skinUrl: string;
  model: SkinModel;
  source: "account" | "fallback";
  message?: string;
}

export interface SavedSkinEntry {
  id: string;
  name: string;
  filePath: string;
  importedAt: string;
  model: SkinModel;
  sha256: string;
  skinUrl: string;
  isLastApplied?: boolean;
}

export interface SkinLibraryState {
  current: CurrentSkinInfo;
  savedSkins: SavedSkinEntry[];
  selectedSkinId?: string;
}

export interface SkinImportInput {
  model: SkinModel;
}

export interface SkinPreviewInput {
  skinId: string;
}

export interface SkinApplyInput {
  skinId: string;
  model: SkinModel;
}

export interface SkinDeleteInput {
  skinId: string;
}

export interface SkinActionResult extends LauncherActionResult {
  current?: CurrentSkinInfo;
  savedSkins?: SavedSkinEntry[];
  selectedSkinId?: string;
  skin?: SavedSkinEntry;
}

export interface JavaStatus {
  detected: boolean;
  message: string;
  executable?: string;
  majorVersion?: number;
  versionText?: string;
}

export type ManifestFileType =
  | "mod"
  | "config"
  | "options"
  | "resourcepack"
  | "shaderpack"
  | "other";

export interface ManifestFileEntry {
  path: string;
  url: string;
  size: number;
  sha256: string;
  type: ManifestFileType;
}

export interface ModpackManifest {
  schemaVersion: 1;
  modpackVersion: string;
  minecraftVersion: "1.21.1";
  fabricLoaderVersion: string;
  generatedAt: string;
  baseUrl: string;
  launcher: {
    name: string;
    serverName: string;
    minecraftVersion: "1.21.1";
    loader: "fabric";
    javaVersion: 21;
    mainMod: "HPRPASLAN";
  };
  files: ManifestFileEntry[];
}

export type ModpackInstallState = "not-installed" | "update-available" | "ready" | "error";

export interface ModpackStatus {
  state: ModpackInstallState;
  message: string;
  localVersion?: string;
  remoteVersion?: string;
  filesToDownload: number;
  filesToDelete: number;
  checkedAt?: string;
  error?: string;
}

export type OfficialServerStatusState = "pending" | "online" | "offline" | "error";

export interface OfficialServerStatus {
  state: OfficialServerStatusState;
  message: string;
  host: string;
  port: number;
  checkedAt: string;
  latencyMs?: number;
  onlinePlayers?: number;
  maxPlayers?: number;
  error?: string;
}

export interface LauncherSyncProgress {
  phase: "manifest" | "check" | "copy" | "cleanup" | "done" | "error";
  current: number;
  total: number;
  percent: number;
  message: string;
}

export type LauncherSyncProgressHandler = (progress: LauncherSyncProgress) => void;
