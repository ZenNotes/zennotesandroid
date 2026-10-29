import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { holdUntilSettled, LANDING_HOLD_CAP_MS, type LandingClock } from './landing-hold.ts'

/** A clock the test moves by hand. Plain fields: node --test strips types only. */
class Clock implements LandingClock {
  t = 0
  timers: Array<{ at: number; callback: () => void; id: number }> = []
  next = 1
  now(): number { return this.t }
  set(callback: () => void, ms: number): unknown { const id = this.next++; this.timers.push({ at: this.t + ms, callback, id }); return id }
  clear(handle: unknown): void { this.timers = this.timers.filter((timer) => timer.id !== handle) }
  advance(ms: number): void {
    const until = this.t + ms
    for (;;) {
      const due = this.timers.filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      this.timers = this.timers.filter((timer) => timer !== due)
      this.t = due.at
      due.callback()
    }
    this.t = until
  }
}

class Hold {
  armedAt: number[] = []
  openedAt: number[] = []
  readonly clock: Clock
  constructor(clock: Clock) { this.clock = clock }
  arm(): void { this.armedAt.push(this.clock.t) }
  opened(): void { this.openedAt.push(this.clock.t) }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('holdUntilSettled', () => {
  it('keeps the hold armed past a fixed wait while a slow restore is still running', async () => {
    const clock = new Clock()
    const hold = new Hold(clock)
    const note = deferred()
    const done = holdUntilSettled(hold, note.promise, { rearmMs: 2500, clock, touched: () => false })
    clock.advance(9000) // longer than the 5 s an open waits
    assert.ok(hold.armedAt.length >= 4, `re-armed ${hold.armedAt.length} times`)
    assert.deepEqual(hold.openedAt, [])
    note.resolve()
    assert.equal(await done, 'settled')
    assert.deepEqual(hold.openedAt, [9000])
  })

  it('lets go at the cap when the note never appears', async () => {
    const clock = new Clock()
    const hold = new Hold(clock)
    const done = holdUntilSettled(hold, new Promise(() => {}), { rearmMs: 2500, clock, touched: () => false })
    clock.advance(LANDING_HOLD_CAP_MS + 1000)
    assert.equal(await done, 'cap')
    assert.deepEqual(hold.openedAt, [LANDING_HOLD_CAP_MS])
    const armsAtCap = hold.armedAt.length
    clock.advance(10000)
    assert.equal(hold.armedAt.length, armsAtCap)
  })

  it('stops re-arming as soon as the person touches the screen', async () => {
    const clock = new Clock()
    const hold = new Hold(clock)
    let touched = false
    const done = holdUntilSettled(hold, new Promise(() => {}), { rearmMs: 2500, clock, touched: () => touched })
    clock.advance(3000)
    touched = true
    clock.advance(3000)
    assert.equal(await done, 'touched')
    const arms = hold.armedAt.length
    clock.advance(20000)
    assert.equal(hold.armedAt.length, arms)
    assert.deepEqual(hold.openedAt, [])
  })

  it('settles at once for a fast landing', async () => {
    const clock = new Clock()
    const hold = new Hold(clock)
    const done = holdUntilSettled(hold, Promise.resolve(), { rearmMs: 2500, clock, touched: () => false })
    await flush()
    assert.equal(await done, 'settled')
    assert.deepEqual(hold.armedAt, [0])
    assert.deepEqual(hold.openedAt, [0])
    assert.equal(clock.timers.length, 0)
  })
})
