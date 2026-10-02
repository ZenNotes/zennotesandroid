import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import type { CloudSyncContent, CloudSyncMutation } from '@zennotes/bridge-contract/cloud-sync'
import type {
  CloudSyncLocalItem, CloudSyncState, CloudSyncStoredConflict
} from '@zennotes/shared-domain/cloud-sync-engine'
import type { CloudSyncRepository } from '@zennotes/shared-domain/cloud-sync-coordinator'

import { loadMobileModule } from '../../tooling/load-mobile-module.ts'

const { CachedCloudSyncRepository, mutateWithMobileDirectUploads } = await loadMobileModule([
  './src/bridge/cloud-sync-repository', './src/bridge/mobile-direct-upload'
])
const { CloudSyncCoordinator } = await loadMobileModule('@zennotes/shared-domain/cloud-sync-coordinator')

type StoredFile = { bytes: Buffer; mtime: number }
function harness(initial: Record<string, string | Buffer> = { 'note.md': 'Hello' }) {
  const files = new Map<string, StoredFile>(
    Object.entries(initial).map(([path, body]) => [path, { bytes: Buffer.from(body), mtime: 1000 }])
  )
  let cache: unknown = null
  let state: CloudSyncState | null = null
  let clock = 1000
  const reads: string[] = []
  const writes: string[] = []
  const copies: string[] = []
  const failures = { cacheRead: false, cacheWrite: false, stateRead: false, directory: false, file: false }
  let onRead: ((path: string) => void) | undefined
  let onWrite: ((path: string) => void) | undefined
  let onRename: ((from: string, to: string) => void) | undefined
  let onCopy: ((from: string, to: string) => void) | undefined
  const put = (path: string, body: string | Buffer) => {
    files.set(path, { bytes: Buffer.from(body), mtime: ++clock })
  }
  const stat = async (path: string) => {
    const file = files.get(path)
    if (file) return { type: 'file' as const, size: file.bytes.length, mtime: file.mtime }
    if ([...files.keys()].some((name) => name.startsWith(path + '/'))) {
      return { type: 'directory' as const, size: 0, mtime: 1000 }
    }
    return null
  }
  const readdir = async (directory: string) => {
    if (failures.directory) throw new Error('Directory unavailable')
    const entries = new Map<string, { name: string; type: 'file' | 'directory'; size: number; mtime: number }>()
    const prefix = directory ? directory + '/' : ''
    for (const [path, file] of files) {
      if (!path.startsWith(prefix)) continue
      const relative = path.slice(prefix.length)
      const [name, nested] = relative.split('/')
      entries.set(name, {
        name, type: nested ? 'directory' : 'file',
        size: nested ? 0 : file.bytes.length, mtime: nested ? 1000 : file.mtime
      })
    }
    return [...entries.values()]
  }
  const readBase64 = async (path: string) => {
    reads.push(path)
    if (failures.file) throw new Error('File unavailable')
    onRead?.(path)
    const file = files.get(path)
    if (!file) throw new Error('File missing')
    if (file.bytes.length > 5 * 1024 * 1024) throw new Error('Whole-file bridge read exceeded the inline limit')
    return file.bytes.toString('base64')
  }
  const fs = {
    readdir,
    stat: async (path: string) => (await stat(path))?.type ?? null,
    readBase64,
    writeText: async (path: string, data: string) => { writes.push(path); put(path, data); onWrite?.(path) },
    writeBase64: async (path: string, data: string) => { writes.push(path); put(path, Buffer.from(data, 'base64')); onWrite?.(path) },
    deleteFile: async (path: string) => { writes.push(path); files.delete(path) },
    rename: async (from: string, to: string) => {
      const file = files.get(from)
      if (!file) throw new Error('File missing')
      writes.push(to)
      files.set(to, file)
      files.delete(from)
      onRename?.(from, to)
    }
  }
  const native = {
    readdirStrict: readdir, readBase64, statOrNull: stat, stat,
    async copyForSync(from: string, to: string) {
      copies.push(from)
      const file = files.get(from)
      if (!file) throw new Error('File missing')
      writes.push(to)
      put(to, file.bytes)
      onCopy?.(from, to)
    },
    async readForSync(path: string, textCandidate: boolean) {
      reads.push(path)
      if (failures.file) throw new Error('File unavailable')
      onRead?.(path)
      const file = files.get(path)
      if (!file) throw new Error('File missing')
      let utf8 = false
      try {
        if (textCandidate) {
          new TextDecoder('utf-8', { fatal: true }).decode(file.bytes)
          utf8 = true
        }
      } catch {}
      return {
        uri: `file:///vault/${path}`,
        sha256: createHash('sha256').update(file.bytes).digest('hex'),
        byteLength: file.bytes.length, utf8,
        ...(file.bytes.length <= 5 * 1024 * 1024 ? { inlineBase64: file.bytes.toString('base64') } : {})
      }
    }
  }
  const store = {
    loadTracked: async () => {
      if (failures.stateRead) throw new Error('State unavailable')
      return state
    },
    loadCache: async () => {
      if (failures.cacheRead) throw new Error('Cache unavailable')
      return cache
    },
    saveCache: async (next: unknown) => {
      if (failures.cacheWrite) throw new Error('Cache unavailable')
      cache = structuredClone(next)
    }
  }
  const repository: CloudSyncRepository = new CachedCloudSyncRepository(fs, native, store)
  function acknowledge(items: CloudSyncLocalItem[]) {
    state = {
      version: 1, vault_id: 'vault-1', cursor: 1,
      items: Object.fromEntries(items.map((item, index) => [`item-${index}`, {
        item_id: `item-${index}`, path: item.path, kind: item.kind, revision: 1,
        sha256: item.content.sha256, byte_length: item.content.byte_length,
        media_type: item.content.media_type
      }]))
    }
  }
  const coordinator = (manifestItems: unknown[] = [], syncRepository = repository) => {
    const mutations: CloudSyncMutation[] = []
    const remote = {
      manifest: async () => ({ data: manifestItems, cursor: state?.cursor ?? 0, next_page: null }),
      changes: async () => ({ data: [], cursor: state?.cursor ?? 0, has_more: false }),
      mutate: async (_vaultId: string, body: { mutations: CloudSyncMutation[] }) => {
        // Serialization is deliberately real: a cache placeholder must never be uploaded.
        mutations.push(...JSON.parse(JSON.stringify(body.mutations)))
        return {
          acknowledged: body.mutations.map((mutation) => ({
            operation_id: mutation.operation_id, item_id: mutation.item_id, revision: 2, sequence: 1
          })),
          conflicts: [], cursor: 1
        }
      }
    }
    let id = 0
    return {
      mutations,
      service: new CloudSyncCoordinator('vault-1', remote, syncRepository, {
        load: async () => state,
        save: async (next: CloudSyncState) => { state = structuredClone(next) }
      }, { itemId: () => `new-${++id}`, operationId: () => `op-${++id}` })
    }
  }
  return {
    files, reads, writes, copies, failures, repository, acknowledge, coordinator, put, fs, native, store,
    setReadHook: (hook: typeof onRead) => { onRead = hook },
    setWriteHook: (hook: typeof onWrite) => { onWrite = hook },
    setRenameHook: (hook: typeof onRename) => { onRename = hook },
    setCopyHook: (hook: typeof onCopy) => { onCopy = hook },
    get cache() { return cache }, set cache(next: unknown) { cache = next },
    get state() { return state }, set state(next: CloudSyncState | null) { state = next }
  }
}

function content(text: string): CloudSyncContent {
  return {
    encoding: 'utf8', data: text, sha256: createHash('sha256').update(text).digest('hex'),
    byte_length: Buffer.byteLength(text), media_type: 'text/markdown'
  }
}

function pending(path: string, local: CloudSyncContent, cloud = content('Other device')): CloudSyncStoredConflict {
  return {
    id: 'conflict-1', item_id: 'item-0', kind: 'content', sequence: 2,
    base: { path, revision: 1, kind: 'text', content: content('Base') },
    local: { path, revision: null, kind: 'text', content: local },
    cloud: { path, revision: 2, kind: 'text', content: cloud }
  }
}

describe('cached mobile Cloud scan', () => {
  it('scans a large attachment without materializing its contents across the bridge', async () => {
    const bytes = Buffer.alloc(8_000_000, 129)
    const h = harness({ 'attachements/large.bin': bytes })
    const [item] = await h.repository.scan()
    assert.equal(item.content.byte_length, bytes.length)
    assert.equal(item.content.sha256, createHash('sha256').update(bytes).digest('hex'))
    assert.equal(item.content.data, '')
    assert.equal(item.kind, 'binary')
    assert.ok(JSON.stringify(item).length < 500)
  })

  it('preserves UTF-8 classification and raw-byte hashes for file-backed text', async () => {
    const bytes = Buffer.from('日本語 café\n'.repeat(400_000))
    const h = harness({ 'large.md': bytes })
    const [item] = await h.repository.scan()
    assert.equal(item.kind, 'text')
    assert.equal(item.content.encoding, 'utf8')
    assert.equal(item.content.sha256, createHash('sha256').update(bytes).digest('hex'))
    assert.equal(item.content.data, '')
  })

  it('passes a scanned file to the uploader by URI and completes only after the native transfer', async () => {
    const bytes = Buffer.alloc(6_000_000, 197)
    const h = harness({ 'attachements/large.bin': bytes })
    const [item] = await h.repository.scan()
    let uploaded = false
    const result = await mutateWithMobileDirectUploads({
      mutate: async () => { throw new Error('Unexpected inline upload') },
      initiateUpload: async (_vault: string, request: any) => ({ data: {
        id: 'upload', operation_id: request.operation_id, expected_bytes: bytes.length,
        upload: { method: 'PUT', url: 'https://storage.example.test/object', headers: {} }
      } }),
      completeUpload: async () => {
        assert.equal(uploaded, true)
        return { data: { result: { acknowledged: [{ item_id: 'item' }], conflicts: [], cursor: 1 } } }
      },
      abortUpload: async () => { throw new Error('Unexpected abort') }
    }, 'vault', { mutations: [{ ...item, type: 'upsert', item_id: 'item', operation_id: 'operation', base_revision: null }] }, async (request: any) => {
      assert.equal(request.uri, 'file:///vault/attachements/large.bin')
      assert.equal(request.base64, undefined)
      assert.equal(request.sha256, createHash('sha256').update(bytes).digest('hex'))
      assert.equal(request.byteLength, bytes.length)
      uploaded = true
    })
    assert.equal(result.acknowledged.length, 1)
  })

  it('reads and hashes new text and binary files with the same portable semantics', async () => {
    const bytes = Buffer.from([0, 255, 1, 128])
    const h = harness({ 'note.md': 'Hello', 'assets/photo.png': bytes, '.zennotes/cache.json': '{}' })
    const items = await h.repository.scan()
    assert.deepEqual(items.map((item) => item.path), ['assets/photo.png', 'note.md'])
    assert.equal(items[0].kind, 'binary')
    assert.equal(items[0].content.data, bytes.toString('base64'))
    assert.equal(items[0].content.sha256, createHash('sha256').update(bytes).digest('hex'))
    assert.deepEqual(items[1].content, content('Hello'))
  })

  it('does not reread unchanged acknowledged files on the next sync', async () => {
    const h = harness({ 'a.md': 'A', 'b.md': 'B', 'assets/p.png': Buffer.from([0, 255]) })
    h.acknowledge(await h.repository.scan())
    h.reads.length = 0
    const result = await h.coordinator().service.sync()
    assert.deepEqual(h.reads, [])
    assert.equal(result.pushed, 0)
    assert.equal(result.pendingConflicts.length, 0)
  })

  it('rereads only the edited file and uploads its complete current bytes', async () => {
    const h = harness({ 'a.md': 'A', 'b.md': 'B' })
    h.acknowledge(await h.repository.scan())
    h.put('a.md', 'Changed')
    h.reads.length = 0
    const c = h.coordinator()
    const result = await c.service.sync()
    assert.deepEqual(h.reads, ['a.md'])
    assert.equal(result.pushed, 1)
    assert.equal(c.mutations[0].type, 'upsert')
    if (c.mutations[0].type === 'upsert') assert.equal(c.mutations[0].content.data, 'Changed')
  })


  it('rereads a same-size edit when its modification time changes', async () => {
    const h = harness()
    h.acknowledge(await h.repository.scan())
    h.put('note.md', 'World')
    h.reads.length = 0
    assert.equal((await h.repository.scan())[0].content.data, 'World')
    assert.deepEqual(h.reads, ['note.md'])
  })

  it('rereads a size change even if a provider preserves the modification time', async () => {
    const h = harness()
    h.acknowledge(await h.repository.scan())
    h.files.set('note.md', { bytes: Buffer.from('Longer content'), mtime: 1000 })
    h.reads.length = 0
    assert.equal((await h.repository.scan())[0].content.data, 'Longer content')
    assert.deepEqual(h.reads, ['note.md'])
  })

  it('rereads files whose scanned content has not yet been acknowledged', async () => {
    const h = harness()
    await h.repository.scan()
    h.reads.length = 0
    assert.equal((await h.repository.scan())[0].content.data, 'Hello')
    assert.deepEqual(h.reads, ['note.md'])
  })

  it('rereads an unacknowledged edit even when its fingerprint is cached', async () => {
    const h = harness()
    h.acknowledge(await h.repository.scan())
    h.put('note.md', 'Local edit')
    await h.repository.scan()
    h.reads.length = 0
    assert.equal((await h.repository.scan())[0].content.data, 'Local edit')
    assert.deepEqual(h.reads, ['note.md'])
  })

  it('keeps rename and deletion semantics intact without uploading cached bytes', async () => {
    const h = harness({ 'a.md': 'A', 'b.md': 'B' })
    h.acknowledge(await h.repository.scan())
    h.files.set('renamed.md', h.files.get('a.md')!)
    h.files.delete('a.md')
    h.files.delete('b.md')
    const c = h.coordinator()
    await c.service.sync()
    assert.deepEqual(c.mutations.map((mutation) => mutation.type).sort(), ['delete', 'move'])
    assert.equal(c.mutations.find((mutation) => mutation.type === 'move')?.path, 'renamed.md')
    assert.deepEqual(Object.keys(h.cache as object), ['renamed.md'])
  })

  for (const failure of ['cacheRead', 'stateRead', 'cacheWrite'] as const) {
    it(`falls back safely when ${failure} fails`, async () => {
      const h = harness()
      h.acknowledge(await h.repository.scan())
      h.reads.length = 0
      h.failures[failure] = true
      const items = await h.repository.scan()
      assert.equal(items[0].content.sha256, content('Hello').sha256)
      if (failure !== 'cacheWrite') assert.deepEqual(h.reads, ['note.md'])
    })
  }

  it('rebuilds a lost or malformed cache from actual file content', async () => {
    const h = harness()
    h.acknowledge(await h.repository.scan())
    for (const damaged of [null, { 'note.md': { mtime: 1000, sha256: 'not-an-entry' } }]) {
      h.cache = damaged
      h.reads.length = 0
      assert.equal((await h.repository.scan())[0].content.data, 'Hello')
      assert.deepEqual(h.reads, ['note.md'])
    }
  })

  for (const mtime of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    it(`does not trust unavailable or invalid modification time ${mtime}`, async () => {
      const h = harness()
      h.files.get('note.md')!.mtime = mtime
      h.acknowledge(await h.repository.scan())
      h.reads.length = 0
      assert.equal((await h.repository.scan())[0].content.data, 'Hello')
      assert.deepEqual(h.reads, ['note.md'])
    })
  }

  it('does not cache a file that changes while its bytes are being read', async () => {
    const h = harness()
    h.setReadHook((path) => { h.put(path, 'World') })
    h.acknowledge(await h.repository.scan())
    h.setReadHook(undefined)
    // Restore the old metadata as can happen with coarse timestamps: the
    // unstable read must not leave a reusable cache entry for that fingerprint.
    h.files.get('note.md')!.mtime = 1000
    h.reads.length = 0
    await h.repository.scan()
    assert.deepEqual(h.reads, ['note.md'])
  })

  for (const failure of ['directory', 'file'] as const) {
    it(`fails closed on a ${failure} read error, without manufacturing a deletion`, async () => {
      const h = harness()
      h.acknowledge(await h.repository.scan())
      const priorCache = structuredClone(h.cache)
      h.put('note.md', 'Unreadable new edit')
      h.failures[failure] = true
      const c = h.coordinator()
      await assert.rejects(c.service.sync(), /unavailable/)
      assert.deepEqual(c.mutations, [])
      assert.deepEqual(h.cache, priorCache)
    })
  }
})

describe('cached scan with the pinned conflict coordinator', () => {
  it('keeps all 6 MB of the local version while replacing the original with Cloud bytes', async () => {
    const bytes = Buffer.alloc(6_000_000, 197)
    const h = harness({ 'asset.bin': bytes })
    const [local] = await h.repository.scan()
    h.acknowledge([local])
    const cloud = content('Cloud replacement')
    h.state!.pending_conflicts = { 'conflict-1': pending('asset.bin', local.content, cloud) }
    const coordinator = h.coordinator([{
      item_id: 'item-0', path: 'asset.bin', kind: 'text', revision: 2,
      sha256: cloud.sha256, byte_length: cloud.byte_length, media_type: cloud.media_type
    }])

    await coordinator.service.resolveConflict({
      conflict_id: 'conflict-1', choice: 'both', keep_both_path: 'copies/local.bin',
      expected_local_sha256: local.content.sha256, expected_cloud_revision: 2
    })

    assert.deepEqual(h.files.get('copies/local.bin')?.bytes, bytes)
    assert.equal(h.files.get('asset.bin')?.bytes.toString(), cloud.data)
    assert.equal(h.state!.pending_conflicts?.['conflict-1'], undefined)
    assert.deepEqual([...h.files.keys()].sort(), ['asset.bin', 'copies/local.bin'])
    assert.ok(h.copies.length > 0)
  })

  it('rejects a changed file-backed source before writing any resolution files', async () => {
    const h = harness({ 'source.bin': Buffer.alloc(6_000_000, 197), 'note.md': 'Keep me' })
    const source = (await h.repository.scan()).find((item) => item.path === 'source.bin')!
    h.put('source.bin', Buffer.alloc(6_000_000, 198))
    await assert.rejects(h.repository.applyConflictResolutionFiles!({
      expected_path: 'note.md', expected_sha256: content('Keep me').sha256,
      files: [{ path: 'first.md', content: content('First') }, { path: 'copy.bin', content: source.content }]
    }), /changed|source/i)
    assert.deepEqual(h.writes, [])
    assert.equal(h.files.get('note.md')?.bytes.toString(), 'Keep me')
  })

  it('preserves raw UTF-8 bytes when a large local text version is copied', async () => {
    const bytes = Buffer.from('日本語é\n'.repeat(500_000))
    assert.equal(bytes.length, 6_000_000)
    const h = harness({ 'large.md': bytes })
    const [local] = await h.repository.scan()
    assert.equal(local.content.encoding, 'utf8')
    await h.repository.applyConflictResolutionFiles!({
      expected_path: 'large.md', expected_sha256: local.content.sha256,
      files: [{ path: 'large.md', content: content('Cloud') }, { path: 'local.md', content: local.content }]
    })
    assert.deepEqual(h.files.get('local.md')?.bytes, bytes)
    assert.equal(h.files.get('large.md')?.bytes.toString(), 'Cloud')
  })

  it('does not upload a deletion when an interrupted replacement left a rollback file', async () => {
    const bytes = Buffer.alloc(6_000_000, 197)
    const h = harness({ 'asset.bin': bytes })
    h.acknowledge(await h.repository.scan())
    const rollback = '.zennotes/sync/rollback-interrupted.bin'
    h.files.delete('asset.bin')
    h.put(rollback, bytes)
    const restarted = new CachedCloudSyncRepository(h.fs, h.native, h.store)
    const coordinator = h.coordinator([], restarted)
    await assert.rejects(coordinator.service.sync(), /needs recovery/)
    assert.deepEqual(coordinator.mutations, [])
    assert.deepEqual(h.files.get(rollback)?.bytes, bytes)
  })

  it('rechecks recovery files on the next scan of an already-running repository', async () => {
    const h = harness({ 'note.md': 'original' })
    h.acknowledge(await h.repository.scan())
    h.files.delete('note.md')
    h.put('.zennotes/sync/rollback-failed.md', 'original')
    const coordinator = h.coordinator()
    await assert.rejects(coordinator.service.sync(), /needs recovery/)
    assert.deepEqual(coordinator.mutations, [])
  })

  it('rejects unknown metadata-only content before a bootstrap rename or a multi-file write', async () => {
    const h = harness({ 'note.md': 'Keep me' })
    const missing = { ...content('Missing bytes'), data: '' }
    await assert.rejects(h.repository.resolveBootstrapConflict!({
      path: 'note.md', expectedLocalSha256: content('Keep me').sha256, cloudContent: missing,
      resolution: { choice: 'both', keep_both_path: 'copy.md', conflict: {
        code: 'BOOTSTRAP_CONTENT_CONFLICT', item_id: 'item', path: 'note.md',
        local_sha256: content('Keep me').sha256, remote_sha256: missing.sha256
      } }
    }), /source|bytes|content/i)
    await assert.rejects(h.repository.applyConflictResolutionFiles!({
      expected_path: 'note.md', expected_sha256: content('Keep me').sha256,
      files: [{ path: 'first.md', content: content('First') }, { path: 'note.md', content: missing }]
    }), /source|bytes|content/i)
    assert.deepEqual(h.writes, [])
    assert.deepEqual([...h.files.keys()], ['note.md'])
  })

  it('rolls back a failed Cloud replacement after creating the large local copy', async () => {
    const bytes = Buffer.alloc(6_000_000, 197)
    const h = harness({ 'asset.bin': bytes })
    const [local] = await h.repository.scan()
    let failed = false
    h.setRenameHook((_from, to) => {
      if (to === 'asset.bin' && !failed) {
        failed = true
        h.put(to, 'Partial write')
        throw new Error('Native replacement failed after modifying the target')
      }
    })
    await assert.rejects(h.repository.applyConflictResolutionFiles!({
      expected_path: 'asset.bin', expected_sha256: local.content.sha256,
      files: [{ path: 'asset.bin', content: content('Cloud') }, { path: 'copy.bin', content: local.content }]
    }), /failed/)
    assert.equal(failed, true)
    assert.deepEqual(h.files.get('asset.bin')?.bytes, bytes)
    assert.deepEqual([...h.files.keys()], ['asset.bin'])
  })

  it('rejects a corrupt native copy before replacing the original', async () => {
    const bytes = Buffer.alloc(6_000_000, 197)
    const h = harness({ 'asset.bin': bytes })
    const [local] = await h.repository.scan()
    h.setCopyHook((_from, to) => h.put(to, 'Truncated copy'))
    await assert.rejects(h.repository.applyConflictResolutionFiles!({
      expected_path: 'asset.bin', expected_sha256: local.content.sha256,
      files: [{ path: 'copy.bin', content: local.content }, { path: 'asset.bin', content: content('Cloud') }]
    }), /bytes|hash|changed|verification/i)
    assert.deepEqual(h.files.get('asset.bin')?.bytes, bytes)
    assert.deepEqual([...h.files.keys()], ['asset.bin'])
  })

  it('retains a source edited during copying and does not publish the stale copy', async () => {
    const h = harness({ 'source.bin': Buffer.alloc(6_000_000, 197), 'note.md': 'Keep me' })
    const source = (await h.repository.scan()).find((item) => item.path === 'source.bin')!
    const changed = Buffer.alloc(6_000_000, 198)
    h.setCopyHook((from) => h.put(from, changed))
    await assert.rejects(h.repository.applyConflictResolutionFiles!({
      expected_path: 'note.md', expected_sha256: content('Keep me').sha256,
      files: [{ path: 'copy.bin', content: source.content }, { path: 'note.md', content: content('Cloud') }]
    }), /changed/)
    assert.deepEqual(h.files.get('source.bin')?.bytes, changed)
    assert.equal(h.files.get('note.md')?.bytes.toString(), 'Keep me')
    assert.deepEqual([...h.files.keys()].sort(), ['note.md', 'source.bin'])
  })

  it('preserves the large original when staging a replacement fails after a partial write', async () => {
    const bytes = Buffer.alloc(6_000_000, 197)
    const h = harness({ 'asset.bin': bytes })
    const [local] = await h.repository.scan()
    h.setWriteHook((path) => {
      h.put(path, 'Partial')
      throw new Error('Staging failed')
    })
    await assert.rejects(h.repository.replaceConflictFile!({
      path: local.path, expectedSha256: local.content.sha256, content: content('Cloud')
    }), /Staging failed/)
    assert.deepEqual(h.files.get('asset.bin')?.bytes, bytes)
    assert.deepEqual([...h.files.keys()], ['asset.bin'])
  })

  it('keeps a large bootstrap local copy without reading its body across the bridge', async () => {
    const bytes = Buffer.alloc(6_000_000, 197)
    const h = harness({ 'asset.bin': bytes })
    const [local] = await h.repository.scan()
    const cloud = content('Cloud')
    await h.repository.resolveBootstrapConflict!({
      path: local.path, expectedLocalSha256: local.content.sha256, cloudContent: cloud,
      resolution: { choice: 'both', keep_both_path: 'local.bin', conflict: {
        code: 'BOOTSTRAP_CONTENT_CONFLICT', item_id: 'item', path: local.path,
        local_sha256: local.content.sha256, remote_sha256: cloud.sha256
      } }
    })
    assert.deepEqual(h.files.get('local.bin')?.bytes, bytes)
    assert.equal(h.files.get('asset.bin')?.bytes.toString(), 'Cloud')
  })

  it('rolls back the bootstrap rename when the Cloud write fails', async () => {
    const bytes = Buffer.alloc(6_000_000, 197)
    const h = harness({ 'asset.bin': bytes })
    const [local] = await h.repository.scan()
    const cloud = content('Cloud')
    h.setWriteHook(() => { throw new Error('Write failed') })
    await assert.rejects(h.repository.resolveBootstrapConflict!({
      path: local.path, expectedLocalSha256: local.content.sha256, cloudContent: cloud,
      resolution: { choice: 'both', keep_both_path: 'local.bin', conflict: {
        code: 'BOOTSTRAP_CONTENT_CONFLICT', item_id: 'item', path: local.path,
        local_sha256: local.content.sha256, remote_sha256: cloud.sha256
      } }
    }), /Write failed/)
    assert.deepEqual(h.files.get('asset.bin')?.bytes, bytes)
    assert.deepEqual([...h.files.keys()], ['asset.bin'])
  })

  it('rejects unknown metadata on inherited apply and replace before changing files', async () => {
    const h = harness({ 'note.md': 'Keep me' })
    const missing = { ...content('Unavailable'), data: '' }
    await assert.rejects(h.repository.apply({ sequence: 2, revision: 2, item_id: 'item',
      path: 'note.md', previous_path: null, type: 'upsert', content: missing }, undefined), /source/)
    await assert.rejects(h.repository.replaceConflictFile!({
      path: 'note.md', expectedSha256: content('Keep me').sha256, content: missing
    }), /source/)
    assert.deepEqual(h.writes, [])
    assert.equal(h.files.get('note.md')?.bytes.toString(), 'Keep me')
  })

  it('uses streaming reads for inherited apply and preserves an unsynced large edit', async () => {
    const bytes = Buffer.alloc(6_000_000, 197)
    const h = harness({ 'asset.bin': bytes })
    const [local] = await h.repository.scan()
    const change = { sequence: 2, item_id: 'item', revision: 2, type: 'upsert' as const,
      path: 'asset.bin', previous_path: null, content: content('Cloud') }
    const conflict = await h.repository.apply(change, undefined)
    assert.equal(conflict?.code, 'LOCAL_EDIT_CONFLICT')
    assert.deepEqual(h.files.get('asset.bin')?.bytes, bytes)
    await h.repository.apply(change, { item_id: 'item', path: local.path, kind: local.kind, revision: 1,
      sha256: local.content.sha256, byte_length: bytes.length, media_type: local.content.media_type })
    assert.equal(h.files.get('asset.bin')?.bytes.toString(), 'Cloud')
  })

  it('returns real bytes for review when pending local content matches acknowledged content', async () => {
    const h = harness()
    h.acknowledge(await h.repository.scan())
    h.state!.pending_conflicts = { 'conflict-1': pending('note.md', content('Hello')) }
    h.reads.length = 0
    const details = await h.coordinator().service.getConflict('conflict-1')
    assert.equal(details.local.text, 'Hello')
    assert.deepEqual(h.reads, ['note.md'])
  })

  it('can locate and read a moved pending-conflict file even when its new path is acknowledged', async () => {
    const h = harness({ 'renamed.md': 'Hello' })
    h.acknowledge(await h.repository.scan())
    h.state!.pending_conflicts = { 'conflict-1': pending('old.md', content('Hello')) }
    h.reads.length = 0
    const details = await h.coordinator().service.getConflict('conflict-1')
    assert.equal(details.local.path, 'renamed.md')
    assert.equal(details.local.text, 'Hello')
    assert.deepEqual(h.reads, ['renamed.md'])
  })
})
