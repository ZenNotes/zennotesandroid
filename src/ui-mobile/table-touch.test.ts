import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import postcss from 'postcss'

// Core 2.81.0 shows hover-only controls where nothing can hover. On a phone
// the database Table's row Open then sat over the end of every long name, and
// the always-shown select boxes lost their column to a long title.

const css = postcss.parse(readFileSync(new URL('./mobile.css', import.meta.url), 'utf8'))
const table = readFileSync(
  new URL('../../node_modules/@zennotes/app-core/dist/components/DatabaseTableView.js', import.meta.url),
  'utf8'
)

function declaration(selector: string, property: string): string | undefined {
  let result: string | undefined
  css.walkRules((rule) => {
    if (!rule.selectors.includes(selector)) return
    rule.walkDecls(property, (decl) => { result = decl.value })
  })
  return result
}

describe('the database Table on a phone', () => {
  it('drops the row Open that covered long names; the page glyph opens the page', () => {
    assert.equal(
      declaration(".zn-mobile.zn-phone tr.group\\/row td button.zn-hover-reveal[title='Open page']", 'display'),
      'none'
    )
    assert.match(table, /zn-hover-reveal absolute right-1\.5/)
    assert.match(table, /title: hasContent \? 'Open page' : 'Open page \(empty\)'/)
  })

  it('keeps the select column wide enough for its box', () => {
    assert.equal(declaration('.zn-mobile.zn-phone th.group\\/sa.w-10', 'min-width'), '2.5rem')
    assert.equal(declaration('.zn-mobile.zn-phone tr.group\\/row > td.w-10:first-child', 'min-width'), '2.5rem')
    assert.match(table, /group\/sa w-10/)
  })
})
