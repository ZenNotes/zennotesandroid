import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { applyNativePreferences, readNativePreferences, type MirroredPreference } from './boot-preferences.ts'
import { settleWithin, type BootTimer } from './boot-wait.ts'

const PAIRS: MirroredPreference[] = [
  { web: 'zen:prefs:v2', native: 'zn-app-preferences-v2' },
  { web: 'zn:layout-mode', native: 'zn-layout-mode' },
  { web: 'zn:start-screen', native: 'zn-start-screen' }
]

class Web {
  readonly items = new Map<string, string>()
  getItem(key: string): string | null { return this.items.get(key) ?? null }
  setItem(key: string, value: string): void { this.items.set(key, value) }
}

class FakeTimer implements BootTimer {
  callback: (() => void) | null = null
  set(callback: () => void): unknown { this.callback = callback; return 1 }
  clear(): void { this.callback = null }
  fire(): void { this.callback?.() }
}

/** The restore as bootstrap.ts runs it, with its stores and timer handed in. */
async function restore(native: { get(o: { key: string }): Promise<{ value: string | null }> }, web: Web, timer: BootTimer, writes: Array<[string, string]>, themes: string[]): Promise<boolean> {
  const answer = await settleWithin(readNativePreferences(PAIRS, native), 2000, () => {}, timer)
  if (!answer.inTime) return false
  applyNativePreferences(PAIRS, answer.value, web, (key, value) => writes.push([key, value]), (pair, value) => {
    if (pair.web === 'zen:prefs:v2') themes.push(value)
  })
  return true
}

describe('the bootstrap restore', () => {
  it('lets boot continue within the wait when native storage never answers', async () => {
    const timer = new FakeTimer()
    const web = new Web()
    web.setItem('zn:layout-mode', 'phone')
    const writes: Array<[string, string]> = []
    const done = restore({ get: () => new Promise(() => {}) }, web, timer, writes, [])
    timer.fire()
    assert.equal(await done, false)
    assert.equal(web.getItem('zn:layout-mode'), 'phone')
    assert.deepEqual(writes, [])
  })

  it('applies a fast restore: native values back into localStorage, theme first', async () => {
    const timer = new FakeTimer()
    const web = new Web()
    web.setItem('zn:start-screen', 'home')
    const native = new Map([['zn-app-preferences-v2', '{"themeId":"nord","vimMode":true}'], ['zn-layout-mode', 'desktop']])
    const writes: Array<[string, string]> = []
    const themes: string[] = []
    const inTime = await restore({ get: async ({ key }) => ({ value: native.get(key) ?? null }) }, web, timer, writes, themes)
    assert.equal(inTime, true)
    assert.equal(web.getItem('zen:prefs:v2'), '{"themeId":"nord","vimMode":true}')
    assert.equal(web.getItem('zn:layout-mode'), 'desktop')
    assert.deepEqual(themes, ['{"themeId":"nord","vimMode":true}'])
    // Only localStorage held the Start screen: it is copied to native.
    assert.deepEqual(writes, [['zn-start-screen', 'home']])
  })

  it('never lets a late answer clobber what the app wrote after boot went on', async () => {
    const timer = new FakeTimer()
    const web = new Web()
    let answer!: (value: { value: string | null }) => void
    const pending = new Promise<{ value: string | null }>((r) => { answer = r })
    const writes: Array<[string, string]> = []
    const done = restore({ get: () => pending }, web, timer, writes, [])
    timer.fire()
    assert.equal(await done, false)
    web.setItem('zn:layout-mode', 'phone') // the person switched Layout after boot
    answer({ value: 'desktop' }) // the stale native answer arrives
    await new Promise((r) => setTimeout(r, 0))
    assert.equal(web.getItem('zn:layout-mode'), 'phone')
    assert.deepEqual(writes, [])
  })

  it('reads every native value before writing any', async () => {
    const order: string[] = []
    const web = { getItem: () => null, setItem: (key: string) => { order.push('write ' + key) } }
    const values = await readNativePreferences(PAIRS, { get: async ({ key }) => { order.push('read ' + key); return { value: 'x' } } })
    applyNativePreferences(PAIRS, values, web, () => {})
    assert.deepEqual(order.slice(0, 3), ['read zn-app-preferences-v2', 'read zn-layout-mode', 'read zn-start-screen'])
    assert.ok(order.slice(3).every((step) => step.startsWith('write')))
  })
})
