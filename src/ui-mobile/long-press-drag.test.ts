import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

describe('A long-press drag on the phone layout', () => {
  const shell = readFileSync(new URL('./MobileShell.tsx', import.meta.url), 'utf8')
  const board = readFileSync(
    new URL('../../node_modules/@zennotes/app-core/dist/components/DatabaseBoardView.js', import.meta.url),
    'utf8'
  )
  const suppress = shell.slice(shell.indexOf('const suppressDrag = '), shell.indexOf("document.addEventListener('contextmenu', onContextMenu, true)"))

  it('is cancelled before app-core hears of it', () => {
    assert.match(suppress, /if \(!isPhoneWidth\(\)\) return\n\s+e\.preventDefault\(\)\n\s+e\.stopPropagation\(\)/)
    assert.match(shell, /document\.addEventListener\('dragstart', suppressDrag, true\)/)
  })

  it('matters because a Board card dims on dragstart until a dragend', () => {
    assert.match(board, /onDragStart: \(\) => setDragRow\(row\.id\), onDragEnd: \(\) => setDragRow\(null\)/)
    assert.match(board, /dragRow === row\.id \? 'opacity-50'/)
  })
})
