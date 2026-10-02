import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { it } from 'node:test'
import { loadMobileModule } from '../../tooling/load-mobile-module.ts'

/** Account capability + reference-mode responses, as the backend now serves them. */
function referenceServer(items: any[], feedRef: { feed: any[] }, requests: URL[], downloads: string[]) {
  return async ({ url, method }: { url: string; method?: string }) => {
    const request = new URL(url)
    requests.push(request)
    if (request.pathname.endsWith('/account')) {
      return { status: 200, data: { data: { capabilities: { content_references: true }, user: {}, device: {}, features: {}, usage: {} } } }
    }
    if (request.pathname.endsWith('/manifest')) {
      assert.equal(request.searchParams.get('content_mode'), 'references')
      const page = Number(request.searchParams.get('page') ?? 1)
      const size = Number(request.searchParams.get('per_page') ?? 100)
      const data = items.slice((page - 1) * size, page * size).map(({ content, ...metadata }) => ({
        ...metadata, content_ref: { item_id: metadata.item_id, revision: metadata.revision, ...content, data: undefined }
      })).map((row) => ({ ...row, content_ref: Object.fromEntries(Object.entries(row.content_ref).filter(([, v]) => v !== undefined)) }))
      return { status: 200, data: { data, cursor: 3, next_page: page * size < items.length ? page + 1 : null } }
    }
    if (request.pathname.endsWith('/download')) {
      const [, itemId, revision] = request.pathname.match(/items\/([^/]+)\/revisions\/(\d+)\/download/)!
      const item = items.find((candidate) => candidate.item_id === itemId)!
      const content = item.versions?.[Number(revision)] ?? item.content
      downloads.push(`${itemId}:${revision}`)
      return { status: 200, data: { data: {
        item_id: itemId, revision: Number(revision),
        content: { encoding: content.encoding, sha256: content.sha256, byte_length: content.byte_length, media_type: content.media_type },
        download: { url: `https://objects.example.test/${itemId}/${revision}`, method: 'GET', headers: {}, expires_at: new Date(Date.now() + 300_000).toISOString() }
      } } }
    }
    assert.ok(request.pathname.endsWith('/changes'), `unexpected ${method} ${request.pathname}`)
    assert.equal(request.searchParams.get('content_mode'), 'references')
    const after = Number(request.searchParams.get('after'))
    const size = Number(request.searchParams.get('limit'))
    const remaining = feedRef.feed.filter((change) => change.sequence > after)
    const data = remaining.slice(0, size)
    return { status: 200, data: { data, cursor: feedRef.feed.at(-1)?.sequence ?? 3, has_more: remaining.length > size } }
  }
}

it('syncs large attachments as native-staged references, never as base64 through the bridge', async () => {
  const requests: URL[] = []
  const downloads: string[] = []
  const items = [1, 2, 3].map((id) => {
    const bytes = Buffer.alloc(1_048_577, id)
    const hash = createHash('sha256').update(bytes).digest('hex')
    const content = { encoding: 'base64', sha256: hash, byte_length: bytes.length, media_type: 'image/jpeg' }
    return { item_id: `asset-${id}`, path: `assets/${id}.jpg`, kind: 'binary', revision: 1, sha256: hash, byte_length: bytes.length, media_type: 'image/jpeg', content, versions: { 1: content } as Record<number, any> }
  })
  const feedRef = { feed: [] as any[] }
  const { createCloudSyncClient, CloudSyncCoordinator, registerCloudSyncStagedFile } = await loadMobileModule([
    './src/bridge/cloud-sync-client.ts', '@zennotes/shared-domain/cloud-sync-coordinator', '@zennotes/shared-domain/cloud-sync-content'
  ], {
    '@capacitor/core': { registerPlugin: () => ({}), CapacitorHttp: { request: referenceServer(items, feedRef, requests, downloads) } }
  })
  const files = new Map<string, any>()
  let state: any = null
  const staged: string[] = []
  const repository = {
    scan: async () => [...files.values()],
    apply: async () => assert.fail('reference-mode hosts must receive staged files, not inline apply'),
    stageCloudContent: async (source: any) => {
      await source.getInstruction()
      staged.push(`${source.reference.item_id}:${source.reference.revision}`)
      return registerCloudSyncStagedFile(source.reference, { native: true }, async () => {})
    },
    applyStagedCloudContent: async (change: any) => {
      files.set(change.path, { path: change.path, kind: 'binary', content: { ...change.content_ref, data: '' } })
    },
    resolveStagedCloudConflict: async () => assert.fail('no conflicts expected')
  }
  const sync = new CloudSyncCoordinator('vault-1', createCloudSyncClient('https://example.test', 'test-only', { accountId: 'account' }), repository, {
    load: async () => state,
    save: async (next: any) => { state = structuredClone(next) }
  }, {
    itemId: () => assert.fail('download must not invent an item'),
    operationId: () => assert.fail('download must not upload unchanged files')
  })

  await sync.sync()
  assert.equal(state.cursor, 3)
  assert.equal(files.size, 3)
  assert.deepEqual(staged.sort(), ['asset-1:1', 'asset-2:1', 'asset-3:1'])
  assert.deepEqual(downloads.sort(), staged.sort())
  // No request ever carried a body larger than metadata.
  assert.ok(requests.every((url) => !url.pathname.includes('/revisions/') || url.pathname.endsWith('/download')))

  feedRef.feed = items.map((item, index) => {
    const bytes = Buffer.alloc(2_000_000, 100 + index)
    const hash = createHash('sha256').update(bytes).digest('hex')
    const content = { encoding: 'base64', sha256: hash, byte_length: bytes.length, media_type: 'image/jpeg' }
    item.versions[2] = content
    return { sequence: 4 + index, item_id: item.item_id, path: item.path, previous_path: item.path, type: 'upsert', revision: 2,
      content_ref: { item_id: item.item_id, revision: 2, ...content } }
  })
  requests.length = 0
  staged.length = 0
  await sync.sync()
  assert.equal(state.cursor, 6)
  assert.deepEqual([...files.values()].map((item) => item.content.sha256), feedRef.feed.map((change) => change.content_ref.sha256))
  assert.deepEqual(staged.sort(), ['asset-1:2', 'asset-2:2', 'asset-3:2'])
})

it('keeps metadata-only manifest pagination intact', async () => {
  const requests: URL[] = []
  const { createCloudSyncClient } = await loadMobileModule('./src/bridge/cloud-sync-client.ts', {
    '@capacitor/core': {
      registerPlugin: () => ({}),
      CapacitorHttp: { request: async ({ url }: { url: string }) => {
        requests.push(new URL(url))
        return { status: 200, data: { data: [], cursor: 10, next_page: null } }
      } }
    }
  })
  const client = createCloudSyncClient('https://example.test', 'test-only', { accountId: 'account' })
  await client.manifest('vault-1', { includeContent: false, page: 2, perPage: 250 })
  await client.manifest('vault-1', { includeContent: false, perPage: 1 })
  assert.equal(requests[0].searchParams.get('per_page'), '250')
  assert.equal(requests[0].searchParams.get('page'), '2')
  assert.equal(requests[1].searchParams.get('per_page'), '1')
  assert.ok(requests.every((url) => url.searchParams.get('include_content') === 'false'))
})

it('preserves the requested change page size and metadata-only content budget', async () => {
  const requests: URL[] = []
  const { createCloudSyncClient } = await loadMobileModule('./src/bridge/cloud-sync-client.ts', {
    '@capacitor/core': {
      registerPlugin: () => ({}),
      CapacitorHttp: { request: referenceServer([], { feed: [] }, requests, []) }
    }
  })
  const client = createCloudSyncClient('https://pagination.example.test', 'test-only', { accountId: 'account' })
  await client.negotiateContentReferences()
  await client.changes('vault-1', 10, 250, { contentMode: 'references', maxInlineBytes: 0 })
  const request = requests.at(-1)!
  assert.equal(request.searchParams.get('limit'), '250')
  assert.equal(request.searchParams.get('after'), '10')
  assert.equal(request.searchParams.get('max_inline_bytes'), '0')
  assert.equal(request.searchParams.get('max_response_bytes'), '1048576')
})
