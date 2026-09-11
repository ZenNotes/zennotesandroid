import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import type { CloudSyncContent, CloudSyncMutation } from '@zennotes/bridge-contract/cloud-sync'
import type {
  CloudSyncLocalItem, CloudSyncState, CloudSyncStoredConflict
} from '@zennotes/shared-domain/cloud-sync-engine'
import type { CloudSyncRepository } from '@zennotes/shared-domain/cloud-sync-coordinator'

import { loadMobileModule } from '../../tooling/load-mobile-module.ts'

const { CachedCloudSyncRepository } = await loadMobileModule('./src/bridge/cloud-sync-repository')
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
  const failures = { cacheRead: false, cacheWrite: false, stateRead: false, directory: false, file: false }
  let onRead: ((path: string) => void) | undefined
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
    return file.bytes.toString('base64')
  }
  const fs = {
    readdir,
    stat: async (path: string) => (await stat(path))?.type ?? null,
    readBase64,
    writeText: async (path: string, data: string) => put(path, data),
    writeBase64: async (path: string, data: string) => put(path, Buffer.from(data, 'base64')),
    deleteFile: async (path: string) => { files.delete(path) },
    rename: async (from: string, to: string) => {
      const file = files.get(from)
      if (!file) throw new Error('File missing')
      files.set(to, file)
      files.delete(from)
    }
  }
  const native = { readdirStrict: readdir, readBase64, statOrNull: stat, stat }
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
  const coordinator = () => {
    const mutations: CloudSyncMutation[] = []
    const remote = {
      manifest: async () => ({ data: [], cursor: state?.cursor ?? 0, next_page: null }),
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
      service: new CloudSyncCoordinator('vault-1', remote, repository, {
        load: async () => state,
        save: async (next: CloudSyncState) => { state = structuredClone(next) }
      }, { itemId: () => `new-${++id}`, operationId: () => `op-${++id}` })
    }
  }
  return {
    files, reads, failures, repository, acknowledge, coordinator, put,
    setReadHook: (hook: typeof onRead) => { onRead = hook },
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
