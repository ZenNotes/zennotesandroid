/**
 * PortableCloudSyncRepository with a scan cache. The upstream portable scan
 * reads and hashes every file's full bytes across the native bridge on every
 * sync run — a 60-second background cadence on app-core's auto-sync — which
 * scales battery and memory cost with vault size. This subclass skips the
 * read for files that are provably not needed:
 *
 *   skip ⇔ (mtime AND size unchanged since the last real read)
 *          AND (that read's hash equals the acked sync state's hash)
 *          AND (the file is not involved in a pending conflict)
 *
 * The engine (cloud-sync-engine planCloudSyncMutations) touches
 * `content.data` only for items whose hash differs from the tracked state or
 * that the state does not know. The host disables skipping for review and
 * restore actions, which need real bytes even for acknowledged content.
 * A skipped item's `data` property THROWS if unexpectedly consumed, rather
 * than silently pushing content we never read.
 *
 * A lost cache or unknown timestamp causes a full read. Like other
 * metadata-based caches, this relies on the provider updating mtime or size
 * when content changes; same-size writes preserving mtime cannot be detected.
 */
import type {
  CloudSyncContent,
  CloudSyncItemKind
} from '@zennotes/bridge-contract/cloud-sync'
import {
  cloudSyncPathKey,
  normalizeCloudSyncPath,
  shouldSyncVaultPath,
  shouldTraverseCloudSyncDirectory
} from '@zennotes/shared-domain/cloud-sync'
import {
  PortableCloudSyncRepository,
  type PortableCloudSyncFileSystem
} from '@zennotes/shared-domain/cloud-sync-portable-filesystem'
import type { CloudSyncLocalItem, CloudSyncState } from '@zennotes/shared-domain/cloud-sync-engine'
import type { NativeFs } from './native-fs'
import { cloudSyncWorkBudget, decodeCloudSyncBase64 } from './cloud-sync-work'

export interface ScanCacheEntry {
  mtime: number
  size: number
  sha256: string
  kind: CloudSyncItemKind
  byte_length: number
  media_type: string
}

export type ScanCache = Record<string, ScanCacheEntry>

export interface ScanCacheStore {
  loadTracked(): Promise<CloudSyncState | null>
  loadCache(): Promise<unknown>
  saveCache(cache: ScanCache): Promise<void>
}

export class CachedCloudSyncRepository extends PortableCloudSyncRepository {
  constructor(
    fs: PortableCloudSyncFileSystem,
    private readonly native: Pick<NativeFs, 'readdirStrict' | 'readBase64' | 'statOrNull'>,
    private readonly store: ScanCacheStore,
    private readonly onChanged: () => void = () => {}
  ) {
    super(fs)
  }

  override async scan(): Promise<CloudSyncLocalItem[]> {
    const trackedSha = trackedShaByPath(await this.store.loadTracked().catch(() => null))
    const cache = normalizeScanCache(await this.store.loadCache().catch(() => null))
    const nextCache: ScanCache = {}
    const items: CloudSyncLocalItem[] = []
    await this.walkCached('', trackedSha, cache, nextCache, items)
    if (Object.keys(cache).some((path) => !nextCache[path])) this.onChanged()
    // Cache loss is only a slow next scan — never let it fail the sync run.
    await this.store.saveCache(nextCache).catch(() => {})
    return items.sort((left, right) => left.path.localeCompare(right.path))
  }

  private async walkCached(
    directory: string,
    trackedSha: Map<string, string>,
    cache: ScanCache,
    nextCache: ScanCache,
    items: CloudSyncLocalItem[]
  ): Promise<void> {
    // readdirStrict entries carry mtime and size, so validating the cache
    // costs no extra stat calls on a hit. Fresh reads are checked again
    // before their fingerprints can be reused on a later scan.
    const entries = await this.native.readdirStrict(directory)
    const checkpoint = cloudSyncWorkBudget()
    for (const entry of entries) {
      await checkpoint()
      const relPath = directory ? `${directory}/${entry.name}` : entry.name
      if (entry.type === 'directory') {
        if (shouldTraverseCloudSyncDirectory(relPath)) {
          await this.walkCached(relPath, trackedSha, cache, nextCache, items)
        }
        continue
      }
      if (!shouldSyncVaultPath(relPath)) continue

      const path = normalizeCloudSyncPath(relPath)
      const cached = cache[path]
      if (
        cached &&
        cached.mtime === entry.mtime &&
        cached.size === entry.size &&
        trackedSha.get(cloudSyncPathKey(path)) === cached.sha256
      ) {
        nextCache[path] = cached
        items.push(itemFromCache(path, cached))
        continue
      }

      const item = await this.readItemFresh(path)
      if (!cached || cached.mtime !== entry.mtime || cached.size !== entry.size || cached.sha256 !== item.content.sha256) {
        this.onChanged()
      }
      // Never seed a reusable fingerprint from an unstable native read.
      // Unknown provider timestamps are deliberately always cache misses.
      const after = await this.native.statOrNull(path).catch(() => null)
      if (validFingerprint(entry) && after?.type === 'file' &&
          after.mtime === entry.mtime && after.size === entry.size &&
          item.content.byte_length === entry.size) nextCache[path] = {
        mtime: entry.mtime,
        size: entry.size,
        sha256: item.content.sha256,
        kind: item.kind,
        byte_length: item.content.byte_length,
        media_type: item.content.media_type
      }
      items.push(item)
    }
  }

  // ---------------------------------------------------------------------
  // Preserve upstream readItem's encoding/hash semantics while yielding
  // during large base64 decoding and avoiding a binary re-encode.
  // ---------------------------------------------------------------------

  private async readItemFresh(path: string): Promise<CloudSyncLocalItem> {
    const { bytes, base64 } = await decodeCloudSyncBase64(await this.native.readBase64(path))
    const text = decodeText(path, bytes)
    return {
      path,
      kind: text === null ? 'binary' : 'text',
      content: {
        encoding: text === null ? 'base64' : 'utf8',
        data: text === null ? base64 : text,
        sha256: await sha256(bytes),
        byte_length: bytes.byteLength,
        media_type: mediaType(path, text !== null)
      }
    }
  }
}

function itemFromCache(path: string, cached: ScanCacheEntry): CloudSyncLocalItem {
  const content = {
    encoding: cached.kind === 'text' ? 'utf8' : 'base64',
    sha256: cached.sha256,
    byte_length: cached.byte_length,
    media_type: cached.media_type
  } as CloudSyncContent
  Object.defineProperty(content, 'data', {
    enumerable: true,
    get(): string {
      throw new Error(
        `Cloud sync tried to push ${path} from the scan cache without reading it — the engine's hash-equal items must never need content.`
      )
    }
  })
  return { path, kind: cached.kind, content }
}

function trackedShaByPath(state: CloudSyncState | null): Map<string, string> {
  const out = new Map<string, string>()
  if (!state || state.version !== 1 || !state.items) return out
  for (const item of Object.values(state.items)) {
    if (item && typeof item.path === 'string' && typeof item.sha256 === 'string') {
      out.set(cloudSyncPathKey(item.path), item.sha256)
    }
  }
  // Conflict review/resolution consumes actual bytes, even if a version is
  // already acknowledged. Hash exclusions also cover moved local versions.
  const paths = new Set<string>()
  const hashes = new Set<string>()
  for (const conflict of Object.values(state.pending_conflicts ?? {})) {
    for (const snapshot of [conflict.base, conflict.local, conflict.cloud]) {
      if (snapshot?.path) paths.add(cloudSyncPathKey(snapshot.path))
      if (snapshot?.content?.sha256) hashes.add(snapshot.content.sha256)
    }
    for (const path of conflict.paused_paths ?? []) paths.add(cloudSyncPathKey(path))
  }
  for (const [path, hash] of out) {
    if (paths.has(path) || hashes.has(hash)) out.delete(path)
  }
  return out
}

function validFingerprint(entry: { mtime?: number; size?: number }): boolean {
  return typeof entry.mtime === 'number' && Number.isFinite(entry.mtime) && entry.mtime > 0 &&
    typeof entry.size === 'number' && Number.isSafeInteger(entry.size) && entry.size >= 0
}

function normalizeScanCache(raw: unknown): ScanCache {
  if (!raw || typeof raw !== 'object') return {}
  const out: ScanCache = {}
  for (const [path, value] of Object.entries(raw as Record<string, unknown>)) {
    const entry = value as Partial<ScanCacheEntry> | null
    if (
      entry &&
      validFingerprint(entry) &&
      typeof entry.sha256 === 'string' &&
      (entry.kind === 'text' || entry.kind === 'binary') &&
      typeof entry.byte_length === 'number' &&
      typeof entry.media_type === 'string'
    ) {
      out[path] = entry as ScanCacheEntry
    }
  }
  return out
}

// Mirrored from upstream cloud-sync-portable-filesystem.ts — keep in lockstep.

const TEXT_EXTENSIONS = new Set([
  '.base',
  '.css',
  '.csv',
  '.excalidraw',
  '.htm',
  '.html',
  '.ini',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mdx',
  '.svg',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
  '.yaml',
  '.yml'
])

const MEDIA_TYPES: Record<string, string> = {
  '.css': 'text/css',
  '.csv': 'text/csv',
  '.gif': 'image/gif',
  '.htm': 'text/html',
  '.html': 'text/html',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.toml': 'application/toml',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml'
}

function decodeText(path: string, bytes: Uint8Array): string | null {
  if (!TEXT_EXTENSIONS.has(extension(path))) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

function extension(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot).toLowerCase()
}

function mediaType(path: string, text: boolean): string {
  return MEDIA_TYPES[extension(path)] ?? (text ? 'text/plain' : 'application/octet-stream')
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.buffer)
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}
