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

const { DEFAULT_GESTURES, getGesturePrefs, setGesturePrefs } = await import('./gestures.ts')
const { GESTURES_KEY } = await import('../viewport.ts')

test('garbage in storage falls back to the defaults', () => {
  store.set(GESTURES_KEY, '{not json')
  assert.deepEqual(getGesturePrefs(), DEFAULT_GESTURES)
})

test('unknown values normalize per-field, not wholesale', () => {
  setGesturePrefs({
    swipeLeft: 'outline',
    // @ts-expect-error deliberately invalid, e.g. from a newer version's value
    swipeRight: 'jetpack',
    pullDown: 'search'
  })
  assert.deepEqual(getGesturePrefs(), {
    swipeLeft: 'outline',
    swipeRight: DEFAULT_GESTURES.swipeRight,
    pullDown: 'search'
  })
})

test('set/get roundtrip persists through storage', () => {
  setGesturePrefs({ swipeLeft: 'browse', swipeRight: 'outline', pullDown: 'new' })
  assert.deepEqual(JSON.parse(store.get(GESTURES_KEY) ?? ''), {
    swipeLeft: 'browse',
    swipeRight: 'outline',
    pullDown: 'new'
  })
  assert.deepEqual(getGesturePrefs(), {
    swipeLeft: 'browse',
    swipeRight: 'outline',
    pullDown: 'new'
  })
})

test('setting the defaults removes the key entirely', () => {
  setGesturePrefs({ ...DEFAULT_GESTURES })
  assert.equal(store.has(GESTURES_KEY), false)
  assert.deepEqual(getGesturePrefs(), DEFAULT_GESTURES)
})
