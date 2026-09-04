/**
 * The on-device vault: desktop `vault.ts` semantics reimplemented over the
 * Capacitor Filesystem (there is no Node `fs` in a WKWebView). Same on-disk
 * layout, same folder mapping, same naming rules — a vault created here opens
 * unchanged in ZenNotes desktop.
 */
import type { FileInfo } from '@capacitor/filesystem'
import type {
  AssetMeta,
  DeletedAsset,
  FolderEntry,
  ImportedAsset,
  NoteComment,
  NoteCommentInput,
  NoteContent,
  NoteFolder,
  NoteMeta,
  PastedImageInput,
  VaultDemoTourResult,
  VaultSettings,
  VaultTextSearchMatch
} from '@bridge-contract/ipc'
import { DEFAULT_VAULT_SETTINGS } from '@bridge-contract/ipc'
import type { CustomTemplateFile, WriteTemplateInput } from '@bridge-contract/templates'
import type { VaultTask } from '@shared/tasks'
import { parseTaskFile, parseTasksFromBody } from '@shared/tasks'
import { normalizeHarperVaultState } from '@shared/harper-settings'
import { isFormDirName, isDatabaseInternalPath } from '@shared/databases'
import { emptyExcalidrawDocument } from '@shared/excalidraw'
import { DEMO_TOUR_ASSETS, DEMO_TOUR_NOTES } from '@desktop-main/demo-tour-data'
import { WELCOME_NOTE_PATH, WELCOME_NOTE_BODY } from './welcome-note'
import {
  rewriteWikilinksForRename,
  type RenameNoteRef
} from '@desktop-main/wikilink-rename'
import { NativeFs } from './native-fs'
import { ensureDownloaded } from './icloud'
import { emitVaultChange } from './events'
import {
  buildExcerpt,
  bodyHasLocalAsset,
  classifyImportedAsset,
  collapseSearchLine,
  dirName,
  extName,
  extractAssetEmbeds,
  extractTags,
  extractWikilinks,
  firstMatchColumn,
  folderForRelativePath,
  hiddenPrimaryRootNames,
  importedAssetFilename,
  importedAssetMarkdown,
  importedAssetRelPath,
  isExcalidrawPath,
  isMarkdownPath,
  joinPath,
  NOTE_COMMENTS_DIR,
  NOTE_COMMENTS_SUFFIX,
  RESERVED_ROOT_NAMES,
  resolveSafeRel,
  sanitizeNoteTitle,
  scoreMatch,
  SEARCHABLE_TEXT_FOLDERS,
  stemName,
  ATTACHMENTS_DIRS,
  ASSETS_DIR,
  INTERNAL_VAULT_DIR,
  TEMPLATES_DIR,
  FOLDERS
} from './vault-core'
import {
  DEFAULT_FOLDER_PATHS,
  describeSystemFolderPathIssue,
  normalizeSystemFolderPaths,
  resolveFolderPath,
  type SystemFolderPaths
} from '@shared/system-folder-paths'

const META_CACHE_FILE = `${INTERNAL_VAULT_DIR}/mobile-note-meta-cache-v1.json`
/** Restore metadata written next to each deleted asset (desktop parity). */
const DELETED_ASSET_META = '.zn-deleted.json'

interface CachedMeta {
  mtime: number
  size: number
  meta: NoteMeta
}

interface SearchCandidate {
  path: string
  title: string
  folder: NoteFolder
  lineNumber: number
  offset: number
  lineText: string
  rawLine: string
}

function uuid(): string {
  return crypto.randomUUID()
}

/**
 * Say something when a hand-written `systemFolderPaths` entry is thrown away
 * — mirrored 1:1 from desktop vault.ts (#533). Normalization drops what it
 * cannot use, which is the right way to read a file a person may have edited
 * with any text editor, but doing it silently left them concluding the
 * setting did not work. Runs only where vault.json is actually parsed, which
 * the settings cache makes once per open rather than once per read.
 */
function warnAboutDiscardedFolderPaths(parsed: unknown, settings: VaultSettings): void {
  // The RAW object, deliberately: normalization is exactly the step that
  // throws the bad value away, so asking the normalized settings what the
  // file said reports only what survived.
  if (!parsed || typeof parsed !== 'object') return
  const stated = (parsed as { systemFolderPaths?: unknown }).systemFolderPaths
  if (!stated || typeof stated !== 'object') return
  for (const [folder, value] of Object.entries(stated as Record<string, unknown>)) {
    if (!(folder in DEFAULT_FOLDER_PATHS)) continue
    if (typeof value !== 'string' || value.trim() === '') continue
    const kept = settings.systemFolderPaths?.[folder as NoteFolder]
    if (kept === value.trim()) continue
    // Its own default is not a rejection, just a redundant line.
    if (value.trim() === DEFAULT_FOLDER_PATHS[folder as NoteFolder]) continue
    const reason =
      describeSystemFolderPathIssue(folder as NoteFolder, value, settings.systemFolderPaths) ??
      'it could not be used'
    console.warn(
      `[zen] vault.json: systemFolderPaths.${folder} = ${JSON.stringify(value)} was ignored. ${reason}`
    )
  }
}

export class MobileVault {
  readonly name: string
  readonly fs: NativeFs
  private metaCache = new Map<string, CachedMeta>()
  private metaCacheDirty = false
  private metaCachePersistTimer: ReturnType<typeof setTimeout> | null = null
  private settingsCache: VaultSettings | null = null

  constructor(name: string, cloudRootUri: string | null = null) {
    this.name = name
    this.fs = new NativeFs(name, cloudRootUri)
  }

  async open(): Promise<void> {
    await this.fs.init()
    if (this.fs.isCloud && this.fs.rootUri) {
      // Materialize evicted iCloud items before the first walk so nothing
      // reads as missing (bounded wait; stragglers land via later rescans).
      await ensureDownloaded(this.fs.rootUri, 20000)
    }
    await this.ensureVaultLayout()
    await this.loadMetaCache()
    await this.sweepWriteArtifacts()
  }

  /** Remove `.md.bak`/`.md.tmp` siblings an earlier build's atomic-write
   *  experiment left behind — they read as stray files in the sidebar. */
  private async sweepWriteArtifacts(): Promise<void> {
    const sweep = async (dirRel: string): Promise<void> => {
      const entries = await this.fs.readdir(dirRel)
      for (const entry of entries) {
        const childRel = dirRel ? `${dirRel}/${entry.name}` : entry.name
        if (entry.type === 'directory') {
          if (entry.name.startsWith('.')) continue
          await sweep(childRel)
          continue
        }
        const lower = entry.name.toLowerCase()
        if (lower.endsWith('.md.bak') || lower.endsWith('.md.tmp')) {
          await this.fs.deleteFile(childRel).catch(() => {})
        }
      }
    }
    await sweep('')
    for (const entry of await this.fs.readdir(INTERNAL_VAULT_DIR)) {
      const lower = entry.name.toLowerCase()
      if (entry.type === 'file' && (lower.endsWith('.bak') || lower.endsWith('.tmp'))) {
        await this.fs.deleteFile(`${INTERNAL_VAULT_DIR}/${entry.name}`).catch(() => {})
      }
    }
  }

  get rootLabel(): string {
    return this.fs.rootUri ?? this.fs.rootPath
  }

  // -------------------------------------------------------------------
  // Layout / settings
  // -------------------------------------------------------------------

  async ensureVaultLayout(): Promise<void> {
    const settings = await this.getVaultSettings()
    // The RESOLVED directory of each system folder (vault.json
    // `systemFolderPaths`), not the default name — creating `inbox/` while
    // the settings point the inbox at `01 - Entry/` would leave a stray
    // directory every classifier then reads as the system inbox.
    const folders: NoteFolder[] =
      settings.primaryNotesLocation === 'root'
        ? ['quick', 'archive', 'trash']
        : ['inbox', 'quick', 'archive', 'trash']
    for (const f of folders) {
      await this.fs.mkdir(resolveFolderPath(f, settings.systemFolderPaths))
    }
  }

  private async inferPrimaryNotesLocation(
    systemFolderPaths?: SystemFolderPaths | null
  ): Promise<'inbox' | 'root'> {
    const entries = await this.fs.readdir('')
    // The resolved inbox directory is the strongest signal of ZenNotes' own
    // layout — trust it even when other loose folders exist at the root (a
    // daily/weekly-notes dir created during a transient mis-inference must
    // never flip a vault into root mode permanently).
    const inboxDir = resolveFolderPath('inbox', systemFolderPaths).toLowerCase()
    if (entries.some((e) => e.type === 'directory' && e.name.toLowerCase() === inboxDir)) {
      return 'inbox'
    }
    // Remapped system folders are system directories, not loose user content:
    // without this, a vault whose inbox is `01 - Entry` reads as a flat
    // root-mode vault.
    const customDirs = new Set<string>()
    if (systemFolderPaths) {
      for (const value of Object.values(systemFolderPaths)) {
        if (value) customDirs.add(value.toLowerCase())
      }
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      if (RESERVED_ROOT_NAMES.has(e.name)) continue
      if (customDirs.has(e.name.toLowerCase())) continue
      if (e.type === 'directory') return 'root'
      if (isMarkdownPath(e.name)) return 'root'
    }
    return 'inbox'
  }

  async getVaultSettings(): Promise<VaultSettings> {
    if (this.settingsCache) return this.settingsCache
    const raw = await this.fs.readTextOrNull(`${INTERNAL_VAULT_DIR}/vault.json`)
    let parsed: unknown = null
    if (raw !== null) {
      try {
        parsed = JSON.parse(raw)
      } catch {
        parsed = null
      }
    }
    const fallbackPrimary = parsed === null ? await this.inferPrimaryNotesLocation() : 'inbox'
    const normalized = this.normalizeVaultSettings(parsed, fallbackPrimary)
    warnAboutDiscardedFolderPaths(parsed, normalized)
    this.settingsCache = normalized
    return normalized
  }

  private normalizeVaultSettings(raw: unknown, fallbackPrimary: 'inbox' | 'root'): VaultSettings {
    const defaults: VaultSettings = JSON.parse(JSON.stringify(DEFAULT_VAULT_SETTINGS))
    if (!raw || typeof raw !== 'object') {
      return { ...defaults, primaryNotesLocation: fallbackPrimary }
    }
    const obj = raw as Record<string, unknown>
    const out: VaultSettings = {
      ...defaults,
      // Pass every key the file already carries through untouched — newer
      // desktop versions add settings (monthlyNotes in 2.11, …) that a
      // mobile write must never strip from a shared vault.json.
      ...(obj as Partial<VaultSettings>),
      primaryNotesLocation: obj.primaryNotesLocation === 'root' ? 'root' : 'inbox',
      dailyNotes: {
        ...defaults.dailyNotes,
        ...(obj.dailyNotes && typeof obj.dailyNotes === 'object'
          ? (obj.dailyNotes as object)
          : {})
      },
      weeklyNotes: {
        ...defaults.weeklyNotes,
        ...(obj.weeklyNotes && typeof obj.weeklyNotes === 'object'
          ? (obj.weeklyNotes as object)
          : {})
      },
      monthlyNotes: {
        ...defaults.monthlyNotes,
        ...(obj.monthlyNotes && typeof obj.monthlyNotes === 'object'
          ? (obj.monthlyNotes as object)
          : {})
      },
      folderIcons:
        obj.folderIcons && typeof obj.folderIcons === 'object'
          ? (obj.folderIcons as VaultSettings['folderIcons'])
          : {},
      folderColors:
        obj.folderColors && typeof obj.folderColors === 'object'
          ? (obj.folderColors as VaultSettings['folderColors'])
          : {},
      favorites: Array.isArray(obj.favorites)
        ? [...new Set(obj.favorites.filter((f): f is string => typeof f === 'string'))]
        : [],
      // Same validation as desktop: drop paths that collide, nest, or claim
      // another folder's default name, so every surface classifies alike.
      systemFolderPaths: normalizeSystemFolderPaths(obj.systemFolderPaths)
    }
    if (obj.view && typeof obj.view === 'object') out.view = obj.view as VaultSettings['view']
    // Harper's vault dictionary and ignored suggestions are written by desktop
    // and web; a save from this device must carry them through, or the next
    // sync erases what the user taught it. Phones never run Harper themselves.
    const harper = normalizeHarperVaultState(obj.harper)
    if (harper) out.harper = harper
    return out
  }

  async setVaultSettings(next: VaultSettings): Promise<VaultSettings> {
    const normalized = this.normalizeVaultSettings(next, 'inbox')
    await this.fs.mkdir(INTERNAL_VAULT_DIR)
    await this.fs.writeText(
      `${INTERNAL_VAULT_DIR}/vault.json`,
      JSON.stringify(normalized, null, 2)
    )
    this.settingsCache = normalized
    if (normalized.primaryNotesLocation === 'inbox') {
      // The RESOLVED inbox, not the literal one (see ensureVaultLayout).
      await this.fs.mkdir(resolveFolderPath('inbox', normalized.systemFolderPaths))
    }
    emitVaultChange({ kind: 'change', path: '.zennotes/vault.json', folder: 'inbox', scope: 'vault-settings' })
    return normalized
  }

  async rootContentHiddenByInboxMode(): Promise<boolean> {
    const settings = await this.getVaultSettings()
    if (settings.primaryNotesLocation !== 'inbox') return false
    return (await this.inferPrimaryNotesLocation(settings.systemFolderPaths)) === 'root'
  }

  /** The folder a vault-relative path belongs to, remap-aware. Settings are
   *  cached after the first read, so this is cheap on the hot paths. */
  private async folderOf(rel: string): Promise<NoteFolder | null> {
    return folderForRelativePath(rel, await this.getVaultSettings())
  }

  /** Vault-relative dir for a top folder ('' when inbox lives at root). */
  private async folderRootRel(folder: NoteFolder): Promise<string> {
    const settings = await this.getVaultSettings()
    if (folder === 'inbox' && settings.primaryNotesLocation === 'root') return ''
    return resolveFolderPath(folder, settings.systemFolderPaths)
  }

  // -------------------------------------------------------------------
  // Meta cache
  // -------------------------------------------------------------------

  private async loadMetaCache(): Promise<void> {
    const raw = await this.fs.readTextOrNull(META_CACHE_FILE)
    if (!raw) return
    try {
      const parsed = JSON.parse(raw) as { version: number; entries: Record<string, CachedMeta> }
      if (parsed.version === 1 && parsed.entries) {
        this.metaCache = new Map(Object.entries(parsed.entries))
      }
    } catch {
      // corrupt cache is disposable
    }
  }

  private scheduleMetaCachePersist(): void {
    if (!this.metaCacheDirty) return
    if (this.metaCachePersistTimer) return
    this.metaCachePersistTimer = setTimeout(() => {
      this.metaCachePersistTimer = null
      this.metaCacheDirty = false
      const entries = Object.fromEntries(this.metaCache)
      void this.fs
        .writeText(META_CACHE_FILE, JSON.stringify({ version: 1, entries }))
        .catch(() => {})
    }, 2000)
  }

  private invalidateMeta(relPath: string): void {
    this.metaCache.delete(relPath)
    this.metaCacheDirty = true
  }

  // -------------------------------------------------------------------
  // Note meta
  // -------------------------------------------------------------------

  private async readMeta(
    relPath: string,
    folder: NoteFolder,
    stat: { mtime: number; ctime: number | null; size: number },
    siblingOrder: number
  ): Promise<NoteMeta> {
    const cached = this.metaCache.get(relPath)
    if (cached && cached.mtime === stat.mtime && cached.size === stat.size) {
      return { ...cached.meta, folder, siblingOrder }
    }
    let meta: NoteMeta
    if (isExcalidrawPath(relPath)) {
      meta = {
        path: relPath,
        title: stemName(relPath),
        folder,
        siblingOrder,
        createdAt: stat.ctime || stat.mtime,
        updatedAt: stat.mtime,
        size: stat.size,
        tags: [],
        wikilinks: [],
        assetEmbeds: [],
        hasAttachments: false,
        excerpt: ''
      }
    } else {
      const body = (await this.fs.readTextOrNull(relPath)) ?? ''
      meta = {
        path: relPath,
        title: stemName(relPath),
        folder,
        siblingOrder,
        createdAt: stat.ctime || stat.mtime,
        updatedAt: stat.mtime,
        size: stat.size,
        tags: extractTags(body),
        wikilinks: extractWikilinks(body),
        assetEmbeds: extractAssetEmbeds(body),
        hasAttachments: bodyHasLocalAsset(body),
        excerpt: buildExcerpt(body)
      }
    }
    this.metaCache.set(relPath, { mtime: stat.mtime, size: stat.size, meta })
    this.metaCacheDirty = true
    return meta
  }

  private async metaForPath(relPath: string): Promise<NoteMeta> {
    const rel = resolveSafeRel(relPath)
    const folder = await this.folderOf(rel)
    if (!folder) throw new Error(`Note not in a known folder: ${rel}`)
    const stat = await this.fs.statOrNull(rel)
    if (!stat || stat.type !== 'file') throw new Error(`Note not found: ${rel}`)
    const order = await this.siblingOrderOf(rel)
    return await this.readMeta(rel, folder, stat, order)
  }

  private async siblingOrderOf(relPath: string): Promise<number> {
    const dir = dirName(relPath)
    const entries = await this.fs.readdir(dir)
    const name = relPath.slice(dir ? dir.length + 1 : 0)
    const idx = entries.findIndex((e) => e.name === name)
    return idx === -1 ? Number.MAX_SAFE_INTEGER : idx
  }

  // -------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------

  async listNotes(): Promise<NoteMeta[]> {
    const out: NoteMeta[] = []
    const settings = await this.getVaultSettings()
    const hidden = hiddenPrimaryRootNames(settings.systemFolderPaths)
    for (const folder of FOLDERS) {
      const topRel = await this.folderRootRel(folder)
      if (folder !== 'inbox' || topRel !== '') {
        const stat = await this.fs.statOrNull(topRel)
        if (!stat || stat.type !== 'directory') continue
      }
      await this.walkNotes(topRel, folder, topRel === '' || topRel === undefined, hidden, out)
    }
    this.scheduleMetaCachePersist()
    return out
  }

  private async walkNotes(
    dirRel: string,
    folder: NoteFolder,
    isPrimaryRoot: boolean,
    hidden: Set<string>,
    out: NoteMeta[]
  ): Promise<void> {
    const entries = await this.fs.readdir(dirRel)
    for (const [index, entry] of entries.entries()) {
      const childRel = dirRel ? `${dirRel}/${entry.name}` : entry.name
      if (entry.type === 'directory') {
        if (entry.name.startsWith('.')) continue
        if (isPrimaryRoot && hidden.has(entry.name)) continue
        await this.walkNotes(childRel, folder, false, hidden, out)
        continue
      }
      if (!isMarkdownPath(entry.name) && !isExcalidrawPath(entry.name)) continue
      out.push(
        await this.readMeta(
          childRel,
          folder,
          { mtime: entry.mtime, ctime: entry.ctime ?? null, size: entry.size },
          index
        )
      )
    }
  }

  async listFolders(): Promise<FolderEntry[]> {
    const out: FolderEntry[] = []
    const settings = await this.getVaultSettings()
    const hidden = hiddenPrimaryRootNames(settings.systemFolderPaths)
    for (const folder of FOLDERS) {
      const topRel = await this.folderRootRel(folder)
      const isPrimaryRoot = folder === 'inbox' && topRel === ''
      if (!isPrimaryRoot) {
        const stat = await this.fs.statOrNull(topRel)
        if (!stat || stat.type !== 'directory') continue
      }
      await this.walkFolders(topRel, folder, '', isPrimaryRoot, hidden, out)
    }
    return out
  }

  private async walkFolders(
    dirRel: string,
    folder: NoteFolder,
    subpath: string,
    isPrimaryRoot: boolean,
    hidden: Set<string>,
    out: FolderEntry[]
  ): Promise<void> {
    const entries = await this.fs.readdir(dirRel)
    for (const [index, entry] of entries.entries()) {
      if (entry.type !== 'directory') continue
      if (entry.name.startsWith('.')) continue
      if (isPrimaryRoot && hidden.has(entry.name)) continue
      const childRel = dirRel ? `${dirRel}/${entry.name}` : entry.name
      const nextSub = subpath ? `${subpath}/${entry.name}` : entry.name
      out.push({ folder, subpath: nextSub, siblingOrder: index })
      if (isFormDirName(entry.name)) continue
      await this.walkFolders(childRel, folder, nextSub, false, hidden, out)
    }
  }

  async listAssets(): Promise<AssetMeta[]> {
    const out: AssetMeta[] = []
    await this.walkAssets('', true, out)
    out.sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name))
    return out
  }

  private async walkAssets(dirRel: string, isRoot: boolean, out: AssetMeta[]): Promise<void> {
    const entries = await this.fs.readdir(dirRel)
    for (const [index, entry] of entries.entries()) {
      if (entry.name.startsWith('.')) continue
      const childRel = dirRel ? `${dirRel}/${entry.name}` : entry.name
      if (entry.type === 'directory') {
        if (isRoot && entry.name === INTERNAL_VAULT_DIR) continue
        if (isFormDirName(entry.name)) continue
        await this.walkAssets(childRel, false, out)
        continue
      }
      if (isMarkdownPath(entry.name) || isExcalidrawPath(entry.name)) continue
      if (isDatabaseInternalPath(childRel)) continue
      out.push({
        path: childRel,
        name: entry.name,
        kind: classifyImportedAsset(entry.name),
        siblingOrder: index,
        size: entry.size,
        updatedAt: entry.mtime
      })
    }
  }

  async hasAssetsDir(): Promise<boolean> {
    for (const dir of ATTACHMENTS_DIRS) {
      const stat = await this.fs.statOrNull(dir)
      if (stat?.type === 'directory') return true
    }
    return false
  }

  // -------------------------------------------------------------------
  // Read / write
  // -------------------------------------------------------------------

  async readNote(relPath: string): Promise<NoteContent> {
    const rel = resolveSafeRel(relPath)
    const stat = await this.fs.statOrNull(rel)
    if (!stat || stat.type !== 'file') throw new Error(`Note not found: ${rel}`)
    const body = await this.fs.readText(rel)
    const folder = (await this.folderOf(rel)) ?? 'inbox'
    const order = await this.siblingOrderOf(rel)
    const meta = await this.readMeta(
      rel,
      folder,
      { mtime: stat.mtime, ctime: stat.ctime, size: stat.size },
      order
    )
    return { ...meta, body }
  }

  async writeNote(relPath: string, body: string): Promise<NoteMeta> {
    const rel = resolveSafeRel(relPath)
    await this.fs.writeText(rel, body)
    this.invalidateMeta(rel)
    const folder = (await this.folderOf(rel)) ?? 'inbox'
    const isDb = isDatabaseInternalPath(rel)
    emitVaultChange({ kind: 'change', path: rel, folder, scope: isDb ? 'database' : 'content' })
    const stat = await this.fs.statOrNull(rel)
    const order = await this.siblingOrderOf(rel)
    return await this.readMeta(
      rel,
      folder,
      { mtime: stat?.mtime ?? Date.now(), ctime: stat?.ctime ?? null, size: stat?.size ?? body.length },
      order
    )
  }

  async appendToNote(relPath: string, body: string, position: 'start' | 'end'): Promise<NoteMeta> {
    const current = await this.readNote(relPath)
    const trimmed = body.replace(/\s+$/u, '')
    if (!trimmed) return current
    const next =
      position === 'end'
        ? `${current.body}${current.body.endsWith('\n') ? '' : '\n'}\n${trimmed}\n`
        : `${trimmed}\n\n${current.body}`
    return await this.writeNote(relPath, next)
  }

  private async uniqueTitle(dirRel: string, baseTitle: string, ext = '.md'): Promise<string> {
    let candidate = baseTitle
    let n = 1
    while (await this.fs.exists(joinPath(dirRel, `${candidate}${ext}`))) {
      n += 1
      candidate = `${baseTitle} ${n}`
    }
    return candidate
  }

  private async uniqueFilename(dirRel: string, filename: string): Promise<string> {
    const ext = extName(filename)
    const base = ext ? filename.slice(0, -ext.length) : filename
    let candidate = filename
    let n = 1
    while (await this.fs.exists(joinPath(dirRel, candidate))) {
      n += 1
      candidate = `${base} ${n}${ext}`
    }
    return candidate
  }

  async createNote(folder: NoteFolder, title?: string, subpath = ''): Promise<NoteMeta> {
    const base = sanitizeNoteTitle(title)
    const clean = subpath.replace(/^\/+|\/+$/g, '')
    const topRel = await this.folderRootRel(folder)
    const dir = clean ? resolveSafeRel(joinPath(topRel, clean)) : topRel
    if (dir) await this.fs.mkdir(dir)
    const finalTitle = await this.uniqueTitle(dir, base)
    const rel = joinPath(dir, `${finalTitle}.md`)
    await this.fs.writeText(rel, `# ${finalTitle}\n\n`)
    emitVaultChange({ kind: 'add', path: rel, folder, scope: 'content' })
    return await this.metaForPath(rel)
  }

  async createExcalidraw(folder: NoteFolder, subpath = '', title?: string): Promise<NoteMeta> {
    const base = title ? sanitizeNoteTitle(title) : 'Untitled drawing'
    const clean = subpath.replace(/^\/+|\/+$/g, '')
    const topRel = await this.folderRootRel(folder)
    const dir = clean ? resolveSafeRel(joinPath(topRel, clean)) : topRel
    if (dir) await this.fs.mkdir(dir)
    const finalTitle = await this.uniqueTitle(dir, base, '.excalidraw')
    const rel = joinPath(dir, `${finalTitle}.excalidraw`)
    await this.fs.writeText(rel, JSON.stringify(emptyExcalidrawDocument(), null, 2))
    emitVaultChange({ kind: 'add', path: rel, folder, scope: 'content' })
    return await this.metaForPath(rel)
  }

  async renameNote(relPath: string, nextTitle: string): Promise<NoteMeta> {
    const rel = resolveSafeRel(relPath)
    const folder = await this.folderOf(rel)
    if (!folder) throw new Error(`Note not in a known folder: ${rel}`)
    const dir = dirName(rel)
    const trimmed = sanitizeNoteTitle(nextTitle)
    const ext = isExcalidrawPath(rel) ? '.excalidraw' : '.md'
    const target = joinPath(dir, `${trimmed}${ext}`)
    if (target === rel) return await this.metaForPath(rel)
    if (await this.fs.exists(target)) {
      throw new Error(`A note named "${trimmed}" already exists in ${folder}`)
    }
    // Snapshot for inbound wikilink rewriting before the rename lands.
    const preNotes = await this.listNotes()
    await this.fs.rename(rel, target)
    this.invalidateMeta(rel)
    await this.moveNoteComments(rel, target)
    emitVaultChange({ kind: 'unlink', path: rel, folder, scope: 'content' })
    emitVaultChange({ kind: 'add', path: target, folder, scope: 'content' })
    await this.updateInboundWikilinks(preNotes, rel, trimmed)
    return await this.metaForPath(target)
  }

  private async updateInboundWikilinks(
    preNotes: NoteMeta[],
    oldPath: string,
    newTitle: string
  ): Promise<void> {
    const refs: RenameNoteRef[] = preNotes.map((n) => ({
      path: n.path,
      title: n.title,
      folder: n.folder
    }))
    const oldTitle = stemName(oldPath)
    for (const note of preNotes) {
      if (note.folder === 'trash') continue
      if (note.path === oldPath) continue
      if (!note.wikilinks.length) continue
      const mightLink = note.wikilinks.some((target) => {
        const t = target.toLowerCase()
        return (
          t === oldTitle.toLowerCase() ||
          t.endsWith(`/${oldTitle.toLowerCase()}`) ||
          t.replace(/\.md$/i, '') === oldPath.replace(/\.md$/i, '').toLowerCase() ||
          oldPath.toLowerCase().endsWith(`${t.replace(/\.md$/i, '')}.md`)
        )
      })
      if (!mightLink) continue
      const body = await this.fs.readTextOrNull(note.path)
      if (body === null) continue
      const { body: nextBody, changed } = rewriteWikilinksForRename(body, refs, oldPath, newTitle)
      if (changed > 0) {
        await this.fs.writeText(note.path, nextBody)
        this.invalidateMeta(note.path)
        emitVaultChange({ kind: 'change', path: note.path, folder: note.folder, scope: 'content' })
      }
    }
  }

  private async folderSubpathOf(rel: string): Promise<string> {
    const folder = await this.folderOf(rel)
    if (!folder) return ''
    const topRel = await this.folderRootRel(folder)
    const dir = dirName(rel)
    if (!topRel) return dir
    if (dir === topRel) return ''
    return dir.startsWith(`${topRel}/`) ? dir.slice(topRel.length + 1) : ''
  }

  private async moveBetweenFolders(relPath: string, target: NoteFolder): Promise<NoteMeta> {
    const rel = resolveSafeRel(relPath)
    const sourceFolder = (await this.folderOf(rel)) ?? 'inbox'
    const filename = rel.slice(dirName(rel) ? dirName(rel).length + 1 : 0)
    const subpath = await this.folderSubpathOf(rel)
    const targetRoot = await this.folderRootRel(target)
    const destDir = subpath ? resolveSafeRel(joinPath(targetRoot, subpath)) : targetRoot
    if (destDir) await this.fs.mkdir(destDir)
    const ext = isExcalidrawPath(filename) ? '.excalidraw' : '.md'
    const baseTitle = stemName(filename)
    const finalTitle = await this.uniqueTitle(destDir, baseTitle, ext)
    const destRel = joinPath(destDir, `${finalTitle}${ext}`)
    await this.fs.rename(rel, destRel)
    this.invalidateMeta(rel)
    await this.moveNoteComments(rel, destRel)
    emitVaultChange({ kind: 'unlink', path: rel, folder: sourceFolder, scope: 'content' })
    emitVaultChange({ kind: 'add', path: destRel, folder: target, scope: 'content' })
    return await this.metaForPath(destRel)
  }

  moveToTrash(relPath: string): Promise<NoteMeta> {
    return this.moveBetweenFolders(relPath, 'trash')
  }
  restoreFromTrash(relPath: string): Promise<NoteMeta> {
    return this.moveBetweenFolders(relPath, 'inbox')
  }
  archiveNote(relPath: string): Promise<NoteMeta> {
    return this.moveBetweenFolders(relPath, 'archive')
  }
  unarchiveNote(relPath: string): Promise<NoteMeta> {
    return this.moveBetweenFolders(relPath, 'inbox')
  }

  async emptyTrash(): Promise<void> {
    const trashDir = await this.folderRootRel('trash')
    const entries = await this.fs.readdir(trashDir)
    for (const entry of entries) {
      const rel = `${trashDir}/${entry.name}`
      await this.removeNoteComments(rel)
      if (entry.type === 'directory') {
        await this.fs.rmdir(rel).catch(() => {})
      } else {
        await this.fs.deleteFile(rel).catch(() => {})
      }
      this.invalidateMeta(rel)
      emitVaultChange({ kind: 'unlink', path: rel, folder: 'trash', scope: 'content' })
    }
  }

  async deleteNote(relPath: string): Promise<void> {
    const rel = resolveSafeRel(relPath)
    const folder = (await this.folderOf(rel)) ?? 'trash'
    await this.fs.deleteFile(rel)
    await this.removeNoteComments(rel)
    this.invalidateMeta(rel)
    emitVaultChange({ kind: 'unlink', path: rel, folder, scope: 'content' })
  }

  async duplicateNote(relPath: string): Promise<NoteMeta> {
    const rel = resolveSafeRel(relPath)
    const folder = (await this.folderOf(rel)) ?? 'inbox'
    const dir = dirName(rel)
    const ext = isExcalidrawPath(rel) ? '.excalidraw' : '.md'
    const copyTitle = await this.uniqueTitle(dir, `${stemName(rel)} copy`, ext)
    const destRel = joinPath(dir, `${copyTitle}${ext}`)
    const body = await this.fs.readText(rel)
    await this.fs.writeText(destRel, body)
    const comments = await this.readNoteComments(rel)
    if (comments.length > 0) {
      const now = Date.now()
      await this.writeCommentsFile(
        destRel,
        comments.map((c) => ({ ...c, id: uuid(), notePath: destRel, createdAt: now, updatedAt: now }))
      )
    }
    emitVaultChange({ kind: 'add', path: destRel, folder, scope: 'content' })
    return await this.metaForPath(destRel)
  }

  async moveNote(relPath: string, targetFolder: NoteFolder, targetSubpath: string): Promise<NoteMeta> {
    const rel = resolveSafeRel(relPath)
    const sourceFolder = (await this.folderOf(rel)) ?? 'inbox'
    const filename = rel.slice(dirName(rel) ? dirName(rel).length + 1 : 0)
    const targetRoot = await this.folderRootRel(targetFolder)
    const clean = (targetSubpath ?? '').replace(/^\/+|\/+$/g, '')
    const destDir = clean ? resolveSafeRel(joinPath(targetRoot, clean)) : targetRoot
    if (destDir) await this.fs.mkdir(destDir)
    const ext = extName(filename)
    const baseTitle = stemName(filename)
    const destRel = joinPath(
      destDir,
      `${await this.uniqueTitle(destDir, baseTitle, ext || '.md')}${ext || '.md'}`
    )
    if (destRel === rel) return await this.metaForPath(rel)
    await this.fs.rename(rel, destRel)
    this.invalidateMeta(rel)
    await this.moveNoteComments(rel, destRel)
    emitVaultChange({ kind: 'unlink', path: rel, folder: sourceFolder, scope: 'content' })
    emitVaultChange({ kind: 'add', path: destRel, folder: targetFolder, scope: 'content' })
    return await this.metaForPath(destRel)
  }

  // -------------------------------------------------------------------
  // Folders
  // -------------------------------------------------------------------

  async createFolder(folder: NoteFolder, subpath: string): Promise<void> {
    const topRel = await this.folderRootRel(folder)
    const clean = subpath.replace(/^\/+|\/+$/g, '')
    if (!clean) return
    await this.fs.mkdir(resolveSafeRel(joinPath(topRel, clean)))
    emitVaultChange({ kind: 'add', path: joinPath(topRel, clean), folder, scope: 'folder' })
  }

  async renameFolder(folder: NoteFolder, oldSubpath: string, newSubpath: string): Promise<string> {
    const topRel = await this.folderRootRel(folder)
    const oldClean = oldSubpath.replace(/^\/+|\/+$/g, '')
    const newClean = newSubpath.replace(/^\/+|\/+$/g, '')
    if (!oldClean || !newClean) throw new Error('Folder path required')
    if (newClean === oldClean) return oldClean
    if (`${newClean}/`.startsWith(`${oldClean}/`)) {
      throw new Error('Cannot move a folder into itself')
    }
    const oldRel = resolveSafeRel(joinPath(topRel, oldClean))
    const newRel = resolveSafeRel(joinPath(topRel, newClean))
    if (await this.fs.exists(newRel)) {
      throw new Error(`A folder named "${newClean}" already exists`)
    }
    const parent = dirName(newRel)
    if (parent) await this.fs.mkdir(parent)
    await this.fs.rename(oldRel, newRel)
    // Re-key folder icons/colors + drop stale meta cache entries under the old path.
    const settings = await this.getVaultSettings()
    const rekey = (map: Record<string, string>): Record<string, string> => {
      const out: Record<string, string> = {}
      const oldKey = `${folder}:${oldClean}`
      const newKey = `${folder}:${newClean}`
      for (const [k, v] of Object.entries(map)) {
        if (k === oldKey) out[newKey] = v
        else if (k.startsWith(`${oldKey}/`)) out[`${newKey}${k.slice(oldKey.length)}`] = v
        else out[k] = v
      }
      return out
    }
    await this.setVaultSettings({
      ...settings,
      folderIcons: rekey(settings.folderIcons as Record<string, string>) as VaultSettings['folderIcons'],
      folderColors: rekey(settings.folderColors as Record<string, string>) as VaultSettings['folderColors']
    })
    for (const key of [...this.metaCache.keys()]) {
      if (key.startsWith(`${oldRel}/`)) this.invalidateMeta(key)
    }
    emitVaultChange({ kind: 'unlink', path: oldRel, folder, scope: 'folder' })
    emitVaultChange({ kind: 'add', path: newRel, folder, scope: 'folder' })
    return newClean
  }

  async deleteFolder(folder: NoteFolder, subpath: string): Promise<void> {
    const topRel = await this.folderRootRel(folder)
    const clean = subpath.replace(/^\/+|\/+$/g, '')
    if (!clean) return
    const rel = resolveSafeRel(joinPath(topRel, clean))
    await this.fs.rmdir(rel)
    for (const key of [...this.metaCache.keys()]) {
      if (key.startsWith(`${rel}/`)) this.invalidateMeta(key)
    }
    emitVaultChange({ kind: 'unlink', path: rel, folder, scope: 'folder' })
  }

  async duplicateFolder(folder: NoteFolder, subpath: string): Promise<string> {
    const topRel = await this.folderRootRel(folder)
    const clean = subpath.replace(/^\/+|\/+$/g, '')
    if (!clean) throw new Error('Folder path required')
    const srcRel = resolveSafeRel(joinPath(topRel, clean))
    const parentSub = dirName(clean)
    const base = `${clean.split('/').pop()} copy`
    let candidate = base
    let n = 1
    while (await this.fs.exists(joinPath(topRel, parentSub, candidate))) {
      n += 1
      candidate = `${base} ${n}`
    }
    const destSub = parentSub ? `${parentSub}/${candidate}` : candidate
    await this.fs.copy(srcRel, resolveSafeRel(joinPath(topRel, destSub)))
    emitVaultChange({ kind: 'add', path: joinPath(topRel, destSub), folder, scope: 'folder' })
    return destSub
  }

  // -------------------------------------------------------------------
  // Comments — .zennotes/comments/<rel>.comments.json
  // -------------------------------------------------------------------

  private commentsPathFor(rel: string): string {
    return `${INTERNAL_VAULT_DIR}/${NOTE_COMMENTS_DIR}/${rel}${NOTE_COMMENTS_SUFFIX}`
  }

  async readNoteComments(relPath: string): Promise<NoteComment[]> {
    const raw = await this.fs.readTextOrNull(this.commentsPathFor(resolveSafeRel(relPath)))
    if (!raw) return []
    try {
      const parsed = JSON.parse(raw) as { comments?: NoteComment[] } | NoteComment[]
      const list = Array.isArray(parsed) ? parsed : (parsed.comments ?? [])
      return list
        .filter((c) => c && typeof c === 'object')
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    } catch {
      return []
    }
  }

  private async writeCommentsFile(rel: string, comments: NoteComment[]): Promise<void> {
    const path = this.commentsPathFor(rel)
    if (comments.length === 0) {
      await this.fs.deleteFile(path).catch(() => {})
      return
    }
    await this.fs.writeText(path, JSON.stringify({ version: 1, comments }, null, 2))
  }

  async writeNoteComments(relPath: string, inputs: NoteCommentInput[]): Promise<NoteComment[]> {
    const rel = resolveSafeRel(relPath)
    const now = Date.now()
    const comments: NoteComment[] = inputs.map((input) => ({
      id: input.id ?? uuid(),
      notePath: rel,
      anchorStart: Math.max(0, Math.min(input.anchorStart, input.anchorEnd)),
      anchorEnd: Math.max(0, Math.max(input.anchorStart, input.anchorEnd)),
      anchorText: (input.anchorText ?? '').slice(0, 500),
      body: input.body ?? '',
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
      resolvedAt: input.resolvedAt ?? null
    }))
    await this.writeCommentsFile(rel, comments)
    emitVaultChange({
      kind: 'change',
      path: rel,
      folder: (await this.folderOf(rel)) ?? 'inbox',
      scope: 'comments'
    })
    return comments
  }

  private async moveNoteComments(oldRel: string, newRel: string): Promise<void> {
    const oldPath = this.commentsPathFor(oldRel)
    const raw = await this.fs.readTextOrNull(oldPath)
    if (raw === null) return
    try {
      const parsed = JSON.parse(raw) as { comments?: NoteComment[] }
      const comments = (parsed.comments ?? []).map((c) => ({ ...c, notePath: newRel }))
      await this.writeCommentsFile(newRel, comments)
    } catch {
      // unreadable sidecar — drop it
    }
    await this.fs.deleteFile(oldPath).catch(() => {})
  }

  private async removeNoteComments(rel: string): Promise<void> {
    await this.fs.deleteFile(this.commentsPathFor(rel)).catch(() => {})
  }

  // -------------------------------------------------------------------
  // Workspace state
  // -------------------------------------------------------------------

  async readWorkspaceState(): Promise<string | null> {
    return await this.fs.readTextOrNull(`${INTERNAL_VAULT_DIR}/workspace.json`)
  }

  async writeWorkspaceState(json: string): Promise<void> {
    if (typeof json !== 'string') return
    await this.fs.mkdir(INTERNAL_VAULT_DIR)
    await this.fs.writeText(`${INTERNAL_VAULT_DIR}/workspace.json`, json)
  }

  // -------------------------------------------------------------------
  // Search — builtin backend semantics (per line, fuzzy, trash excluded)
  // -------------------------------------------------------------------

  async searchVaultText(query: string, limit = 80): Promise<VaultTextSearchMatch[]> {
    const trimmed = query.trim()
    if (!trimmed) return []
    const candidates: SearchCandidate[] = []
    const settings = await this.getVaultSettings()
    const hidden = hiddenPrimaryRootNames(settings.systemFolderPaths)
    for (const folder of SEARCHABLE_TEXT_FOLDERS) {
      const topRel = await this.folderRootRel(folder)
      const isPrimaryRoot = folder === 'inbox' && topRel === ''
      if (!isPrimaryRoot) {
        const stat = await this.fs.statOrNull(topRel)
        if (!stat || stat.type !== 'directory') continue
      }
      await this.collectSearchCandidates(topRel, folder, isPrimaryRoot, hidden, candidates)
    }
    const ranked: { score: number; c: SearchCandidate }[] = []
    for (const c of candidates) {
      const bodyScore = scoreMatch(trimmed, c.lineText)
      if (bodyScore <= 0) continue
      const titleScore = scoreMatch(trimmed, c.title) * 0.18
      const pathScore = scoreMatch(trimmed, c.path) * 0.1
      ranked.push({ score: bodyScore + titleScore + pathScore, c })
    }
    ranked.sort((a, b) => b.score - a.score)
    return ranked.slice(0, limit).map(({ c }) => ({
      path: c.path,
      title: c.title,
      folder: c.folder,
      lineNumber: c.lineNumber,
      offset: Math.min(c.offset + firstMatchColumn(trimmed, c.rawLine), c.offset + c.rawLine.length),
      lineText: c.lineText
    }))
  }

  private async collectSearchCandidates(
    dirRel: string,
    folder: NoteFolder,
    isPrimaryRoot: boolean,
    hidden: Set<string>,
    out: SearchCandidate[]
  ): Promise<void> {
    const entries = await this.fs.readdir(dirRel)
    for (const entry of entries) {
      const childRel = dirRel ? `${dirRel}/${entry.name}` : entry.name
      if (entry.type === 'directory') {
        if (entry.name.startsWith('.')) continue
        if (isPrimaryRoot && hidden.has(entry.name)) continue
        await this.collectSearchCandidates(childRel, folder, false, hidden, out)
        continue
      }
      if (!isMarkdownPath(entry.name)) continue
      const body = await this.fs.readTextOrNull(childRel)
      if (body === null) continue
      const title = stemName(entry.name)
      let lineOffset = 0
      const lines = body.split('\n')
      for (const [index, rawLine] of lines.entries()) {
        const lineText = collapseSearchLine(rawLine).slice(0, 220)
        if (lineText) {
          out.push({
            path: childRel,
            title,
            folder,
            lineNumber: index + 1,
            offset: lineOffset,
            lineText,
            rawLine
          })
        }
        lineOffset += rawLine.length + 1
      }
    }
  }

  // -------------------------------------------------------------------
  // Tasks
  // -------------------------------------------------------------------

  /** A note's file-task (if its frontmatter tags it `#task`) first — so it
   *  heads the note's group in the Tasks list — then every inline `- [ ]`
   *  checkbox; mirrors desktop `apps/desktop/src/main/tasks.ts`. */
  private parseAllTasks(
    body: string,
    ctx: { path: string; title: string; folder: NoteFolder }
  ): VaultTask[] {
    const fileTask = parseTaskFile(body, ctx)
    const inline = parseTasksFromBody(body, ctx)
    return fileTask ? [fileTask, ...inline] : inline
  }

  async scanTasks(): Promise<VaultTask[]> {
    const notes = await this.listNotes()
    const out: VaultTask[] = []
    for (const note of notes) {
      if (note.folder === 'trash') continue
      if (!isMarkdownPath(note.path)) continue
      const body = await this.fs.readTextOrNull(note.path)
      if (body === null) continue
      out.push(
        ...this.parseAllTasks(body, { path: note.path, title: note.title, folder: note.folder })
      )
    }
    return out
  }

  async scanTasksForPath(relPath: string): Promise<VaultTask[]> {
    const rel = resolveSafeRel(relPath)
    const folder = await this.folderOf(rel)
    if (!folder || folder === 'trash') return []
    if (!isMarkdownPath(rel)) return []
    const body = await this.fs.readTextOrNull(rel)
    if (body === null) return []
    return this.parseAllTasks(body, { path: rel, title: stemName(rel), folder })
  }

  // -------------------------------------------------------------------
  // Templates — .zennotes/templates/*.md
  // -------------------------------------------------------------------

  async listTemplates(): Promise<CustomTemplateFile[]> {
    const entries = await this.fs.readdir(TEMPLATES_DIR)
    const out: CustomTemplateFile[] = []
    for (const entry of entries) {
      if (entry.type !== 'file' || !isMarkdownPath(entry.name)) continue
      const sourcePath = `${TEMPLATES_DIR}/${entry.name}`
      const raw = await this.fs.readTextOrNull(sourcePath)
      if (raw !== null) out.push({ sourcePath, raw })
    }
    return out
  }

  async readTemplate(sourcePath: string): Promise<string> {
    const raw = await this.fs.readTextOrNull(resolveSafeRel(sourcePath))
    if (raw === null) throw new Error(`Template not found: ${sourcePath}`)
    return raw
  }

  async writeTemplate(input: WriteTemplateInput): Promise<CustomTemplateFile> {
    await this.fs.mkdir(TEMPLATES_DIR)
    const sourcePath = `${TEMPLATES_DIR}/${input.slug}.md`
    await this.fs.writeText(sourcePath, input.raw)
    if (input.previousSourcePath && input.previousSourcePath !== sourcePath) {
      await this.fs.deleteFile(resolveSafeRel(input.previousSourcePath)).catch(() => {})
    }
    return { sourcePath, raw: input.raw }
  }

  async deleteTemplate(sourcePath: string): Promise<void> {
    await this.fs.deleteFile(resolveSafeRel(sourcePath))
  }

  // -------------------------------------------------------------------
  // Demo tour
  // -------------------------------------------------------------------

  /** First-boot seed for brand-new vaults: one phone-focused welcome note
   *  (the desktop demo tour stays available via its command). */
  async seedWelcomeNote(): Promise<void> {
    await this.ensureVaultLayout()
    await this.fs.writeText(WELCOME_NOTE_PATH, WELCOME_NOTE_BODY)
    this.invalidateMeta(WELCOME_NOTE_PATH)
    emitVaultChange({ kind: 'add', path: WELCOME_NOTE_PATH, folder: 'inbox', scope: 'content' })
  }

  async generateDemoTour(): Promise<VaultDemoTourResult> {
    await this.ensureVaultLayout()
    for (const note of DEMO_TOUR_NOTES) {
      const dir = dirName(note.path)
      if (dir) await this.fs.mkdir(dir)
      await this.fs.writeText(note.path, note.body)
      this.invalidateMeta(note.path)
    }
    for (const asset of DEMO_TOUR_ASSETS) {
      const dir = dirName(asset.path)
      if (dir) await this.fs.mkdir(dir)
      await this.fs.writeText(asset.path, asset.body)
    }
    emitVaultChange({ kind: 'add', path: 'inbox/demo', folder: 'inbox', scope: 'content' })
    return {
      notePaths: DEMO_TOUR_NOTES.map((n) => n.path),
      assetPaths: DEMO_TOUR_ASSETS.map((a) => a.path)
    }
  }

  async removeDemoTour(): Promise<VaultDemoTourResult> {
    for (const note of DEMO_TOUR_NOTES) {
      await this.fs.deleteFile(note.path).catch(() => {})
      this.invalidateMeta(note.path)
    }
    for (const asset of DEMO_TOUR_ASSETS) {
      await this.fs.deleteFile(asset.path).catch(() => {})
    }
    const remaining = await this.fs.readdir('inbox/demo')
    if (remaining.length === 0) await this.fs.rmdir('inbox/demo').catch(() => {})
    emitVaultChange({ kind: 'unlink', path: 'inbox/demo', folder: 'inbox', scope: 'content' })
    return {
      notePaths: DEMO_TOUR_NOTES.map((n) => n.path),
      assetPaths: DEMO_TOUR_ASSETS.map((a) => a.path)
    }
  }

  // -------------------------------------------------------------------
  // Assets
  // -------------------------------------------------------------------

  async importPastedImage(input: PastedImageInput): Promise<ImportedAsset> {
    const bytes =
      input.data instanceof Uint8Array ? input.data : new Uint8Array(input.data as ArrayBuffer)
    const ext = pastedImageExtension(input.mimeType, input.suggestedName ?? null)
    const base = pastedImageBaseName(input.suggestedName ?? null)
    await this.fs.mkdir(ASSETS_DIR)
    const filename = await this.uniqueFilename(ASSETS_DIR, `${base}${ext}`)
    const rel = `${ASSETS_DIR}/${filename}`
    await this.fs.writeBase64(rel, bytesToBase64(bytes))
    emitVaultChange({ kind: 'add', path: rel, folder: 'inbox', scope: 'content' })
    return { name: filename, path: rel, markdown: `![[${rel}]]`, kind: 'image' }
  }

  /**
   * An attached file lands in `assets/`, the same folder a pasted image goes to
   * (`importPastedImage`) and the same one the cloud vault uploads to, and is
   * linked by vault-relative path.
   *
   * It used to be written to the vault ROOT and linked with a hand-built
   * `'../'.repeat(depth)` path, so attaching a file scattered images among the
   * notes and produced `![name](<../name.jpg>)` (reported on Discord by xenin).
   * Desktop had exactly this bug and fixed it in #377; the port was missed
   * here. Images take the wikilink form so every surface resolves them the same
   * way paste already does.
   */
  async importDroppedFile(_notePath: string, file: File): Promise<ImportedAsset> {
    const bytes = new Uint8Array(await file.arrayBuffer())
    await this.fs.mkdir(ASSETS_DIR)
    const filename = await this.uniqueFilename(ASSETS_DIR, importedAssetFilename(file.name))
    const rel = importedAssetRelPath(filename)
    await this.fs.writeBase64(rel, bytesToBase64(bytes))
    const kind = classifyImportedAsset(filename)
    emitVaultChange({ kind: 'add', path: rel, folder: 'inbox', scope: 'content' })
    return { name: filename, path: rel, markdown: importedAssetMarkdown(rel, filename, kind), kind }
  }

  async renameAsset(relPath: string, nextName: string): Promise<AssetMeta> {
    const rel = resolveSafeRel(relPath)
    const dir = dirName(rel)
    const clean = nextName.replace(/[\\/:*?"<>|]/g, '-').trim()
    if (!clean) throw new Error('Asset name required')
    const target = joinPath(dir, clean)
    if (target !== rel && (await this.fs.exists(target))) {
      throw new Error(`A file named "${clean}" already exists`)
    }
    await this.fs.rename(rel, target)
    emitVaultChange({ kind: 'unlink', path: rel, folder: 'inbox', scope: 'content' })
    emitVaultChange({ kind: 'add', path: target, folder: 'inbox', scope: 'content' })
    return await this.assetMetaFor(target)
  }

  async moveAsset(relPath: string, targetDir: string): Promise<AssetMeta> {
    const rel = resolveSafeRel(relPath)
    const cleanDir = targetDir ? resolveSafeRel(targetDir) : ASSETS_DIR
    await this.fs.mkdir(cleanDir)
    const name = rel.split('/').pop() as string
    const finalName = await this.uniqueFilename(cleanDir, name)
    const target = joinPath(cleanDir, finalName)
    await this.fs.rename(rel, target)
    emitVaultChange({ kind: 'unlink', path: rel, folder: 'inbox', scope: 'content' })
    emitVaultChange({ kind: 'add', path: target, folder: 'inbox', scope: 'content' })
    return await this.assetMetaFor(target)
  }

  async duplicateAsset(relPath: string): Promise<AssetMeta> {
    const rel = resolveSafeRel(relPath)
    const dir = dirName(rel)
    const ext = extName(rel)
    const base = stemName(rel)
    const finalName = await this.uniqueFilename(dir, `${base} copy${ext}`)
    const target = joinPath(dir, finalName)
    await this.fs.copy(rel, target)
    emitVaultChange({ kind: 'add', path: target, folder: 'inbox', scope: 'content' })
    return await this.assetMetaFor(target)
  }

  async deleteAsset(relPath: string): Promise<DeletedAsset> {
    const rel = resolveSafeRel(relPath)
    const name = rel.split('/').pop() as string
    const undoToken = uuid()
    const trashDir = `${INTERNAL_VAULT_DIR}/deleted-assets/${undoToken}`
    await this.fs.mkdir(trashDir)
    const deletedAt = new Date().toISOString()
    await this.fs.rename(rel, `${trashDir}/${name}`)
    // Persist the original location so the asset can be listed + restored
    // from the Trash view even after a restart (desktop 2.11 parity).
    await this.fs.writeText(
      `${trashDir}/${DELETED_ASSET_META}`,
      JSON.stringify({ path: rel, name, deletedAt }, null, 2)
    )
    emitVaultChange({ kind: 'unlink', path: rel, folder: 'inbox', scope: 'content' })
    return { path: rel, name, undoToken, deletedAt }
  }

  /** Enumerate restorable assets in the deleted-assets store, newest first.
   *  Entries without metadata (pre-2.11 deletes) are skipped. */
  async listDeletedAssets(): Promise<DeletedAsset[]> {
    let tokens: Array<{ name: string; type: string }>
    try {
      tokens = await this.fs.readdir(`${INTERNAL_VAULT_DIR}/deleted-assets`)
    } catch {
      return []
    }
    const out: DeletedAsset[] = []
    for (const entry of tokens) {
      if (entry.type !== 'directory') continue
      const undoToken = entry.name
      try {
        const raw = await this.fs.readTextOrNull(
          `${INTERNAL_VAULT_DIR}/deleted-assets/${undoToken}/${DELETED_ASSET_META}`
        )
        if (raw === null) continue
        const meta = JSON.parse(raw) as { path?: unknown; name?: unknown; deletedAt?: unknown }
        if (typeof meta.path !== 'string' || typeof meta.name !== 'string') continue
        // The asset file itself must still be present to be restorable.
        const files = await this.fs.readdir(`${INTERNAL_VAULT_DIR}/deleted-assets/${undoToken}`)
        if (!files.some((f) => f.name === meta.name)) continue
        out.push({
          path: meta.path,
          name: meta.name,
          undoToken,
          deletedAt: typeof meta.deletedAt === 'string' ? meta.deletedAt : undefined
        })
      } catch {
        // Missing/invalid metadata — not listable from the Trash view.
      }
    }
    out.sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''))
    return out
  }

  /** Permanently delete one asset from the deleted-assets store. */
  async purgeDeletedAsset(undoToken: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(undoToken)) throw new Error('Invalid restore token')
    await this.fs.rmdir(`${INTERNAL_VAULT_DIR}/deleted-assets/${undoToken}`).catch(() => {})
  }

  /** Permanently delete every asset in the deleted-assets store. */
  async emptyDeletedAssets(): Promise<void> {
    await this.fs.rmdir(`${INTERNAL_VAULT_DIR}/deleted-assets`).catch(() => {})
  }

  async restoreDeletedAsset(asset: DeletedAsset): Promise<AssetMeta> {
    if (!/^[0-9a-f-]{36}$/i.test(asset.undoToken)) throw new Error('Invalid restore token')
    const source = `${INTERNAL_VAULT_DIR}/deleted-assets/${asset.undoToken}/${asset.name}`
    const dir = dirName(resolveSafeRel(asset.path))
    if (dir) await this.fs.mkdir(dir)
    const finalName = await this.uniqueFilename(dir, asset.name)
    const target = joinPath(dir, finalName)
    await this.fs.rename(source, target)
    await this.fs.rmdir(`${INTERNAL_VAULT_DIR}/deleted-assets/${asset.undoToken}`).catch(() => {})
    emitVaultChange({ kind: 'add', path: target, folder: 'inbox', scope: 'content' })
    return await this.assetMetaFor(target)
  }

  private async assetMetaFor(rel: string): Promise<AssetMeta> {
    const stat = await this.fs.statOrNull(rel)
    if (!stat) throw new Error(`Asset not found: ${rel}`)
    const name = rel.split('/').pop() as string
    return {
      path: rel,
      name,
      kind: classifyImportedAsset(name),
      siblingOrder: await this.siblingOrderOf(rel),
      size: stat.size,
      updatedAt: stat.mtime
    }
  }

  /** Foreground rescan: re-stat the tree, emit change events for anything new. */
  async rescan(): Promise<void> {
    // Vault settings may have changed externally (desktop edit synced via
    // iCloud) — drop the cache so the next read sees the file.
    this.settingsCache = null
    const before = new Map<string, CachedMeta>(this.metaCache)
    const notes = await this.listNotes()
    const seen = new Set(notes.map((n) => n.path))
    for (const note of notes) {
      const prev = before.get(note.path)
      if (!prev) {
        emitVaultChange({ kind: 'add', path: note.path, folder: note.folder, scope: 'content' })
      } else if (prev.meta.updatedAt !== note.updatedAt || prev.size !== note.size) {
        emitVaultChange({ kind: 'change', path: note.path, folder: note.folder, scope: 'content' })
      }
    }
    for (const [path] of before) {
      if (!seen.has(path)) {
        this.invalidateMeta(path)
        emitVaultChange({
          kind: 'unlink',
          path,
          folder: (await this.folderOf(path)) ?? 'inbox',
          scope: 'content'
        })
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Pasted image naming — mirrors vault.ts pastedImage* helpers
// ---------------------------------------------------------------------------

const PASTED_IMAGE_MIME_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/svg+xml': '.svg'
}

function pastedImageExtension(mimeType: string, suggestedName: string | null): string {
  if (suggestedName) {
    const ext = extName(suggestedName).toLowerCase()
    if (ext && ['.apng', '.avif', '.gif', '.jpeg', '.jpg', '.png', '.svg', '.webp'].includes(ext)) {
      return ext
    }
  }
  const mapped = PASTED_IMAGE_MIME_EXTENSIONS[mimeType.toLowerCase()]
  if (mapped) return mapped
  if (mimeType.toLowerCase().startsWith('image/')) return '.png'
  throw new Error(`Unsupported pasted image type: ${mimeType}`)
}

function pastedImageTimestamp(now: Date): string {
  const pad = (v: number): string => String(v).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

function pastedImageBaseName(suggestedName: string | null): string {
  if (suggestedName) {
    const base = stemName(suggestedName)
      .replace(/[\\/:%*?"<>|[\]#^]/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
    if (base) return base
  }
  return `Pasted Image ${pastedImageTimestamp(new Date())}`
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

export type { FileInfo }
