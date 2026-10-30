import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

const core = (path: string): string =>
  readFileSync(new URL(`../../node_modules/@zennotes/app-core/dist/${path}`, import.meta.url), 'utf8')
const readOpen = readFileSync(new URL('./read-open.ts', import.meta.url), 'utf8')

describe('the Columns menu find field on a phone', () => {
  it('core leaves the field alone as the menu opens on a host that opens notes to read (core 2.80)', () => {
    // Core 2.80 took this guard over (ZenNotes/zennotes 1956a8a2); the shell's
    // stays as a second line until both phone shells drop it together.
    const menu = core('components/DatabaseColumnsMenu.js')
    assert.match(menu, /"aria-label": "Find a column"/)
    assert.match(menu, /else if \(!hostOpensNotesToRead\(\)\)\s*findRef\.current\?\.focus\(\)/)
  })

  it('the shell refuses that focus unless the field itself was touched', () => {
    assert.match(readOpen, /const NO_AUTOFOCUS_FIELDS = 'input\[aria-label="Find a column"\]'/)
    assert.match(readOpen, /if \(isPhoneViewport\(\) && this\.matches\(NO_AUTOFOCUS_FIELDS\) && touchedField !== this\) return/)
    assert.match(readOpen, /touchedField = event\.target instanceof Element \? event\.target\.closest\(NO_AUTOFOCUS_FIELDS\) : null/)
  })
})

describe('a callout menu pick on a phone', () => {
  it('core leaves the editor unfocused after the pick on a host that opens notes to read (core 2.80)', () => {
    // Core 2.80 took this guard over too; the shell's stays as a second line.
    const pane = core('components/EditorPane.js')
    assert.match(pane, /title: "Callout type"/)
    assert.match(pane, /setCalloutType\(view, calloutMenu\.range, choice\.type\);[^]*?if \(!hostOpensNotesToRead\(\)\)\s*view\.focus\(\)/)
    assert.match(pane, /removeCalloutIn\(view, calloutRange\);[^]*?if \(!hostOpensNotesToRead\(\)\)\s*view\.focus\(\)/)
    // The phone layout is such a host (editor-host.ts).
    assert.match(readFileSync(new URL('./editor-host.ts', import.meta.url), 'utf8'), /openNotesToRead: isPhoneViewport/)
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
