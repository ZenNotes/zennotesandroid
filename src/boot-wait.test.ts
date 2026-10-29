import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { BOOT_NATIVE_WAIT_MS, settleWithin, type BootTimer } from './boot-wait.ts'

/** A timer the test fires by hand. Plain fields, not parameter properties:
 *  node --test strips types only and refuses those. */
class FakeTimer implements BootTimer {
  callback: (() => void) | null = null
  ms = 0
  cleared = false
  set(callback: () => void, ms: number): unknown {
    this.callback = callback
    this.ms = ms
    return 1
  }
  clear(): void {
    this.cleared = true
    this.callback = null
  }
  fire(): void {
    this.callback?.()
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

describe('settleWithin', () => {
  it('lets boot continue when the native answer never comes, logging once', async () => {
    const timer = new FakeTimer()
    let logged = 0
    const waiting = settleWithin(new Promise<string>(() => {}), BOOT_NATIVE_WAIT_MS, () => { logged++ }, timer)
    assert.equal(timer.ms, BOOT_NATIVE_WAIT_MS)
    timer.fire()
    assert.deepEqual(await waiting, { inTime: false })
    timer.fire() // a second tick changes nothing
    assert.equal(logged, 1)
  })

  it('applies a fast answer and stops the timer', async () => {
    const timer = new FakeTimer()
    let logged = 0
    const answer = await settleWithin(Promise.resolve('1.34.0'), BOOT_NATIVE_WAIT_MS, () => { logged++ }, timer)
    assert.deepEqual(answer, { inTime: true, value: '1.34.0' })
    assert.equal(timer.cleared, true)
    assert.equal(logged, 0)
  })

  it('never lets a late answer overwrite what was written since boot', async () => {
    const timer = new FakeTimer()
    const native = deferred<string>()
    let version = 'placeholder'
    const waiting = settleWithin(native.promise, BOOT_NATIVE_WAIT_MS, () => {}, timer).then((answer) => {
      if (answer.inTime) version = answer.value
    })
    timer.fire()
    await waiting
    version = 'set after boot'
    native.resolve('late native answer')
    await native.promise
    await new Promise((r) => setTimeout(r, 0))
    assert.equal(version, 'set after boot')
  })

  it('passes a failure in time through to the caller', async () => {
    const timer = new FakeTimer()
    await assert.rejects(settleWithin(Promise.reject(new Error('no plugin')), 10, () => {}, timer), /no plugin/)
  })
})

describe('boot', () => {
  const bootstrap = readFileSync(new URL('./bootstrap.ts', import.meta.url), 'utf8')
  const main = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8')
  const bridge = readFileSync(new URL('./bridge/mobile-bridge.ts', import.meta.url), 'utf8')

  it('bounds the native preferences restore before main.tsx loads', () => {
    assert.match(bootstrap, /await waitAtBoot\('native preferences', readNativePreferences\(RESTORED_PREFERENCES, Preferences\)\)/)
    assert.match(bootstrap, /if \(!answer\.inTime\) return/)
    const boot = bootstrap.slice(bootstrap.indexOf('async function bootstrap('))
    assert.ok(boot.indexOf('await restoreNativePreferences()') < boot.indexOf("await import('./main')"))
  })

  it('bounds every native answer it can do without before the app renders', () => {
    assert.match(main, /await waitAtBoot\('Cloud sign-in links', configureMobileCloudAuth\(appVersion\)\)/)
    assert.match(main, /await waitAtBoot\('shared captures', importPendingShares\(\)/)
    assert.match(bridge, /await waitAtBoot\('the app version', CapApp\.getInfo\(\)\)/)
    assert.match(bridge, /if \(info\.inTime && info\.value\.version\) appVersion = info\.value\.version/)
  })

  it('keeps the two second wait generous next to a normal answer', () => {
    assert.ok(BOOT_NATIVE_WAIT_MS >= 1500 && BOOT_NATIVE_WAIT_MS <= 3000)
  })
})
