/**
 * Thin async wrapper over @capacitor/filesystem scoped to the vault root.
 *
 * Storage (spec 03, Android default tier): the vault lives in app-scoped
 * external storage — /Android/data/md.zennotes/files/ZenNotes/<vault> — via
 * Directory.External. No permission prompt, works under scoped storage.
 * (Directory.Documents on Android maps to the PUBLIC Documents collection,
 * which the Filesystem plugin permission-gates and Android 11+ scoped
 * storage effectively breaks — do not use it here.)
 *
 * The cloud mode (absolute-URL roots with `directory` omitted) and the
 * `.name.icloud` placeholder discipline are inherited from the iPhone shell;
 * on Android no cloud tier is offered, so those paths are inert but kept
 * intact to minimize drift between the two shells.
 *
 * All paths passed in are vault-relative POSIX paths; this module owns the
 * translation to the on-device location. Nothing above this file touches
 * Capacitor directly for file I/O.
 */
import { Capacitor, registerPlugin } from '@capacitor/core'
import { Directory, Encoding, Filesystem, type FileInfo } from '@capacitor/filesystem'
import { toBase64, type Zne1ChunkCipherParams } from '@zennotes/shared-domain/cloud-e2ee'
import { ensureDownloaded } from './icloud'
import { isNotFoundError } from './fs-errors'
import type { MobileSealedUploadFile } from './mobile-direct-upload'
import { randomUUID } from './uuid'

export const VAULTS_DIR = 'ZenNotes'

/**
 * Root Directory for the local vault tier (see header). Directory.External
 * normally, but some devices boot with getExternalFilesDir unusable (custom
 * ROMs, restricted profiles — issue #2's "Missing parent directory" crash),
 * so boot probes it once and falls back to Directory.Data. The outcome is
 * persisted: a root must never flip between launches or the user's vaults
 * would seem to vanish.
 */
const VAULTS_ROOT_KEY = 'zn-mobile:vaults-root-dir'
let vaultsRootDir: Directory =
  localStorage.getItem(VAULTS_ROOT_KEY) === 'data' ? Directory.Data : Directory.External

export function vaultsRoot(): Directory {
  return vaultsRootDir
}

/** Resolve the local-tier root before anything touches it (bootVault). */
export async function initVaultsRoot(): Promise<void> {
  const stored = localStorage.getItem(VAULTS_ROOT_KEY)
  if (stored === 'data' || stored === 'external') return
  // mkdir rejects when the directory already exists — stat is the probe.
  await Filesystem.mkdir({
    path: VAULTS_DIR,
    directory: Directory.External,
    recursive: true
  }).catch(() => {})
  try {
    await Filesystem.stat({ path: VAULTS_DIR, directory: Directory.External })
    vaultsRootDir = Directory.External
    localStorage.setItem(VAULTS_ROOT_KEY, 'external')
  } catch {
    console.warn('[zen] app-external storage is unavailable — using internal app storage')
    vaultsRootDir = Directory.Data
    localStorage.setItem(VAULTS_ROOT_KEY, 'data')
    await Filesystem.mkdir({
      path: VAULTS_DIR,
      directory: Directory.Data,
      recursive: true
    }).catch(() => {})
  }
}

/**
 * SAF document-tree file ops (SafFsPlugin.java) for external-folder vaults.
 * @capacitor/filesystem cannot address content:// tree URIs, so every op on
 * a picked shared-storage folder routes through this plugin instead.
 */
interface SafFileInfo {
  name: string
  type: 'file' | 'directory'
  size: number
  mtime: number
  uri: string
}

const SafFs = registerPlugin<{
  readdir(o: { root: string; path: string }): Promise<{ files: SafFileInfo[] }>
  stat(o: {
    root: string
    path: string
  }): Promise<{ type: string; size: number; mtime: number; uri: string }>
  readText(o: { root: string; path: string }): Promise<{ data: string }>
  readBase64(o: { root: string; path: string }): Promise<{ data: string }>
  writeText(o: { root: string; path: string; data: string }): Promise<void>
  writeBase64(o: { root: string; path: string; data: string }): Promise<void>
  mkdir(o: { root: string; path: string }): Promise<void>
  rename(o: { root: string; from: string; to: string }): Promise<void>
  copy(o: { root: string; from: string; to: string }): Promise<void>
  delete(o: { root: string; path: string }): Promise<void>
  rmdirIfEmpty(o: { root: string; path: string }): Promise<void>
}>('SafFs')

export interface CloudFileFingerprint {
  uri: string
  sha256: string
  byteLength: number
  utf8: boolean
  inlineBase64?: string
}

/**
 * One ZNE1 object for the native chunk loop (cloud-e2ee.md). JavaScript
 * derives the object key, builds the header, checks the key commitment and
 * computes the AAD; native code only seals or opens the 64 KiB chunks and
 * hashes them, so no parent key ever crosses the bridge. `source` and
 * `destination` are vault file URIs, as for `copy`, and must differ.
 */
export interface Zne1FileRequest {
  source: string
  destination: string
  /** Base64 of the object's 74-byte header. */
  header: string
  /** Base64 of the 32-byte per-object AES-256-GCM key. */
  objectKey: string
  /** Base64 of SHA-256 over the header followed by the context. */
  aad: string
}

/** The ciphertext the upload declares, and the plaintext the item metadata records. */
export interface Zne1FileEncryption {
  byteLength: number
  sha256: string
  plaintextByteLength: number
  plaintextSha256: string
}

const CloudFiles = registerPlugin<{
  inspect(options: { uri: string; textCandidate: boolean }): Promise<CloudFileFingerprint>
  copy(options: { from: string; to: string; byteLength: number; sha256: string }): Promise<void>
  download(options: { url: string; headers: Record<string, string>; to: string; byteLength: number; sha256: string }): Promise<void>
  /** Writes the header, then the sealed chunks. Rejects with INVALID_ENCRYPT_REQUEST or CLOUD_FILE_ENCRYPT_FAILED. */
  encryptFile(options: Zne1FileRequest): Promise<Zne1FileEncryption>
  /**
   * Writes the plaintext and resolves its length and SHA-256. Rejects with
   * E2EE_TAMPERED (the file does not begin with `header`, a chunk fails
   * authentication, or the input stops early), E2EE_MALFORMED (shorter than a
   * header, or an empty last chunk after a full one), INVALID_DECRYPT_REQUEST
   * or CLOUD_FILE_DECRYPT_FAILED. Every rejection deletes the partial output.
   */
  decryptFile(options: Zne1FileRequest): Promise<{ byteLength: number; sha256: string }>
  /**
   * Base64 of up to `length` bytes (at most 65536) from the start of a file;
   * a ZNE1 header is 74. Rejects with INVALID_HEADER_REQUEST or
   * CLOUD_FILE_READ_FAILED.
   */
  readHeader(options: { source: string; length: number }): Promise<{ base64: string }>
}>('ZenDirectUpload')

/** Base64 of what one ZNE1 object's native chunk loop needs; never a parent key. */
export type Zne1NativeKeys = Pick<Zne1FileRequest, 'header' | 'objectKey' | 'aad'>

/** Where encrypted uploads are sealed: inside the vault's private sync folder, which sync never uploads from. */
const UPLOAD_SEALING_DIRECTORY = '.zennotes/sync/uploads'

export function isSafRoot(uri: string | null | undefined): boolean {
  return typeof uri === 'string' && uri.startsWith('content://')
}

export interface StatResult {
  type: 'file' | 'directory'
  size: number
  mtime: number
  ctime: number | null
  uri: string
}

interface FsLocation {
  path: string
  directory?: Directory
}

function encodeSegments(rel: string): string {
  return rel
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/')
}

const ICLOUD_STUB_RE = /^\.(.+)\.icloud$/

export class NativeFs {
  /** Path of the vault root inside Directory.Documents (local mode). */
  readonly rootPath: string
  /** file:// URL of the vault root in the ubiquity container (icloud mode). */
  readonly cloudRootUri: string | null
  /** Native URI of the vault root, resolved at open. */
  rootUri: string | null = null
  /** The local-tier Directory rootUri was resolved in. */
  private rootDirectory: Directory | null = null
  /**
   * Moves before and after every change this vault makes on disk, so a
   * listing taken at one generation is known to predate nothing the app wrote
   * since (MobileVault shares listings between overlapping tree walks on that
   * promise). Writers outside the app are not counted; the foreground rescan
   * is what finds those.
   */
  writeGeneration = 0

  constructor(vaultName: string, cloudRootUri: string | null = null) {
    this.rootPath = `${VAULTS_DIR}/${vaultName}`
    this.cloudRootUri = cloudRootUri
  }

  get isCloud(): boolean {
    return this.cloudRootUri !== null
  }

  /** External-folder tier: the absolute root is a SAF content:// tree URI —
   *  every op must route through SafFs instead of Capacitor Filesystem. */
  private get saf(): boolean {
    return isSafRoot(this.cloudRootUri)
  }

  private async changing<T>(change: () => Promise<T>): Promise<T> {
    this.writeGeneration += 1
    try {
      return await change()
    } finally {
      this.writeGeneration += 1
    }
  }

  private loc(relPath: string): FsLocation {
    if (this.cloudRootUri) {
      return {
        path: relPath ? `${this.cloudRootUri}/${encodeSegments(relPath)}` : this.cloudRootUri
      }
    }
    return {
      path: relPath ? `${this.rootPath}/${relPath}` : this.rootPath,
      directory: vaultsRoot()
    }
  }

  async init(): Promise<void> {
    if (this.saf) {
      // The picked folder IS the vault root and already exists.
      this.rootUri = this.cloudRootUri
      return
    }
    const root = this.loc('')
    await Filesystem.mkdir({ ...root, recursive: true }).catch(() => {})
    if (this.cloudRootUri) {
      this.rootUri = this.cloudRootUri
    } else {
      const directory = vaultsRoot()
      const { uri } = await Filesystem.getUri({
        path: this.rootPath,
        directory
      })
      this.rootUri = uri
      this.rootDirectory = directory
    }
  }

  /** WebView-loadable URL for a vault-relative file (images, PDFs, ...). */
  fileSrc(relPath: string): string | null {
    if (!this.rootUri) return null
    if (this.saf) {
      // Build the child document URI from the tree URI: the docId of a child
      // is `<rootDocId>/<relPath>`, URL-encoded as one path segment. This is
      // how ExternalStorageProvider (shared storage — the tier's target)
      // shapes docIds; convertFileSrc then serves it via
      // https://localhost/_capacitor_content_/.
      const treeUri = this.cloudRootUri!
      const rootDocId = decodeURIComponent(treeUri.split('/tree/')[1] ?? '')
      if (!rootDocId) return null
      const docId = relPath ? `${rootDocId}/${relPath}` : rootDocId
      return Capacitor.convertFileSrc(`${treeUri}/document/${encodeURIComponent(docId)}`)
    }
    if (this.cloudRootUri) {
      return Capacitor.convertFileSrc(`${this.cloudRootUri}/${encodeSegments(relPath)}`)
    }
    return Capacitor.convertFileSrc(`${this.rootUri}/${encodeSegments(relPath)}`)
  }

  async readText(relPath: string): Promise<string> {
    try {
      return await this.readTextOnce(relPath)
    } catch (err) {
      if (!this.cloudRootUri) throw err
      // The file may be an evicted iCloud item — request it and retry.
      await ensureDownloaded(this.loc(relPath).path, 15000)
      return await this.readTextOnce(relPath)
    }
  }

  private async readTextOnce(relPath: string): Promise<string> {
    if (this.saf) {
      const { data } = await SafFs.readText({ root: this.cloudRootUri!, path: relPath })
      return data
    }
    const res = await Filesystem.readFile({ ...this.loc(relPath), encoding: Encoding.UTF8 })
    return typeof res.data === 'string' ? res.data : await res.data.text()
  }

  /** Read any file as base64 so sync hashes the exact bytes, including text. */
  async readBase64(relPath: string): Promise<string> {
    if (this.saf) {
      const { data } = await SafFs.readBase64({ root: this.cloudRootUri!, path: relPath })
      return data
    }
    const res = await Filesystem.readFile(this.loc(relPath))
    if (typeof res.data === 'string') return res.data
    return bytesToBase64(new Uint8Array(await res.data.arrayBuffer()))
  }

  async readForSync(relPath: string, textCandidate: boolean, knownUri?: string): Promise<CloudFileFingerprint> {
    return CloudFiles.inspect({ uri: knownUri ?? await this.fileUri(relPath), textCandidate })
  }

  /** Native URI of a vault file: content:// under a picked folder, file:// otherwise. */
  async fileUri(relPath: string): Promise<string> {
    if (this.saf) return (await SafFs.stat({ root: this.cloudRootUri!, path: relPath })).uri
    const location = this.loc(relPath)
    if (location.directory === undefined) return location.path
    // getUri names a file by the root's URI (a folder's ends in a slash) and
    // the path with each segment escaped exactly as encodeURIComponent does,
    // so the root resolved at open saves a bridge call per file.
    if (this.rootUri && location.directory === this.rootDirectory) {
      if (!relPath) return this.rootUri
      return `${this.rootUri.endsWith('/') ? this.rootUri : `${this.rootUri}/`}${encodeSegments(relPath)}`
    }
    return (await Filesystem.getUri({ path: location.path, directory: location.directory })).uri
  }

  async readTextOrNull(relPath: string): Promise<string | null> {
    try {
      return await this.readText(relPath)
    } catch (error) {
      if (!isNotFoundError(error)) throw error
      return null
    }
  }

  /**
   * Plain overwrite, matching desktop `writeNote` (which uses fs.writeFile,
   * not the atomic path). No `.tmp`/`.bak` siblings: anything non-md left in
   * a note folder surfaces in listAssets and the sidebar as a stray file.
   */
  async writeText(relPath: string, body: string): Promise<void> {
    await this.changing(async () => {
      if (this.saf) {
        await SafFs.writeText({ root: this.cloudRootUri!, path: relPath, data: body })
        return
      }
      await Filesystem.writeFile({
        ...this.loc(relPath),
        data: body,
        encoding: Encoding.UTF8,
        recursive: true
      })
    })
  }

  /** Write binary data from a base64 string (Capacitor's native transport). */
  async writeBase64(relPath: string, base64Data: string): Promise<void> {
    await this.changing(async () => {
      if (this.saf) {
        await SafFs.writeBase64({ root: this.cloudRootUri!, path: relPath, data: base64Data })
        return
      }
      await Filesystem.writeFile({
        ...this.loc(relPath),
        data: base64Data,
        recursive: true
      })
    })
  }

  async statOrNull(relPath: string): Promise<StatResult | null> {
    try {
      if (this.saf) {
        const s = await SafFs.stat({ root: this.cloudRootUri!, path: relPath })
        return {
          type: s.type === 'directory' ? 'directory' : 'file',
          size: s.size,
          mtime: s.mtime,
          ctime: null,
          uri: s.uri
        }
      }
      const s = await Filesystem.stat(this.loc(relPath))
      return {
        type: s.type === 'directory' ? 'directory' : 'file',
        size: s.size,
        mtime: s.mtime,
        ctime: s.ctime ?? null,
        uri: s.uri
      }
    } catch {
      return null
    }
  }

  async readdir(relPath: string): Promise<FileInfo[]> {
    try {
      return await this.readdirStrict(relPath)
    } catch {
      return []
    }
  }

  /** Sync-grade listing: unreadable must never become empty, because an
   *  empty scan would plan deletion for every tracked item in the folder. */
  async readdirStrict(relPath: string): Promise<FileInfo[]> {
    if (this.saf) {
      const res = await SafFs.readdir({ root: this.cloudRootUri!, path: relPath })
      return res.files
    }
    const res = await Filesystem.readdir(this.loc(relPath))
    if (!this.cloudRootUri) return res.files
    return mapICloudStubs(res.files)
  }

  /** Sync-grade stat: null means the native provider verified that the path
   *  is absent. Permissions, provider failures, and timeouts propagate. */
  async statVerified(relPath: string): Promise<'file' | 'directory' | null> {
    try {
      if (this.saf) {
        const result = await SafFs.stat({ root: this.cloudRootUri!, path: relPath })
        return result.type === 'directory' ? 'directory' : 'file'
      }
      const result = await Filesystem.stat(this.loc(relPath))
      return result.type === 'directory' ? 'directory' : 'file'
    } catch (error) {
      if (!isNotFoundError(error)) throw error
      return null
    }
  }

  async mkdir(relPath: string): Promise<void> {
    await this.changing(async () => {
      if (this.saf) {
        await SafFs.mkdir({ root: this.cloudRootUri!, path: relPath })
        return
      }
      await Filesystem.mkdir({ ...this.loc(relPath), recursive: true }).catch((err) => {
        const msg = String((err as Error)?.message ?? err)
        if (!/exist/i.test(msg)) throw err
      })
    })
  }

  async rename(fromRel: string, toRel: string): Promise<void> {
    await this.changing(async () => {
      if (this.saf) {
        await SafFs.rename({ root: this.cloudRootUri!, from: fromRel, to: toRel })
        return
      }
      const from = this.loc(fromRel)
      const to = this.loc(toRel)
      await Filesystem.rename({
        from: from.path,
        to: to.path,
        directory: from.directory,
        toDirectory: to.directory
      })
    })
  }

  async copy(fromRel: string, toRel: string): Promise<void> {
    await this.changing(async () => {
      if (this.saf) {
        await SafFs.copy({ root: this.cloudRootUri!, from: fromRel, to: toRel })
        return
      }
      const from = this.loc(fromRel)
      const to = this.loc(toRel)
      await Filesystem.copy({
        from: from.path,
        to: to.path,
        directory: from.directory,
        toDirectory: to.directory
      })
    })
  }

  /** Copy into staging without carrying file bytes across the bridge or
   * reopening a remote document provider for every chunk. */
  async copyForSync(fromRel: string, toRel: string, byteLength: number): Promise<void> {
    await this.changing(() => this.copyForSyncOnce(fromRel, toRel, byteLength))
  }

  private async copyForSyncOnce(fromRel: string, toRel: string, byteLength: number): Promise<void> {
    if (fromRel === toRel || !Number.isSafeInteger(byteLength) || byteLength < 0) {
      throw new Error('Invalid Cloud file copy.')
    }
    if (await this.statVerified(toRel) !== null) throw new Error('Cloud copy destination already exists.')
    const source = await this.readForSync(fromRel, false)
    if (source.byteLength !== byteLength) throw new Error('The Cloud copy source changed size.')
    const parent = toRel.includes('/') ? toRel.slice(0, toRel.lastIndexOf('/')) : ''
    if (parent) await this.mkdir(parent)
    await this.writeBase64(toRel, '')
    const target = await this.statOrNull(toRel)
    if (!target) throw new Error('Cloud copy staging file is unavailable.')
    await CloudFiles.copy({ from: source.uri, to: target.uri, byteLength, sha256: source.sha256 })
  }

  /** Stream a signed Cloud revision into a fresh vault-private staging file.
   * The native side verifies length and SHA-256 before resolving, so the
   * WebView never holds the body and a truncated download never lands. */
  async download(options: { url: string; headers: Record<string, string>; to: string; byteLength: number; sha256: string }): Promise<void> {
    await this.changing(() => this.downloadOnce(options))
  }

  private async downloadOnce(options: { url: string; headers: Record<string, string>; to: string; byteLength: number; sha256: string }): Promise<void> {
    if (await this.statVerified(options.to) !== null) throw new Error('Cloud download destination already exists.')
    const parent = options.to.includes('/') ? options.to.slice(0, options.to.lastIndexOf('/')) : ''
    if (parent) await this.mkdir(parent)
    await this.writeBase64(options.to, '')
    const target = await this.statOrNull(options.to)
    if (!target) throw new Error('Cloud download staging file is unavailable.')
    try {
      await CloudFiles.download({ ...options, to: target.uri })
    } catch (error) {
      await this.deleteFile(options.to).catch(() => {})
      throw error
    }
  }

  /** Seal a file into a fresh private ZNE1 file for an encrypted vault's
   * streamed upload. JavaScript hands over only the object key, header and AAD
   * the vault cipher made for this one file, so the plaintext never crosses the
   * bridge. The caller discards the sealed file when the upload ends, however
   * it ends. */
  async sealForUpload(sourceUri: string, params: Zne1ChunkCipherParams): Promise<MobileSealedUploadFile> {
    const path = `${UPLOAD_SEALING_DIRECTORY}/${randomUUID()}.zne1`
    await this.mkdir(UPLOAD_SEALING_DIRECTORY)
    await this.writeBase64(path, '')
    const discard = () => this.deleteFile(path).catch(() => {})
    try {
      const target = await this.statOrNull(path)
      if (!target) throw new Error('Encrypted upload staging file is unavailable.')
      const sealed = await CloudFiles.encryptFile({
        source: sourceUri, destination: target.uri,
        header: toBase64(params.header), objectKey: toBase64(params.objectKey), aad: toBase64(params.aad)
      })
      return { ...sealed, uri: target.uri, discard }
    } catch (error) {
      await discard()
      throw error
    }
  }

  /** Base64 of up to `length` leading bytes of a vault file, without reading
   * the rest: the header JavaScript checks before native code opens a staged
   * ZNE1 object. */
  async readHeader(relPath: string, length: number): Promise<string> {
    const file = await this.statOrNull(relPath)
    if (file?.type !== 'file') throw new Error('Cloud staging file is unavailable.')
    return (await CloudFiles.readHeader({ source: file.uri, length })).base64
  }

  /** Open a staged ZNE1 file into a fresh file with the native chunk loop.
   * Native code checks that the file still begins with the header JavaScript
   * checked and writes only chunks that authenticate. The destination is
   * created first because a document provider can only open what exists, and
   * a failure removes it again. */
  async decryptFile(options: { from: string; to: string } & Zne1NativeKeys): Promise<{ byteLength: number; sha256: string }> {
    return await this.changing(() => this.decryptFileOnce(options))
  }

  private async decryptFileOnce(options: { from: string; to: string } & Zne1NativeKeys): Promise<{ byteLength: number; sha256: string }> {
    const { from, to, header, objectKey, aad } = options
    if (from === to) throw new Error('Invalid Cloud file decryption.')
    if (await this.statVerified(to) !== null) throw new Error('Cloud decryption destination already exists.')
    const source = await this.statOrNull(from)
    if (source?.type !== 'file') throw new Error('Cloud staging file is unavailable.')
    const parent = to.includes('/') ? to.slice(0, to.lastIndexOf('/')) : ''
    if (parent) await this.mkdir(parent)
    await this.writeBase64(to, '')
    try {
      const target = await this.statOrNull(to)
      if (!target) throw new Error('Cloud decryption staging file is unavailable.')
      return await CloudFiles.decryptFile({ source: source.uri, destination: target.uri, header, objectKey, aad })
    } catch (error) {
      await this.deleteFile(to).catch(() => {})
      throw error
    }
  }

  async deleteFile(relPath: string): Promise<void> {
    await this.changing(async () => {
      if (this.saf) {
        await SafFs.delete({ root: this.cloudRootUri!, path: relPath })
        return
      }
      await Filesystem.deleteFile(this.loc(relPath))
    })
  }

  async rmdir(relPath: string): Promise<void> {
    await this.changing(async () => {
      if (this.saf) {
        await SafFs.delete({ root: this.cloudRootUri!, path: relPath })
        return
      }
      await Filesystem.rmdir({ ...this.loc(relPath), recursive: true })
    })
  }

  /** Fails on a folder holding anything, where rmdir takes it all. */
  async rmdirIfEmpty(relPath: string): Promise<void> {
    await this.changing(async () => {
      if (this.saf) {
        await SafFs.rmdirIfEmpty({ root: this.cloudRootUri!, path: relPath })
        return
      }
      await Filesystem.rmdir({ ...this.loc(relPath), recursive: false })
    })
  }

  async exists(relPath: string): Promise<boolean> {
    return (await this.statOrNull(relPath)) !== null
  }
}

/** Map `.name.icloud` eviction stubs to their logical entries (deduped
 *  against already-materialized siblings). */
function mapICloudStubs(files: FileInfo[]): FileInfo[] {
  const realNames = new Set(files.map((f) => f.name))
  const out: FileInfo[] = []
  for (const f of files) {
    const m = f.name.match(ICLOUD_STUB_RE)
    if (!m) {
      out.push(f)
      continue
    }
    const logical = m[1]!
    if (realNames.has(logical)) continue
    out.push({ ...f, name: logical, type: 'file' })
  }
  return out
}

/** List vault directories under <app files>/ZenNotes (local mode). */
export async function listVaultDirs(): Promise<{ name: string; mtime: number }[]> {
  try {
    const res = await Filesystem.readdir({ path: VAULTS_DIR, directory: vaultsRoot() })
    return res.files
      .filter((f) => f.type === 'directory' && !f.name.startsWith('.'))
      .map((f) => ({ name: f.name, mtime: f.mtime }))
  } catch {
    return []
  }
}

/**
 * The raw `displayName` a local vault carries in its own vault.json
 * (ZenNotes #692), or null when the vault has none or the file cannot be
 * read. For the vault switcher, which lists vaults that are not open and so
 * have no MobileVault to ask; the caller normalizes and falls back to the
 * folder name, the way desktop's describeVault does.
 */
export async function readVaultDisplayName(vaultName: string): Promise<string | null> {
  return readDisplayNameFrom({
    path: `${VAULTS_DIR}/${vaultName}/.zennotes/vault.json`,
    directory: vaultsRoot()
  })
}

/**
 * The same for a vault addressed by a file URL, which is how the cloud tier
 * lists its vaults (see looksLikeVaultDir). One read attempt, no download
 * wait: an evicted vault.json answers null and the vault keeps its folder
 * name in the switcher, rather than every listing waiting on the cloud.
 */
export async function readVaultDisplayNameAtUrl(url: string): Promise<string | null> {
  return readDisplayNameFrom({ path: `${url}/.zennotes/vault.json` })
}

async function readDisplayNameFrom(loc: { path: string; directory?: Directory }): Promise<string | null> {
  try {
    const res = await Filesystem.readFile({ ...loc, encoding: Encoding.UTF8 })
    const parsed: unknown = JSON.parse(typeof res.data === 'string' ? res.data : '')
    const name = (parsed as { displayName?: unknown } | null)?.displayName
    return typeof name === 'string' ? name : null
  } catch {
    return null
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 32_768
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}
