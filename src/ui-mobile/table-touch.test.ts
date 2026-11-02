import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import postcss from 'postcss'

// Core 2.81.1 keeps the database Table clear on a touch screen, so the shell
// no longer has to. These pin what it relies on: the row's hover Open, laid
// over the end of the name cell, is gone where nothing can hover, and the
// select column, its box always shown, keeps its 40 px against a long title.

const coreDist = new URL('../../node_modules/@zennotes/app-core/dist/', import.meta.url)
const table = readFileSync(new URL('components/DatabaseTableView.js', coreDist), 'utf8')
const view = readFileSync(new URL('components/DatabaseView.js', coreDist), 'utf8')
const button = readFileSync(new URL('components/ui/Button.js', coreDist), 'utf8')
const shell = postcss.parse(readFileSync(new URL('./mobile.css', import.meta.url), 'utf8'))
const coreCss = postcss.parse(readFileSync(new URL('styles/index.css', coreDist), 'utf8'))

function displayWhereNothingHovers(selector: string): string | undefined {
  let result: string | undefined
  coreCss.walkAtRules('media', (media) => {
    if (media.params !== 'not all and (hover: hover) and (pointer: fine)') return
    media.walkRules(selector, (rule) => {
      rule.walkDecls('display', (decl) => { result = `${decl.value}${decl.important ? ' !important' : ''}` })
    })
  })
  return result
}

describe('the database Table on a touch screen', () => {
  it('has no row Open over long names; the page glyph opens the page', () => {
    assert.match(table, /title: "Open page", className: "zn-hover-only absolute right-1\.5/)
    assert.equal(displayWhereNothingHovers('.zn-hover-only'), 'none !important')
    assert.match(table, /title: hasContent \? 'Open page' : 'Open page \(empty\)'/)
  })

  it('keeps the select column wide enough for its box', () => {
    assert.match(table, /"group\/sa w-10 min-w-10 /)
    assert.match(table, /_jsx\("td", \{ className: "w-10 min-w-10 /)
  })
})

describe('the database header on a phone', () => {
  const tools = ".zn-mobile.zn-phone header.glass-header:has(button[title='Toggle the underlying CSV text']) > .ml-auto"

  function shellDeclaration(selector: string, property: string): string | undefined {
    let result: string | undefined
    shell.walkRules((rule) => {
      if (rule.selector.replace(/\s+/g, ' ') !== selector) return
      rule.walkDecls(property, (decl) => { result = decl.value })
    })
    return result
  }

  it('holds the tools core wraps on one line, so the ... menu keeps its place beside them', () => {
    assert.match(view, /"ml-auto flex max-w-full flex-wrap items-center justify-end gap-1\.5"/)
    assert.match(button, /px-3/)
    assert.equal(shellDeclaration(tools, 'column-gap'), '0.25rem')
    assert.equal(shellDeclaration(`${tools} > button.px-3`, 'padding-inline'), '0.375rem')
  })
})
