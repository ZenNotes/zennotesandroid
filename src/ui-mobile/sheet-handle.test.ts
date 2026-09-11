import assert from 'node:assert/strict'
import test from 'node:test'
import { loadMobileModule } from '../../tooling/load-mobile-module.ts'

const { SheetHandle } = await loadMobileModule('./src/ui-mobile/SheetHandle.tsx', {
  react: { useRef: (current: unknown) => ({ current }) },
  'react/jsx-runtime': { jsx: (type: unknown, props: unknown) => ({ type, props }) }
})

function setup() {
  let dismissed = 0
  const style = new Map<string, string>()
  const attributes = new Set<string>()
  const sheet = { style: { setProperty: (k: string, v: string) => style.set(k, v), removeProperty: (k: string) => style.delete(k) },
    setAttribute: (k: string) => attributes.add(k), removeAttribute: (k: string) => attributes.delete(k) }
  const target = { closest: () => sheet, setPointerCapture: () => {} }
  const handle = SheetHandle({ onDismiss: () => { dismissed++ } }).props
  const event = (x: number, y: number, timeStamp: number) => ({
    isPrimary: true, button: 0, pointerId: 1, clientX: x, clientY: y, timeStamp, currentTarget: target
  })
  return { handle, event, style, attributes, dismissals: () => dismissed }
}
test('real sheet handle handlers move the sheet and dismiss exactly once', () => {
  const s = setup()
  s.handle.onPointerDown(s.event(50, 10, 0))
  s.handle.onPointerMove(s.event(50, 110, 500))
  assert.equal(s.style.get('--zn-sheet-drag'), '100px')
  assert.equal(s.attributes.has('data-dragging'), true)
  s.handle.onPointerUp(s.event(50, 110, 600))
  s.handle.onClick({ detail: 1 })
  assert.equal(s.dismissals(), 1)
  assert.equal(s.style.has('--zn-sheet-drag'), false)
  assert.equal(s.attributes.has('data-dragging'), false)
})
test('short/cancelled drags snap back and do not become close-button clicks', () => {
  for (const cancel of [true, false]) {
    const s = setup()
    s.handle.onPointerDown(s.event(50, 10, 0))
    s.handle.onPointerMove(s.event(50, 30, 500))
    if (cancel) s.handle.onPointerCancel()
    else s.handle.onPointerUp(s.event(50, 30, 600))
    s.handle.onClick({ detail: 1 })
    assert.equal(s.dismissals(), 0)
    assert.equal(s.style.has('--zn-sheet-drag'), false)
    s.handle.onClick({ detail: 0 })
    assert.equal(s.dismissals(), 1, 'keyboard activation still closes')
  }
})
