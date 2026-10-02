import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { it } from 'node:test'
import { loadMobileModule } from '../../tooling/load-mobile-module.ts'

for (const provider of ['file', 'content']) {
  it(`copies a 6 MB ${provider} source using a verified native file handle`, async () => {
    const bytes = Buffer.alloc(6_000_000, 197)
    const uri = (path: string) => `${provider}:///${path.replace('ZenNotes/Test/', '')}`
    const files = new Map<string, Buffer[]>([[uri('source.bin'), [bytes]]])
    const copies: unknown[] = []
    const missing = () => Object.assign(new Error('Not found'), { code: 'OS-PLUG-FILE-0008' })
    const stat = (path: string) => {
      const chunks = files.get(uri(path))
      if (!chunks) throw missing()
      return { type: 'file', uri: uri(path), mtime: 1, size: chunks.reduce((sum, chunk) => sum + chunk.length, 0) }
    }
    const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null } })
    try {
      const { NativeFs } = await loadMobileModule('./src/bridge/native-fs', {
        './icloud': { ensureDownloaded: async () => {} },
        '@capacitor/core': {
          Capacitor: {},
          registerPlugin: (name: string) => name === 'SafFs' ? {
            stat: async ({ path }: { path: string }) => stat(path),
            writeBase64: async ({ path, data }: { path: string; data: string }) => {
              assert.equal(data, '')
              files.set(uri(path), [])
            },
            copy: () => assert.fail('SafFs.copy buffers the whole source')
          } : {
            inspect: async ({ uri: path }: { uri: string }) => {
              const chunks = files.get(path)
              assert.ok(chunks)
              const hash = createHash('sha256')
              for (const chunk of chunks) hash.update(chunk)
              return { uri: path, byteLength: chunks.reduce((sum, chunk) => sum + chunk.length, 0),
                sha256: hash.digest('hex'), utf8: false }
            },
            copy: async (request: { from: string; to: string; byteLength: number; sha256: string }) => {
              assert.deepEqual(request, { from: uri('source.bin'), to: uri('copy.bin'), byteLength: bytes.length,
                sha256: createHash('sha256').update(bytes).digest('hex') })
              assert.ok(JSON.stringify(request).length < 400)
              copies.push(request)
              files.set(request.to, [Buffer.from(bytes)])
            }
          }
        },
        '@capacitor/filesystem': {
          Directory: { Data: 'DATA', External: 'EXTERNAL' }, Encoding: { UTF8: 'utf8' },
          Filesystem: {
            getUri: async ({ path }: { path: string }) => ({ uri: uri(path) }),
            stat: async ({ path }: { path: string }) => stat(path),
            writeFile: async ({ path, data }: { path: string; data: string }) => {
              assert.equal(data, '')
              files.set(uri(path), [])
            },
            readFile: () => assert.fail('File bytes must not cross the bridge'),
            appendFile: () => assert.fail('File bytes must not cross the bridge'),
            copy: () => assert.fail('Whole-file native copy is not used')
          }
        }
      })
      const fs = new NativeFs('Test', provider === 'content' ? 'content:///tree/root' : null)
      await fs.copyForSync('source.bin', 'copy.bin', bytes.length)
      assert.deepEqual(Buffer.concat(files.get(uri('copy.bin'))!), bytes)
      assert.equal(copies.length, 1)
      await assert.rejects(fs.copyForSync('source.bin', 'copy.bin', bytes.length), /already exists/)
    } finally {
      if (storage) Object.defineProperty(globalThis, 'localStorage', storage)
      else Reflect.deleteProperty(globalThis, 'localStorage')
    }
  })
}
