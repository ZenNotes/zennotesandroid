import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import { loadMobileModule } from '../../tooling/load-mobile-module.ts'

// One bundle: the staging token registry is a module-private WeakMap, so the
// helper that reads a handle must share the module instance that wrote it.
const { NativeCloudStaging, cloudSyncStagedHandle } = await loadMobileModule([
  './src/bridge/cloud-sync-staging', '@zennotes/shared-domain/cloud-sync-content'
])

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

/** In-memory vault with a fake native downloader; bytes never pass through JS strings. */
function harness(initial: Record<string, Buffer> = {}) {
  const files = new Map(Object.entries(initial))
  const objects = new Map<string, Buffer>()
  const log: string[] = []
  const native = {
    async statVerified(path: string) { return files.has(path) ? 'file' as const : null },
    async readForSync(path: string) {
      const bytes = files.get(path)
      if (!bytes) throw new Error(`missing ${path}`)
      let utf8 = true
      try { new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { utf8 = false }
      return { uri: `file:///${path}`, sha256: hash(bytes), byteLength: bytes.length, utf8 }
    },
    async download(options: { url: string; to: string; byteLength: number; sha256: string }) {
      log.push(`download ${options.url}`)
      const bytes = objects.get(options.url)
      if (!bytes) throw Object.assign(new Error('not found'), { status: 404 })
      if (bytes.length !== options.byteLength || hash(bytes) !== options.sha256) throw new Error('verification failed')
      files.set(options.to, bytes)
    },
    async copyForSync(from: string, to: string) {
      log.push(`copy ${from} -> ${to}`)
      files.set(to, Buffer.from(files.get(from)!))
    },
    async rename(from: string, to: string) {
      log.push(`rename ${from} -> ${to}`)
      const bytes = files.get(from)
      if (!bytes) throw new Error(`rename missing ${from}`)
      files.set(to, bytes)
      files.delete(from)
    },
    async deleteFile(path: string) { files.delete(path) },
    async mkdir() {},
    async readText(path: string) { return files.get(path)!.toString('utf8') }
  }
  const staging = new NativeCloudStaging(native, (path: string) => path.endsWith('.md'), async (path: string) => {
    const bytes = files.get(path)!
    return { path, kind: 'text', content: { encoding: 'utf8', data: bytes.toString('utf8'),
      sha256: hash(bytes), byte_length: bytes.length, media_type: 'text/markdown' } }
  })
  const reference = (itemId: string, revision: number, bytes: Buffer, encoding = 'base64') => ({
    item_id: itemId, revision, encoding, sha256: hash(bytes), byte_length: bytes.length, media_type: 'application/octet-stream'
  })
  const source = (ref: any, url: string) => ({
    reference: ref, previewLimitBytes: 262_144, allowInsecureLoopback: false,
    getInstruction: async () => ({ item_id: ref.item_id, revision: ref.revision,
      content: { encoding: ref.encoding, sha256: ref.sha256, byte_length: ref.byte_length, media_type: ref.media_type },
      download: { url, method: 'GET', headers: {}, expires_at: new Date(Date.now() + 300_000).toISOString() } })
  })
  return { files, objects, log, staging, reference, source, native }
}

describe('native Cloud staging', () => {
  for (const failure of ['copy', 'publish', 'restore', 'cancel'] as const) {
    it(`preserves the original and cleans partial writes after ${failure} failure`, async () => {
      const local = Buffer.from('local')
      const h = harness({ 'note.md': local })
      const cloud = Buffer.from('cloud')
      const ref = h.reference('item', 2, cloud, 'utf8')
      const url = 'https://objects.example.test/item/2'
      h.objects.set(url, cloud)
      const controller = new AbortController()
      const file = await h.staging.stage({ ...h.source(ref, url), signal: controller.signal })
      const rename = h.native.rename
      if (failure === 'copy') h.native.copyForSync = async (_from, to) => {
        h.files.set(to, Buffer.from('partial'))
        throw new Error('copy failed')
      }
      if (failure === 'publish' || failure === 'restore') h.native.rename = async (from, to) => {
        if (failure === 'restore' && from.startsWith('.zennotes/sync/rollback-')) throw new Error('restore failed')
        await rename(from, to)
        if (from.startsWith('.zennotes/sync/downloads/')) {
          h.files.set(to, Buffer.from('corrupt'))
          if (failure === 'restore') throw new Error('publish failed')
        }
      }
      if (failure === 'cancel') controller.abort()
      await assert.rejects(h.staging.resolve({
        expected_path: 'note.md', expected_sha256: hash(local), cloud_path: 'note.md', file,
        ...(failure === 'copy' ? { keep_both_path: 'local.md' } : {})
      }))
      assert.equal(h.files.has('local.md'), false)
      if (failure === 'restore') {
        const recovery = [...h.files.keys()].find((path) => /^\.zennotes\/sync\/rollback-[^/]+$/.test(path))
        assert.ok(recovery, 'stranded original must be visible to the scan recovery guard')
        assert.deepEqual(h.files.get(recovery), local)
      } else {
        assert.deepEqual(h.files.get('note.md'), local)
      }
    })
  }

  it('removes a newly created destination when native rename partially publishes then rejects', async () => {
    const h = harness()
    const bytes = Buffer.from('cloud')
    const ref = h.reference('item', 1, bytes)
    const url = 'https://objects.example.test/item/1'
    h.objects.set(url, bytes)
    const file = await h.staging.stage(h.source(ref, url))
    h.native.rename = async (_from, to) => {
      h.files.set(to, Buffer.from('partial'))
      throw new Error('rename failed')
    }
    await assert.rejects(h.staging.apply({ sequence: 1, item_id: 'item', type: 'upsert',
      path: 'new.bin', previous_path: null, revision: 1, content_ref: ref }, undefined, file))
    assert.equal(h.files.has('new.bin'), false)
  })

  for (const failure of ['publish', 'edited-copy', 'rollback'] as const) {
    it(`keeps a failed keep-both resolution safe and retryable after ${failure}`, async () => {
      const local = Buffer.from('local')
      const cloud = Buffer.from('cloud')
      const h = harness({ 'note.md': local })
      const ref = h.reference('item', 2, cloud, 'utf8')
      const url = 'https://objects.example.test/item/2'
      h.objects.set(url, cloud)
      const file = await h.staging.stage(h.source(ref, url))
      const rename = h.native.rename
      h.native.rename = async (from, to) => {
        if (from.startsWith('.zennotes/sync/downloads/') && to === 'note.md') {
          if (failure === 'edited-copy') h.files.set('local.md', Buffer.from('later user edit'))
          throw new Error('disk full')
        }
        if (failure === 'rollback' && from.startsWith('.zennotes/sync/rollback-')) throw new Error('rollback failed')
        await rename(from, to)
      }
      const input = { expected_path: 'note.md', expected_sha256: hash(local), cloud_path: 'note.md', file, keep_both_path: 'local.md' }
      await assert.rejects(h.staging.resolve(input))
      if (failure === 'publish') {
        assert.deepEqual(h.files.get('note.md'), local)
        assert.equal(h.files.has('local.md'), false, 'the unfinished decision must not block its own retry')
        h.native.rename = rename
        await h.staging.resolve(input)
        assert.deepEqual(h.files.get('note.md'), cloud)
        assert.deepEqual(h.files.get('local.md'), local)
      } else {
        assert.deepEqual(h.files.get('local.md'), failure === 'edited-copy' ? Buffer.from('later user edit') : local)
      }
    })
  }

  it('refreshes an expired signed URL reported as a native Capacitor rejection', async () => {
    const h = harness()
    const bytes = Buffer.from('cloud')
    const ref = h.reference('item', 1, bytes)
    const url = 'https://objects.example.test/item/1'
    h.objects.set(url, bytes)
    const download = h.native.download
    let attempts = 0
    h.native.download = async (options) => {
      if (++attempts === 1) {
        h.files.set(options.to, Buffer.from('partial'))
        throw Object.assign(new Error('expired'), { data: { status: 403 } })
      }
      assert.equal(h.files.has(options.to), false)
      await download(options)
    }
    await h.staging.stage(h.source(ref, url))
    assert.equal(attempts, 2)
  })

  it('downloads into staging, verifies, then publishes atomically', async () => {
    const h = harness()
    const bytes = Buffer.alloc(6_000_000, 42)
    const ref = h.reference('item', 3, bytes)
    h.objects.set('https://objects.example.test/item/3', bytes)
    const file = await h.staging.stage(h.source(ref, 'https://objects.example.test/item/3'))
    assert.equal(cloudSyncStagedHandle(file).owner, h.staging)
    const staged = [...h.files.keys()].find((path) => path.startsWith('.zennotes/sync/downloads/'))!
    assert.ok(staged, 'file staged in vault-private directory')
    const conflict = await h.staging.apply(
      { sequence: 9, item_id: 'item', type: 'upsert', path: 'attachements/big.bin', previous_path: null, revision: 3, content_ref: ref },
      undefined, file
    )
    assert.equal(conflict, undefined)
    assert.deepEqual(h.files.get('attachements/big.bin'), bytes)
    assert.equal(h.files.has(staged), false, 'staging file was moved, not copied')
  })

  it('rejects a download whose bytes do not match the reference and leaves nothing behind', async () => {
    const h = harness()
    const bytes = Buffer.alloc(1000, 1)
    const ref = h.reference('item', 1, bytes)
    h.objects.set('https://objects.example.test/item/1', Buffer.alloc(1000, 2))
    await assert.rejects(h.staging.stage(h.source(ref, 'https://objects.example.test/item/1')), /verification/)
    assert.equal([...h.files.keys()].some((path) => path.startsWith('.zennotes/sync/downloads/')), false)
  })

  it('preserves a local edit as a conflict instead of overwriting it', async () => {
    const localEdit = Buffer.from('my local edit')
    const h = harness({ 'note.md': localEdit })
    const cloud = Buffer.from('cloud version')
    const ref = h.reference('item', 2, cloud, 'utf8')
    h.objects.set('https://objects.example.test/item/2', cloud)
    const file = await h.staging.stage(h.source(ref, 'https://objects.example.test/item/2'))
    const tracked = { item_id: 'item', path: 'note.md', kind: 'text', revision: 1, sha256: hash(Buffer.from('original')), byte_length: 8, media_type: 'text/markdown' }
    const conflict = await h.staging.apply(
      { sequence: 5, item_id: 'item', type: 'upsert', path: 'note.md', previous_path: null, revision: 2, content_ref: ref },
      tracked, file
    )
    assert.equal(conflict?.code, 'LOCAL_EDIT_CONFLICT')
    assert.equal(conflict?.local?.content.data, 'my local edit')
    assert.deepEqual(h.files.get('note.md'), localEdit, 'local bytes untouched')
  })

  it('keeps both versions with a byte-verified copy of the local file', async () => {
    const local = Buffer.alloc(6_000_000, 7)
    const h = harness({ 'attachements/big.bin': local })
    const cloud = Buffer.alloc(6_000_000, 9)
    const ref = h.reference('item', 4, cloud)
    h.objects.set('https://objects.example.test/item/4', cloud)
    const file = await h.staging.stage(h.source(ref, 'https://objects.example.test/item/4'))
    await h.staging.resolve({
      expected_path: 'attachements/big.bin', expected_sha256: hash(local),
      cloud_path: 'attachements/big.bin', file, keep_both_path: 'attachements/big (local).bin'
    })
    assert.deepEqual(h.files.get('attachements/big.bin'), cloud)
    assert.deepEqual(h.files.get('attachements/big (local).bin'), local)
    assert.ok(h.log.some((entry) => entry.startsWith('copy attachements/big.bin')))
  })

  it('refuses to resolve when the local file changed since the conflict was recorded', async () => {
    const h = harness({ 'note.md': Buffer.from('changed again') })
    const cloud = Buffer.from('cloud')
    const ref = h.reference('item', 1, cloud, 'utf8')
    h.objects.set('https://objects.example.test/item/1', cloud)
    const file = await h.staging.stage(h.source(ref, 'https://objects.example.test/item/1'))
    await assert.rejects(h.staging.resolve({
      expected_path: 'note.md', expected_sha256: hash(Buffer.from('stale')), cloud_path: 'note.md', file
    }), /changed on this device/)
    assert.equal(h.files.get('note.md')!.toString(), 'changed again')
  })
})
