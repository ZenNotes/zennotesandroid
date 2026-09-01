import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { vaultSettingsAccessForLayout } from './vault-settings-access.ts'

describe('vaultSettingsAccessForLayout', () => {
  it('keeps the full quick-switch controls in the phone settings layout', () => {
    assert.equal(vaultSettingsAccessForLayout(true), 'quick-switch')
  })

  it('keeps the vault manager reachable in the tablet settings layout', () => {
    assert.equal(vaultSettingsAccessForLayout(false), 'manage-button')
  })
})
