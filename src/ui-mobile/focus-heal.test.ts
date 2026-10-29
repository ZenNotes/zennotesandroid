import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { FocusHealGate, pageEventOf } from './focus-heal.ts'
import { KeyboardHold, READ_OPEN_SETTLE_MS } from './keyboard-hold.ts'

const win = { name: 'window' }
const editor = { name: 'cm-content' }
const phone = { phone: true, editorFocused: false }

describe('pageEventOf', () => {
  it('hears the window losing and regaining focus, not an element on its way', () => {
    assert.equal(pageEventOf({ type: 'blur', target: win }, win, 'visible'), 'leave')
    assert.equal(pageEventOf({ type: 'focus', target: win }, win, 'visible'), 'return')
    assert.equal(pageEventOf({ type: 'blur', target: editor }, win, 'visible'), 'other')
    assert.equal(pageEventOf({ type: 'focus', target: editor }, win, 'visible'), 'other')
  })

  it('hears the page going hidden and coming back', () => {
    assert.equal(pageEventOf({ type: 'visibilitychange', target: {} }, win, 'hidden'), 'leave')
    assert.equal(pageEventOf({ type: 'visibilitychange', target: {} }, win, 'visible'), 'return')
    assert.equal(pageEventOf({ type: 'pagehide', target: win }, win, 'hidden'), 'leave')
  })
})

describe('FocusHealGate', () => {
  it('holds the keyboard down when a note being read comes back', () => {
    const gate = new FocusHealGate()
    gate.left(false) // blur
    gate.left(false) // hidden
    assert.equal(gate.returned(phone), true) // visible
    assert.equal(gate.returned(phone), true) // window focus
  })

  it('lets the heal bring the keyboard back to someone who was typing', () => {
    const gate = new FocusHealGate()
    gate.left(true) // blur, the editor focused
    gate.left(false) // hidden, after the WebView let go of it
    assert.equal(gate.returned(phone), false)
    assert.equal(gate.returned(phone), false) // the second return event too
  })

  it('forgets the typing once the app is left again while reading', () => {
    const gate = new FocusHealGate()
    gate.left(true)
    gate.returned(phone)
    gate.left(false)
    assert.equal(gate.returned(phone), true)
  })

  it('counts a fresh page (a cold launch, the Layout reload) as reading', () => {
    assert.equal(new FocusHealGate().returned(phone), true)
  })

  it('leaves a focused editor and a tablet layout alone', () => {
    assert.equal(new FocusHealGate().returned({ phone: true, editorFocused: true }), false)
    assert.equal(new FocusHealGate().returned({ phone: false, editorFocused: false }), false)
  })

  it('refuses the heal\'s burst of tries, then lets a later focus through', () => {
    let t = 1_000_000
    const hold = new KeyboardHold(() => t)
    hold.arm()
    hold.opened()
    for (let i = 0; i < 8; i++) {
      t += 32 // focusEditorNormalMode's retries
      assert.equal(hold.refuse(), true)
    }
    t += READ_OPEN_SETTLE_MS + 1
    assert.equal(hold.refuse(), false)
  })
})

describe('the read-open guard', () => {
  const source = readFileSync(new URL('./read-open.ts', import.meta.url), 'utf8')

  it('listens for leaving and coming back in the capture phase, ahead of core', () => {
    for (const [target, type] of [['window', 'blur'], ['window', 'pagehide'], ['window', 'focus'], ['document', 'visibilitychange']]) {
      assert.match(source, new RegExp(`${target}\\.addEventListener\\('${type}', holdThroughHeal, true\\)`))
    }
  })
})
