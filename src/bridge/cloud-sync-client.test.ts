import assert from 'node:assert/strict'
import { it } from 'node:test'
import { loadMobileModule } from '../../tooling/load-mobile-module.ts'

it('downloads every manifest and change page without grouping large attachments in one native response', async () => {
  const requests: URL[] = []
  const items = [1, 2, 3].map((id) => ({
    item_id: `asset-${id}`, path: `assets/${id}.jpg`, kind: 'binary', revision: 1,
    sha256: `hash-${id}`, byte_length: 8_700_000, media_type: 'image/jpeg',
    content: {
      encoding: 'base64', data: `fixture-${id}`, sha256: `hash-${id}`,
      byte_length: 8_700_000, media_type: 'image/jpeg'
    }
  }))
  let feed: any[] = []
  const { createCloudSyncClient, CloudSyncCoordinator } = await loadMobileModule([
    './src/bridge/cloud-sync-client.ts', '@zennotes/shared-domain/cloud-sync-coordinator'
  ], {
    '@capacitor/core': {
      registerPlugin: () => ({}),
      CapacitorHttp: {
        request: async ({ url }: { url: string }) => {
          const request = new URL(url)
          requests.push(request)
          if (request.pathname.endsWith('/manifest')) {
            const page = Number(request.searchParams.get('page') ?? 1)
            const size = Number(request.searchParams.get('per_page') ?? 100)
            const data = items.slice((page - 1) * size, page * size)
            assert.ok(data.length <= 1, 'content responses must fit one attachment through the native bridge')
            return { status: 200, data: { data, cursor: 3, next_page: page * size < items.length ? page + 1 : null } }
          }
          assert.ok(request.pathname.endsWith('/changes'))
          const after = Number(request.searchParams.get('after'))
          const size = Number(request.searchParams.get('limit'))
          const remaining = feed.filter((change) => change.sequence > after)
          const data = remaining.slice(0, size)
          assert.ok(data.length <= 1, 'change responses must fit one attachment through the native bridge')
          return { status: 200, data: { data, cursor: feed.at(-1)?.sequence ?? 3, has_more: remaining.length > size } }
        }
      }
    }
  })
  const files = new Map<string, any>()
  let state: any = null
  const sync = new CloudSyncCoordinator('vault-1', createCloudSyncClient('https://example.test', 'test-only'), {
    scan: async () => [...files.values()],
    apply: async (change: any) => {
      files.set(change.path, { path: change.path, kind: 'binary', content: change.content })
    }
  }, {
    load: async () => state,
    save: async (next: any) => { state = structuredClone(next) }
  }, {
    itemId: () => assert.fail('download must not invent an item'),
    operationId: () => assert.fail('download must not upload unchanged files')
  })

  await sync.sync()
  assert.equal(state.cursor, 3)
  assert.equal(files.size, 3)
  assert.deepEqual(requests.filter((url) => url.pathname.endsWith('/manifest')).map((url) => url.searchParams.get('page')), ['1', '2', '3'])

  feed = items.map((item, index) => ({
    sequence: 4 + index, item_id: item.item_id, path: item.path, previous_path: item.path,
    type: 'upsert', revision: 2,
    content: { ...item.content, data: `updated-${index}`, sha256: `updated-hash-${index}` }
  }))
  requests.length = 0
  await sync.sync()
  assert.equal(state.cursor, 6)
  assert.deepEqual([...files.values()].map((item) => item.content.sha256), feed.map((change) => change.content.sha256))
  assert.deepEqual(requests.slice(0, 3).map((url) => url.searchParams.get('after')), ['3', '4', '5'])
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
  const client = createCloudSyncClient('https://example.test', 'test-only')
  await client.manifest('vault-1', { includeContent: false, page: 2, perPage: 250 })
  await client.manifest('vault-1', { includeContent: false, perPage: 1 })
  assert.equal(requests[0].searchParams.get('per_page'), '250')
  assert.equal(requests[0].searchParams.get('page'), '2')
  assert.equal(requests[1].searchParams.get('per_page'), '1')
  assert.ok(requests.every((url) => url.searchParams.get('include_content') === 'false'))
})
