import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { enterPlan, settleTarget, stepTarget, type PaletteRow } from './palette-hidden-rows.ts'

/** Rows from a picture: `h` hidden, `v` visible, upper case highlighted. */
function rows(picture: string): PaletteRow[] {
  return [...picture].map((c) => ({ hidden: c.toLowerCase() === 'h', active: c === c.toUpperCase() }))
}

describe('settleTarget', () => {
  it('moves a highlight off a hidden row onto the first visible one ("timeline")', () => {
    // Toggle Timeline (hidden) first, then Close Right Panel and Remember Panels.
    assert.equal(settleTarget(rows('Hvv')), 1)
    assert.equal(settleTarget(rows('vHhv')), 0)
  })

  it('leaves a visible highlight alone', () => {
    assert.equal(settleTarget(rows('hVv')), -1)
    assert.equal(settleTarget(rows('Vvv')), -1)
  })

  it('has nowhere to go when every row is hidden', () => {
    assert.equal(settleTarget(rows('Hh')), -1)
  })
})

describe('stepTarget', () => {
  it('skips hidden rows both ways', () => {
    assert.equal(stepTarget(rows('Vhhv'), 1), 3)
    assert.equal(stepTarget(rows('vhhV'), -1), 0)
  })

  it('stays on the last or first visible row, as core clamps', () => {
    assert.equal(stepTarget(rows('vVh'), 1), 1)
    assert.equal(stepTarget(rows('hVv'), -1), 1)
  })

  it('falls back to the first visible row from a hidden highlight at an end', () => {
    assert.equal(stepTarget(rows('vH'), 1), 0)
  })

  it('finds no row when every row is hidden', () => {
    assert.equal(stepTarget(rows('Hh'), 1), -1)
  })
})

describe('enterPlan', () => {
  it('lets core run a visible highlight', () => {
    assert.deepEqual(enterPlan(rows('hVv')), { run: 'core' })
  })

  it('runs the first visible row instead of a hidden highlight', () => {
    assert.deepEqual(enterPlan(rows('Hvv')), { run: 'row', index: 1 })
  })

  it('runs nothing when no row is visible, so the palette stays open', () => {
    assert.deepEqual(enterPlan(rows('Hh')), { run: 'none' })
  })
})
