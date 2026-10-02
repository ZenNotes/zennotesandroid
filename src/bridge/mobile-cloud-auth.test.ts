import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { it } from 'node:test'
import { registerPlugin } from '@capacitor/core'
import { loadMobileModule } from '../../tooling/load-mobile-module.ts'

const account = {
  base_url: 'https://zennotes.org', connected_at: '2026-09-14T12:00:00Z',
  user: { name: 'Test', email: 'test@example.test' },
  device: { id: 'test-device', name: 'Test phone', platform: 'android' }
}
const credential = JSON.stringify({ base_url: account.base_url, token: 'test-only', account })

async function coldLaunch(saved: Map<string, string>) {
  const lifecycle: string[] = []
  const listeners = new Map<string, (event: any) => void>()
  let lifetime = new AbortController()
  let delayRead: { entered(): void; wait: Promise<void> } | null = null
  // Exercise the real Capacitor lazy proxy: concurrent first calls can
  // instantiate separate implementations, each with its own key prefix.
  const secureStorage = registerPlugin(`TestCloudStorage${randomUUID()}`, {
    web: async () => {
      await Promise.resolve()
      return new class {
        prefix = 'capacitor-storage_'
        async setKeyPrefix(prefix: string) { this.prefix = prefix }
        async setSynchronize(_value: boolean) {}
        async setDefaultKeychainAccess(_value: unknown) {}
        async getItem(key: string) {
          const value = saved.get(this.prefix + key) ?? null
          if (key === 'credential' && delayRead) {
            const delayed = delayRead
            delayRead = null
            delayed.entered()
            await delayed.wait
          }
          return value
        }
        async setItem(key: string, value: string) { saved.set(this.prefix + key, value) }
        async removeItem(key: string) { saved.delete(this.prefix + key) }
      }()
    }
  })
  const api = await loadMobileModule('./src/bridge/mobile-cloud-auth.ts', {
    '@capacitor/core': { Capacitor: { isNativePlatform: () => true }, CapacitorHttp: {} },
    '@capacitor/app': { App: { addListener: async (name: string, listener: (event: any) => void) => {
      listeners.set(name, listener)
      return {}
    }, getLaunchUrl: async () => null } },
    '@aparajita/capacitor-secure-storage': {
      SecureStorage: secureStorage,
      KeychainAccess: { whenUnlockedThisDeviceOnly: 'device-only' }
    },
    './cloud-sync-client': {
      createCloudSyncClient: () => assert.fail('status must only read storage'),
      stopMobileCloudRequests: () => { lifecycle.push('stop'); lifetime.abort() },
      resumeMobileCloudRequests: () => { lifecycle.push('resume'); if (lifetime.signal.aborted) lifetime = new AbortController() },
      mobileCloudRequestSignal: () => lifetime.signal
    }
  })
  await api.configureMobileCloudAuth('test-version')
  api.lifecycle = lifecycle
  api.appState = (isActive: boolean) => listeners.get('appStateChange')!({ isActive })
  api.pauseNextCredentialRead = () => {
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const wait = new Promise<void>(resolve => { release = resolve })
    delayRead = { entered, wait }
    return { started, release }
  }
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
  assert.ok(api.lifecycle.includes('stop'))
  assert.equal(saved.size, 0)
  assert.deepEqual(await (await coldLaunch(saved)).getMobileCloudAccountStatus(), { state: 'disconnected', account: null })
})

it('stops pending Cloud requests in the background and resumes on foreground', async () => {
  const api = await coldLaunch(new Map([['zennotes.cloud.credential', credential]]))
  api.appState(false)
  api.appState(true)
  assert.deepEqual(api.lifecycle, ['stop', 'resume'])
})

it('rejects a credential read spanning logout even after foreground creates a new lifetime', async () => {
  const saved = new Map([['zennotes.cloud.credential', credential]])
  const api = await coldLaunch(saved)
  await api.getMobileCloudAccountStatus()
  const paused = api.pauseNextCredentialRead()
  const pending = api.authenticatedClient().catch((error: unknown) => error)
  await paused.started
  await api.logoutMobileCloudAccount()
  api.appState(true)
  paused.release()
  assert.equal((await pending).name, 'AbortError')
  assert.equal(saved.size, 0)
})

it('rejects invalid recovered credentials through the shared auth validator', async () => {
  const invalid = JSON.stringify({ base_url: 'https://wrong.example.test', token: 'test-only', account })
  const saved = new Map([['capacitor-storage_credential', invalid]])
  const api = await coldLaunch(saved)
  assert.deepEqual(await api.getMobileCloudAccountStatus(), { state: 'disconnected', account: null })
  assert.equal(saved.size, 0)
})

it('recovers pending sign-in state across cold launches', async () => {
  const pending = JSON.stringify({
    base_url: account.base_url, state: 'test-state', code_verifier: 'a'.repeat(43), expires_at: '2099-01-01T00:00:00Z'
  })
  const saved = new Map([['capacitor-storage_pending-auth', pending]])
  for (let launch = 0; launch < 2; launch++) {
    const api = await coldLaunch(saved)
    assert.deepEqual(await api.getMobileCloudAccountStatus(), { state: 'connecting', account: null })
    assert.deepEqual([...saved.entries()], [['zennotes.cloud.pending-auth', pending]])
  }
})
