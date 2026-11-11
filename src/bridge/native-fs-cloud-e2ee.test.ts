import assert from 'node:assert/strict'
import { createDecipheriv, createHash } from 'node:crypto'
import { it } from 'node:test'
import { generateCloudE2eeKey } from '@zennotes/shared-domain/cloud-e2ee'
import { CloudVaultCipher } from '@zennotes/shared-domain/cloud-e2ee-vault'
import { loadMobileModule } from '../../tooling/load-mobile-module.ts'

const params = {
  header: new Uint8Array(74).fill(1),
  objectKey: new Uint8Array(32).fill(2),
  aad: new Uint8Array(32).fill(3)
}
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')
/** What the package hands sealForUpload: the same three, in base64. */
const sealKeys = { header: base64(params.header), objectKey: base64(params.objectKey), aad: base64(params.aad) }

/** A local-tier NativeFs whose ZenDirectUpload calls go to `plugin`. */
async function nativeFs(plugin: Record<string, unknown>) {
  const files = new Map<string, Buffer>()
  const uri = (path: string) => `file:///data/${path}`
  const missing = () => Object.assign(new Error('Not found'), { code: 'OS-PLUG-FILE-0008' })
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null } })
  try {
    const { NativeFs } = await loadMobileModule('./src/bridge/native-fs', {
      './icloud': { ensureDownloaded: async () => {} },
      '@capacitor/core': { Capacitor: {}, registerPlugin: (name: string) => name === 'SafFs' ? {} : plugin },
      '@capacitor/filesystem': {
        Directory: { Data: 'DATA', External: 'EXTERNAL' }, Encoding: { UTF8: 'utf8' },
        Filesystem: {
          stat: async ({ path }: { path: string }) => {
            const file = files.get(path)
            if (!file) throw missing()
            return { type: 'file', uri: uri(path), mtime: 1, size: file.length }
          },
          writeFile: async ({ path, data }: { path: string; data: string }) => { files.set(path, Buffer.from(data, 'base64')) },
          deleteFile: async ({ path }: { path: string }) => { files.delete(path) },
          mkdir: async () => {},
          getUri: async ({ path }: { path: string }) => ({ uri: uri(path) }),
          readFile: () => assert.fail('File bytes must not cross the bridge')
        }
      }
    })
    return { fs: new NativeFs('Test'), files, uri }
  } finally {
    if (storage) Object.defineProperty(globalThis, 'localStorage', storage)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
}

it('seals into a fresh private file under .zennotes/sync/uploads, and removes it when sealing fails', async () => {
  const requests: unknown[] = []
  let refuse = false
  const h = await nativeFs({
    encryptFile: async (request: unknown) => {
      requests.push(request)
      if (refuse) throw new Error('Cloud file encryption failed.')
      return { byteLength: 106, sha256: 'b'.repeat(64), plaintextByteLength: 16, plaintextSha256: 'c'.repeat(64) }
    }
  })
  const sealed = await h.fs.sealForUpload('file:///data/ZenNotes/Test/big.bin', sealKeys)
  const [path] = [...h.files.keys()]
  assert.match(path!, /^ZenNotes\/Test\/\.zennotes\/sync\/uploads\/[0-9a-f-]{36}\.zne1$/)
  assert.deepEqual(requests, [{
    source: 'file:///data/ZenNotes/Test/big.bin', destination: h.uri(path!),
    header: base64(params.header), objectKey: base64(params.objectKey), aad: base64(params.aad)
  }])
  assert.deepEqual([sealed.uri, sealed.byteLength, sealed.plaintextByteLength], [h.uri(path!), 106, 16])
  await sealed.discard()
  assert.equal(h.files.size, 0)

  refuse = true
  await assert.rejects(h.fs.sealForUpload('file:///data/ZenNotes/Test/big.bin', sealKeys), /encryption failed/)
  assert.equal(h.files.size, 0)
})

it('reads a staged file\'s header without reading the rest', async () => {
  const h = await nativeFs({
    readHeader: async ({ source, length }: { source: string; length: number }) => {
      assert.equal(source, h.uri('ZenNotes/Test/.zennotes/sync/downloads/sealed'))
      assert.equal(length, 74)
      return { base64: Buffer.alloc(74, 9).toString('base64') }
    }
  })
  h.files.set('ZenNotes/Test/.zennotes/sync/downloads/sealed', Buffer.alloc(1_000))
  assert.equal(await h.fs.readHeader('.zennotes/sync/downloads/sealed', 74), Buffer.alloc(74, 9).toString('base64'))
  await assert.rejects(h.fs.readHeader('.zennotes/sync/downloads/missing', 74), /unavailable/)
})

it('opens a staged file into a fresh file, and leaves nothing behind when the data is refused', async () => {
  const requests: unknown[] = []
  let refuse = false
  const h = await nativeFs({
    decryptFile: async (request: unknown) => {
      requests.push(request)
      if (refuse) throw Object.assign(new Error('The encrypted data was changed or is incomplete.'), { code: 'E2EE_TAMPERED' })
      return { byteLength: 5, sha256: 'd'.repeat(64) }
    }
  })
  const keys = { header: base64(params.header), objectKey: base64(params.objectKey), aad: base64(params.aad) }
  h.files.set('ZenNotes/Test/.zennotes/sync/downloads/sealed', Buffer.alloc(95))
  const open = (to: string) => h.fs.decryptFile({ from: '.zennotes/sync/downloads/sealed', to, ...keys })
  assert.deepEqual(await open('.zennotes/sync/downloads/plain'), { byteLength: 5, sha256: 'd'.repeat(64) })
  assert.deepEqual(requests, [{
    source: h.uri('ZenNotes/Test/.zennotes/sync/downloads/sealed'),
    destination: h.uri('ZenNotes/Test/.zennotes/sync/downloads/plain'), ...keys
  }])
  await assert.rejects(open('.zennotes/sync/downloads/plain'), /already exists/)
  refuse = true
  await assert.rejects(open('.zennotes/sync/downloads/again'), { code: 'E2EE_TAMPERED' })
  assert.equal(h.files.has('ZenNotes/Test/.zennotes/sync/downloads/again'), false)
})

it('opens an encrypted download through the shared staging with this NativeFs', async () => {
  const accountKey = generateCloudE2eeKey()
  const cipher = await CloudVaultCipher.open(
    { id: 'vault-1', encryption: await CloudVaultCipher.prepareVault('Notes', accountKey, 1) }, accountKey, 1
  )
  const plaintext = Buffer.alloc(200_000, 6)
  const pieces: Buffer[] = []
  for await (const piece of cipher.encryptStream([plaintext])) pieces.push(Buffer.from(piece))
  const sealed = Buffer.concat(pieces)
  const path = (fileUri: string) => fileUri.replace('file:///data/', '')
  const calls: string[] = []
  const h = await nativeFs({
    download: async ({ to }: { to: string }) => { calls.push('download'); h.files.set(path(to), sealed) },
    readHeader: async ({ source, length }: { source: string; length: number }) => {
      calls.push(`readHeader ${length}`)
      return { base64: h.files.get(path(source))!.subarray(0, length).toString('base64') }
    },
    decryptFile: async (request: { source: string; destination: string; header: string; objectKey: string; aad: string }) => {
      calls.push('decryptFile')
      const opened = openNatively(h.files.get(path(request.source))!, request)
      h.files.set(path(request.destination), opened)
      return { byteLength: opened.length, sha256: sha256(opened) }
    },
    inspect: async ({ uri: fileUri }: { uri: string }) => {
      const bytes = h.files.get(path(fileUri))!
      return { uri: fileUri, sha256: sha256(bytes), byteLength: bytes.length, utf8: false }
    }
  })
  const { NativeCloudStaging } = await loadMobileModule('@zennotes/portable-vault/cloud-sync-staging')
  const staging = new NativeCloudStaging(h.fs, () => false, async () => assert.fail('no local reads'))
  const reference = {
    item_id: 'item', revision: 3, encoding: 'base64', sha256: sha256(plaintext), byte_length: plaintext.length,
    media_type: 'application/octet-stream', encrypted: { sha256: sha256(sealed), byte_length: sealed.length }
  }
  await staging.stage({
    reference, previewLimitBytes: 262_144, decryptor: cipher,
    getInstruction: async () => ({
      item_id: 'item', revision: 3,
      content: { encoding: 'aes-gcm', sha256: sha256(sealed), byte_length: sealed.length, media_type: 'application/octet-stream' },
      download: { url: 'https://objects.example.test/item/3', method: 'GET', headers: {}, expires_at: new Date(Date.now() + 300_000).toISOString() }
    })
  })

  assert.deepEqual(calls, ['download', 'readHeader 74', 'decryptFile'])
  const staged = [...h.files.keys()]
  assert.equal(staged.length, 1, 'only the opened file remains; the ciphertext is gone')
  assert.match(staged[0]!, /^ZenNotes\/Test\/\.zennotes\/sync\/downloads\/[0-9a-f-]{36}$/)
  assert.ok(h.files.get(staged[0]!)!.equals(plaintext))
})

/** What DirectUploadPlugin.decryptFile does on the device, from the same inputs. */
function openNatively(sealed: Buffer, keys: { header: string; objectKey: string; aad: string }): Buffer {
  assert.ok(sealed.subarray(0, 74).equals(Buffer.from(keys.header, 'base64')))
  const body = sealed.subarray(74)
  const parts: Buffer[] = []
  for (let index = 0, offset = 0; offset < body.length; index++) {
    const end = Math.min(offset + 65_552, body.length)
    const nonce = Buffer.alloc(12)
    nonce.writeUInt32BE(index, 7)
    nonce[11] = end === body.length ? 1 : 0
    const gcm = createDecipheriv('aes-256-gcm', Buffer.from(keys.objectKey, 'base64'), nonce)
    gcm.setAAD(Buffer.from(keys.aad, 'base64'))
    gcm.setAuthTag(body.subarray(end - 16, end))
    parts.push(gcm.update(body.subarray(offset, end - 16)), gcm.final())
    offset = end
  }
  return Buffer.concat(parts)
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
