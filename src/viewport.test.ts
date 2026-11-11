import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { isPhoneDevice, isPhoneViewport, LAYOUT_MODE_KEY } from './viewport.ts'

const store = new Map<string, string>()
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key)
  }
})

function screenOf(width: number, height: number): void {
  Object.assign(globalThis, { window: { screen: { width, height }, innerWidth: width, innerHeight: height } })
}

describe('isPhoneDevice', () => {
  afterEach(() => store.clear())

  it('answers for the screen, in either orientation', () => {
    screenOf(411, 914)
    assert.equal(isPhoneDevice(), true)
    screenOf(914, 411)
    assert.equal(isPhoneDevice(), true)
    screenOf(800, 1280)
    assert.equal(isPhoneDevice(), false)
  })

  it('ignores the layout the user picked, which isPhoneViewport follows', () => {
    screenOf(411, 914)
    store.set(LAYOUT_MODE_KEY, 'desktop')
    assert.equal(isPhoneViewport(), false)
    assert.equal(isPhoneDevice(), true)

    screenOf(800, 1280)
    store.set(LAYOUT_MODE_KEY, 'phone')
    assert.equal(isPhoneViewport(), true)
    assert.equal(isPhoneDevice(), false)
  })
})
