import { relocateLocalVault } from '@zennotes/app-core/workspace'
/**
 * Android's `window.zen`: @zennotes/portable-vault's bridge (every method
 * that acts on the open vault, Cloud, a remote workspace or a desktop-only
 * stub, which this file and the iPhone shell's used to carry as copies),
 * over this app's host (host.ts) and the vault tiers below: app storage
 * (`VAULT_ROOT_PREFIX`, under vaultsRoot()), picked shared-storage folders
 * through SAF (`EXTERNAL_VAULT_ROOT_PREFIX`, folder-picker.ts) and the inert
 * iCloud tier kept from the iPhone (`ICLOUD_VAULT_ROOT_PREFIX`). The tiers
 * open a vault by handing its NativeFs to the package's openPortableVault.
 */
import { registerPlugin } from '@capacitor/core'
import { Filesystem } from '@capacitor/filesystem'
import { installZenBridge } from '@zennotes/bridge-contract/bridge'
import type { DirectoryBrowseResult, LocalVaultEntry, VaultInfo } from '@zennotes/shared-domain/ipc'
import { normalizeVaultDisplayName, resolveVaultName } from '@zennotes/shared-domain/vault-display-name'
import {
  activePortableVault,
  activeVault as activePortableOrRemoteVault,
  bootPortableVault,
  cloudBackgroundSyncHost,
  createPortableBridge,
  currentVaultFolderName,
  isMobileNoteIndexReady,
  openPortableVault
} from '@zennotes/portable-vault/bridge'
import { installPortableHost, type HostVaults, type PortableHost } from '@zennotes/portable-vault/host'
import type { RemoteVault } from '@zennotes/portable-vault/remote-vault'
import { activeRemote, disconnectRemote, listProfiles } from '@zennotes/portable-vault/remote-workspace'
import { PortableVault } from '@zennotes/portable-vault/vault'
import { sanitizeNoteTitle } from '@zennotes/portable-vault/vault-core'
import { welcomeNoteBody } from '@zennotes/portable-vault/welcome-note'
import {
  listVaultDirs,
  NativeFs,
  readVaultDisplayName,
  readVaultDisplayNameAtUrl,
  VAULTS_DIR,
  vaultsRoot,
  initVaultsRoot
} from './native-fs'
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
import type { BackgroundSyncHost } from './background-sync'
import { openAssetExternally } from './open-asset'
import { androidHost, loadNativeAppVersion } from './host'
import { isPhoneViewport } from '../viewport'

export { currentVaultFolderName, isMobileNoteIndexReady, loadNativeAppVersion }

/** The open vault, typed for this app: every local vault it opens runs on
 *  NativeFs (openVaultByName), so the shell can read its native root. */
export function activeVault(): PortableVault<NativeFs> | RemoteVault {
  return activePortableOrRemoteVault() as PortableVault<NativeFs> | RemoteVault
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
  /** The folder's name on disk: what rename and delete act on, and what the
   *  open vault's `folderName` is compared with to mark it current. */
  name: string
  /** The name the vault goes by when its vault.json carries one (ZenNotes
   *  #692), normalized; the sheet shows it in place of the folder name. */
  displayName?: string
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
    const displayName = normalizeVaultDisplayName(await readVaultDisplayName(d.name))
    out.push({
      root: `${VAULT_ROOT_PREFIX}${d.name}`,
      name: d.name,
      tier: 'local',
      ...(displayName ? { displayName } : {})
    })
  }
  const status = await icloudStatus().catch(() => null)
  if (status?.available && status.rootUrl) {
    for (const name of filterCloudVaultNames(status.vaults ?? [])) {
      const url = `${status.rootUrl}/${encodeURIComponent(name)}`
      if (!(await looksLikeVaultDir(url))) continue
      const displayName = normalizeVaultDisplayName(await readVaultDisplayNameAtUrl(url))
      out.push({
        root: `${ICLOUD_VAULT_ROOT_PREFIX}${encodeURIComponent(name)}`,
        name,
        tier: 'icloud',
        ...(displayName ? { displayName } : {})
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
  if (currentVaultFolderName() !== entry.name) return false
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
  const wasCurrent = isCurrentVaultEntry(entry)
  const token = (name: string): string => entry.tier === 'icloud'
    ? `${ICLOUD_VAULT_ROOT_PREFIX}${encodeURIComponent(name)}` : `${VAULT_ROOT_PREFIX}${name}`
  let from = '', to = ''
  await relocateLocalVault({
    ...(wasCurrent ? { reopen: { source: token(entry.name), destination: token(clean) } } : {}),
    move: async () => {
      await assertNameFree(entry.tier, clean)
      from = entry.tier === 'icloud' ? await icloudVaultUrl(entry.name) : `${VAULTS_DIR}/${entry.name}`
      to = entry.tier === 'icloud' ? await icloudVaultUrl(clean) : `${VAULTS_DIR}/${clean}`
      await Filesystem.rename({ from, to, ...(entry.tier === 'icloud' ? {} : { directory: vaultsRoot(), toDirectory: vaultsRoot() }) })
    },
    rollback: async () => {
      await Filesystem.rename({ from: to, to: from, ...(entry.tier === 'icloud' ? {} : { directory: vaultsRoot(), toDirectory: vaultsRoot() }) })
    }
  })
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
  const wasCurrent = isCurrentVaultEntry(entry)
  const token = (tier: 'local' | 'icloud'): string => tier === 'icloud'
    ? `${ICLOUD_VAULT_ROOT_PREFIX}${encodeURIComponent(entry.name)}` : `${VAULT_ROOT_PREFIX}${entry.name}`
  let localPath = ''
  await relocateLocalVault({
    ...(wasCurrent ? { reopen: { source: token(entry.tier), destination: token(to) } } : {}),
    move: async () => {
      await assertNameFree(to, entry.name)
      localPath = await localVaultPath(entry.name)
      if (to === 'icloud') {
        const status = await icloudStatus()
        if (!status.available) throw new Error('iCloud is not available. Sign in to iCloud and turn on iCloud Drive.')
        await ICloudVault.enable({ localPath, name: entry.name })
      } else await ICloudVault.disable({ name: entry.name, localPath })
    },
    rollback: async () => {
      if (to === 'icloud') await ICloudVault.disable({ name: entry.name, localPath })
      else await ICloudVault.enable({ localPath, name: entry.name })
    }
  })
}

/**
 * The on-device vault this app opened last, null before boot. Unlike the
 * package's currentVaultFolderName, it still answers while a remote
 * workspace is in front, as this bridge's own `vault` did: the share inbox
 * was written against that.
 */
let localVault: PortableVault<NativeFs> | null = null

function openedLocalVault(): PortableVault<NativeFs> | null {
  return localVault
}

/** The open vault's root as a native URI (`file://`, or a SAF `content://`
 *  tree for a picked folder), where the Calendar widget writes a tick; null
 *  for a remote workspace, whose notes are not on this device. */
export function activeVaultNativeRoot(): string | null {
  try {
    const current = activeVault()
    return current instanceof PortableVault ? (current.fs as NativeFs).rootUri : null
  } catch {
    return null
  }
}

/** The open vault as background sync sees it: ready when it is an on-device
 *  vault linked to the signed-in account (the package's check). */
export const mobileBackgroundSyncHost: BackgroundSyncHost = cloudBackgroundSyncHost

function vaultNameFromRoot(root: string): string {
  const raw = root.startsWith(VAULT_ROOT_PREFIX) ? root.slice(VAULT_ROOT_PREFIX.length) : root
  const name = decodeURIComponent(raw).split('/').filter(Boolean).pop() ?? ''
  return name || DEFAULT_VAULT_NAME
}

/** Human-readable location for the settings UI — where the vault actually
 *  lives, not an internal token. */
function friendlyVaultRoot(v: { name: string; fs: NativeFs }): string {
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

async function openVaultByName(name: string, cloudRootUri: string | null = null): Promise<VaultInfo> {
  const info = await openPortableVault(name, new NativeFs(name, cloudRootUri))
  localVault = activePortableVault() as PortableVault<NativeFs>
  localStorage.setItem(CURRENT_VAULT_KEY, name)
  return info
}

/**
 * First-run bootstrap: open the remembered vault, or create the default one
 * seeded with the mobile welcome note so the first launch lands in guidance
 * instead of an empty screen (the full demo tour stays available as a
 * command). A remembered remote workspace wins; unreachable servers fall
 * through to the local tiers so launch never blocks on the network.
 */
export async function bootVault(): Promise<void> {
  // Resolve where local vaults live before anything touches the tier:
  // devices without usable app-external storage fall back to internal.
  await initVaultsRoot()
  await bootPortableVault()
}

/** The local storage tiers (external folder / iCloud / on-device), shared by
 *  boot and by returning from a remote workspace. When the storage
 *  preference is iCloud (spec 03 tier), the vault lives in the ubiquity
 *  container instead, falling back to local when iCloud is unavailable
 *  rather than blocking the app. */
async function openLocalVaultTier(): Promise<void> {
  // Where local vaults live is resolved before anything touches the tier
  // (once per install; a no-op after that).
  await initVaultsRoot()
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
      if (fresh) await activePortableVault().seedWelcomeNote(welcomeNoteBody(isPhoneViewport(), 'android'))
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
  await activePortableVault().seedWelcomeNote(welcomeNoteBody(isPhoneViewport(), 'android'))
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
  if (!openedLocalVault()) return 0
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
// The host: where vaults live, for the package's bridge
// --------------------------------------------------------------------

const vaults: HostVaults = {
  openDefault: () => openLocalVaultTier(),
  async list(): Promise<LocalVaultEntry[]> {
    const dirs = await listVaultDirs()
    // The switcher shows each vault by the name it goes by (#692): one small
    // vault.json read per folder, the folder name when there is none.
    return Promise.all(
      dirs.map(async (d) => ({
        root: `${VAULT_ROOT_PREFIX}${d.name}`,
        name: resolveVaultName(await readVaultDisplayName(d.name), d.name),
        lastOpenedAt: d.mtime
      }))
    )
  },
  async open(root: string): Promise<VaultInfo> {
    // One entry point for switching to any device-reachable vault: local
    // roots return to local storage mode, zn://icloud-vaults/ roots open the
    // named vault in the iCloud container, and an external token reopens
    // the picked folder its bookmark names. The bridge has left remote mode
    // before this runs.
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
  async pick(): Promise<VaultInfo | null> {
    const picked = await pickExternalVault()
    if (!picked) return null
    await disconnectRemote()
    return await openVaultByName(picked.name, picked.url)
  },
  async select(path: string): Promise<VaultInfo> {
    const name = sanitizeNoteTitle(vaultNameFromRoot(path))
    return await openVaultByName(name)
  },
  async browse(path: string): Promise<DirectoryBrowseResult> {
    const dirs = await listVaultDirs()
    return {
      currentPath: path || VAULT_ROOT_PREFIX,
      parentPath: null,
      entries: dirs.map((d) => ({ name: d.name, path: `${VAULT_ROOT_PREFIX}${d.name}` })),
      shortcuts: [{ label: 'Vaults', path: VAULT_ROOT_PREFIX }]
    }
  },
  describeRoot: (vault) => friendlyVaultRoot(vault as { name: string; fs: NativeFs }),
  // A vault attachment, unlike an arbitrary OS path, is a file this app owns,
  // so the phone can genuinely open it (an intent to another app) instead of
  // answering 'desktop-only' the way the web bridge must.
  openAssetExternally: (relPath) => openAssetExternally(activeVault(), relPath)
}

const mobileHost: PortableHost = { ...androidHost, vaults }

/** Installs the host alone, for what boot runs before the bridge: Cloud
 *  sign-in reads it (configureMobileCloudAuth), and the bridge itself is
 *  installed after that, as it always was. */
export function installMobileHost(): void {
  installPortableHost(mobileHost)
}

export function installMobileBridge(): void {
  installZenBridge(createPortableBridge(mobileHost))
}
