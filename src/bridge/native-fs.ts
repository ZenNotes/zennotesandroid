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
import { ensureDownloaded } from './icloud'

export const VAULTS_DIR = 'ZenNotes'
/** Root Directory for the local vault tier (see header). */
export const VAULTS_ROOT = Directory.External

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
  writeText(o: { root: string; path: string; data: string }): Promise<void>
  writeBase64(o: { root: string; path: string; data: string }): Promise<void>
  mkdir(o: { root: string; path: string }): Promise<void>
  rename(o: { root: string; from: string; to: string }): Promise<void>
  copy(o: { root: string; from: string; to: string }): Promise<void>
  delete(o: { root: string; path: string }): Promise<void>
}>('SafFs')

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

  private loc(relPath: string): FsLocation {
    if (this.cloudRootUri) {
      return {
        path: relPath ? `${this.cloudRootUri}/${encodeSegments(relPath)}` : this.cloudRootUri
      }
    }
    return {
      path: relPath ? `${this.rootPath}/${relPath}` : this.rootPath,
      directory: VAULTS_ROOT
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
      const { uri } = await Filesystem.getUri({
        path: this.rootPath,
        directory: VAULTS_ROOT
      })
      this.rootUri = uri
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

  async readTextOrNull(relPath: string): Promise<string | null> {
    try {
      return await this.readText(relPath)
    } catch {
      return null
    }
  }

  /**
   * Plain overwrite, matching desktop `writeNote` (which uses fs.writeFile,
   * not the atomic path). No `.tmp`/`.bak` siblings: anything non-md left in
   * a note folder surfaces in listAssets and the sidebar as a stray file.
   */
  async writeText(relPath: string, body: string): Promise<void> {
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
  }

  /** Write binary data from a base64 string (Capacitor's native transport). */
  async writeBase64(relPath: string, base64Data: string): Promise<void> {
    if (this.saf) {
      await SafFs.writeBase64({ root: this.cloudRootUri!, path: relPath, data: base64Data })
      return
    }
    await Filesystem.writeFile({
      ...this.loc(relPath),
      data: base64Data,
      recursive: true
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
      if (this.saf) {
        const res = await SafFs.readdir({ root: this.cloudRootUri!, path: relPath })
        return res.files
      }
      const res = await Filesystem.readdir(this.loc(relPath))
      if (!this.cloudRootUri) return res.files
      return mapICloudStubs(res.files)
    } catch {
      return []
    }
  }

  async mkdir(relPath: string): Promise<void> {
    if (this.saf) {
      await SafFs.mkdir({ root: this.cloudRootUri!, path: relPath })
      return
    }
    await Filesystem.mkdir({ ...this.loc(relPath), recursive: true }).catch((err) => {
      const msg = String((err as Error)?.message ?? err)
      if (!/exist/i.test(msg)) throw err
    })
  }

  async rename(fromRel: string, toRel: string): Promise<void> {
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
  }

  async copy(fromRel: string, toRel: string): Promise<void> {
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
  }

  async deleteFile(relPath: string): Promise<void> {
    if (this.saf) {
      await SafFs.delete({ root: this.cloudRootUri!, path: relPath })
      return
    }
    await Filesystem.deleteFile(this.loc(relPath))
  }

  async rmdir(relPath: string): Promise<void> {
    if (this.saf) {
      await SafFs.delete({ root: this.cloudRootUri!, path: relPath })
      return
    }
    await Filesystem.rmdir({ ...this.loc(relPath), recursive: true })
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
    const res = await Filesystem.readdir({ path: VAULTS_DIR, directory: VAULTS_ROOT })
    return res.files
      .filter((f) => f.type === 'directory' && !f.name.startsWith('.'))
      .map((f) => ({ name: f.name, mtime: f.mtime }))
  } catch {
    return []
  }
}
