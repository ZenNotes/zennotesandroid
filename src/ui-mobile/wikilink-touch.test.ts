import assert from 'node:assert/strict'
import test from 'node:test'
import { installWikilinkTouchNavigation } from './wikilink-touch.ts'

function setup() {
  const target = new EventTarget()
  let time = 0
  let selected = false
  const opened: string[] = []
  const uninstall = installWikilinkTouchNavigation(target as unknown as Document, {
    hasSelection: () => selected,
    open: (link) => opened.push(link),
    now: () => time
  })
  const element = { closest: () => ({ dataset: { target: 'A note' } }) }
  const send = (type: string, x = 20, y = 20, fingers = 1): Event => {
    const event = new Event(type, { cancelable: true })
    Object.defineProperties(event, {
      target: { value: element },
      touches: { value: Array.from({ length: type === 'touchend' ? 0 : fingers }, (_, i) => ({ identifier: i, clientX: x, clientY: y })) },
      changedTouches: { value: [{ identifier: 0, clientX: x, clientY: y }] }
    })
    target.dispatchEvent(event)
    return event
  }
  return { opened, send, uninstall, tick: (ms: number) => { time += ms }, select: () => { selected = true } }
}

test('a wikilink opens only after a completed short tap (#50)', () => {
  const s = setup()
  s.send('touchstart')
  assert.deepEqual(s.opened, [])
  s.tick(100)
  assert.equal(s.send('touchend').defaultPrevented, true)
  assert.deepEqual(s.opened, ['A note'])
  s.uninstall()
})

for (const action of ['drag', 'long drag', 'long press', 'selection', 'existing selection', 'scroll', 'cancel', 'multitouch']) {
  test(`a ${action} does not activate a wikilink or its synthesized mouse event`, () => {
    const s = setup()
    if (action === 'existing selection') s.select()
    s.send('touchstart')
    if (action === 'drag') s.send('touchmove', 20, 70)
    if (action === 'long drag') { s.send('scroll'); s.tick(2000) }
    if (action === 'long press') s.tick(600)
    if (action === 'selection') s.select()
    if (action === 'scroll') s.send('scroll')
    if (action === 'cancel') s.send('touchcancel')
    if (action === 'multitouch') s.send('touchstart', 20, 20, 2)
    s.send('touchend')
    assert.deepEqual(s.opened, [])
    assert.equal(s.send('mousedown').defaultPrevented, true)
    s.tick(900)
    assert.equal(s.send('mousedown').defaultPrevented, false)
    s.uninstall()
  })
}

test('cleanup removes gesture listeners', () => {
  const s = setup()
  s.uninstall()
  s.send('touchstart')
  s.send('touchend')
  assert.deepEqual(s.opened, [])
})
