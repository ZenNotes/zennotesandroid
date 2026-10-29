import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

const core = (path: string): string =>
  readFileSync(new URL(`../../node_modules/@zennotes/app-core/dist/${path}`, import.meta.url), 'utf8')
const readOpen = readFileSync(new URL('./read-open.ts', import.meta.url), 'utf8')

describe('the Columns menu find field on a phone', () => {
  it('core focuses the field as the menu opens (a change there fails here at the next adoption)', () => {
    const menu = core('components/DatabaseColumnsMenu.js')
    assert.match(menu, /"aria-label": "Find a column"/)
    assert.match(menu, /findRef\.current\?\.focus\(\)/)
  })

  it('the shell refuses that focus unless the field itself was touched', () => {
    assert.match(readOpen, /const NO_AUTOFOCUS_FIELDS = 'input\[aria-label="Find a column"\]'/)
    assert.match(readOpen, /if \(isPhoneViewport\(\) && this\.matches\(NO_AUTOFOCUS_FIELDS\) && touchedField !== this\) return/)
    assert.match(readOpen, /touchedField = event\.target instanceof Element \? event\.target\.closest\(NO_AUTOFOCUS_FIELDS\) : null/)
  })
})

describe('a callout menu pick on a phone', () => {
  it('core focuses the editor after the pick (a change there fails here at the next adoption)', () => {
    const pane = core('components/EditorPane.js')
    assert.match(pane, /title: "Callout type"/)
    assert.match(pane, /setCalloutType\(view, calloutMenu\.range, choice\.type\);\s*view\.focus\(\)/)
    assert.match(core('lib/callout-transform.js'), /label: 'Remove callout'/)
    const contextMenu = core('components/ContextMenu.js')
    assert.match(contextMenu, /"data-ctx-menu": true, role: "menu", "aria-label": title/)
  })

  it('the shell arms the read-open hold on those rows, so the keyboard stays down', () => {
    assert.match(readOpen, /const KEEP_DOWN_MENU_ROWS = '\[data-ctx-menu\]\[aria-label="Callout type"\] \[role\^="menuitem"\]'/)
    assert.match(readOpen, /const KEEP_DOWN_MENU_LABELS = \['Remove callout'\]/)
    assert.match(readOpen, /if \(isPhoneViewport\(\) && \(opensToRead\(event\.target\) \|\| keepsKeyboardDown\(event\.target\)\)\) hold\.arm\(\)/)
  })
})
