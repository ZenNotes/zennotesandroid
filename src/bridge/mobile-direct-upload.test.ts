import assert from 'node:assert/strict'
import { createCipheriv, createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import type {
  CloudSyncMutationRequest,
  CloudSyncMutationResponse,
  CloudSyncUploadRequest,
  CloudSyncUpsertMutation
} from '@zennotes/bridge-contract/cloud-sync'
import {
  CloudPathIndex,
  Zne1Purpose,
  decryptItemMeta,
  decryptZne1,
  generateCloudE2eeKey,
  unwrapVaultKey,
  zne1CiphertextLength,
  type Zne1ChunkCipherParams
} from '@zennotes/shared-domain/cloud-e2ee'
import { CloudE2eeLockedError, CloudVaultCipher } from '@zennotes/shared-domain/cloud-e2ee-vault'
import { CloudSyncPathRefusedError, cloudSyncPathRefusal } from '@zennotes/shared-domain/cloud-sync-refusal'
import {
  CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES,
  MobileDirectUploadError,
  mobileObjectUploadOptions,
  mutateWithMobileDirectUploads,
  rememberMobileUploadSource,
  type MobileDirectUploadApi,
  type MobileObjectUpload,
  type MobileObjectUploadRequest,
  type MobileUploadSealer
} from './mobile-direct-upload.ts'

describe('mutateWithMobileDirectUploads', () => {
  it('adds a content type to host-only signed uploads so Android writes the binary body', () => {
    const headers = { Host: 'objects.example.test' }
    const options = mobileObjectUploadOptions({
      url: 'https://objects.example.test/upload',
      method: 'PUT',
      headers,
      base64: 'AQID',
      byteLength: 3
    })
    assert.equal(options.headers['Content-Type'], 'application/octet-stream')
    assert.deepEqual(headers, { Host: 'objects.example.test' })
  })

  it('preserves an existing signed content type regardless of casing', () => {
    const options = mobileObjectUploadOptions({
      url: 'https://objects.example.test/upload',
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
      base64: 'AQID',
      byteLength: 3
    })
    assert.deepEqual(options.headers, { 'content-type': 'image/png' })
  })

  it('builds a native binary PUT without an account bearer token or redirects', () => {
    const options = mobileObjectUploadOptions({
      url: 'https://objects.example.test/upload?signature=signed',
      method: 'PUT',
      headers: {
        'Content-Type': 'image/png',
        'Content-Length': '3'
      },
      base64: 'AQID',
      byteLength: 3
    })

    assert.deepEqual(options, {
      url: 'https://objects.example.test/upload?signature=signed',
      method: 'PUT',
      headers: {
        'Content-Type': 'image/png',
        'Content-Length': '3'
      },
      data: 'AQID',
      dataType: 'file',
      connectTimeout: 30_000,
      readTimeout: 300_000,
      disableRedirects: true
    })
    assert.equal(options.headers.Authorization, undefined)
  })

  it('keeps files at the inline limit in the normal mutation request', async () => {
    const mutation = upsertMutation(CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES, 'AA==')
    const inlineBodies: CloudSyncMutationRequest[] = []
    const api = fakeApi({
      mutate: async (_vaultId, body) => {
        inlineBodies.push(body)
        return emptyResponse()
      }
    })

    await mutateWithMobileDirectUploads(api, 'vault-1', { mutations: [mutation] }, async () => {
      assert.fail('object upload must not run for an inline file')
    })

    assert.deepEqual(inlineBodies, [{ mutations: [mutation] }])
  })

  it('uploads a file above the inline limit through the signed object URL', async () => {
    const base64 = Buffer.alloc(CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES + 1, 7).toString('base64')
    const mutation = upsertMutation(CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES + 1, base64)
    const calls: string[] = []
    const acknowledgement = {
      operation_id: mutation.operation_id,
      item_id: mutation.item_id,
      revision: 3,
      sequence: 9
    }
    let completionAttempts = 0
    const api = fakeApi({
      initiateUpload: async () => {
        calls.push('initiate')
        return uploadInstruction(mutation, 'https://objects.example.test/upload?signature=signed')
      },
      completeUpload: async () => {
        calls.push('complete')
        completionAttempts += 1
        if (completionAttempts === 1) {
          throw new MobileDirectUploadError('Try again.', 503, 'TEMPORARY_FAILURE')
        }
        return {
          data: {
            id: 'upload-1',
            operation_id: mutation.operation_id,
            status: 'completed',
            result: { acknowledged: [acknowledgement], conflicts: [], cursor: 9 }
          }
        }
      }
    })
    const uploads: Parameters<MobileObjectUpload>[0][] = []

    const result = await mutateWithMobileDirectUploads(
      api,
      'vault-1',
      { mutations: [mutation] },
      async (upload) => {
        calls.push('put')
        uploads.push(upload)
      }
    )

    assert.deepEqual(result, { acknowledged: [acknowledgement], conflicts: [], cursor: 9 })
    assert.deepEqual(calls, ['initiate', 'put', 'complete', 'complete'])
    assert.equal(uploads[0]?.url, 'https://objects.example.test/upload?signature=signed')
    assert.equal(uploads[0]?.base64, base64)
    assert.equal(uploads[0]?.byteLength, CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES + 1)
    assert.equal(uploads[0]?.headers.Authorization, undefined)
  })

  it('aborts the reservation when object storage rejects the upload', async () => {
    const byteLength = CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES + 1
    const mutation = upsertMutation(byteLength, Buffer.alloc(byteLength, 11).toString('base64'))
    const aborted: string[] = []
    const api = fakeApi({
      initiateUpload: async () => uploadInstruction(mutation, 'https://objects.example.test/upload'),
      abortUpload: async (_vaultId, uploadId) => {
        aborted.push(uploadId)
      }
    })

    await assert.rejects(
      mutateWithMobileDirectUploads(api, 'vault-1', { mutations: [mutation] }, async () => {
        throw new MobileDirectUploadError('Object upload failed.', 503, 'DIRECT_UPLOAD_FAILED')
      }),
      (error: unknown) =>
        error instanceof MobileDirectUploadError && error.code === 'DIRECT_UPLOAD_FAILED'
    )
    assert.deepEqual(aborted, ['upload-1'])
  })

  it('rejects insecure signed URLs before transmitting bytes and aborts the reservation', async () => {
    const byteLength = CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES + 1
    const mutation = upsertMutation(byteLength, Buffer.alloc(byteLength, 12).toString('base64'))
    const aborted: string[] = []
    let uploaded = false
    const api = fakeApi({
      initiateUpload: async () => uploadInstruction(mutation, 'http://objects.example.test/upload'),
      abortUpload: async (_vaultId, uploadId) => {
        aborted.push(uploadId)
      }
    })

    await assert.rejects(
      mutateWithMobileDirectUploads(api, 'vault-1', { mutations: [mutation] }, async () => {
        uploaded = true
      }),
      (error: unknown) =>
        error instanceof MobileDirectUploadError && error.code === 'INSECURE_DIRECT_UPLOAD_URL'
    )
    assert.equal(uploaded, false)
    assert.deepEqual(aborted, ['upload-1'])
  })
})

describe('a path Cloud refuses (#1004)', () => {
  const refusedText = 'This path is not eligible for vault sync.'
  const validation = (errors: Record<string, string[]>) =>
    new MobileDirectUploadError(refusedText, 422, 'VALIDATION_FAILED', { errors })
  const small = (operation: string, path: string): CloudSyncUpsertMutation =>
    ({ ...upsertMutation(4, 'YWJjZA=='), operation_id: operation, item_id: `${operation}-item`, path })
  const large = (operation: string, path: string): CloudSyncUpsertMutation => {
    const byteLength = CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES + 1
    return { ...upsertMutation(byteLength, Buffer.alloc(byteLength, 5).toString('base64')), operation_id: operation, item_id: `${operation}-item`, path }
  }
  const ack = (mutation: CloudSyncUpsertMutation, sequence: number) =>
    ({ operation_id: mutation.operation_id, item_id: mutation.item_id, revision: 1, sequence })

  it('names an inline mutation by its place in the whole batch, with the direct upload that went before', async () => {
    const big = large('big', 'assets/photo.png')
    const kept = small('kept', 'inbox/Note.md')
    const refused = small('refused', '.zennotes/agent-edits/inbox/Note.md.json')
    const body = { mutations: [big, kept, refused] }
    const api = fakeApi({
      initiateUpload: async () => uploadInstruction(big, 'https://objects.example.test/upload'),
      completeUpload: async () => ({
        data: { id: 'upload-1', operation_id: big.operation_id, status: 'completed' as const, result: { acknowledged: [ack(big, 4)], conflicts: [], cursor: 4 } }
      }),
      // The inline request carries kept and refused; Cloud names its own index 1.
      mutate: async () => { throw validation({ 'mutations.1.path': [refusedText] }) }
    })

    const error = await mutateWithMobileDirectUploads(api, 'vault-1', body, async () => {}).catch((caught: unknown) => caught)

    assert.ok(error instanceof CloudSyncPathRefusedError)
    assert.deepEqual(error.refusal.indices, [2])
    assert.deepEqual(error.refusal.applied, { acknowledged: [ack(big, 4)], conflicts: [], cursor: 4 })
    assert.deepEqual(cloudSyncPathRefusal(error, body)?.indices, [2])
  })

  it('names a direct upload refused for its own path by its place in the batch, with what went before', async () => {
    const kept = small('kept', 'inbox/Note.md')
    const big = large('big', '.zennotes/agent-edits/assets/photo.png.json')
    const body = { mutations: [kept, big] }
    let uploaded = false
    const api = fakeApi({
      mutate: async () => ({ acknowledged: [ack(kept, 3)], conflicts: [], cursor: 3 }),
      initiateUpload: async () => { throw validation({ path: [refusedText] }) }
    })

    const error = await mutateWithMobileDirectUploads(api, 'vault-1', body, async () => { uploaded = true })
      .catch((caught: unknown) => caught)

    assert.ok(error instanceof CloudSyncPathRefusedError)
    assert.deepEqual(error.refusal.indices, [1])
    assert.deepEqual(error.refusal.applied, { acknowledged: [ack(kept, 3)], conflicts: [], cursor: 3 })
    assert.equal(uploaded, false)
  })

  it('stops as before when Cloud refuses anything but a path', async () => {
    const big = large('big', 'assets/photo.png')
    const other = small('other', 'inbox/Note.md')
    const original = validation({ 'mutations.0.base_revision': ['The base revision is invalid.'] })
    const api = fakeApi({
      initiateUpload: async () => uploadInstruction(big, 'https://objects.example.test/upload'),
      completeUpload: async () => ({
        data: { id: 'upload-1', operation_id: big.operation_id, status: 'completed' as const, result: { acknowledged: [ack(big, 4)], conflicts: [], cursor: 4 } }
      }),
      mutate: async () => { throw original }
    })

    const error = await mutateWithMobileDirectUploads(api, 'vault-1', { mutations: [big, other] }, async () => {})
      .catch((caught: unknown) => caught)

    assert.equal(error, original)
  })
})

describe('encrypted vaults', () => {
  const SIGNED_URL = 'https://objects.example.test/upload?signature=signed'

  it('seals a large file natively, sends only ciphertext under a path id, and discards the sealed copy', async () => {
    const { cipher, vaultKey } = await encryptedVault()
    const plaintext = Buffer.alloc(CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES + 70_000, 7)
    const files = new Map([['file:///vault/assets/photo.png', plaintext]])
    const log: string[] = []
    const mutation = fileBackedMutation('assets/photo.png', plaintext)
    rememberMobileUploadSource(mutation.content, 'file:///vault/assets/photo.png', nativeSealer(files, log))
    const sealedLength = zne1CiphertextLength(plaintext.length)
    let initiated: CloudSyncUploadRequest | undefined
    let sent: Buffer | undefined
    const uploads: MobileObjectUploadRequest[] = []

    const result = await mutateWithMobileDirectUploads(fakeApi({
      vaultCipher: async () => cipher,
      mutate: async () => assert.fail('a large encrypted file never goes inline'),
      initiateUpload: async (_vaultId, body) => {
        initiated = body
        return uploadInstruction(mutation, SIGNED_URL, sealedLength)
      },
      completeUpload: async () => completion(mutation)
    }), 'vault-1', { mutations: [mutation] }, async (upload) => {
      uploads.push(upload)
      sent = files.get(upload.uri!)
    })

    assert.deepEqual(result.acknowledged.map((ack) => ack.revision), [3])
    assert.ok(initiated && sent)
    assert.equal(initiated.path, await cipher.pathId('assets/photo.png'))
    assert.equal(initiated.kind, 'binary')
    assert.deepEqual(initiated.content, {
      encoding: 'aes-gcm', sha256: sha256(sent), byte_length: sealedLength, media_type: 'application/octet-stream'
    })
    const meta = await decryptItemMeta(initiated.meta!, {
      vaultKey, vaultKeyVersion: 1, pathId: initiated.path, pathIndex: await CloudPathIndex.forVaultKey(vaultKey)
    })
    assert.deepEqual([meta.path, meta.kind, meta.sha256, meta.byte_length], ['assets/photo.png', 'binary', sha256(plaintext), plaintext.length])
    assert.equal(uploads.length, 1)
    assert.equal(uploads[0]!.base64, undefined)
    assert.deepEqual([uploads[0]!.sha256, uploads[0]!.byteLength], [sha256(sent), sealedLength])
    const opened = await decryptZne1(sent, { parentKey: vaultKey, purpose: Zne1Purpose.content, keyVersion: 1 })
    assert.ok(Buffer.from(opened).equals(plaintext))
    assert.deepEqual(log, ['seal file:///vault/assets/photo.png', 'discard file:///vault/.zennotes/sync/uploads/0.zne1'])
  })

  it('decides inline or direct by the size an encrypted vault actually sends', async () => {
    const { cipher, vaultKey } = await encryptedVault()
    const plaintext = Buffer.alloc(CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES - 100, 3)
    assert.ok(zne1CiphertextLength(plaintext.length) > CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES)
    const mutation = { ...fileBackedMutation('assets/scan.pdf', plaintext), content: inlineContent(plaintext) }

    const inline: CloudSyncMutationRequest[] = []
    await mutateWithMobileDirectUploads(fakeApi({
      vaultCipher: async () => null,
      mutate: async (_vaultId, body) => { inline.push(body); return emptyResponse() }
    }), 'vault-1', { mutations: [mutation] }, async () => assert.fail('a readable vault sends this file inline'))
    assert.equal(inline.length, 1)

    let initiated: CloudSyncUploadRequest | undefined
    const uploads: MobileObjectUploadRequest[] = []
    await mutateWithMobileDirectUploads(fakeApi({
      vaultCipher: async () => cipher,
      mutate: async () => assert.fail('its ciphertext is over the inline cap'),
      initiateUpload: async (_vaultId, body) => {
        initiated = body
        return uploadInstruction(mutation, SIGNED_URL, zne1CiphertextLength(plaintext.length))
      },
      completeUpload: async () => completion(mutation)
    }), 'vault-1', { mutations: [mutation] }, async (upload) => { uploads.push(upload) })

    const sealed = Buffer.from(uploads[0]!.base64!, 'base64')
    assert.equal(sealed.length, zne1CiphertextLength(plaintext.length))
    assert.deepEqual([uploads[0]!.sha256, uploads[0]!.byteLength], [sha256(sealed), sealed.length])
    assert.equal(initiated?.content.sha256, sha256(sealed))
    const opened = await decryptZne1(sealed, { parentKey: vaultKey, purpose: Zne1Purpose.content, keyVersion: 1 })
    assert.ok(Buffer.from(opened).equals(plaintext))
  })

  it('refuses a file that changed after sync hashed it, before anything is sent', async () => {
    const { cipher } = await encryptedVault()
    const plaintext = Buffer.alloc(CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES + 1, 9)
    const files = new Map([['file:///vault/big.bin', plaintext]])
    const log: string[] = []
    const mutation = fileBackedMutation('big.bin', plaintext)
    const edited = (bytes: Buffer) => Buffer.concat([bytes.subarray(1), Buffer.from([1])])
    rememberMobileUploadSource(mutation.content, 'file:///vault/big.bin', nativeSealer(files, log, edited))

    await assert.rejects(
      mutateWithMobileDirectUploads(fakeApi({ vaultCipher: async () => cipher }), 'vault-1', { mutations: [mutation] },
        async () => assert.fail('nothing is uploaded')),
      (error: unknown) => error instanceof MobileDirectUploadError && error.code === 'DIRECT_UPLOAD_SIZE_MISMATCH'
    )
    assert.deepEqual(log, ['seal file:///vault/big.bin', 'discard file:///vault/.zennotes/sync/uploads/0.zne1'])
  })

  it('discards the sealed copy when the upload fails, and opens a conflict back to its real path', async () => {
    const { cipher } = await encryptedVault()
    const plaintext = Buffer.alloc(CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES + 1, 5)
    const files = new Map([['file:///vault/big.bin', plaintext]])
    const log: string[] = []
    const aborted: string[] = []
    const mutation = fileBackedMutation('big.bin', plaintext)
    rememberMobileUploadSource(mutation.content, 'file:///vault/big.bin', nativeSealer(files, log))

    await assert.rejects(mutateWithMobileDirectUploads(fakeApi({
      vaultCipher: async () => cipher,
      initiateUpload: async () => uploadInstruction(mutation, SIGNED_URL, zne1CiphertextLength(plaintext.length)),
      abortUpload: async (_vaultId, uploadId) => { aborted.push(uploadId) }
    }), 'vault-1', { mutations: [mutation] }, async () => {
      throw new MobileDirectUploadError('Object upload failed.', 503, 'DIRECT_UPLOAD_FAILED')
    }), /Object upload failed/)
    assert.deepEqual(aborted, ['upload-1'])
    assert.deepEqual(log.at(-1), 'discard file:///vault/.zennotes/sync/uploads/0.zne1')

    const other = await cipher.sealMeta('Other.png', 'binary', mutation.content)
    const result = await mutateWithMobileDirectUploads(fakeApi({
      vaultCipher: async () => cipher,
      initiateUpload: async () => {
        throw new MobileDirectUploadError('Path taken.', 409, 'PATH_CONFLICT', {
          current_revision: 4, current_path: other.pathId, current_meta: other.meta
        })
      }
    }), 'vault-1', { mutations: [mutation] }, async () => assert.fail('a conflict uploads nothing'))
    assert.deepEqual(result.conflicts.map((conflict) => [conflict.code, conflict.current_path]), [['PATH_CONFLICT', 'Other.png']])
    assert.deepEqual(log.at(-1), 'discard file:///vault/.zennotes/sync/uploads/1.zne1')
  })

  it('stops a locked encrypted vault before anything is sent', async () => {
    const bytes = Buffer.from('a note')
    await assert.rejects(
      mutateWithMobileDirectUploads(fakeApi({
        vaultCipher: async () => { throw new CloudE2eeLockedError() },
        mutate: async () => assert.fail('nothing is sent while locked')
      }), 'vault-1', { mutations: [{ ...fileBackedMutation('note.md', bytes), content: inlineContent(bytes) }] },
      async () => assert.fail('nothing is uploaded while locked')),
      { code: 'E2EE_LOCKED' }
    )
  })
})

async function encryptedVault() {
  const accountKey = generateCloudE2eeKey()
  const encryption = await CloudVaultCipher.prepareVault('Notes', accountKey, 1)
  return {
    cipher: await CloudVaultCipher.open({ id: 'vault-1', encryption }, accountKey, 1),
    vaultKey: await unwrapVaultKey(encryption.vault_key_envelope, accountKey, 1, encryption.key_id)
  }
}

/** What ZenDirectUpload.encryptFile does on the device, from the same three inputs. */
function nativeSeal(plaintext: Buffer, params: Zne1ChunkCipherParams): Buffer {
  const parts = [Buffer.from(params.header)]
  const chunks = Math.max(1, Math.ceil(plaintext.length / 65_536))
  for (let index = 0; index < chunks; index++) {
    const nonce = Buffer.alloc(12)
    nonce.writeUInt32BE(index, 7)
    nonce[11] = index === chunks - 1 ? 1 : 0
    const gcm = createCipheriv('aes-256-gcm', params.objectKey, nonce)
    gcm.setAAD(params.aad)
    parts.push(gcm.update(plaintext.subarray(index * 65_536, (index + 1) * 65_536)), gcm.final(), gcm.getAuthTag())
  }
  return Buffer.concat(parts)
}

function nativeSealer(files: Map<string, Buffer>, log: string[], read = (bytes: Buffer) => bytes): MobileUploadSealer {
  let count = 0
  return async (uri, params) => {
    const plaintext = read(files.get(uri)!)
    const sealed = nativeSeal(plaintext, params)
    const sealedUri = `file:///vault/.zennotes/sync/uploads/${count++}.zne1`
    files.set(sealedUri, sealed)
    log.push(`seal ${uri}`)
    return {
      uri: sealedUri, byteLength: sealed.length, sha256: sha256(sealed),
      plaintextByteLength: plaintext.length, plaintextSha256: sha256(plaintext),
      discard: async () => {
        log.push(`discard ${sealedUri}`)
        files.delete(sealedUri)
      }
    }
  }
}

function fileBackedMutation(path: string, bytes: Buffer): CloudSyncUpsertMutation {
  return {
    type: 'upsert', operation_id: 'operation-1', item_id: 'item-1', base_revision: null, path, kind: 'binary',
    content: { encoding: 'base64', data: '', sha256: sha256(bytes), byte_length: bytes.length, media_type: 'image/png' }
  }
}

function inlineContent(bytes: Buffer): CloudSyncUpsertMutation['content'] {
  return { encoding: 'base64', data: bytes.toString('base64'), sha256: sha256(bytes), byte_length: bytes.length, media_type: 'application/pdf' }
}

function completion(mutation: CloudSyncUpsertMutation) {
  return {
    data: {
      id: 'upload-1', operation_id: mutation.operation_id, status: 'completed' as const,
      result: { acknowledged: [{ operation_id: mutation.operation_id, item_id: mutation.item_id, revision: 3, sequence: 9 }], conflicts: [], cursor: 9 }
    }
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function fakeApi(overrides: Partial<MobileDirectUploadApi>): MobileDirectUploadApi {
  return {
    mutate: async () => emptyResponse(),
    initiateUpload: async () => {
      throw new Error('Unexpected initiateUpload call')
    },
    completeUpload: async () => {
      throw new Error('Unexpected completeUpload call')
    },
    abortUpload: async () => {},
    ...overrides
  }
}

function emptyResponse(): CloudSyncMutationResponse {
  return { acknowledged: [], conflicts: [], cursor: 0 }
}

function upsertMutation(byteLength: number, data: string): CloudSyncUpsertMutation {
  return {
    type: 'upsert',
    operation_id: 'operation-1',
    item_id: 'item-1',
    base_revision: null,
    path: 'assets/photo.png',
    kind: 'binary',
    content: {
      encoding: 'base64',
      data,
      sha256: 'a'.repeat(64),
      byte_length: byteLength,
      media_type: 'image/png'
    }
  }
}

function uploadInstruction(mutation: CloudSyncUpsertMutation, url: string, expectedBytes = mutation.content.byte_length) {
  return {
    data: {
      id: 'upload-1',
      operation_id: mutation.operation_id,
      status: 'uploading' as const,
      expected_bytes: expectedBytes,
      expires_at: '2026-08-26T18:30:00.000Z',
      upload: {
        method: 'PUT' as const,
        url,
        headers: {
          'Content-Type': mutation.content.media_type,
          'Content-Length': String(mutation.content.byte_length)
        }
      }
    }
  }
}
