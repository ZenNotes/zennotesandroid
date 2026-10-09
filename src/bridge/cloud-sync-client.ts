import { CapacitorHttp, registerPlugin } from '@capacitor/core'
import {
  CloudSyncApiClient,
  cloudSyncRateLimits,
  type CloudSyncResponseHeaders,
  type CloudSyncHttpRequest,
  type CloudSyncHttpTransport
} from '@zennotes/shared-domain/cloud-sync-api'
import type {
  CloudSyncMutationRequest,
  CloudSyncMutationResponse
} from '@zennotes/bridge-contract/cloud-sync'
import {
  MobileDirectUploadError,
  mutateWithMobileDirectUploads,
  type MobileObjectUpload
} from './mobile-direct-upload'

let requestLifetime = new AbortController()

export function mobileCloudRequestSignal(): AbortSignal {
  return requestLifetime.signal
}

export function stopMobileCloudRequests(): void {
  requestLifetime.abort()
  cloudSyncRateLimits.cancelAll()
}

export function resumeMobileCloudRequests(): void {
  if (requestLifetime.signal.aborted) requestLifetime = new AbortController()
}

export class CloudServiceRequestError extends Error {
  readonly status: number
  readonly code: string | null
  readonly details: Record<string, unknown> | null

  constructor(
    message: string,
    status: number,
    code: string | null,
    details: Record<string, unknown> | null = null,
    readonly headers: CloudSyncResponseHeaders = {}
  ) {
    super(message)
    this.name = 'CloudServiceRequestError'
    this.status = status
    this.code = code
    this.details = details
  }
}

export function createCloudSyncClient(baseUrl: string, token: string, options: { accountId: string; signal?: AbortSignal }): CloudSyncApiClient {
  const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, '')
  const lifetime = options.signal ?? requestLifetime.signal
  const transport: CloudSyncHttpTransport = {
    async request<Response>(request: CloudSyncHttpRequest): Promise<Response> {
      const multipart = request.body instanceof FormData
      const response = await CapacitorHttp.request({
        method: request.method,
        url: `${normalizedBaseUrl}${request.path}`,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          ...(multipart
            ? { 'Content-Type': 'multipart/form-data' }
            : request.body === undefined
              ? {}
              : { 'Content-Type': 'application/json' })
        },
        data: request.body instanceof FormData
          ? await serializeFormData(request.body)
          : request.body,
        ...(multipart ? { dataType: 'formData' as const } : {}),
        connectTimeout: 30_000,
        // Attachment-heavy first syncs legitimately take longer on mobile.
        // A short timeout repeatedly retries the same batch without progress.
        readTimeout: request.timeoutMs ?? 300_000
      })

      if (response.status < 200 || response.status >= 300) {
        const error = response.data?.error
        const validationMessage = firstValidationMessage(response.data?.errors)
        throw new CloudServiceRequestError(
          validationMessage ?? (typeof error?.message === 'string'
            ? error.message
            : typeof response.data?.message === 'string'
              ? response.data.message
              : `ZenNotes Cloud request failed (${response.status}).`),
          response.status,
          typeof error?.code === 'string' ? error.code : null,
          isRecord(error?.details) ? error.details : null,
          response.headers ?? {}
        )
      }

      if (typeof response.data === 'string') {
        if (response.data === '') return undefined as Response
        try {
          return JSON.parse(response.data) as Response
        } catch {
          throw new CloudServiceRequestError(
            'ZenNotes Cloud returned an unexpected response.',
            response.status,
            null
          )
        }
      }
      return response.data as Response
    }
  }

  const loopback = /^http:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/.test(normalizedBaseUrl)
  return new MobileCloudSyncApiClient(cloudSyncRateLimits.wrap(transport, {
    baseUrl: normalizedBaseUrl, accountId: options.accountId, signal: lifetime
  }), async (request) => {
    if (lifetime.aborted) throw new DOMException('Cloud request cancelled.', 'AbortError')
    await uploadObject(request)
    if (lifetime.aborted) throw new DOMException('Cloud request cancelled.', 'AbortError')
  }, {
    // Streaming host: large revisions arrive as references and are downloaded
    // natively into staging, never as base64 through the WebView bridge.
    contentReferences: true,
    accountScope: { baseUrl: normalizedBaseUrl, accountId: options.accountId },
    signal: lifetime,
    bootstrapContentPageBytes: 1024 * 1024,
    allowInsecureLoopbackDownloads: loopback
  })
}

class MobileCloudSyncApiClient extends CloudSyncApiClient {
  constructor(
    http: CloudSyncHttpTransport,
    private readonly uploadObject: MobileObjectUpload,
    options: ConstructorParameters<typeof CloudSyncApiClient>[1]
  ) {
    super(http, options)
  }

  override async mutate(
    vaultId: string,
    body: CloudSyncMutationRequest
  ): Promise<CloudSyncMutationResponse> {
    return mutateWithMobileDirectUploads(
      {
        mutate: (nextVaultId, nextBody) => super.mutate(nextVaultId, nextBody),
        initiateUpload: (nextVaultId, nextBody) => super.initiateUpload(nextVaultId, nextBody),
        completeUpload: (nextVaultId, uploadId) => super.completeUpload(nextVaultId, uploadId),
        abortUpload: (nextVaultId, uploadId) => super.abortUpload(nextVaultId, uploadId)
      },
      vaultId,
      body,
      this.uploadObject
    )
  }
}

const DirectUpload = registerPlugin<{
  put(options: {
    url: string
    headers: Record<string, string>
    base64?: string
    uri?: string
    sha256?: string
    byteLength: number
  }): Promise<{ status: number }>
}>('ZenDirectUpload')

export const uploadObject: MobileObjectUpload = async (request) => {
  let response: { status: number }
  try {
    response = await DirectUpload.put({
      url: request.url,
      headers: request.headers,
      base64: request.base64,
      uri: request.uri,
      sha256: request.sha256,
      byteLength: request.byteLength
    })
  } catch {
    throw new MobileDirectUploadError(
      'ZenNotes could not reach Cloud object storage. Check your connection and try again.',
      0,
      'DIRECT_UPLOAD_FAILED'
    )
  }
  if (response.status < 200 || response.status >= 300) {
    throw new MobileDirectUploadError(
      `ZenNotes Cloud object upload failed (${response.status}).`,
      response.status,
      'DIRECT_UPLOAD_FAILED'
    )
  }
}

function firstValidationMessage(errors: unknown): string | null {
  if (!errors || typeof errors !== 'object') return null

  for (const messages of Object.values(errors)) {
    if (Array.isArray(messages)) {
      const message = messages.find((candidate): candidate is string => typeof candidate === 'string')
      if (message) return message
    }
  }

  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function serializeFormData(form: FormData): Promise<Array<{
  key: string
  value: string
  type: 'base64File' | 'string'
  contentType?: string
  fileName?: string
}>> {
  const entries = []
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') {
      entries.push({ key, value, type: 'string' as const })
      continue
    }
    entries.push({
      key,
      value: bytesToBase64(new Uint8Array(await value.arrayBuffer())),
      type: 'base64File' as const,
      contentType: value.type || 'application/octet-stream',
      fileName: value.name
    })
  }
  return entries
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}
