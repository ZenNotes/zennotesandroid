import assert from 'node:assert/strict'
import { it } from 'node:test'
import { loadMobileModule } from '../../tooling/load-mobile-module.ts'

const { connectionErrorMessage } = await loadMobileModule('./src/bridge/remote-client.ts', {
  '@capacitor/core': { CapacitorHttp: {} }
})

it('never points an Android user at the iPhone Local Network setting', () => {
  for (const url of ['http://192.168.1.20:7878', 'https://notes.example.com']) {
    const text: string = connectionErrorMessage(url, new Error('Failed to fetch'))
    assert.doesNotMatch(text, /Local Network|Privacy & Security/)
    assert.ok(text.includes(`Could not connect to the ZenNotes server at ${url}.`))
    assert.ok(text.includes('Could not reach the server: Failed to fetch.'))
  }
})

it('says where to install a certificate authority for an https server only', () => {
  assert.ok(connectionErrorMessage('https://notes.example.com', null).includes('Install a certificate'))
  assert.ok(!connectionErrorMessage('http://192.168.1.20:7878', null).includes('certificate'))
})
