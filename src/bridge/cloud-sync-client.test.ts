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

function memoryKeyStore(value: { format: 1; key: string; version: number } | null) {
  return { load: async () => value, save: async () => assert.fail('nothing saves here'), clear: async () => {} }
}

async function encryptedVaultFixture(name = 'Journal 2026') {
  const { generateCloudE2eeKey, toBase64 } = await import('@zennotes/shared-domain/cloud-e2ee')
  const { CloudVaultCipher } = await import('@zennotes/shared-domain/cloud-e2ee-vault')
  const accountKey = generateCloudE2eeKey()
  const vault = {
    id: 'vault-1', name: 'Encrypted vault', cursor: 0, created_at: '2026-10-12T00:00:00Z', updated_at: '2026-10-12T00:00:00Z',
    encryption: await CloudVaultCipher.prepareVault(name, accountKey, 1)
  }
  return { vault, unlocked: { format: 1 as const, key: toBase64(accountKey), version: 1 } }
}

it('announces end-to-end encryption only for a client given a keyring, and forwards request headers', async () => {
  const { CloudE2eeKeyring } = await import('@zennotes/shared-domain/cloud-e2ee-account')
  const requests: { headers: Record<string, string> }[] = []
  const { createCloudSyncClient } = await loadMobileModule('./src/bridge/cloud-sync-client.ts', {
    '@capacitor/core': {
      registerPlugin: () => ({}),
      CapacitorHttp: { request: async ({ headers }: { headers: Record<string, string> }) => {
        requests.push({ headers })
        return { status: 200, data: { data: [], cursor: 0, next_page: null } }
      } }
    }
  })
  const readable = { id: 'vault-1', name: 'Notes', cursor: 0, created_at: '', updated_at: '', encryption: null }
  const keyring = new CloudE2eeKeyring({ listVaults: async () => [readable], store: memoryKeyStore(null) })
  await createCloudSyncClient('https://example.test', 'test-only', { accountId: 'account' }).manifest('vault-1', { includeContent: false })
  await createCloudSyncClient('https://example.test', 'test-only', { accountId: 'account', keyring }).manifest('vault-1', { includeContent: false })
  assert.equal(requests[0]!.headers['X-ZenNotes-Encryption'], undefined)
  assert.equal(requests[1]!.headers['X-ZenNotes-Encryption'], 'zne1')
  assert.ok(requests.every(({ headers }) => headers.Authorization === 'Bearer test-only'))
})

it('lists an encrypted vault under its real name when this device is unlocked, and the placeholder when locked', async () => {
  const { CloudE2eeKeyring } = await import('@zennotes/shared-domain/cloud-e2ee-account')
  const { vault, unlocked } = await encryptedVaultFixture()
  const readable = { id: 'vault-2', name: 'Notes', cursor: 0, created_at: '', updated_at: '', encryption: null }
  const { createCloudSyncClient } = await loadMobileModule('./src/bridge/cloud-sync-client.ts', {
    '@capacitor/core': {
      registerPlugin: () => ({}),
      CapacitorHttp: { request: async () => ({ status: 200, data: { data: [vault, readable] } }) }
    }
  })
  const names = async (stored: typeof unlocked | null) => (await createCloudSyncClient('https://example.test', 'test-only', {
    accountId: 'account',
    keyring: new CloudE2eeKeyring({ listVaults: async () => [vault, readable], store: memoryKeyStore(stored) })
  }).listVaults()).data.map((listed: { name: string }) => listed.name)
  assert.deepEqual(await names(unlocked), ['Journal 2026', 'Notes'])
  assert.deepEqual(await names(null), ['Encrypted vault', 'Notes'])
})

it('sends an encrypted vault\'s file direct once its ciphertext passes the inline cap, sealed and never readable', async () => {
  const { CloudE2eeKeyring } = await import('@zennotes/shared-domain/cloud-e2ee-account')
  const { zne1CiphertextLength } = await import('@zennotes/shared-domain/cloud-e2ee')
  const { vault, unlocked } = await encryptedVaultFixture()
  const requests: { method: string; path: string; headers: Record<string, string>; data: any }[] = []
  const puts: any[] = []
  const { createCloudSyncClient } = await loadMobileModule('./src/bridge/cloud-sync-client.ts', {
    '@capacitor/core': {
      registerPlugin: () => ({ put: async (request: unknown) => { puts.push(request); return { status: 200 } } }),
      CapacitorHttp: { request: async ({ method, url, headers, data }: any) => {
        const path = new URL(url).pathname
        requests.push({ method, path, headers, data })
        if (path.endsWith('/uploads')) {
          return { status: 201, data: { data: {
            id: 'upload-1', operation_id: data.operation_id, status: 'uploading', expected_bytes: data.content.byte_length,
            expires_at: '2099-01-01T00:00:00Z', upload: { method: 'PUT', url: 'https://objects.example.test/put', headers: {} }
          } } }
        }
        assert.ok(path.endsWith('/uploads/upload-1/complete'), `unexpected ${method} ${path}`)
        return { status: 200, data: { data: { id: 'upload-1', operation_id: 'operation-1', status: 'completed',
          result: { acknowledged: [{ operation_id: 'operation-1', item_id: 'item-1', revision: 1, sequence: 1 }], conflicts: [], cursor: 1 } } } }
      } }
    }
  })
  const keyring = new CloudE2eeKeyring({ listVaults: async () => [vault], store: memoryKeyStore(unlocked) })
  const client = createCloudSyncClient('https://example.test', 'test-only', { accountId: 'account', keyring })
  const bytes = Buffer.alloc(5 * 1024 * 1024 - 100, 4)
  const result = await client.mutate('vault-1', { mutations: [{
    type: 'upsert', operation_id: 'operation-1', item_id: 'item-1', base_revision: null, path: 'Scans/receipt.pdf', kind: 'binary',
    content: { encoding: 'base64', data: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex'),
      byte_length: bytes.length, media_type: 'application/pdf' }
  }] })

  assert.equal(result.acknowledged.length, 1)
  assert.deepEqual(requests.map(({ method, path }) => `${method} ${path}`), [
    'POST /api/v1/vaults/vault-1/uploads', 'POST /api/v1/vaults/vault-1/uploads/upload-1/complete'
  ])
  assert.ok(requests.every(({ headers }) => headers['X-ZenNotes-Encryption'] === 'zne1'))
  const initiated = requests[0]!.data
  assert.match(initiated.path, /^[0-9a-f]{64}$/)
  assert.equal(JSON.stringify(initiated).includes('receipt'), false)
  assert.deepEqual([initiated.kind, initiated.content.encoding, initiated.content.byte_length], ['binary', 'aes-gcm', zne1CiphertextLength(bytes.length)])
  const sealed = Buffer.from(puts[0].base64, 'base64')
  assert.equal(puts[0].sha256, createHash('sha256').update(sealed).digest('hex'))
  assert.equal(sealed.subarray(0, 4).toString('latin1'), 'ZNE1')
})

it('lets a request go 30 s without a byte and a connection 15 s to open; only a publication waits longer', async () => {
  const options: Array<{ connectTimeout?: number; readTimeout?: number }> = []
  const { createCloudSyncClient } = await loadMobileModule('./src/bridge/cloud-sync-client.ts', {
    '@capacitor/core': {
      registerPlugin: () => ({}),
      CapacitorHttp: { request: async (request: { connectTimeout?: number; readTimeout?: number }) => {
        options.push(request)
        return { status: 200, data: { data: [], id: 1, slug: 'note', url: 'https://example.test/s/note' } }
      } }
    }
  })
  const client = createCloudSyncClient('https://example.test', 'test-only', { accountId: 'account' })
  await client.listVaults()
  await client.publishNote({ note_path: 'Note.md', title: 'Note', markdown: 'Text' })
  // Android's read timeout starts over with every byte, so 30 s is how long a
  // request may go silent; a big page on a slow link takes as long as it needs.
  assert.deepEqual(options.map(({ connectTimeout, readTimeout }) => ({ connectTimeout, readTimeout })), [
    { connectTimeout: 15_000, readTimeout: 30_000 },
    { connectTimeout: 15_000, readTimeout: 300_000 }
  ])
})

it('sends a read that went silent again instead of failing the sync', async (t) => {
  t.mock.method(Math, 'random', () => 0)
  const paths: string[] = []
  const { createCloudSyncClient } = await loadMobileModule('./src/bridge/cloud-sync-client.ts', {
    '@capacitor/core': {
      registerPlugin: () => ({}),
      CapacitorHttp: { request: async ({ url }: { url: string }) => {
        paths.push(new URL(url).pathname)
        if (paths.length === 1) throw Object.assign(new Error('timeout'), { code: 'SocketTimeoutException' })
        return { status: 200, data: { data: [] } }
      } }
    }
  })
  const client = createCloudSyncClient('https://example.test', 'test-only', { accountId: 'stalled-read' })
  assert.deepEqual(await client.listVaults(), { data: [] })
  assert.deepEqual(paths, ['/api/v1/vaults', '/api/v1/vaults'])
})

it('never sends a request again that the service might apply twice, and says the connection stalled', async () => {
  let calls = 0
  const { createCloudSyncClient } = await loadMobileModule('./src/bridge/cloud-sync-client.ts', {
    '@capacitor/core': {
      registerPlugin: () => ({}),
      CapacitorHttp: { request: async () => {
        calls++
        throw Object.assign(new Error('timeout'), { code: 'SocketTimeoutException' })
      } }
    }
  })
  const { describeCloudError, CLOUD_TIMEOUT_MESSAGE } = await import('@zennotes/shared-domain/cloud-error-copy')
  const client = createCloudSyncClient('https://example.test', 'test-only', { accountId: 'stalled-write' })
  const error = await client.createVault('New vault').catch((failure: unknown) => failure)
  assert.equal(calls, 1)
  assert.equal((error as Error).name, 'CloudSyncTransportError')
  assert.equal((error as { stalled?: boolean }).stalled, true)
  assert.equal(describeCloudError(error).message, CLOUD_TIMEOUT_MESSAGE)
})

it('puts an object again when the store never answered, never when it refused', async (t) => {
  t.mock.method(Math, 'random', () => 0)
  for (const outcome of ['no answer', 'refused'] as const) {
    const puts: Array<{ base64?: string }> = []
    const requests: string[] = []
    const { createCloudSyncClient } = await loadMobileModule('./src/bridge/cloud-sync-client.ts', {
      '@capacitor/core': {
        registerPlugin: () => ({ put: async (request: { base64?: string }) => {
          puts.push(request)
          if (puts.length > 1) return { status: 200 }
          if (outcome === 'refused') return { status: 403 }
          throw Object.assign(new Error('Cloud object upload failed.'), { code: 'DIRECT_UPLOAD_FAILED' })
        } }),
        CapacitorHttp: { request: async ({ method, url, data }: any) => {
          const path = new URL(url).pathname
          requests.push(`${method} ${path}`)
          if (path.endsWith('/uploads')) {
            return { status: 201, data: { data: {
              id: 'upload-1', operation_id: data.operation_id, status: 'uploading', expected_bytes: data.content.byte_length,
              expires_at: '2099-01-01T00:00:00Z', upload: { method: 'PUT', url: 'https://objects.example.test/put', headers: {} }
            } } }
          }
          if (method === 'DELETE') return { status: 204, data: '' }
          return { status: 200, data: { data: { id: 'upload-1', operation_id: 'operation-1', status: 'completed',
            result: { acknowledged: [{ operation_id: 'operation-1', item_id: 'item-1', revision: 1, sequence: 1 }], conflicts: [], cursor: 1 } } } }
        } }
      }
    })
    const client = createCloudSyncClient('https://example.test', 'test-only', { accountId: `put-${outcome}` })
    const bytes = Buffer.alloc(5 * 1024 * 1024 + 1, 7)
    const mutation = client.mutate('vault-1', { mutations: [{
      type: 'upsert', operation_id: 'operation-1', item_id: 'item-1', base_revision: null, path: 'Scans/receipt.pdf', kind: 'binary',
      content: { encoding: 'base64', data: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex'),
        byte_length: bytes.length, media_type: 'application/pdf' }
    }] })
    if (outcome === 'no answer') {
      assert.equal((await mutation).acknowledged.length, 1)
      assert.equal(puts.length, 2)
      assert.equal(puts[1]!.base64, puts[0]!.base64)
      assert.deepEqual(requests, ['POST /api/v1/vaults/vault-1/uploads', 'POST /api/v1/vaults/vault-1/uploads/upload-1/complete'])
    } else {
      await assert.rejects(mutation, /403/)
      assert.equal(puts.length, 1)
      assert.deepEqual(requests, ['POST /api/v1/vaults/vault-1/uploads', 'DELETE /api/v1/vaults/vault-1/uploads/upload-1'])
    }
  }
})

it('keeps which fields a 422 refused, so sync sets one path aside and sends the rest (#1004)', async () => {
  const refused = 'This path is not eligible for vault sync.'
  const requests: string[] = []
  const { createCloudSyncClient, cloudSyncPathRefusal, CloudSyncPathRefusedError } = await loadMobileModule([
    './src/bridge/cloud-sync-client.ts', '@zennotes/shared-domain/cloud-sync-refusal'
  ], {
    '@capacitor/core': {
      registerPlugin: () => ({}),
      CapacitorHttp: { request: async ({ url, method }: { url: string; method: string }) => {
        requests.push(`${method} ${new URL(url).pathname}`)
        if (url.endsWith('/uploads')) {
          return { status: 422, data: { error: { code: 'VALIDATION_FAILED', message: 'The request data is invalid.' }, errors: { path: [refused] } } }
        }
        if (requests.length === 1) {
          return { status: 422, data: { error: { code: 'VALIDATION_FAILED', message: 'The request data is invalid.' }, errors: { 'mutations.1.path': [refused] } } }
        }
        return { status: 200, data: { acknowledged: [{ operation_id: 'kept', item_id: 'kept-item', revision: 1, sequence: 3 }], conflicts: [], cursor: 3 } }
      } }
    }
  })
  const content = (bytes: number) => ({ encoding: 'base64', data: Buffer.alloc(bytes, 1).toString('base64'), sha256: 'a'.repeat(64), byte_length: bytes, media_type: 'text/markdown' })
  const upsert = (operation: string, path: string, bytes = 4) =>
    ({ type: 'upsert', operation_id: operation, item_id: `${operation}-item`, base_revision: null, path, kind: 'markdown', content: content(bytes) })
  const client = createCloudSyncClient('https://example.test', 'test-only', { accountId: 'refused-path' })

  // One request: the transport keeps Cloud's `errors`, so the refusal names the path.
  const inline = { mutations: [upsert('kept', 'inbox/Note.md'), upsert('agent', '.zennotes/agent-edits/inbox/Note.md.json')] }
  const error = await client.mutate('vault-1', inline).catch((caught: unknown) => caught)
  assert.equal(error.status, 422)
  assert.equal(error.code, 'VALIDATION_FAILED')
  assert.equal(error.message, refused)
  assert.deepEqual(error.details, { errors: { 'mutations.1.path': [refused] } })
  assert.deepEqual(cloudSyncPathRefusal(error, inline)?.indices, [1])

  // Several requests: a large file's upload refused for its path is named by
  // its place in the batch, and carries what the inline request applied.
  const mixed = { mutations: [upsert('kept', 'inbox/Note.md'), upsert('big', '.zennotes/agent-edits/big.json', 5 * 1024 * 1024 + 1)] }
  const split = await client.mutate('vault-1', mixed).catch((caught: unknown) => caught)
  assert.ok(split instanceof CloudSyncPathRefusedError)
  assert.deepEqual(split.refusal.indices, [1])
  assert.deepEqual(split.refusal.applied.acknowledged.map((entry: { operation_id: string }) => entry.operation_id), ['kept'])
  assert.deepEqual(cloudSyncPathRefusal(split, mixed)?.indices, [1])
})
