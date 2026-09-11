import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import type {
  CloudSyncChange, CloudSyncContent, CloudSyncManifestItem, CloudSyncMutation
} from '@zennotes/bridge-contract/cloud-sync'
import type { CloudSyncState } from '@zennotes/shared-domain/cloud-sync-engine'
import { loadMobileModule } from '../../tooling/load-mobile-module.ts'

function textContent(text: string): CloudSyncContent {
  return {
    encoding: 'utf8', data: text, byte_length: Buffer.byteLength(text),
    sha256: createHash('sha256').update(text).digest('hex'), media_type: 'text/markdown'
  }
}

/** Real mobile adapter -> host service -> coordinator -> cached repository.
 * Only Capacitor storage/auth/layout and the server boundary are fakes. */
async function fixture(initial: Record<string, string> = { 'note.md': 'Original' }) {
  const persisted = new Map<string, string>()
  const files = new Map(Object.entries(initial).map(([path, data]) => [
    path, { bytes: Buffer.from(data), mtime: 1000 }
  ]))
  const remoteItems = new Map<string, CloudSyncManifestItem>()
  const revisions = new Map<string, CloudSyncManifestItem>()
  const feed: CloudSyncChange[] = []
  const reads: string[] = []
  const refreshes: Record<string, string>[] = []
  const uploaded: CloudSyncMutation[] = []
  let cursor = 0
  let clock = 1000
  let failWritePath: string | null = null
  let beforeChanges: (() => void) | undefined

  const put = (path: string, bytes: string | Buffer) => {
    files.set(path, { bytes: Buffer.from(bytes), mtime: ++clock })
  }
  function remoteText(path: string, text: string) {
    const previous = [...remoteItems.values()].find((item) => item.path === path)
    const itemId = previous?.item_id ?? 'remote-' + path
    const content = textContent(text)
    const revision = (previous?.revision ?? 0) + 1
    const item: CloudSyncManifestItem = {
      item_id: itemId, path, kind: 'text', revision, content,
      sha256: content.sha256, byte_length: content.byte_length, media_type: content.media_type
    }
    remoteItems.set(itemId, item)
    revisions.set(itemId + ':' + revision, structuredClone(item))
    feed.push({
      sequence: ++cursor, item_id: itemId, type: 'upsert', path,
      previous_path: previous?.path ?? null, revision, content
    })
    return item
  }
  const remote = {
    listVaults: async () => ({ data: [{ id: 'vault-1', name: 'Test vault' }] }),
    manifest: async () => ({ data: [...remoteItems.values()], cursor, next_page: null }),
    changes: async (_vaultId: string, after: number) => {
      beforeChanges?.()
      return { data: feed.filter((change) => change.sequence > after), cursor, has_more: false }
    },
    revision: async (_vaultId: string, itemId: string, revision: number) => {
      const item = revisions.get(itemId + ':' + revision)
      assert.ok(item)
      return { data: { ...item, deleted: false } }
    },
    mutate: async (_vaultId: string, request: { mutations: CloudSyncMutation[] }) => {
      uploaded.push(...JSON.parse(JSON.stringify(request.mutations)))
      const acknowledged = request.mutations.map((mutation) => {
        const previous = remoteItems.get(mutation.item_id)
        const revision = (previous?.revision ?? 0) + 1
        if (mutation.type === 'upsert') {
          const item: CloudSyncManifestItem = {
            item_id: mutation.item_id, path: mutation.path, kind: mutation.kind,
            revision, content: structuredClone(mutation.content),
            sha256: mutation.content.sha256, byte_length: mutation.content.byte_length,
            media_type: mutation.content.media_type
          }
          remoteItems.set(item.item_id, item)
          revisions.set(item.item_id + ':' + revision, structuredClone(item))
          feed.push({
            sequence: ++cursor, item_id: item.item_id, type: 'upsert', path: item.path,
            previous_path: previous?.path ?? null, revision, content: item.content
          })
        } else {
          assert.ok(previous)
          if (mutation.type === 'delete') remoteItems.delete(mutation.item_id)
          else remoteItems.set(mutation.item_id, { ...previous, path: mutation.path, revision })
          feed.push({
            sequence: ++cursor, item_id: mutation.item_id, type: mutation.type,
            path: mutation.type === 'move' ? mutation.path : previous.path,
            previous_path: previous.path, revision
          })
        }
        return { operation_id: mutation.operation_id, item_id: mutation.item_id, revision, sequence: cursor }
      })
      return { acknowledged, conflicts: [], cursor }
    }
  }
  const native = {
    rootPath: 'ZenNotes/Test',
    async readdirStrict(directory: string) {
      const entries = new Map<string, { name: string; type: 'file' | 'directory'; size: number; mtime: number }>()
      const prefix = directory ? directory + '/' : ''
      for (const [path, file] of files) {
        if (!path.startsWith(prefix)) continue
        const [name, nested] = path.slice(prefix.length).split('/')
        entries.set(name, {
          name, type: nested ? 'directory' : 'file',
          size: nested ? 0 : file.bytes.length, mtime: nested ? 1000 : file.mtime
        })
      }
      return [...entries.values()]
    },
    async statOrNull(path: string) {
      const file = files.get(path)
      return file ? { type: 'file' as const, mtime: file.mtime, size: file.bytes.length } : null
    },
    async statVerified(path: string) { return files.has(path) ? 'file' : null },
    async readBase64(path: string) {
      reads.push(path)
      const file = files.get(path)
      assert.ok(file)
      return file.bytes.toString('base64')
    },
    async writeText(path: string, data: string) {
      put(path, data)
      if (path === failWritePath) throw new Error('Native write failed after writing')
    },
    async writeBase64(path: string, data: string) {
      put(path, Buffer.from(data, 'base64'))
      if (path === failWritePath) throw new Error('Native write failed after writing')
    },
    async deleteFile(path: string) { files.delete(path) },
    async mkdir(_path: string) {},
    async rename(from: string, to: string) {
      const file = files.get(from)
      assert.ok(file)
      files.set(to, file)
      files.delete(from)
    }
  }
  const vault = {
    rootLabel: 'ZenNotes/Test', fs: native,
    async rescan() {
      refreshes.push(Object.fromEntries([...files].map(([path, file]) => [path, file.bytes.toString()])))
    }
  }
  const api = await loadMobileModule('./src/bridge/mobile-cloud-sync', {
    '@capacitor/filesystem': {
      Directory: { Data: 'DATA', Cache: 'CACHE' }, Encoding: { UTF8: 'utf8' },
      Filesystem: {
        async readFile({ path }: { path: string }) {
          if (!persisted.has(path)) throw Object.assign(new Error('Missing'), { code: 'OS-PLUG-FILE-0008' })
          return { data: persisted.get(path)! }
        },
        async writeFile({ path, data }: { path: string; data: string }) { persisted.set(path, data) },
        async deleteFile({ path }: { path: string }) { persisted.delete(path) }
      }
    },
    '@capacitor/share': { Share: {} },
    './vault-fs': { MobileVault: class {} },
    './cloud-layout': { reconcileLayoutForCloudJoin: async () => {} },
    './mobile-cloud-auth': {
      authenticatedCredential: async () => ({ base_url: 'https://sync.example.test', token: 'test-only' }),
      authenticatedClient: async () => remote,
      getMobileCloudAccountStatus: async () => ({
        state: 'connected', account: { base_url: 'https://sync.example.test' }
      })
    }
  })
  await api.linkMobileCloudVault(vault, 'vault-1')
  const stateKey = () => [...persisted.keys()].find((path) => path.includes('/states/'))
  return {
    api, vault, files, reads, uploaded, refreshes, remoteText, put,
    sync: () => api.syncMobileCloudVault(vault),
    setFailWrite: (path: string | null) => { failWritePath = path },
    setBeforeChanges: (callback: typeof beforeChanges) => { beforeChanges = callback },
    clearState: () => { const key = stateKey(); if (key) persisted.delete(key) },
    get state(): CloudSyncState {
      const key = stateKey()
      assert.ok(key)
      return JSON.parse(persisted.get(key)!)
    },
    set state(value: CloudSyncState) {
      const key = stateKey()
      assert.ok(key)
      persisted.set(key, JSON.stringify(value))
    }
  }
}

describe('mobile Cloud adapter wiring', () => {
  it('does not rescan the vault or reread acknowledged bytes during a no-op sync', async () => {
    const h = await fixture()
    await h.sync()
    h.refreshes.length = 0
    h.reads.length = 0
    const summary = await h.sync()
    assert.equal(summary.pushed, 0)
    assert.equal(summary.pulled, 0)
    assert.deepEqual(h.refreshes, [])
    assert.deepEqual(h.reads, [])
  })

  it('resynchronizes UI state once after a whole batch of pulled files', async () => {
    const h = await fixture()
    await h.sync()
    h.refreshes.length = 0
    h.remoteText('note.md', 'Remote update')
    h.remoteText('second.md', 'Second note')
    h.remoteText('folder/third.md', 'Third note')
    const summary = await h.sync()
    assert.equal(summary.pulled, 3)
    assert.equal(h.refreshes.length, 1)
    assert.deepEqual(h.refreshes[0], {
      'note.md': 'Remote update', 'second.md': 'Second note', 'folder/third.md': 'Third note'
    })
    h.refreshes.length = 0
    await h.sync()
    assert.deepEqual(h.refreshes, [])
  })

  it('refreshes a newly discovered local edit even when nothing is downloaded', async () => {
    const h = await fixture()
    await h.sync()
    h.refreshes.length = 0
    h.put('note.md', 'Local changes')
    const summary = await h.sync()
    assert.equal(summary.pulled, 0)
    assert.equal(summary.pushed, 1)
    assert.deepEqual(h.refreshes, [{ 'note.md': 'Local changes' }])
    const uploaded = h.uploaded.at(-1)
    assert.equal(uploaded?.type, 'upsert')
    if (uploaded?.type === 'upsert') assert.equal(uploaded.content.data, 'Local changes')
  })

  it('exposes partial native writes when a pull fails, and can retry safely', async () => {
    const h = await fixture()
    await h.sync()
    h.refreshes.length = 0
    h.remoteText('note.md', 'Remote update')
    h.remoteText('second.md', 'Partially written')
    h.setFailWrite('second.md')
    await assert.rejects(h.sync(), /Native write failed/)
    assert.deepEqual(h.refreshes, [{ 'note.md': 'Remote update', 'second.md': 'Partially written' }])
    h.setFailWrite(null)
    await h.sync()
    assert.equal(h.files.get('note.md')?.bytes.toString(), 'Remote update')
    assert.equal(h.files.get('second.md')?.bytes.toString(), 'Partially written')
  })

  it('keeps a conflicting local edit visible when a remote version arrives', async () => {
    const h = await fixture()
    await h.sync()
    h.refreshes.length = 0
    h.remoteText('note.md', 'Cloud replacement')
    h.setBeforeChanges(() => {
      h.setBeforeChanges(undefined)
      h.put('note.md', 'Local replacement')
    })
    const summary = await h.sync()
    assert.equal(summary.pending_conflicts.length, 1)
    assert.equal(h.files.get('note.md')?.bytes.toString(), 'Local replacement')
    assert.equal(h.refreshes.at(-1)?.['note.md'], 'Local replacement')
    const details = await h.api.getMobileCloudConflict(h.vault, summary.pending_conflicts[0].id)
    assert.equal(details.local.text, 'Local replacement')
    assert.equal(details.cloud.text, 'Cloud replacement')
  })

  it('loads full pending-conflict review bytes despite an acknowledged warm scan cache', async () => {
    const h = await fixture()
    await h.sync()
    const state = h.state
    const [item] = Object.values(state.items)
    state.pending_conflicts = {
      [item.item_id]: {
        id: item.item_id, item_id: item.item_id, kind: 'content', sequence: 2,
        base: { path: item.path, revision: 1, kind: 'text', content: textContent('Base') },
        local: { path: item.path, revision: null, kind: 'text', content: textContent('Original') },
        cloud: { path: item.path, revision: 2, kind: 'text', content: textContent('Cloud replacement') }
      }
    }
    h.state = state
    h.reads.length = 0
    const details = await h.api.getMobileCloudConflict(h.vault, item.item_id)
    assert.equal(details.local.text, 'Original')
    assert.equal(details.cloud.text, 'Cloud replacement')
    assert.deepEqual(h.reads, ['note.md'])
  })

  it('loads full bootstrap review bytes when old scan cache survives a lost sync state', async () => {
    const h = await fixture()
    await h.sync()
    const cloud = h.remoteText('note.md', 'Cloud replacement')
    h.clearState()
    h.reads.length = 0
    const details = await h.api.getMobileCloudBootstrapConflict(h.vault, {
      code: 'BOOTSTRAP_CONTENT_CONFLICT', item_id: cloud.item_id, path: cloud.path,
      local_sha256: textContent('Original').sha256, remote_sha256: cloud.sha256
    })
    assert.equal(details.local.text, 'Original')
    assert.equal(details.cloud.text, 'Cloud replacement')
    assert.deepEqual(h.reads, ['note.md'])
  })
})
