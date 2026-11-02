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
