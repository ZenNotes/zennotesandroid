import assert from 'node:assert/strict'
import test from 'node:test'
import { selectionToolbarInset } from './selection-toolbar-space.ts'

const editor = { top: 60, bottom: 440, left: 0, right: 390 }
test('selection menu gets real editor space, not just scroll padding (#51)', () => {
  assert.equal(selectionToolbarInset(editor, { top: 290, bottom: 410, left: 61, right: 329 }), 158)
})
test('selection clearance follows keyboard resize and menu growth', () => {
  assert.equal(selectionToolbarInset({ ...editor, bottom: 340 }, { top: 190, bottom: 310, left: 61, right: 329 }), 158)
  assert.equal(selectionToolbarInset(editor, { top: 250, bottom: 410, left: 61, right: 329 }), 198)
})
test('hidden, external, or nonoverlapping menus reserve no space', () => {
  assert.equal(selectionToolbarInset(editor, null), 0)
  assert.equal(selectionToolbarInset(editor, { top: 450, bottom: 570, left: 61, right: 329 }), 0)
  assert.equal(selectionToolbarInset(editor, { top: 290, bottom: 410, left: 400, right: 668 }), 0)
  assert.equal(selectionToolbarInset({ ...editor, bottom: 280 }, { top: 290, bottom: 410, left: 61, right: 329 }), 0)
})
