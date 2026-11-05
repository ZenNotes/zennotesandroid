import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { NOTE_TITLE_FIELD, toolbarModeFor } from './toolbar-mode.ts'

const el = (inside: string[], is: string[] = []) => ({
  closest: (selector: string) => (inside.includes(selector) ? {} : null),
  matches: (selector: string) => is.includes(selector)
})

describe('the toolbar above the keyboard', () => {
  it('formats in the editor, on a phone and a tablet', () => {
    assert.equal(toolbarModeFor(el(['.cm-editor']), true), 'format')
    assert.equal(toolbarModeFor(el(['.cm-editor']), false), 'format')
  })

  it('stays off the editor search panel', () => {
    assert.equal(toolbarModeFor(el(['.cm-editor', '.cm-panel']), true), null)
  })

  it('offers the chevron alone in the note title field, on a phone', () => {
    assert.equal(toolbarModeFor(el([], [NOTE_TITLE_FIELD]), true), 'dismiss')
    assert.equal(toolbarModeFor(el([], [NOTE_TITLE_FIELD]), false), null)
  })

  it('is off for any other field', () => {
    assert.equal(toolbarModeFor(el([]), true), null)
    assert.equal(toolbarModeFor(null, true), null)
  })

  it('core still marks the field, and the shell still blurs to dismiss', () => {
    const core = readFileSync(new URL('../../node_modules/@zennotes/app-core/dist/components/EditorPane.js', import.meta.url), 'utf8')
    assert.match(core, /"data-note-title-input": ""/)
    const toolbar = readFileSync(new URL('./EditorToolbar.tsx', import.meta.url), 'utf8')
    assert.match(toolbar, /active\.blur\(\)/)
    assert.match(toolbar, /mode === 'format' && BUTTONS\.map/)
  })
})
