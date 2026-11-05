import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

// A record page opened from the database Table's page glyph opens to read,
// keyboard down, like a note from a Kanban card: its first Back used to only
// lower the keyboard, so leaving took two.

const readOpen = readFileSync(new URL('./read-open.ts', import.meta.url), 'utf8')
const table = readFileSync(
  new URL('../../node_modules/@zennotes/app-core/dist/components/DatabaseTableView.js', import.meta.url),
  'utf8'
)

describe("the database Table's page glyph", () => {
  it('opens its record page to read', () => {
    assert.match(readOpen, /const READ_PAGE_BUTTONS = 'tr\.group\\\\\/row button\[title\^="Open page"\]'/)
    assert.match(readOpen, /if \(target\.closest\(READ_CARDS\)\) return true\n\s*if \(target\.closest\(READ_PAGE_BUTTONS\)\) return true/)
  })

  it("matches core's row and its page buttons", () => {
    assert.match(table, /'group\/row border-b border-paper-300\/30'/)
    assert.match(table, /title: hasContent \? 'Open page' : 'Open page \(empty\)'/)
  })
})

// A link in a Markdown table cell followed from mousedown, with the cell editable
// under it, and opened its note with the keyboard up, where a link outside a table
// opens it down.
const tableWidget = readFileSync(
  new URL('../../node_modules/@zennotes/app-core/dist/lib/cm-table.js', import.meta.url),
  'utf8'
)

describe('a link in a Markdown table cell', () => {
  it('arms the hold on the touch, after the release every touch does', () => {
    assert.match(readOpen, /const TABLE_CELL_LINKS = '\.cm-table-cell a'/)
    assert.match(readOpen, /hold\.release\(\)\n\s*if \(isPhoneViewport\(\) && event\.target instanceof Element && event\.target\.closest\(TABLE_CELL_LINKS\)\) hold\.arm\(\)/)
  })

  it("matches core's cell class", () => {
    assert.match(tableWidget, /\.className = 'cm-table-cell'/)
  })
})
