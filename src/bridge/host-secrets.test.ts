import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { it } from 'node:test'
import { registerPlugin } from '@capacitor/core'
import { loadMobileModule } from '../../tooling/load-mobile-module.ts'

// The Keystore side of Cloud sign-in moved with the vault layer: the
// package's auth (@zennotes/portable-vault/cloud-auth) asks this app's host
// for its SecretStorage, and the host's prepare() is where secure storage is
// configured and where records an older build wrote under the plugin's
// default prefix (`capacitor-storage_`) move to `zennotes.cloud.`. These are
// the cases that guarded that migration in the old mobile-cloud-auth.test.ts,
// plus the account key's name, which must stay the one this app shipped.

const account = {
  base_url: 'https://zennotes.org', connected_at: '2026-09-14T12:00:00Z',
  user: { name: 'Test', email: 'Test@Example.test' },
  device: { id: 'test-device', name: 'Test phone', platform: 'android' }
}
const credential = JSON.stringify({ base_url: account.base_url, token: 'test-only', account })

async function coldLaunch(saved: Map<string, string>) {
  // The real Capacitor lazy proxy: concurrent first calls can instantiate
  // separate implementations, each with its own key prefix.
  const secureStorage = registerPlugin(`TestCloudStorage${randomUUID()}`, {
    web: async () => {
      await Promise.resolve()
      return new class {
        prefix = 'capacitor-storage_'
        async setKeyPrefix(prefix: string) { this.prefix = prefix }
        async setSynchronize(_value: boolean) {}
        async setDefaultKeychainAccess(_value: unknown) {}
        async getItem(key: string) { return saved.get(this.prefix + key) ?? null }
        async setItem(key: string, value: string) { saved.set(this.prefix + key, value) }
        async removeItem(key: string) { saved.delete(this.prefix + key); return true }
        async keys() {
          return [...saved.keys()].filter((key) => key.startsWith(this.prefix)).map((key) => key.slice(this.prefix.length))
        }
      }()
    }
  })
  const api = await loadMobileModule(['./src/bridge/host.ts', '@zennotes/portable-vault/host', '@zennotes/portable-vault/cloud-auth'], {
    '@capacitor/core': { Capacitor: { isNativePlatform: () => true }, CapacitorHttp: {}, registerPlugin },
    '@capacitor/app': {
      App: {
        addListener: async () => ({}),
        getLaunchUrl: async () => null,
        getInfo: async () => ({ version: '1.1.58' })
      }
    },
    '@capacitor/clipboard': { Clipboard: {} },
    '@capacitor/filesystem': { Directory: {}, Encoding: {}, Filesystem: {} },
    '@capacitor/preferences': { Preferences: {} },
    '@capacitor/share': { Share: {} },
    '@aparajita/capacitor-secure-storage': {
      SecureStorage: secureStorage,
      KeychainAccess: { whenUnlockedThisDeviceOnly: 'device-only' }
    },
    '../viewport': { isPhoneViewport: () => true },
    './background-sync': { leaveApp: () => {}, returnToApp: () => {} },
    './native-fs': { putFile: async () => ({ status: 200 }) }
  })
  api.installPortableHost({ ...api.androidHost, vaults: {} })
  await api.configureMobileCloudAuth('test-version')
  return api
}

for (const prefix of ['zennotes.cloud.', 'capacitor-storage_']) {
  it(`loads a saved account from ${prefix} on every cold launch`, async () => {
    const saved = new Map([[prefix + 'credential', credential]])
    for (let launch = 0; launch < 2; launch++) {
      const api = await coldLaunch(saved)
      const statuses = await Promise.all([api.getMobileCloudAccountStatus(), api.getMobileCloudAccountStatus()])
      assert.deepEqual(statuses, [{ state: 'connected', account }, { state: 'connected', account }])
      assert.deepEqual([...saved.keys()], ['zennotes.cloud.credential'])
    }
  })
}

it('preserves the canonical account and prevents a legacy credential from returning after logout', async () => {
  const saved = new Map([
    ['zennotes.cloud.credential', credential],
    ['capacitor-storage_credential', JSON.stringify({ base_url: account.base_url, token: 'old-test-token', account })]
  ])
  const api = await coldLaunch(saved)
  assert.equal((await api.authenticatedCredential()).token, 'test-only')
  await api.logoutMobileCloudAccount()
  assert.equal(saved.size, 0)
  assert.deepEqual(await (await coldLaunch(saved)).getMobileCloudAccountStatus(), { state: 'disconnected', account: null })
})

it('keeps the account key under the name this app shipped, a fingerprint of the account', async () => {
  const saved = new Map([['zennotes.cloud.credential', credential]])
  const api = await coldLaunch(saved)
  await api.mobileCloudAccountKeyStore({ base_url: account.base_url, account }).save({
    format: 1, key: Buffer.alloc(32, 7).toString('base64'), version: 1
  })
  // What the old mobile-cloud-auth.ts named it: SHA-256 of the base URL and
  // the lowercased email, one line each.
  const fingerprint = createHash('sha256').update('https://zennotes.org\ntest@example.test').digest('hex')
  assert.ok(saved.has(`zennotes.cloud.e2ee-account-key.${fingerprint}`), [...saved.keys()].join(', '))
})

it('reports itself as Android to Cloud sign-in and keeps the version the native app gives', async () => {
  const api = await coldLaunch(new Map())
  assert.equal(await api.loadNativeAppVersion(), '1.1.58')
  const shell = api.androidHost.shell
  assert.deepEqual(
    [shell.platform, shell.cloud.platform, shell.cloud.deviceName, shell.cloud.accountKeyScheme, shell.appInfo().version, shell.appInfo().hostKind],
    ['android', 'android', 'ZenNotes Android', 'hashed', '1.1.58', 'android']
  )
  // Android's read timeout restarts per byte: a short connect, then the
  // stall bound or the request's own.
  assert.deepEqual(api.androidHost.http.cloudTimeouts({ bodyBytes: 0 }), { connectTimeout: 15_000, readTimeout: 30_000 })
  assert.deepEqual(api.androidHost.http.cloudTimeouts({ timeoutMs: 120_000, bodyBytes: 0 }), { connectTimeout: 15_000, readTimeout: 120_000 })
  assert.equal(api.androidHost.http.putsInMemoryBodies, true)
})
