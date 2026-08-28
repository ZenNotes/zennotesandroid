import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'

const baseUrl = requiredUrl('ZENNOTES_CLOUD_E2E_BASE_URL')
const token = required('ZENNOTES_CLOUD_E2E_TOKEN')
const byteLength = 6 * 1024 * 1024
const bytes = Buffer.allocUnsafe(byteLength)
for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251

const sha256 = createHash('sha256').update(bytes).digest('hex')
const itemId = randomUUID()
const operationId = randomUUID()
const path = `assets/mobile-direct-upload-${Date.now()}.bin`
let vaultId = null
let uploadId = null
let completed = false

try {
  await api('/api/v1/account')

  const vault = await api('/api/v1/vaults', {
    method: 'POST',
    body: { name: `Mobile CI ${new Date().toISOString()}` }
  })
  vaultId = requiredString(vault?.data?.id, 'temporary vault id')

  const initiation = await api(`/api/v1/vaults/${encodeURIComponent(vaultId)}/uploads`, {
    method: 'POST',
    body: {
      operation_id: operationId,
      item_id: itemId,
      base_revision: null,
      path,
      kind: 'binary',
      content: {
        encoding: 'base64',
        sha256,
        byte_length: bytes.length,
        media_type: 'application/octet-stream'
      }
    }
  })

  uploadId = requiredString(initiation?.data?.id, 'upload session id')
  assert.equal(initiation?.data?.expected_bytes, bytes.length)
  assert.equal(initiation?.data?.upload?.method, 'PUT')
  const uploadUrl = secureUploadUrl(initiation?.data?.upload?.url)
  const uploadHeaders = stringHeaders(initiation?.data?.upload?.headers)
  assert.equal(hasAuthorizationHeader(uploadHeaders), false)

  const objectResponse = await fetch(uploadUrl, {
    method: 'PUT',
    headers: uploadHeaders,
    body: bytes,
    redirect: 'error',
    signal: AbortSignal.timeout(300_000)
  })
  assert.equal(objectResponse.ok, true, `object upload failed (${objectResponse.status})`)

  const completion = await api(
    `/api/v1/vaults/${encodeURIComponent(vaultId)}/uploads/${encodeURIComponent(uploadId)}/complete`,
    { method: 'POST', timeoutMs: 300_000 }
  )
  assert.equal(completion?.data?.status, 'completed')
  assert.equal(completion?.data?.result?.conflicts?.length, 0)
  assert.equal(completion?.data?.result?.acknowledged?.[0]?.item_id, itemId)
  completed = true

  const manifest = await api(
    `/api/v1/vaults/${encodeURIComponent(vaultId)}/manifest?per_page=100`
  )
  const item = manifest?.data?.find?.((candidate) => candidate?.item_id === itemId)
  assert.ok(item, 'uploaded item missing from manifest')
  assert.equal(item.path, path)
  assert.equal(item.kind, 'binary')
  assert.equal(item.byte_length, bytes.length)
  assert.equal(item.sha256, sha256)

  console.log(`Cloud direct-upload smoke test passed (${bytes.length} bytes).`)
} finally {
  if (vaultId && uploadId && !completed) {
    await api(
      `/api/v1/vaults/${encodeURIComponent(vaultId)}/uploads/${encodeURIComponent(uploadId)}`,
      { method: 'DELETE' }
    ).catch(() => {})
  }
  if (vaultId) {
    await api(`/api/v1/vaults/${encodeURIComponent(vaultId)}`, {
      method: 'DELETE'
    }).catch((error) => {
      console.error(`Could not remove temporary Cloud E2E vault: ${error.message}`)
      process.exitCode = 1
    })
  }
}

async function api(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method ?? 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: 'error',
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000)
  })
  const text = await response.text()
  const payload = text === '' ? null : JSON.parse(text)
  if (!response.ok) {
    const code = payload?.error?.code ? ` ${payload.error.code}` : ''
    throw new Error(`Cloud API request failed (${response.status}${code}).`)
  }
  return payload
}

function required(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}

function requiredUrl(name) {
  const url = new URL(required(name))
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw new Error(`${name} must use HTTPS.`)
  }
  url.pathname = url.pathname.replace(/\/+$/, '')
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/+$/, '')
}

function secureUploadUrl(value) {
  const url = new URL(requiredString(value, 'signed upload URL'))
  if (url.username || url.password || url.protocol !== 'https:') {
    throw new Error('Cloud returned an unsafe signed upload URL.')
  }
  return url.toString()
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Cloud response is missing ${label}.`)
  }
  return value
}

function stringHeaders(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Cloud response has invalid signed upload headers.')
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, headerValue]) => [
      key,
      requiredString(headerValue, `signed header ${key}`)
    ])
  )
}

function hasAuthorizationHeader(headers) {
  return Object.keys(headers).some((name) => name.toLowerCase() === 'authorization')
}
