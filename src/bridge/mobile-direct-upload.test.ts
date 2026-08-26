import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type {
  CloudSyncMutationRequest,
  CloudSyncMutationResponse,
  CloudSyncUpsertMutation
} from '@zennotes/bridge-contract/cloud-sync'
import {
  CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES,
  MobileDirectUploadError,
  mobileObjectUploadOptions,
  mutateWithMobileDirectUploads,
  type MobileDirectUploadApi,
  type MobileObjectUpload
} from './mobile-direct-upload.ts'

describe('mutateWithMobileDirectUploads', () => {
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

function uploadInstruction(mutation: CloudSyncUpsertMutation, url: string) {
  return {
    data: {
      id: 'upload-1',
      operation_id: mutation.operation_id,
      status: 'uploading' as const,
      expected_bytes: mutation.content.byte_length,
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
