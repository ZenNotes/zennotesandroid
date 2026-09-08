import assert from 'node:assert/strict'
import test from 'node:test'

// The module reads localStorage lazily (inside the functions), so a stub
// installed before the first call is all node needs.
const store = new Map<string, string>()
;(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key)
}

const { DEFAULT_START_SCREEN, getStartScreen, setStartScreen } = await import('./start-screen.ts')
const { START_SCREEN_KEY } = await import('../viewport.ts')

test('nothing stored means where the user left off', () => {
  store.delete(START_SCREEN_KEY)
  assert.equal(getStartScreen(), 'last')
  assert.equal(DEFAULT_START_SCREEN, 'last')
})

test('an unknown stored value falls back to the default', () => {
  store.set(START_SCREEN_KEY, 'jetpack')
  assert.equal(getStartScreen(), 'last')
})

test('home persists; the default removes the key', () => {
  setStartScreen('home')
  assert.equal(store.get(START_SCREEN_KEY), 'home')
  assert.equal(getStartScreen(), 'home')
  setStartScreen('last')
  assert.equal(store.has(START_SCREEN_KEY), false)
  assert.equal(getStartScreen(), 'last')
})
