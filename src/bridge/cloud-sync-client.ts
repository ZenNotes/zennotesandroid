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
  CloudSyncMutationResponse,
  CloudSyncVaultCollection
} from '@zennotes/bridge-contract/cloud-sync'
import type { CloudE2eeKeyring } from '@zennotes/shared-domain/cloud-e2ee-account'
import { ENCRYPTED_VAULT_PLACEHOLDER_NAME } from '@zennotes/shared-domain/cloud-e2ee-vault'
import {
  CLOUD_CONNECT_TIMEOUT_MS,
  CLOUD_STALL_TIMEOUT_MS,
  CLOUD_TRANSPORT_RETRY_DELAYS_MS,
  CloudSyncTransportError,
  retryCloudTransfer
} from '@zennotes/shared-domain/cloud-sync-stall'
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

export interface MobileCloudSyncClientOptions {
  accountId: string
  signal?: AbortSignal
  /**
   * Turns on end-to-end encryption: the client tells the service it may serve
   * encrypted vaults and opens them with this keyring's ciphers. Only a host
   * that seals and opens every path an encrypted vault's bytes take may pass it.
   */
  keyring?: CloudE2eeKeyring
}

export function createCloudSyncClient(baseUrl: string, token: string, options: MobileCloudSyncClientOptions): CloudSyncApiClient {
  const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, '')
  const lifetime = options.signal ?? requestLifetime.signal
  const transport: CloudSyncHttpTransport = {
    async request<Response>(request: CloudSyncHttpRequest): Promise<Response> {
      const multipart = request.body instanceof FormData
      const response = await CapacitorHttp.request({
        method: request.method,
        url: `${normalizedBaseUrl}${request.path}`,
        headers: {
          ...request.headers,
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
        connectTimeout: CLOUD_CONNECT_TIMEOUT_MS,
        // Android's read timeout starts over with every byte that arrives, so
        // this is how long a request may go silent, not how long it may take:
        // a big page on a slow link keeps going as long as bytes move. A
        // request that waits on the service's own work says so in timeoutMs.
        readTimeout: request.timeoutMs ?? CLOUD_STALL_TIMEOUT_MS
      }).catch((error: unknown) => { throw unanswered(error) })

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
          errorDetails(error?.details, response.data?.errors),
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
    baseUrl: normalizedBaseUrl, accountId: options.accountId, signal: lifetime,
    transportRetryDelaysMs: CLOUD_TRANSPORT_RETRY_DELAYS_MS
  }), async (request) => {
    if (lifetime.aborted) throw new DOMException('Cloud request cancelled.', 'AbortError')
    // The same bytes to the same object: a PUT that got no answer is safe to send again.
    await retryCloudTransfer(() => uploadObject(request), { signal: lifetime, isTransportFailure: unansweredUpload })
    if (lifetime.aborted) throw new DOMException('Cloud request cancelled.', 'AbortError')
  }, {
    // Streaming host: large revisions arrive as references and are downloaded
    // natively into staging, never as base64 through the WebView bridge.
    contentReferences: true,
    accountScope: { baseUrl: normalizedBaseUrl, accountId: options.accountId },
    signal: lifetime,
    bootstrapContentPageBytes: 1024 * 1024,
    allowInsecureLoopbackDownloads: loopback,
    ...(options.keyring ? { endToEndEncryption: true, vaultCiphers: options.keyring } : {})
  }, options.keyring)
}

class MobileCloudSyncApiClient extends CloudSyncApiClient {
  constructor(
    http: CloudSyncHttpTransport,
    private readonly uploadObject: MobileObjectUpload,
    options: ConstructorParameters<typeof CloudSyncApiClient>[1],
    private readonly keyring?: CloudE2eeKeyring
  ) {
    super(http, options)
  }

  /**
   * An encrypted vault's real name is sealed: show it when this device is
   * unlocked, and the placeholder the service stores otherwise.
   */
  override async listVaults(): Promise<CloudSyncVaultCollection> {
    const response = await super.listVaults()
    const keyring = this.keyring
    if (!keyring) return response
    return {
      ...response,
      data: await Promise.all(response.data.map(async (vault) => {
        if (!vault.encryption) return vault
        try {
          return { ...vault, name: await keyring.vaultName(vault) }
        } catch {
          return { ...vault, name: ENCRYPTED_VAULT_PLACEHOLDER_NAME }
        }
      }))
    }
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
        abortUpload: (nextVaultId, uploadId) => super.abortUpload(nextVaultId, uploadId),
        vaultCipher: (nextVaultId) => this.vaultCipher(nextVaultId)
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

/**
 * CapacitorHttp resolves any HTTP answer, error statuses included, so a
 * rejection means none came: the request stalled past its read timeout, the
 * connection dropped, or it never opened. Android names the Java exception
 * in `code`.
 */
function unanswered(error: unknown): CloudSyncTransportError {
  const { message, code } = (error ?? {}) as { message?: unknown; code?: unknown }
  const name = typeof code === 'string' && code ? code : null
  return new CloudSyncTransportError(
    typeof message === 'string' && message ? message : 'ZenNotes Cloud did not answer.',
    { code: name, stalled: name === 'SocketTimeoutException', cause: error }
  )
}

/** The object store never answered the PUT (a status means it did). */
function unansweredUpload(error: unknown): boolean {
  return error instanceof MobileDirectUploadError && error.status === 0 && error.code === 'DIRECT_UPLOAD_FAILED'
}

/** The answer's error details, with a 422's field errors kept under
 *  `details.errors`: which field Cloud refused (`mutations.3.path`) is only in
 *  those keys, and sync needs it to set one refused path aside instead of
 *  stopping the whole run (#1004, core 2.80; desktop's asErrorPayload). */
export function errorDetails(details: unknown, errors: unknown): Record<string, unknown> | null {
  const kept = isRecord(details) ? details : null
  const fields = isRecord(errors) ? errors : null
  return kept || fields ? { ...kept, ...(fields ? { errors: fields } : {}) } : null
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
