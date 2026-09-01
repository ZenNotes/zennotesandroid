import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { storedFromSystemBarsMode, systemBarsModeFromStored } from './system-bars-mode.ts'

describe('systemBarsModeFromStored', () => {
  it('keeps the 1.1.12 hidden-status-bar flag meaning status-hidden', () => {
    assert.equal(systemBarsModeFromStored('1'), 'status-hidden')
  })

  it('reads the immersive flag', () => {
    assert.equal(systemBarsModeFromStored('immersive'), 'immersive')
  })

  it('treats absent and unknown values as the shown default', () => {
    assert.equal(systemBarsModeFromStored(null), 'shown')
    assert.equal(systemBarsModeFromStored(''), 'shown')
    assert.equal(systemBarsModeFromStored('true'), 'shown')
  })
})

describe('storedFromSystemBarsMode', () => {
  it('round-trips every mode', () => {
    for (const mode of ['shown', 'status-hidden', 'immersive'] as const) {
      assert.equal(systemBarsModeFromStored(storedFromSystemBarsMode(mode)), mode)
    }
  })

  it('clears the key for the shown default', () => {
    assert.equal(storedFromSystemBarsMode('shown'), null)
  })
})
