import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { loadMobileModule } from '../../tooling/load-mobile-module.ts'

const { hardwareKeyboardConnected, watchHardwareKeyboard } = await loadMobileModule(['./src/bridge/hardware-keyboard'])
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function source(initial: boolean | Error) {
  let listener: ((state: { connected: boolean }) => void) | null = null
  let removed = false
  return {
    send: (connected: boolean) => listener?.({ connected }),
    removed: () => removed,
    isConnected: async () => {
      if (initial instanceof Error) throw initial
      return { connected: initial }
    },
    addListener: async (_: 'change', next: (state: { connected: boolean }) => void) => {
      listener = next
      return { remove: async () => { removed = true } }
    }
  }
}

describe('the hardware keyboard watch', () => {
  it('stays off on a device with no keyboard, and does not tell anyone', async () => {
    let told = 0
    const stop = watchHardwareKeyboard(source(false), () => { told += 1 })
    await settle()
    assert.equal(hardwareKeyboardConnected(), false)
    assert.equal(told, 0)
    stop()
  })

  it('reads as off when the plugin cannot answer', async () => {
    const stop = watchHardwareKeyboard(source(new Error('no plugin')), () => {})
    await settle()
    assert.equal(hardwareKeyboardConnected(), false)
    stop()
  })

  it('follows a keyboard connecting and disconnecting', async () => {
    const src = source(false)
    let told = 0
    const stop = watchHardwareKeyboard(src, () => { told += 1 })
    await settle()
    src.send(true)
    assert.equal(hardwareKeyboardConnected(), true)
    src.send(true)
    assert.equal(told, 1)
    src.send(false)
    assert.equal(hardwareKeyboardConnected(), false)
    assert.equal(told, 2)
    stop()
  })

  it('hears nothing after it stops', async () => {
    const src = source(false)
    let told = 0
    const stop = watchHardwareKeyboard(src, () => { told += 1 })
    await settle()
    stop()
    await settle()
    src.send(true)
    assert.equal(told, 0)
    assert.equal(src.removed(), true)
    assert.equal(hardwareKeyboardConnected(), false)
  })
})
