import type { CloudSyncChange, CloudSyncContentReference } from '@zennotes/bridge-contract/cloud-sync'
import { cloudSyncPathKey, normalizeCloudSyncPath, shouldSyncVaultPath } from '@zennotes/shared-domain/cloud-sync'
import {
  cloudSyncStagedHandle,
  registerCloudSyncStagedFile,
  throwIfCloudSyncCancelled,
  validateCloudSyncContentReference,
  validateCloudSyncDownloadInstruction,
  type CloudSyncDownloadSource,
  type CloudSyncStagedConflict,
  type CloudSyncStagedFile
} from '@zennotes/shared-domain/cloud-sync-content'
import type { CloudSyncRepositoryConflict } from '@zennotes/shared-domain/cloud-sync-coordinator'
import type { CloudSyncLocalItem, CloudSyncTrackedItem } from '@zennotes/shared-domain/cloud-sync-engine'
import type { CloudFileFingerprint } from './native-fs'

const ROLLBACK_DIRECTORY = '.zennotes/sync'
const STAGING_DIRECTORY = `${ROLLBACK_DIRECTORY}/downloads`

/** Native file operations the staging layer needs; bytes never cross the bridge. */
export interface CloudStagingNative {
  statVerified(path: string): Promise<'file' | 'directory' | null>
  readForSync(path: string, textCandidate: boolean): Promise<CloudFileFingerprint>
  download(options: { url: string; headers: Record<string, string>; to: string; byteLength: number; sha256: string }): Promise<void>
  copyForSync(from: string, to: string, byteLength: number): Promise<void>
  rename(from: string, to: string): Promise<void>
  deleteFile(path: string): Promise<void>
  mkdir(path: string): Promise<void>
  readText(path: string): Promise<string>
}

interface StagedHandle {
  owner: object
  path: string
  signal?: AbortSignal
}

/** Downloads a referenced revision into vault-private staging, then publishes
 * it only after the local destination is re-verified against sync state. */
export class NativeCloudStaging {
  constructor(
    private readonly native: CloudStagingNative,
    private readonly textCandidate: (path: string) => boolean,
    private readonly readLocal: (path: string) => Promise<CloudSyncLocalItem>
  ) {}

  async stage(source: CloudSyncDownloadSource): Promise<CloudSyncStagedFile> {
    const reference = validateCloudSyncContentReference(source.reference)
    throwIfCloudSyncCancelled(source.signal)
    await this.native.mkdir(STAGING_DIRECTORY)
    const path = `${STAGING_DIRECTORY}/${crypto.randomUUID()}`
    const discard = async () => { await this.native.deleteFile(path).catch(() => {}) }
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        throwIfCloudSyncCancelled(source.signal)
        const instruction = validateCloudSyncDownloadInstruction(
          { data: await source.getInstruction() }, reference, source.allowInsecureLoopback
        )
        if (Date.parse(instruction.download.expires_at) <= Date.now()) {
          if (attempt === 0) continue
          throw new Error('Cloud returned an expired download URL.')
        }
        try {
          await this.native.download({
            url: instruction.download.url, headers: instruction.download.headers, to: path,
            byteLength: reference.byte_length, sha256: reference.sha256
          })
        } catch (error) {
          if (attempt === 0 && isExpiredUrlError(error)) {
            await discard()
            continue
          }
          throw error
        }
        throwIfCloudSyncCancelled(source.signal)
        const staged = await this.native.readForSync(path, false)
        if (staged.sha256 !== reference.sha256 || staged.byteLength !== reference.byte_length) {
          throw new Error('Cloud download failed length or SHA-256 verification.')
        }
        const preview = reference.encoding === 'utf8' && reference.byte_length <= Math.min(source.previewLimitBytes, 262_144)
          ? { encoding: 'utf8' as const, data: await this.native.readText(path), sha256: reference.sha256,
            byte_length: reference.byte_length, media_type: reference.media_type }
          : undefined
        if (preview && new TextEncoder().encode(preview.data).byteLength !== reference.byte_length) {
          throw new Error('Cloud preview did not match its downloaded bytes.')
        }
        throwIfCloudSyncCancelled(source.signal)
        return registerCloudSyncStagedFile(reference, { owner: this, path, signal: source.signal } satisfies StagedHandle, discard, preview)
      }
      throw new Error('Cloud download could not be refreshed.')
    } catch (error) {
      await discard()
      throw error
    }
  }

  async matches(path: string, reference: CloudSyncContentReference): Promise<boolean> {
    if (await this.native.statVerified(path) !== 'file') return false
    const local = await this.native.readForSync(path, false)
    return local.sha256 === reference.sha256 && local.byteLength === reference.byte_length
  }

  async apply(change: CloudSyncChange, previous: CloudSyncTrackedItem | undefined, file: CloudSyncStagedFile): Promise<CloudSyncRepositoryConflict | void> {
    const handle = this.handle(file)
    if (change.type !== 'upsert' || !change.content_ref || change.item_id !== file.reference.item_id || change.revision < file.reference.revision) {
      throw new Error('Invalid staged Cloud change.')
    }
    cloudSyncStagedHandle(file, change.content_ref)
    const target = normalizeCloudSyncPath(change.path)
    const sourcePath = previous?.path ? normalizeCloudSyncPath(previous.path) : target
    if (![target, sourcePath].every(shouldSyncVaultPath)) return
    if (await this.matches(target, file.reference)) {
      if (sourcePath !== target && await this.native.statVerified(sourcePath) === 'file') {
        if (!await this.vouched(sourcePath, previous)) return this.conflict(sourcePath)
        await this.native.deleteFile(sourcePath)
      }
      return
    }
    for (const candidate of new Set([sourcePath, target])) {
      if (await this.native.statVerified(candidate) === 'file' && !await this.vouched(candidate, previous)) {
        return this.conflict(candidate)
      }
    }
    const targetExists = await this.native.statVerified(target) === 'file'
    await this.publish(target, handle, file.reference, targetExists ? previous?.sha256 ?? null : null, previous)
    if (sourcePath !== target && await this.native.statVerified(sourcePath) === 'file') {
      if (!await this.vouched(sourcePath, previous)) return this.conflict(sourcePath)
      throwIfCloudSyncCancelled(handle.signal)
      await this.native.deleteFile(sourcePath)
    }
  }

  async resolve(input: CloudSyncStagedConflict): Promise<void> {
    const handle = this.handle(input.file)
    const expected = input.expected_path === null ? null : normalizeCloudSyncPath(input.expected_path)
    const cloud = normalizeCloudSyncPath(input.cloud_path)
    const keep = input.keep_both_path === undefined ? null : normalizeCloudSyncPath(input.keep_both_path)
    if (!shouldSyncVaultPath(cloud) || (keep && (!shouldSyncVaultPath(keep) || cloudSyncPathKey(keep) === cloudSyncPathKey(cloud) ||
        (expected && cloudSyncPathKey(keep) === cloudSyncPathKey(expected))))) {
      throw new Error('Choose a different filename inside the synced vault.')
    }
    const local = expected ? await this.fingerprint(expected) : null
    if ((local?.sha256 ?? null) !== input.expected_sha256) throw new Error('This file changed on this device.')
    const replacing = expected !== null && cloudSyncPathKey(expected) === cloudSyncPathKey(cloud)
    if (!replacing && await this.native.statVerified(cloud) !== null) throw new Error(`${cloud} already exists.`)
    if (keep) {
      if (!expected || !local) throw new Error('Both versions are no longer available.')
      if (await this.native.statVerified(keep) !== null) throw new Error(`${keep} already exists.`)
      // keep_both_path is user-visible and scanned: a partial copy left behind
      // would be uploaded as the "conflict copy". Any failure removes it.
      try {
        await this.native.copyForSync(expected, keep, local.byteLength)
        const copy = await this.native.readForSync(keep, false)
        if (copy.sha256 !== local.sha256 || copy.byteLength !== local.byteLength) {
          throw new Error('The local copy failed byte verification.')
        }
      } catch (error) {
        await this.native.deleteFile(keep).catch(() => {})
        throw error
      }
    }
    try {
      if (expected && (await this.fingerprint(expected))?.sha256 !== input.expected_sha256) {
        throw new Error('This file changed on this device.')
      }
      await this.publish(cloud, handle, input.file.reference, replacing ? input.expected_sha256 : null)
    } catch (error) {
      // Remove only our unchanged duplicate after the original is confirmed
      // safe. A later edit or incomplete rollback must retain both copies.
      if (keep && expected && local) {
        const original = await this.fingerprint(expected).catch(() => null)
        const duplicate = await this.fingerprint(keep).catch(() => null)
        if (original?.sha256 === local.sha256 && original.byteLength === local.byteLength &&
            duplicate?.sha256 === local.sha256 && duplicate.byteLength === local.byteLength) {
          await this.native.deleteFile(keep).catch(() => {})
        }
      }
      throw error
    }
    if (expected && !replacing) {
      if ((await this.fingerprint(expected))?.sha256 !== input.expected_sha256) throw new Error('This file changed on this device.')
      throwIfCloudSyncCancelled(handle.signal)
      await this.native.deleteFile(expected)
    }
  }

  private async publish(path: string, handle: StagedHandle, reference: CloudSyncContentReference, expectedHash: string | null, previous?: CloudSyncTrackedItem): Promise<void> {
    throwIfCloudSyncCancelled(handle.signal)
    if (!await this.matches(handle.path, reference)) throw new Error('The staged Cloud file changed before publication.')
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
    if (parent) await this.native.mkdir(parent)
    const current = await this.fingerprint(path)
    if ((current?.sha256 ?? null) !== expectedHash && !(current && previous && await this.vouched(path, previous))) {
      throw new Error('This file changed on this device.')
    }
    // The backup lives directly under .zennotes/sync so the repository's
    // fail-closed recovery check (which lists that directory) sees it if the
    // process dies mid-publish. A stranded original must never read as a
    // local deletion on the next scan.
    const backup = `${ROLLBACK_DIRECTORY}/rollback-${crypto.randomUUID()}`
    let publishing = false
    try {
      throwIfCloudSyncCancelled(handle.signal)
      if (current) await this.native.rename(path, backup)
      throwIfCloudSyncCancelled(handle.signal)
      publishing = true
      await this.native.rename(handle.path, path)
      const published = await this.native.readForSync(path, false)
      if (published.sha256 !== reference.sha256 || published.byteLength !== reference.byte_length) {
        throw new Error('Published Cloud file failed byte verification.')
      }
      throwIfCloudSyncCancelled(handle.signal)
    } catch (error) {
      if (await this.native.statVerified(backup) === 'file') {
        try {
          if (await this.native.statVerified(path) !== null) await this.native.deleteFile(path)
          await this.native.rename(backup, path)
        } catch (restoreError) {
          throw new Error(`Cloud publish rollback failed; the original is preserved at ${backup}.`, { cause: restoreError })
        }
      } else if (!current && publishing && await this.native.statVerified(path) !== null) {
        await this.native.deleteFile(path)
      }
      throw error
    }
    if (current) await this.native.deleteFile(backup).catch(() => {})
  }

  private async vouched(path: string, previous: CloudSyncTrackedItem | undefined): Promise<boolean> {
    if (!previous) return false
    const local = await this.fingerprint(path)
    return local !== null && local.sha256 === previous.sha256 && local.byteLength === previous.byte_length
  }

  private async conflict(path: string): Promise<CloudSyncRepositoryConflict> {
    const local = await this.localItem(path)
    return { code: 'LOCAL_EDIT_CONFLICT', path, conflict_copy_path: null, local }
  }

  private async localItem(path: string): Promise<CloudSyncLocalItem | null> {
    if (await this.native.statVerified(path) !== 'file') return null
    return this.readLocal(path)
  }

  private async fingerprint(path: string): Promise<CloudFileFingerprint | null> {
    if (await this.native.statVerified(path) !== 'file') return null
    return this.native.readForSync(path, this.textCandidate(path))
  }

  private handle(file: CloudSyncStagedFile): StagedHandle {
    const handle = cloudSyncStagedHandle<StagedHandle>(file)
    if (handle.owner !== this) throw new Error('Cloud staging belongs to another repository.')
    throwIfCloudSyncCancelled(handle.signal)
    return handle
  }
}

function isExpiredUrlError(error: unknown): boolean {
  // Capacitor plugin rejections carry the HTTP status under `data`.
  const candidate = error as { status?: unknown; data?: { status?: unknown } }
  const status = candidate?.status ?? candidate?.data?.status
  return status === 401 || status === 403
}
