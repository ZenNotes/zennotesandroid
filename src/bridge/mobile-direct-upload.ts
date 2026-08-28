import type {
  CloudSyncCapacityConflict,
  CloudSyncConflict,
  CloudSyncConflictCode,
  CloudSyncMutation,
  CloudSyncMutationRequest,
  CloudSyncMutationResponse,
  CloudSyncUpsertMutation,
  CloudSyncUploadCompletionResponse,
  CloudSyncUploadInitiationResponse,
  CloudSyncUploadRequest
} from '@zennotes/bridge-contract/cloud-sync'

export const CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES = 5 * 1024 * 1024

const DIRECT_UPLOAD_COMPLETION_ATTEMPTS = 3
const SYNC_CONFLICT_CODES = new Set<CloudSyncConflictCode>([
  'REVISION_CONFLICT',
  'PATH_CONFLICT',
  'ITEM_DELETED',
  'QUOTA_EXCEEDED',
  'CAPACITY_EXCEEDED',
  'FILE_SIZE_LIMIT_EXCEEDED'
])

export interface MobileDirectUploadApi {
  mutate(vaultId: string, body: CloudSyncMutationRequest): Promise<CloudSyncMutationResponse>
  initiateUpload(
    vaultId: string,
    body: CloudSyncUploadRequest
  ): Promise<CloudSyncUploadInitiationResponse>
  completeUpload(vaultId: string, uploadId: string): Promise<CloudSyncUploadCompletionResponse>
  abortUpload(vaultId: string, uploadId: string): Promise<void>
}

export interface MobileObjectUploadRequest {
  url: string
  method: 'PUT'
  headers: Record<string, string>
  base64: string
  byteLength: number
}

export type MobileObjectUpload = (request: MobileObjectUploadRequest) => Promise<void>

export interface MobileObjectUploadOptions {
  url: string
  method: 'PUT'
  headers: Record<string, string>
  data: string
  dataType: 'file'
  connectTimeout: number
  readTimeout: number
  disableRedirects: true
}

export function mobileObjectUploadOptions(
  request: MobileObjectUploadRequest
): MobileObjectUploadOptions {
  return {
    url: request.url,
    method: request.method,
    headers: request.headers,
    data: request.base64,
    dataType: 'file',
    connectTimeout: 30_000,
    readTimeout: 300_000,
    disableRedirects: true
  }
}

export class MobileDirectUploadError extends Error {
  readonly status: number
  readonly code: string | null
  readonly details: Record<string, unknown> | null

  constructor(
    message: string,
    status: number,
    code: string | null,
    details: Record<string, unknown> | null = null
  ) {
    super(message)
    this.name = 'MobileDirectUploadError'
    this.status = status
    this.code = code
    this.details = details
  }
}

export async function mutateWithMobileDirectUploads(
  api: MobileDirectUploadApi,
  vaultId: string,
  body: CloudSyncMutationRequest,
  uploadObject: MobileObjectUpload
): Promise<CloudSyncMutationResponse> {
  if (!body.mutations.some(usesDirectUpload)) return api.mutate(vaultId, body)

  const responses: CloudSyncMutationResponse[] = []
  let inlineMutations: CloudSyncMutation[] = []
  const flushInline = async (): Promise<void> => {
    if (inlineMutations.length === 0) return
    responses.push(await api.mutate(vaultId, { mutations: inlineMutations }))
    inlineMutations = []
  }

  for (const mutation of body.mutations) {
    if (usesDirectUpload(mutation)) {
      await flushInline()
      responses.push(await directUpload(api, vaultId, mutation, uploadObject))
    } else {
      inlineMutations.push(mutation)
    }
  }
  await flushInline()

  return {
    acknowledged: responses.flatMap((response) => response.acknowledged),
    conflicts: responses.flatMap((response) => response.conflicts),
    cursor: Math.max(0, ...responses.map((response) => response.cursor))
  }
}

function usesDirectUpload(mutation: CloudSyncMutation): mutation is CloudSyncUpsertMutation {
  return mutation.type === 'upsert' &&
    mutation.content.byte_length > CLOUD_SYNC_INLINE_UPLOAD_LIMIT_BYTES
}

async function directUpload(
  api: MobileDirectUploadApi,
  vaultId: string,
  mutation: CloudSyncUpsertMutation,
  uploadObject: MobileObjectUpload
): Promise<CloudSyncMutationResponse> {
  const base64 = uploadBase64(mutation)
  let initiation: CloudSyncUploadInitiationResponse

  try {
    initiation = await api.initiateUpload(vaultId, uploadRequest(mutation))
  } catch (error) {
    const conflict = directUploadConflict(error, mutation)
    if (conflict) return { acknowledged: [], conflicts: [conflict], cursor: 0 }
    throw error
  }

  let instruction: CloudSyncUploadInitiationResponse['data']
  try {
    instruction = directUploadInstruction(initiation, mutation)
  } catch (error) {
    const uploadId = uploadSessionId(initiation)
    if (uploadId) await abortQuietly(api, vaultId, uploadId)
    throw error
  }

  try {
    await uploadObject({
      url: secureDirectUploadUrl(instruction.upload.url),
      method: instruction.upload.method,
      headers: instruction.upload.headers,
      base64,
      byteLength: mutation.content.byte_length
    })
  } catch (error) {
    await abortQuietly(api, vaultId, instruction.id)
    throw error
  }

  return completeDirectUpload(api, vaultId, instruction.id, mutation)
}

async function completeDirectUpload(
  api: MobileDirectUploadApi,
  vaultId: string,
  uploadId: string,
  mutation: CloudSyncUpsertMutation
): Promise<CloudSyncMutationResponse> {
  for (let attempt = 1; attempt <= DIRECT_UPLOAD_COMPLETION_ATTEMPTS; attempt++) {
    try {
      return (await api.completeUpload(vaultId, uploadId)).data.result
    } catch (error) {
      const conflict = directUploadConflict(error, mutation)
      if (conflict) return { acknowledged: [], conflicts: [conflict], cursor: 0 }
      if (attempt === DIRECT_UPLOAD_COMPLETION_ATTEMPTS || !retryableCompletionError(error)) {
        throw error
      }
    }
  }
  throw new Error('ZenNotes Cloud upload completion ended unexpectedly.')
}

async function abortQuietly(
  api: MobileDirectUploadApi,
  vaultId: string,
  uploadId: string
): Promise<void> {
  await api.abortUpload(vaultId, uploadId).catch(() => {})
}

function uploadRequest(mutation: CloudSyncUpsertMutation): CloudSyncUploadRequest {
  return {
    operation_id: mutation.operation_id,
    item_id: mutation.item_id,
    base_revision: mutation.base_revision,
    path: mutation.path,
    kind: mutation.kind,
    content: {
      encoding: mutation.content.encoding,
      sha256: mutation.content.sha256,
      byte_length: mutation.content.byte_length,
      media_type: mutation.content.media_type
    }
  }
}

function uploadBase64(mutation: CloudSyncUpsertMutation): string {
  if (mutation.content.encoding === 'utf8') {
    const bytes = new TextEncoder().encode(mutation.content.data)
    if (bytes.byteLength !== mutation.content.byte_length) throw directUploadSizeMismatch()
    return bytesToBase64(bytes)
  }

  const normalized = mutation.content.data.includes(',')
    ? mutation.content.data.slice(mutation.content.data.indexOf(',') + 1).replace(/\s/g, '')
    : mutation.content.data.replace(/\s/g, '')
  if (!validBase64(normalized) || decodedBase64Length(normalized) !== mutation.content.byte_length) {
    throw directUploadSizeMismatch()
  }
  return normalized
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 32_768
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

function validBase64(value: string): boolean {
  if (value.length % 4 !== 0) return false
  const paddingStart = value.indexOf('=')
  const contentEnd = paddingStart < 0 ? value.length : paddingStart
  const padding = value.length - contentEnd
  if (padding > 2 || (padding > 0 && contentEnd < value.length - 2)) return false

  for (let index = 0; index < contentEnd; index++) {
    const code = value.charCodeAt(index)
    const valid =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47
    if (!valid) return false
  }
  for (let index = contentEnd; index < value.length; index++) {
    if (value.charCodeAt(index) !== 61) return false
  }
  return true
}

function decodedBase64Length(value: string): number {
  if (value === '') return 0
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return (value.length / 4) * 3 - padding
}

function directUploadInstruction(
  initiation: CloudSyncUploadInitiationResponse,
  mutation: CloudSyncUpsertMutation
): CloudSyncUploadInitiationResponse['data'] {
  const candidate = initiation as unknown as { data?: unknown }
  if (!isRecord(candidate.data)) throw invalidDirectUploadResponse()
  const data = candidate.data
  if (!isRecord(data.upload)) throw invalidDirectUploadResponse()
  const upload = data.upload
  if (
    data.operation_id !== mutation.operation_id ||
    data.expected_bytes !== mutation.content.byte_length ||
    typeof data.id !== 'string' ||
    data.id === '' ||
    upload.method !== 'PUT' ||
    typeof upload.url !== 'string' ||
    !isRecord(upload.headers) ||
    !Object.values(upload.headers).every((value) => typeof value === 'string')
  ) {
    throw invalidDirectUploadResponse()
  }
  return data as unknown as CloudSyncUploadInitiationResponse['data']
}

function uploadSessionId(initiation: CloudSyncUploadInitiationResponse): string | null {
  const candidate = initiation as unknown as { data?: unknown }
  return isRecord(candidate.data) && typeof candidate.data.id === 'string' && candidate.data.id !== ''
    ? candidate.data.id
    : null
}

function secureDirectUploadUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw insecureDirectUploadUrl()
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const loopback = hostname === 'localhost' || hostname === '::1' || hostname.startsWith('127.')
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password
  ) {
    throw insecureDirectUploadUrl()
  }
  return url.href
}

function directUploadConflict(
  error: unknown,
  mutation: CloudSyncUpsertMutation
): CloudSyncConflict | null {
  if (!isServiceError(error) || error.status !== 409 || !error.code) return null
  if (!SYNC_CONFLICT_CODES.has(error.code as CloudSyncConflictCode)) return null
  const capacity = capacityConflictDetails(error.details)
  return {
    operation_id: mutation.operation_id,
    item_id: mutation.item_id,
    code: error.code as CloudSyncConflictCode,
    current_revision:
      typeof error.details?.current_revision === 'number' ? error.details.current_revision : null,
    current_path:
      typeof error.details?.current_path === 'string' ? error.details.current_path : null,
    ...(capacity ? { capacity } : {})
  }
}

function capacityConflictDetails(
  details: Record<string, unknown> | null
): CloudSyncCapacityConflict | null {
  if (
    !details ||
    typeof details.dimension !== 'string' ||
    typeof details.used !== 'number' ||
    typeof details.reserved !== 'number' ||
    typeof details.limit !== 'number' ||
    typeof details.projected !== 'number' ||
    typeof details.can_retry_after_reduction !== 'boolean'
  ) return null
  return details as unknown as CloudSyncCapacityConflict
}

function isServiceError(error: unknown): error is {
  status: number
  code: string | null
  details: Record<string, unknown> | null
} {
  return error instanceof Error &&
    typeof (error as { status?: unknown }).status === 'number' &&
    ((error as { code?: unknown }).code === null || typeof (error as { code?: unknown }).code === 'string')
}

function retryableCompletionError(error: unknown): boolean {
  return !isServiceError(error) || error.status >= 500
}

function directUploadSizeMismatch(): MobileDirectUploadError {
  return new MobileDirectUploadError(
    'The local file changed while ZenNotes was preparing its Cloud upload.',
    0,
    'DIRECT_UPLOAD_SIZE_MISMATCH'
  )
}

function invalidDirectUploadResponse(): MobileDirectUploadError {
  return new MobileDirectUploadError(
    'ZenNotes Cloud returned an invalid object upload instruction.',
    0,
    'INVALID_DIRECT_UPLOAD_RESPONSE'
  )
}

function insecureDirectUploadUrl(): MobileDirectUploadError {
  return new MobileDirectUploadError(
    'ZenNotes Cloud returned an insecure object upload URL.',
    0,
    'INSECURE_DIRECT_UPLOAD_URL'
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
