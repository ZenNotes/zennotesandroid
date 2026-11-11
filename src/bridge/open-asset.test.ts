import assert from 'node:assert/strict'
import { it } from 'node:test'
import { loadMobileModule } from '../../tooling/load-mobile-module.ts'

// The shell never implemented openAssetExternally. App-core now sends a PDF
// here wherever the WebView cannot draw one (Dave, Discord, 2026-10-27), so
// this is how a PDF opens at all on Android.

class FakeRemoteVault {
  readonly client: { fetchAssetBase64(rel: string): Promise<{ base64: string }> }
  constructor(client: FakeRemoteVault['client']) {
    this.client = client
  }
}

interface Harness {
  api: Record<string, any>
  opened: string[]
  written: Array<{ path: string; data: string }>
  failOpen: Error | null
}

async function load(): Promise<Harness> {
  const harness: Harness = { api: {}, opened: [], written: [], failOpen: null }
  harness.api = await loadMobileModule('./src/bridge/open-asset.ts', {
    '@capacitor/core': {
      registerPlugin: () => ({
        open: async ({ uri }: { uri: string }) => {
          if (harness.failOpen) throw harness.failOpen
          harness.opened.push(uri)
        }
      })
    },
    '@capacitor/filesystem': {
      Directory: { Cache: 'CACHE' },
      Filesystem: {
        mkdir: async () => {},
        writeFile: async ({ path, data }: { path: string; data: string }) =>
          void harness.written.push({ path, data }),
        getUri: async ({ path }: { path: string }) => ({ uri: `file:///data/user/0/md.zennotes/cache/${path}` })
      }
    },
    '@zennotes/portable-vault/remote-vault': { RemoteVault: FakeRemoteVault }
  })
  return harness
}

function localVault(files: Record<string, string>) {
  return {
    fs: {
      statOrNull: async (rel: string) => (rel in files ? { type: 'file' } : null),
      fileUri: async (rel: string) => files[rel]
    }
  }
}

const VAULT_FILE =
  'file:///storage/emulated/0/Android/data/md.zennotes/files/ZenNotes/My%20Vault/assets/Tourtickets.pdf'

it('hands an on-device vault file to the viewer by its native URI', async () => {
  const h = await load()
  const result = await h.api.openAssetExternally(
    localVault({ 'assets/Tourtickets.pdf': VAULT_FILE }),
    'assets/Tourtickets.pdf'
  )
  assert.deepEqual(result, { ok: true })
  assert.deepEqual(h.opened, [VAULT_FILE])
})

it('says the file is missing instead of opening nothing', async () => {
  const h = await load()
  const result = await h.api.openAssetExternally(localVault({}), 'assets/Gone.pdf')
  assert.equal(result.ok, false)
  assert.match(result.error, /missing/)
  assert.deepEqual(h.opened, [])
})

it('refuses a path that climbs out of the vault', async () => {
  const h = await load()
  const result = await h.api.openAssetExternally(
    localVault({ 'assets/Tourtickets.pdf': VAULT_FILE }),
    '../outside.pdf'
  )
  assert.equal(result.ok, false)
  assert.deepEqual(h.opened, [])
})

it("passes on the phone's answer when no app views the file", async () => {
  const h = await load()
  h.failOpen = new Error('No app on this phone opens this kind of file.')
  const result = await h.api.openAssetExternally(
    localVault({ 'assets/Tourtickets.pdf': VAULT_FILE }),
    'assets/Tourtickets.pdf'
  )
  assert.deepEqual(result, { ok: false, error: 'No app on this phone opens this kind of file.' })
})

it("copies a remote vault's asset into a fresh cache folder per open, then opens the copy", async () => {
  const h = await load()
  const vault = new FakeRemoteVault({ fetchAssetBase64: async () => ({ base64: 'JVBERi0=' }) })
  await h.api.openAssetExternally(vault, 'assets/Tourtickets.pdf')
  await h.api.openAssetExternally(vault, 'assets/Tourtickets.pdf')

  assert.equal(h.written.length, 2)
  assert.notEqual(h.written[0].path, h.written[1].path)
  for (const { path, data } of h.written) {
    assert.match(path, /^open-asset\/[^/]+\/Tourtickets\.pdf$/)
    assert.equal(data, 'JVBERi0=')
  }
  assert.deepEqual(
    h.opened,
    h.written.map(({ path }) => `file:///data/user/0/md.zennotes/cache/${path}`)
  )
})
