import assert from 'node:assert/strict'
import test from 'node:test'
import { shouldDismissSheet } from './sheet-drag.ts'

test('dragging the handle down dismisses its sheet (#53)', () => {
  assert.equal(shouldDismissSheet(4, 90, 500), true)
  assert.equal(shouldDismissSheet(2, 30, 35), true)
})
test('a tap, short drag, horizontal swipe or upward drag keeps the sheet open', () => {
  for (const [x, y, ms] of [[0, 0, 30], [0, 20, 500], [180, 90, 500], [0, -100, 200]]) {
    assert.equal(shouldDismissSheet(x, y, ms), false)
  }
})
