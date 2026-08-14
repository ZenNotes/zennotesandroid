/**
 * The mobile `window.zen` — third ZenBridge implementation (after Electron IPC
 * and the web HTTP bridge). Vault operations run against the on-device vault
 * (vault-fs.ts); desktop-only surfaces resolve to the same "unsupported"
 * states the web bridge uses so the shared UI hides those affordances.
 *
 * `runtime` reports `'web'`: the current bridge contract only knows
 * 'desktop' | 'web', and every desktop-only code path in app-core is gated on
 * `runtime === 'desktop'`, so 'web' + capability flags produces the correct
 * mobile behavior without modifying the zennotes repo.
 */
import { registerPlugin } from '@capacitor/core'
import { App as CapApp } from '@capacitor/app'
import { Clipboard } from '@capacitor/clipboard'
import {
  installZenBridge,
  type ZenAppInfo,
  type ZenBridge,
  type ZenCapabilities
} from '@zennotes/bridge-contract/bridge'
import type {
  AppUpdateState,
  AssetMeta,
  CliInstallStatus,
  DeletedAsset,
  DirectoryBrowseResult,
  ImportedAsset,
  LocalVaultEntry,
  NoteFolder,
  NoteMeta,
  RaycastExtensionStatus,
  ServerCapabilities,
  ServerSessionStatus,
  TikzRenderResponse,
  VaultInfo,
  VaultTextSearchBackendPreference,
  VaultTextSearchCapabilities,
  VaultTextSearchMatch
} from '@shared/ipc'
import { createDatabaseOps } from '@shared/database-ops'
import type {
  CustomCodeLanguage,
  CustomCodeLanguageInstallInput,
  CustomCodeLanguageUpdateInput
} from '@shared/custom-code-languages'
import type {
  ApplyWorkflowInput,
  WorkflowFile,
  WorkflowRunReceipt,
  WorkflowRunSummary,
  WorkflowUndoResult,
  WriteWorkflowInput
} from '@bridge-contract/workflows'
import type {
  McpClientStatus,
  McpInstructionsPayload,
  McpServerRuntime
} from '@shared/mcp-clients'
import { MobileVault } from './vault-fs'
import { listVaultDirs, VAULTS_DIR, vaultsRoot, initVaultsRoot } from './native-fs'
import { Filesystem } from '@capacitor/filesystem'
import {
  getStoragePref,
  setStoragePref,
  icloudStatus,
  ICloudVault,
  localVaultPath
} from './icloud'
import {
  getExternalVaultRef,
  getExternalVaultRefs,
  setExternalVaultRef,
  removeExternalVaultRef,
  pickExternalVault,
  resolveExternalVault
} from './folder-picker'
import { emitVaultChange, onVaultChange, onOpenNoteRequested, requestOpenNote } from './events'
import { renderTikzOnDevice } from './tikz'
import { fetchLinkMetadataOnDevice } from './link-metadata'
import {
  connectMobileCloudAccount,
  getMobileCloudAccountStatus,
  getMobileCloudServiceAccount,
  listMobileCloudPublishedNotes,
  listMobileCloudVaults,
  logoutMobileCloudAccount,
  onMobileCloudAccountChange,
  publishMobileCloudNote,
  unpublishMobileCloudNote,
  updateMobileCloudPublishedNote
} from './mobile-cloud-auth'
import {
  createAndLinkMobileCloudVault,
  createMobileCloudBackup,
  deleteMobileCloudBackup,
  downloadMobileCloudBackup,
  getMobileCloudBackupSchedule,
  getMobileCloudVaultLink,
  linkMobileCloudVault,
  listMobileCloudBackupItems,
  listMobileCloudBackups,
  restoreMobileCloudBackup,
  restoreMobileCloudBackupNote,
  syncMobileCloudVault,
  updateMobileCloudBackupSchedule,
  unlinkMobileCloudVault
} from './mobile-cloud-sync'
import { RemoteVault } from './remote-vault'
import {
  activeRemote,
  connectRemote,
  connectRemoteProfile,
  deleteProfile,
  disconnectRemote,
  listProfiles,
  remoteStateKey,
  remoteVaultInfo,
  remoteWorkspaceInfo,
  restoreRemoteAtBoot,
  saveProfile
} from './remote-workspace'
import { folderForRelativePath, posixNormalize, sanitizeNoteTitle } from './vault-core'

let appVersion = '1.1.6'

export async function loadNativeAppVersion(): Promise<string> {
  try {
    const info = await CapApp.getInfo()
    if (info.version) appVersion = info.version
  } catch {
    // No native layer (browser dev server) — keep the package fallback.
  }
  return appVersion
}
const CURRENT_VAULT_KEY = 'zn-mobile:current-vault'
const DEFAULT_VAULT_NAME = 'My Vault'
export const VAULT_ROOT_PREFIX = 'zn://vaults/'
// iCloud-tier vaults get their own root scheme so the one openLocalVault
// entry point can route a switch to either storage tier (the vault switcher
// sheet passes these tokens through the store's openLocalVault action).
export const ICLOUD_VAULT_ROOT_PREFIX = 'zn://icloud-vaults/'
// External-tier roots carry the folder's bookmark URI, so any number of
// picked folders stay switchable (zennotes#584). The bare legacy token is
// still accepted and means "the current external vault".
export const EXTERNAL_VAULT_ROOT = 'zn://external-vault'
export const EXTERNAL_VAULT_ROOT_PREFIX = 'zn://external-vaults/'

export function externalVaultRoot(bookmark: string): string {
  return `${EXTERNAL_VAULT_ROOT_PREFIX}${encodeURIComponent(bookmark)}`
}

function externalBookmarkFromRoot(root: string): string | null {
  if (root === EXTERNAL_VAULT_ROOT) return getExternalVaultRef()?.bookmark ?? null
  if (!root.startsWith(EXTERNAL_VAULT_ROOT_PREFIX)) return null
  return decodeURIComponent(root.slice(EXTERNAL_VAULT_ROOT_PREFIX.length))
}

/** Root token of the external vault that is currently pointed at, for the
 *  sheet's "currently open" checks — two picked folders may share a name. */
export function currentExternalVaultRoot(): string | null {
  const ref = getExternalVaultRef()
  return ref ? externalVaultRoot(ref.bookmark) : null
}

export interface MobileVaultEntry {
  root: string
  name: string
  tier: 'local' | 'icloud' | 'external'
}

/**
 * Directory names that belong to a vault's own layout. The native iCloud
 * plugin lists every directory at the container root, and containers that
 * once carried a root-layout vault still have loose `archive`/`quick`/`trash`
 * folders there — those must never be offered (or booted!) as vaults.
 */
const VAULT_LAYOUT_DIR_NAMES = new Set([
  'inbox',
  'quick',
  'archive',
  'trash',
  'assets',
  'attachements',
  'attachments'
])

export function filterCloudVaultNames(names: string[]): string[] {
  return names.filter((n) => !VAULT_LAYOUT_DIR_NAMES.has(n.toLowerCase()))
}

/** A container dir is a vault when it holds its own layout folders or
 *  .zennotes metadata — not when it's a stray folder at the container root. */
async function looksLikeVaultDir(url: string): Promise<boolean> {
  try {
    const res = await Filesystem.readdir({ path: url })
    return res.files.some(
      (f) =>
        f.type === 'directory' &&
        (VAULT_LAYOUT_DIR_NAMES.has(f.name.toLowerCase()) || f.name === '.zennotes')
    )
  } catch {
    return false
  }
}

/** Every on-device vault plus every vault folder in the iCloud container —
 *  the switchable set for the mobile Vaults sheet. */
export async function listSwitchableVaults(): Promise<MobileVaultEntry[]> {
  const out: MobileVaultEntry[] = []
  for (const d of await listVaultDirs()) {
    out.push({ root: `${VAULT_ROOT_PREFIX}${d.name}`, name: d.name, tier: 'local' })
  }
  const status = await icloudStatus().catch(() => null)
  if (status?.available && status.rootUrl) {
    for (const name of filterCloudVaultNames(status.vaults ?? [])) {
      const url = `${status.rootUrl}/${encodeURIComponent(name)}`
      if (!(await looksLikeVaultDir(url))) continue
      out.push({
        root: `${ICLOUD_VAULT_ROOT_PREFIX}${encodeURIComponent(name)}`,
        name,
        tier: 'icloud'
      })
    }
  }
  for (const ref of getExternalVaultRefs()) {
    out.push({ root: externalVaultRoot(ref.bookmark), name: ref.name, tier: 'external' })
  }
  return out
}

// --------------------------------------------------------------------
// Vault management (the Vaults manager sheet): rename / delete / move
// between tiers. External folders are the user's own — the app only ever
// forgets its bookmark, never touches their files.
// --------------------------------------------------------------------

/** Whether the entry names the vault that is open right now. Tier comes from
 *  the storage pref, which every switch path keeps in sync. */
export function isCurrentVaultEntry(entry: MobileVaultEntry): boolean {
  if (activeRemote()) return false
  if (!vault || vault.name !== entry.name) return false
  if (getStoragePref() !== entry.tier) return false
  // Same-named external folders are legal — the bookmark is the identity.
  if (entry.tier === 'external') return entry.root === currentExternalVaultRoot()
  return true
}

async function icloudVaultUrl(name: string): Promise<string> {
  const status = await icloudStatus()
  if (!status.available || !status.rootUrl) {
    throw new Error('iCloud Drive is not available right now.')
  }
  return `${status.rootUrl}/${encodeURIComponent(name)}`
}

async function assertNameFree(tier: MobileVaultEntry['tier'], name: string): Promise<void> {
  const siblings = await listSwitchableVaults()
  if (siblings.some((s) => s.tier === tier && s.name === name)) {
    const where = tier === 'icloud' ? 'iCloud' : 'this device'
    throw new Error(`A vault named “${name}” already exists on ${where}.`)
  }
}

export async function renameVault(entry: MobileVaultEntry, newName: string): Promise<void> {
  const clean = sanitizeNoteTitle(newName.trim())
  if (!clean) throw new Error('Enter a name.')
  if (clean === entry.name) return
  if (entry.tier === 'external') throw new Error('Rename this folder in your file manager.')
  await assertNameFree(entry.tier, clean)
  const wasCurrent = isCurrentVaultEntry(entry)
  if (entry.tier === 'icloud') {
    await Filesystem.rename({
      from: await icloudVaultUrl(entry.name),
      to: await icloudVaultUrl(clean)
    })
    if (wasCurrent) await openVaultByName(clean, await icloudVaultUrl(clean))
  } else {
    await Filesystem.rename({
      from: `${VAULTS_DIR}/${entry.name}`,
      to: `${VAULTS_DIR}/${clean}`,
      directory: vaultsRoot(),
      toDirectory: vaultsRoot()
    })
    if (wasCurrent) await openVaultByName(clean)
  }
}

/** Permanently removes the vault directory and everything in it. The UI owns
 *  the confirmation; the current vault is refused outright as a backstop. */
export async function deleteVault(entry: MobileVaultEntry): Promise<void> {
  if (isCurrentVaultEntry(entry)) throw new Error('Switch to another vault first.')
  if (entry.tier === 'external') {
    forgetExternalVault(entry.root)
    return
  }
  if (entry.tier === 'icloud') {
    await Filesystem.rmdir({ path: await icloudVaultUrl(entry.name), recursive: true })
  } else {
    await Filesystem.rmdir({
      path: `${VAULTS_DIR}/${entry.name}`,
      directory: vaultsRoot(),
      recursive: true
    })
  }
}

/** Forget one picked folder without touching its contents. Accepts an
 *  external root token; the bare legacy token means the current folder. */
export function forgetExternalVault(root: string = EXTERNAL_VAULT_ROOT): void {
  const bookmark = externalBookmarkFromRoot(root)
  if (bookmark) removeExternalVaultRef(bookmark)
  else if (root === EXTERNAL_VAULT_ROOT) setExternalVaultRef(null)
}

/** Move a vault between the on-device and iCloud tiers (setUbiquitous under
 *  the hood, so notes transfer — not copy). Reopens it when it's current. */
export async function moveVault(entry: MobileVaultEntry, to: 'local' | 'icloud'): Promise<void> {
  if (entry.tier === 'external' || entry.tier === to) return
  await assertNameFree(to, entry.name)
  const wasCurrent = isCurrentVaultEntry(entry)
  const localPath = await localVaultPath(entry.name)
  if (to === 'icloud') {
    const status = await icloudStatus()
    if (!status.available) {
      throw new Error('iCloud is not available. Sign in to iCloud and turn on iCloud Drive.')
    }
    await ICloudVault.enable({ localPath, name: entry.name })
  } else {
    await ICloudVault.disable({ name: entry.name, localPath })
  }
  if (wasCurrent) {
    setStoragePref(to)
    if (to === 'icloud') await openVaultByName(entry.name, await icloudVaultUrl(entry.name))
    else await openVaultByName(entry.name)
  }
}

const MOBILE_CAPABILITIES: ZenCapabilities = {
  supportsUpdater: false,
  supportsNativeMenus: false,
  supportsFloatingWindows: false,
  // SAF external-folder tier (spec 03 advanced tier): pick any
  // shared-storage folder via ACTION_OPEN_DOCUMENT_TREE (FolderPickerPlugin);
  // file ops route through SafFsPlugin since Capacitor Filesystem cannot
  // address content:// tree URIs. This is what enables Syncthing/FolderSync
  // cross-device workflows.
  supportsLocalFilesystemPickers: true,
  // Self-hosted ZenNotes servers connect over CapacitorHttp (native, so no
  // CORS and the Bearer header works). The desktop UI entry points stay
  // hidden (they also gate on runtime === 'desktop'); the mobile shell owns
  // the connect flow via the store's actions, which gate on this flag alone.
  supportsRemoteWorkspace: true,
  supportsCloudSync: true,
  supportsCliInstall: false,
  supportsCustomTemplates: true,
  // TextMate grammar import is a desktop feature for now: grammars are
  // per-app (not per-vault), so nothing desyncs by gating this off. The
  // Settings section hides itself behind this flag.
  supportsCustomCodeLanguages: false
}

function mobileAppInfo(): ZenAppInfo {
  return {
    name: 'zennotes-android',
    productName: 'ZenNotes',
    version: appVersion,
    description: 'ZenNotes for Android',
    homepage: 'https://zennotes.org',
    runtime: 'web'
  }
}

let vault: MobileVault | null = null

function isPhoneViewport(): boolean {
  return window.innerWidth < 768
}

export function activeVault(): MobileVault | RemoteVault {
  const remote = activeRemote()
  if (remote) return remote.vault
  if (!vault) throw new Error('No vault is open')
  return vault
}

function activeMobileVault(): MobileVault {
  const current = activeVault()
  if (!(current instanceof MobileVault)) {
    throw new Error('ZenNotes Cloud sync is available for on-device vaults only.')
  }
  return current
}

function vaultNameFromRoot(root: string): string {
  const raw = root.startsWith(VAULT_ROOT_PREFIX) ? root.slice(VAULT_ROOT_PREFIX.length) : root
  const name = decodeURIComponent(raw).split('/').filter(Boolean).pop() ?? ''
  return name || DEFAULT_VAULT_NAME
}

/** Human-readable location for the settings UI — where the vault actually
 *  lives, not an internal token. */
function friendlyVaultRoot(v: MobileVault): string {
  if (!v.fs.isCloud) return `On this device › ZenNotes › ${v.name}`
  const uri = decodeURIComponent(v.fs.cloudRootUri ?? '')
  if (uri.includes('Mobile Documents/iCloud~md~zennotes')) {
    return `iCloud Drive › ZenNotes › ${v.name}`
  }
  const cloudDocs = uri.split('Mobile Documents/com~apple~CloudDocs/Documents/')[1]
  if (cloudDocs !== undefined) {
    return `iCloud Drive › ${cloudDocs.split('/').filter(Boolean).join(' › ') || v.name}`
  }
  return `Folder › ${v.name}`
}

function currentVaultInfo(): VaultInfo | null {
  const remote = remoteVaultInfo()
  if (remote) return remote
  if (!vault) return null
  return { root: friendlyVaultRoot(vault), name: vault.name }
}

async function openVaultByName(name: string, cloudRootUri: string | null = null): Promise<VaultInfo> {
  const next = new MobileVault(name, cloudRootUri)
  await next.open()
  vault = next
  localStorage.setItem(CURRENT_VAULT_KEY, name)
  return currentVaultInfo() as VaultInfo
}

/**
 * First-run bootstrap: open the remembered vault, or create the default one
 * seeded with the mobile welcome note so the first launch lands in guidance
 * instead of an empty screen (the full demo tour stays available as a
 * command). When the
 * storage preference is iCloud (spec 03 tier), the vault lives in the
 * ubiquity container instead — falling back to local when iCloud is
 * unavailable (signed out) rather than blocking the app.
 */
export async function bootVault(): Promise<void> {
  // Resolve where local vaults live before anything touches the tier —
  // devices without usable app-external storage fall back to internal.
  await initVaultsRoot()
  // A remembered remote workspace wins; unreachable servers fall through to
  // the local tiers so launch never blocks on the network.
  if (await restoreRemoteAtBoot()) return
  await openLocalVaultTier()
}

/** The local storage tiers (external folder / iCloud / on-device), shared by
 *  boot and by returning from a remote workspace. */
async function openLocalVaultTier(): Promise<void> {
  const remembered = localStorage.getItem(CURRENT_VAULT_KEY)

  if (getStoragePref() === 'external') {
    const external = await resolveExternalVault()
    if (external) {
      await openVaultByName(external.name, external.url)
      return
    }
    console.warn('external vault bookmark could not be resolved — falling back to local storage')
    setStoragePref('local')
  }

  if (getStoragePref() === 'icloud') {
    const status = await icloudStatus()
    if (status.available && status.rootUrl) {
      const cloudVaults = filterCloudVaultNames(status.vaults ?? [])
      const name =
        remembered && cloudVaults.includes(remembered)
          ? remembered
          : (cloudVaults[0] ?? remembered ?? DEFAULT_VAULT_NAME)
      const fresh = !cloudVaults.includes(name)
      await openVaultByName(name, `${status.rootUrl}/${encodeURIComponent(name)}`)
      if (fresh) await vault?.seedWelcomeNote()
      return
    }
    console.warn('iCloud vault preferred but unavailable — falling back to local storage')
  }

  const existing = await listVaultDirs()
  if (remembered && existing.some((v) => v.name === remembered)) {
    await openVaultByName(remembered)
    return
  }
  if (existing.length > 0) {
    await openVaultByName(existing[0]!.name)
    return
  }
  await openVaultByName(DEFAULT_VAULT_NAME)
  await vault?.seedWelcomeNote()
}

/**
 * True only when this install has never had a vault: nothing remembered,
 * no on-device vault directories, no saved remote profiles. iCloud vaults
 * from a previous install are handled separately (see Onboarding) so
 * returning users are not re-onboarded past their own notes.
 */
export async function isFirstRun(): Promise<boolean> {
  if (localStorage.getItem(CURRENT_VAULT_KEY)) return false
  if ((await listVaultDirs().catch(() => [])).length > 0) return false
  if ((await listProfiles().catch(() => [])).length > 0) return false
  return true
}

// --------------------------------------------------------------------
// Share Extension inbox — captures written by the native extension into the
// App Group (ShareInboxPlugin.swift) become quick notes here, on launch and
// on every foreground.
// --------------------------------------------------------------------

interface ShareCapture {
  body?: string
  createdAt?: number
}

const ShareInbox = registerPlugin<{
  drain(): Promise<{ captures: ShareCapture[] }>
}>('ShareInbox')

/** Quick-capture title semantics (first usable line, 80 chars), with a
 *  friendlier hostname title when the capture is just a shared URL. */
function shareCaptureTitle(body: string): string | undefined {
  const line = (body.split('\n').find((l) => l.trim()) ?? '').trim()
  if (!line) return undefined
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(line)) {
    try {
      return new URL(line).host || undefined
    } catch {
      // fall through to text handling
    }
  }
  const heading = line.match(/^#{1,6}\s+(.+)$/u)
  const title = (heading ? heading[1]! : line.replace(/^[*\-+>\s]+/u, '')).trim().slice(0, 80)
  return title || undefined
}

export async function importPendingShares(): Promise<number> {
  if (!vault) return 0
  let captures: ShareCapture[] = []
  try {
    captures = (await ShareInbox.drain()).captures ?? []
  } catch {
    return 0 // plugin unavailable (e.g. browser dev)
  }
  let imported = 0
  for (const capture of captures) {
    const body = (capture.body ?? '').trim()
    if (!body) continue
    const meta = await activeVault().createNote('quick', shareCaptureTitle(body))
    await activeVault().writeNote(meta.path, `${body}\n`)
    imported++
  }
  return imported
}

// --------------------------------------------------------------------
// Databases — the shared composition (@shared/database-ops, extracted from
// the web bridge in 2.20) bound to the active vault's file ops. Remap-aware:
// the shared layout honors vault.json `systemFolderPaths` when composing
// `.base/` paths, which the old local copy of this glue did not.
// --------------------------------------------------------------------

const dbOps = createDatabaseOps({
  // Absent files answer null; real errors must throw (openDatabase reads
  // null as "bare CSV, adopt it" and writes an inferred schema over it).
  // readTextOrNull follows that contract for the local tiers.
  readFileTextOrNull: (relPath) => activeVault().fs.readTextOrNull(posixNormalize(relPath)),
  writeFile: async (relPath, text) => {
    await activeVault().writeNote(relPath, text)
  },
  createFolder: (folder, subpath) => activeVault().createFolder(folder, subpath),
  renameFolder: (folder, oldSubpath, newSubpath) =>
    activeVault().renameFolder(folder, oldSubpath, newSubpath),
  listFolders: () => activeVault().listFolders(),
  vaultLayout: async () => {
    const settings = await activeVault().getVaultSettings()
    return {
      primaryNotesAtRoot: settings.primaryNotesLocation === 'root',
      systemFolderPaths: settings.systemFolderPaths
    }
  }
})

const {
  openDatabase,
  writeDatabaseRows,
  writeDatabaseSchema,
  createDatabase,
  createRecordPage,
  renameDatabase,
  listDatabases
} = dbOps

// --------------------------------------------------------------------
// Asset URL resolution (WebView-loadable file URLs)
// --------------------------------------------------------------------

// Remote assets: `resolve*AssetUrl` is synchronous, so the first request for
// a path returns null while the bytes are fetched natively (Bearer header —
// an <img> src could never send it); completion emits a change event for the
// requesting note, whose re-render then hits this cache.
const remoteAssetUrls = new Map<string, string>()
const remoteAssetPending = new Set<string>()

function remoteAssetUrl(assetPath: string, notePathForRerender: string | null): string | null {
  const cached = remoteAssetUrls.get(assetPath)
  if (cached) return cached
  const remote = activeRemote()
  if (!remote || remoteAssetPending.has(assetPath)) return null
  remoteAssetPending.add(assetPath)
  void remote.client
    .fetchAssetBase64(assetPath)
    .then(({ base64, mimeType }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
      remoteAssetUrls.set(
        assetPath,
        URL.createObjectURL(new Blob([bytes], { type: mimeType }))
      )
      emitVaultChange({
        kind: 'change',
        path: notePathForRerender ?? assetPath,
        folder: folderForRelativePath(notePathForRerender ?? assetPath) ?? 'inbox',
        scope: 'content'
      })
    })
    .catch(() => {})
    .finally(() => remoteAssetPending.delete(assetPath))
  return null
}

function resolveLocalAssetUrl(_vaultRoot: string, notePath: string, href: string): string | null {
  const trimmed = href.trim()
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return null
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)) return null

  const stripQueryAndHash = (value: string): string => {
    const hashIdx = value.indexOf('#')
    const queryIdx = value.indexOf('?')
    const cutIdx =
      hashIdx === -1 ? queryIdx : queryIdx === -1 ? hashIdx : Math.min(hashIdx, queryIdx)
    return cutIdx === -1 ? value : value.slice(0, cutIdx)
  }
  let decoded = stripQueryAndHash(trimmed)
  try {
    decoded = decodeURIComponent(decoded)
  } catch {
    // keep raw
  }
  const noteDir = notePath.includes('/') ? notePath.slice(0, notePath.lastIndexOf('/')) : ''
  let target: string
  if (decoded.startsWith('/')) {
    target = decoded.replace(/^\/+/, '')
  } else if (noteDir) {
    target = `${noteDir}/${decoded}`
  } else {
    target = decoded
  }
  target = posixNormalize(target)
  if (target.startsWith('../') || target === '..') return null
  if (activeRemote()) return remoteAssetUrl(target, notePath)
  return vault?.fs.fileSrc(target) ?? null
}

function resolveVaultAssetUrl(_vaultRoot: string, assetPath: string): string | null {
  const trimmed = assetPath.trim()
  if (!trimmed) return null
  const normalized = posixNormalize(trimmed.replace(/^\/+/, ''))
  if (normalized.startsWith('../') || normalized === '..') return null
  if (activeRemote()) return remoteAssetUrl(normalized, null)
  return vault?.fs.fileSrc(normalized) ?? null
}

async function readVaultAssetBase64(assetPath: string): Promise<string> {
  const normalized = posixNormalize(assetPath.trim().replace(/^\/+/, ''))
  if (!normalized || normalized.startsWith('../') || normalized === '..') {
    throw new Error('Asset path is invalid.')
  }
  const remote = activeRemote()
  if (remote) return (await remote.client.fetchAssetBase64(normalized)).base64
  return await activeMobileVault().fs.readBase64(normalized)
}

// --------------------------------------------------------------------
// Dropped-file token bucket (mirrors the web bridge)
// --------------------------------------------------------------------

const droppedFiles = new Map<string, File>()

function getPathForFile(file: File): string | null {
  if (!file) return null
  const token = `mobile-drop://${crypto.randomUUID()}/${encodeURIComponent(file.name)}`
  droppedFiles.set(token, file)
  return token
}

async function importFilesToNote(notePath: string, sourcePaths: string[]): Promise<ImportedAsset[]> {
  const results: ImportedAsset[] = []
  for (const raw of sourcePaths) {
    const file = droppedFiles.get(raw)
    if (!file) continue
    results.push(await activeVault().importDroppedFile(notePath, file))
    droppedFiles.delete(raw)
  }
  return results
}

// --------------------------------------------------------------------
// Stubs shared with the web bridge (desktop-only surfaces)
// --------------------------------------------------------------------

function notImplemented(name: string): never {
  throw new Error(`zen.${name} is not available in the mobile app`)
}

const unsupportedUpdateState: AppUpdateState = {
  phase: 'unsupported',
  currentVersion: appVersion,
  availableVersion: null,
  releaseName: null,
  releaseDate: null,
  releaseNotes: null,
  progressPercent: null,
  transferredBytes: null,
  totalBytes: null,
  bytesPerSecond: null,
  message: 'Updates are delivered through the App Store.'
}

const MOBILE_CLI_STATUS: CliInstallStatus = {
  available: false,
  reason: 'CLI installation is only available in the desktop build.',
  defaultTarget: '',
  requiresSudo: false,
  targetOnPath: false,
  pathHint: null,
  installedAt: null,
  installedByThisApp: false,
  supportedPlatform: false
}

const MOBILE_RAYCAST_STATUS: RaycastExtensionStatus = {
  available: false,
  reason: 'Raycast extension installation is only available in the macOS desktop build.',
  supportedPlatform: false,
  installed: false,
  upToDate: false,
  extensionPath: '',
  sourcePath: null,
  raycastInstalled: false,
  nodeAvailable: false,
  npmAvailable: false,
  nodePath: null,
  npmPath: null,
  nodeVersion: null,
  npmVersion: null,
  nodeMeetsMinimum: false,
  npmMeetsMinimum: false,
  installedVersion: null,
  bundledVersion: appVersion,
  lastInstalledAt: null
}

// --------------------------------------------------------------------
// The bridge object
// --------------------------------------------------------------------

export const mobileBridge: ZenBridge = {
  getCapabilities: (): ZenCapabilities => MOBILE_CAPABILITIES,
  getAppInfo: (): ZenAppInfo => mobileAppInfo(),

  // 'linux' gives app-core Ctrl-based keymaps and hides the Mac-only chrome —
  // the right defaults for Android hardware keyboards.
  platform: async () => 'linux' as NodeJS.Platform,
  platformSync: () => 'linux' as NodeJS.Platform,
  // WebView-safe system families plus the fonts the shell bundles itself
  // (public/fonts + index.html @font-face): Android offers no way to install
  // fonts app-wide, so shipping them is the only path to real choices here.
  listSystemFonts: async () => [
    'Cutive Mono',
    'Droid Sans Mono',
    'Georgia',
    'Noto Sans',
    'Noto Serif',
    'Roboto',
    'Roboto Serif',
    'Ubuntu Sans',
    'Ubuntu Sans Mono',
    'monospace',
    'sans-serif',
    'serif'
  ],
  getAppIconDataUrl: async () => null,
  zoomInApp: async () => 1,
  zoomOutApp: async () => 1,
  resetAppZoom: async () => 1,
  getAppUpdateState: async () => unsupportedUpdateState,
  checkForAppUpdates: async () => unsupportedUpdateState,
  checkForAppUpdatesWithUi: async () => {},
  downloadAppUpdate: async () => unsupportedUpdateState,
  installAppUpdate: async () => {},

  getCloudAccountStatus: getMobileCloudAccountStatus,
  connectCloudAccount: connectMobileCloudAccount,
  logoutCloudAccount: logoutMobileCloudAccount,
  onCloudAccountChange: onMobileCloudAccountChange,
  getCloudServiceAccount: getMobileCloudServiceAccount,
  listCloudPublishedNotes: listMobileCloudPublishedNotes,
  publishCloudNote: publishMobileCloudNote,
  updateCloudPublishedNote: updateMobileCloudPublishedNote,
  unpublishCloudNote: unpublishMobileCloudNote,
  listCloudVaults: listMobileCloudVaults,
  getCloudVaultLink: () => getMobileCloudVaultLink(activeMobileVault()),
  linkCloudVault: (vaultId) => linkMobileCloudVault(activeMobileVault(), vaultId),
  createAndLinkCloudVault: (name) =>
    createAndLinkMobileCloudVault(activeMobileVault(), name),
  unlinkCloudVault: () => unlinkMobileCloudVault(activeMobileVault()),
  syncCloudVault: () => syncMobileCloudVault(activeMobileVault()),
  listCloudBackups: () => listMobileCloudBackups(activeMobileVault()),
  getCloudBackupSchedule: () => getMobileCloudBackupSchedule(activeMobileVault()),
  updateCloudBackupSchedule: (enabled) =>
    updateMobileCloudBackupSchedule(activeMobileVault(), enabled),
  listCloudBackupItems: (backupId) =>
    listMobileCloudBackupItems(activeMobileVault(), backupId),
  createCloudBackup: (label) => createMobileCloudBackup(activeMobileVault(), label),
  downloadCloudBackup: (backupId) => downloadMobileCloudBackup(activeMobileVault(), backupId),
  deleteCloudBackup: (backupId) => deleteMobileCloudBackup(activeMobileVault(), backupId),
  restoreCloudBackup: (backupId) => restoreMobileCloudBackup(activeMobileVault(), backupId),
  restoreCloudBackupNote: (backupId, snapshotItemId) =>
    restoreMobileCloudBackupNote(activeMobileVault(), backupId, snapshotItemId),

  getServerCapabilities: async (): Promise<ServerCapabilities | null> =>
    activeRemote()?.capabilities ?? null,
  getServerSession: async (): Promise<ServerSessionStatus> => ({
    authenticated: true,
    authRequired: false,
    supportsSessionLogin: false
  }),
  loginServerSession: async (): Promise<ServerSessionStatus> => ({
    authenticated: true,
    authRequired: false,
    supportsSessionLogin: false
  }),
  logoutServerSession: async (): Promise<ServerSessionStatus> => ({
    authenticated: true,
    authRequired: false,
    supportsSessionLogin: false
  }),
  getRemoteWorkspaceInfo: async () => remoteWorkspaceInfo(),
  connectRemoteWorkspace: (baseUrl, authToken) => connectRemote(baseUrl, authToken),
  disconnectRemoteWorkspace: async () => {
    await disconnectRemote()
    // Reopen the remembered local tier so the app lands somewhere real.
    await openLocalVaultTier()
    return currentVaultInfo()
  },
  // Mobile never boots into a broken workspace (an unreachable remote falls
  // back to the local vault in bootVault), so "retry" simply reports where
  // the app already landed.
  retryWorkspaceBoot: async () => currentVaultInfo(),
  listRemoteWorkspaceProfiles: () => listProfiles(),
  saveRemoteWorkspaceProfile: (input) => saveProfile(input),
  deleteRemoteWorkspaceProfile: (id) => deleteProfile(id),
  connectRemoteWorkspaceProfile: (id) => connectRemoteProfile(id),

  getCurrentVault: async () => currentVaultInfo(),
  listLocalVaults: async (): Promise<LocalVaultEntry[]> => {
    const dirs = await listVaultDirs()
    return dirs.map((d) => ({
      root: `${VAULT_ROOT_PREFIX}${d.name}`,
      name: d.name,
      lastOpenedAt: d.mtime
    }))
  },
  openLocalVault: async (root: string) => {
    // One entry point for switching to any device-reachable vault: local
    // roots return to local storage mode, zn://icloud-vaults/ roots open the
    // named vault in the iCloud container, and the external token reopens
    // the bookmarked Files-app folder. Either way leaves remote mode.
    await disconnectRemote()
    const externalBookmark = externalBookmarkFromRoot(root)
    if (externalBookmark !== null || root === EXTERNAL_VAULT_ROOT) {
      const external = await resolveExternalVault(externalBookmark ?? undefined)
      if (!external) {
        throw new Error('That folder could not be opened. Pick it again with Choose Folder.')
      }
      setExternalVaultRef({ name: external.name, bookmark: external.bookmark })
      setStoragePref('external')
      return await openVaultByName(external.name, external.url)
    }
    if (root.startsWith(ICLOUD_VAULT_ROOT_PREFIX)) {
      const name = decodeURIComponent(root.slice(ICLOUD_VAULT_ROOT_PREFIX.length))
      const status = await icloudStatus()
      if (!status.available || !status.rootUrl) {
        throw new Error('iCloud Drive is not available right now.')
      }
      setStoragePref('icloud')
      return await openVaultByName(name, `${status.rootUrl}/${encodeURIComponent(name)}`)
    }
    setStoragePref('local')
    return await openVaultByName(vaultNameFromRoot(root))
  },
  closeVault: async () => currentVaultInfo(),
  pickVault: async () => {
    const picked = await pickExternalVault()
    if (!picked) return null
    await disconnectRemote()
    return await openVaultByName(picked.name, picked.url)
  },
  selectVaultPath: async (path: string) => {
    // In a remote workspace this is the server-side vault chooser (fed by
    // browseServerDirectories below), matching the desktop flow.
    const remote = activeRemote()
    if (remote) {
      const serverVault = await remote.client.selectVaultPath(path)
      remote.serverVault = serverVault
      remote.vault = new RemoteVault(
        remote.client,
        serverVault,
        remoteStateKey(remote.client.baseUrl, serverVault)
      )
      return currentVaultInfo() as VaultInfo
    }
    const name = sanitizeNoteTitle(vaultNameFromRoot(path))
    return await openVaultByName(name)
  },
  browseServerDirectories: async (path = ''): Promise<DirectoryBrowseResult> => {
    const remote = activeRemote()
    if (remote) return await remote.client.browseDirectories(path)
    const dirs = await listVaultDirs()
    return {
      currentPath: path || VAULT_ROOT_PREFIX,
      parentPath: null,
      entries: dirs.map((d) => ({ name: d.name, path: `${VAULT_ROOT_PREFIX}${d.name}` })),
      shortcuts: [{ label: 'Vaults', path: VAULT_ROOT_PREFIX }]
    }
  },
  getVaultSettings: () => activeVault().getVaultSettings(),
  setVaultSettings: (next) => activeVault().setVaultSettings(next),
  readWorkspaceState: () => activeVault().readWorkspaceState(),
  writeWorkspaceState: (json) => activeVault().writeWorkspaceState(json),
  rootContentHiddenByInboxMode: () => activeVault().rootContentHiddenByInboxMode(),

  listNotes: () => activeVault().listNotes(),
  listFolders: () => activeVault().listFolders(),
  listAssets: () => activeVault().listAssets(),
  hasAssetsDir: () => activeVault().hasAssetsDir(),
  generateDemoTour: () => activeVault().generateDemoTour(),
  removeDemoTour: () => activeVault().removeDemoTour(),
  listTemplates: () => activeVault().listTemplates(),
  readTemplate: (sourcePath) => activeVault().readTemplate(sourcePath),
  writeTemplate: (input) => activeVault().writeTemplate(input),
  deleteTemplate: (sourcePath) => activeVault().deleteTemplate(sourcePath),

  // Workflows are not offered on mobile: the Settings toggle is hidden by the
  // shell (MobileShell mobilizer), so none of these surfaces render. The
  // stubs mirror the web bridge: empty reads, honest rejections for anything
  // that would pretend to write. Note the vault may genuinely CONTAIN
  // `.zennotes/workflows/` files (synced from a desktop via iCloud) — they
  // are simply inert here, exactly like on the web.
  listWorkflows: async (): Promise<WorkflowFile[]> => [],
  writeWorkflow: (_input: WriteWorkflowInput): Promise<WorkflowFile> =>
    Promise.reject(new Error('Editing workflows is available in the ZenNotes desktop app.')),
  deleteWorkflow: (_sourcePath: string): Promise<void> =>
    Promise.reject(new Error('Editing workflows is available in the ZenNotes desktop app.')),
  applyWorkflow: (_input: ApplyWorkflowInput): Promise<WorkflowRunReceipt> =>
    Promise.reject(new Error('Running workflows is available in the ZenNotes desktop app.')),
  undoWorkflowRun: (_runId: string): Promise<WorkflowUndoResult> =>
    Promise.reject(new Error('Running workflows is available in the ZenNotes desktop app.')),
  listWorkflowRuns: async (): Promise<WorkflowRunSummary[]> => [],
  deleteWorkflowRuns: async (_workflowId: string): Promise<number> => 0,
  getVaultTextSearchCapabilities: async (): Promise<VaultTextSearchCapabilities> => ({
    ripgrep: false,
    fzf: false
  }),
  searchVaultText: (
    query: string,
    _backend: VaultTextSearchBackendPreference = 'auto'
  ): Promise<VaultTextSearchMatch[]> => activeVault().searchVaultText(query),
  readNote: async (relPath) => {
    const content = await activeVault().readNote(relPath)
    // Drawings are view-only on phones (spec 06 defers touch drawing):
    // injecting viewModeEnabled at read time makes Excalidraw load with no
    // editing chrome — pan/zoom only. Never persisted (see writeNote).
    if (isPhoneViewport() && relPath.toLowerCase().endsWith('.excalidraw')) {
      try {
        const doc = JSON.parse(content.body) as { appState?: Record<string, unknown> }
        doc.appState = { ...(doc.appState ?? {}), viewModeEnabled: true }
        return { ...content, body: JSON.stringify(doc, null, 2) }
      } catch {
        // unparsable drawing — let the editor surface it as-is
      }
    }
    return content
  },
  readNoteComments: (relPath) => activeVault().readNoteComments(relPath),
  writeNoteComments: (relPath, comments) => activeVault().writeNoteComments(relPath, comments),
  scanTasks: () => activeVault().scanTasks(),
  scanTasksForPath: (relPath) => activeVault().scanTasksForPath(relPath),
  openDatabase,
  writeDatabaseRows,
  writeDatabaseSchema,
  createDatabase,
  renameDatabase,
  createRecordPage,
  listDatabases,
  writeNote: (relPath, body) => {
    // Insurance for the view-only drawing injection above: never let
    // viewModeEnabled reach disk, or desktop would open the drawing locked.
    if (relPath.toLowerCase().endsWith('.excalidraw')) {
      try {
        const doc = JSON.parse(body) as { appState?: Record<string, unknown> }
        if (doc.appState && 'viewModeEnabled' in doc.appState) {
          delete doc.appState.viewModeEnabled
          body = JSON.stringify(doc, null, 2)
        }
      } catch {
        // not JSON — write as-is
      }
    }
    return activeVault().writeNote(relPath, body)
  },
  appendToNote: (relPath, body, position) => activeVault().appendToNote(relPath, body, position),
  createNote: (folder, title, subpath) => activeVault().createNote(folder, title, subpath),
  createExcalidraw: (folder, subpath, title) =>
    activeVault().createExcalidraw(folder, subpath, title),
  renameNote: (relPath, nextTitle) => activeVault().renameNote(relPath, nextTitle),
  deleteNote: (relPath) => activeVault().deleteNote(relPath),
  moveToTrash: (relPath) => activeVault().moveToTrash(relPath),
  restoreFromTrash: (relPath) => activeVault().restoreFromTrash(relPath),
  emptyTrash: () => activeVault().emptyTrash(),
  archiveNote: (relPath) => activeVault().archiveNote(relPath),
  unarchiveNote: (relPath) => activeVault().unarchiveNote(relPath),
  duplicateNote: (relPath) => activeVault().duplicateNote(relPath),
  exportNotePdf: async () => {
    throw new Error('PDF export is available in the ZenNotes desktop app.')
  },
  // The command is gated on runtime === 'desktop', so this never surfaces;
  // the reject keeps the contract honest if it ever does.
  exportNoteDocx: async () => {
    throw new Error('Word export is available in the ZenNotes desktop app.')
  },
  revealNote: async () => {},
  revealNoteTarget: async () => {},
  revealFilePath: async () => {},
  // External file links name OS paths outside the iOS sandbox; the exact
  // 'desktop-only' token makes app-core show its friendly toast.
  openExternalFile: async () => ({ ok: false, error: 'desktop-only' }),
  openAssetExternally: async () => notImplemented('openAssetExternally'),
  // Bookmark cards fetch open-graph metadata natively (link-metadata.ts) —
  // a WKWebView fetch of an arbitrary page would be CORS-blocked.
  fetchLinkMetadata: (url) => fetchLinkMetadataOnDevice(url),
  moveNote: (relPath, targetFolder, targetSubpath) =>
    activeVault().moveNote(relPath, targetFolder, targetSubpath),
  importFilesToNote,
  importPastedImage: (input) => activeVault().importPastedImage(input),
  readVaultAssetBase64,
  renameAsset: (relPath, nextName): Promise<AssetMeta> =>
    activeVault().renameAsset(relPath, nextName),
  moveAsset: (relPath, targetDir): Promise<AssetMeta> =>
    activeVault().moveAsset(relPath, targetDir),
  duplicateAsset: (relPath): Promise<AssetMeta> => activeVault().duplicateAsset(relPath),
  deleteAsset: (relPath): Promise<DeletedAsset> => activeVault().deleteAsset(relPath),
  restoreDeletedAsset: (asset): Promise<AssetMeta> => activeVault().restoreDeletedAsset(asset),
  listDeletedAssets: (): Promise<DeletedAsset[]> => activeVault().listDeletedAssets(),
  purgeDeletedAsset: (undoToken): Promise<void> => activeVault().purgeDeletedAsset(undoToken),
  emptyDeletedAssets: (): Promise<void> => activeVault().emptyDeletedAssets(),
  createFolder: (folder, subpath) => activeVault().createFolder(folder, subpath),
  renameFolder: (folder, oldSubpath, newSubpath) =>
    activeVault().renameFolder(folder, oldSubpath, newSubpath),
  deleteFolder: (folder, subpath) => activeVault().deleteFolder(folder, subpath),
  duplicateFolder: (folder, subpath) => activeVault().duplicateFolder(folder, subpath),
  revealFolder: async () => {},
  revealFolderTarget: async () => {},
  revealAssetsDir: async () => {},
  getPathForFile,
  openFolderTemporary: async () => {},
  resolveLocalAssetUrl,
  resolveVaultAssetUrl,

  onVaultChange,
  onOpenSettings: () => () => {},
  onOpenNoteRequested,
  notifyRendererReady: () => {},
  onAppUpdateState: () => () => {},

  windowMinimize: () => {},
  windowToggleMaximize: () => {},
  windowClose: () => {},
  openNoteWindow: async (relPath: string) => {
    requestOpenNote(relPath)
  },
  openVaultWindow: async () => null,
  readExternalFile: async () => notImplemented('readExternalFile'),
  writeExternalFile: async () => notImplemented('writeExternalFile'),
  moveExternalFileToVault: async () => notImplemented('moveExternalFileToVault'),
  openMarkdownFile: async () => false,
  openFileDialog: async () => false,
  toggleQuickCapture: async () => {
    const meta: NoteMeta = await activeVault().createNote('quick')
    requestOpenNote(meta.path)
  },
  getQuickCaptureHotkey: async () => '',
  setQuickCaptureHotkey: async () => ({
    ok: false,
    hotkey: '',
    error: 'Quick capture hotkeys are a desktop feature.'
  }),
  getQuickCapturePinned: async () => false,
  setQuickCapturePinned: async () => false,
  // On-device TeX via the vendored TikZJax wasm engine (src/bridge/tikz.ts);
  // falls back to the desktop-only message if the assets aren't bundled.
  renderTikz: (source): Promise<TikzRenderResponse> => renderTikzOnDevice(source),

  mcpGetRuntime: async () =>
    ({
      command: '',
      args: [],
      env: {},
      entryPath: null,
      available: false,
      reason: 'MCP client installation is only available in the desktop build.'
    }) as unknown as McpServerRuntime,
  mcpGetStatuses: async (): Promise<McpClientStatus[]> => [],
  mcpInstall: async () => notImplemented('mcpInstall'),
  mcpUninstall: async () => notImplemented('mcpUninstall'),
  mcpGetInstructions: async () =>
    ({
      defaultValue: '',
      current: '',
      isCustom: false,
      filePath: ''
    }) as unknown as McpInstructionsPayload,
  mcpSetInstructions: async () => notImplemented('mcpSetInstructions'),
  cliGetStatus: async () => MOBILE_CLI_STATUS,
  cliInstall: async () => notImplemented('cliInstall'),
  cliUninstall: async () => notImplemented('cliUninstall'),
  raycastGetStatus: async () => MOBILE_RAYCAST_STATUS,
  raycastInstall: async () => notImplemented('raycastInstall'),
  clipboardWriteText: (text: string) => {
    void Clipboard.write({ string: text }).catch(() => {})
  },
  clipboardReadText: () => '',

  getConfigSync: () => null,
  setConfig: async () => {},
  getConfigPath: async () => null,
  revealConfigFile: async () => {},
  onConfigChange: () => () => {},

  listCustomThemes: async () => [],
  getCustomThemesDir: async () => null,
  revealCustomThemesDir: async () => {},
  deleteCustomTheme: async () => {},
  createCustomTheme: async () => null,
  onCustomThemesChange: () => () => {},
  // Custom code languages: capability-gated off (supportsCustomCodeLanguages
  // false hides the Settings section); the empty list keeps the editor and
  // reading view on their zero-cost fast path.
  listCustomCodeLanguages: async (): Promise<CustomCodeLanguage[]> => [],
  installCustomCodeLanguage: (_input: CustomCodeLanguageInstallInput): Promise<CustomCodeLanguage> =>
    Promise.reject(new Error('Custom code languages are available in the ZenNotes desktop app.')),
  updateCustomCodeLanguage: (_input: CustomCodeLanguageUpdateInput): Promise<CustomCodeLanguage> =>
    Promise.reject(new Error('Custom code languages are available in the ZenNotes desktop app.')),
  revealCustomCodeLanguagesDir: async () => {},
  deleteCustomCodeLanguage: (_id: string): Promise<void> =>
    Promise.reject(new Error('Custom code languages are available in the ZenNotes desktop app.')),
  onCustomCodeLanguagesChange: () => () => {},
  listOverrides: async () => [],
  revealOverridesDir: async () => {},
  deleteOverride: async () => {},
  onOverridesChange: () => () => {},
  toggleDevTools: async () => {}
}

export function installMobileBridge(): void {
  installZenBridge(mobileBridge)
}
