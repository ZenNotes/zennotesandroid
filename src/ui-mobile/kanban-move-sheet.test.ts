import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

describe("The Tasks board's Move to… sheet", () => {
  const shell = readFileSync(new URL('./MobileShell.tsx', import.meta.url), 'utf8')
  const kanban = readFileSync(
    new URL('../../node_modules/@zennotes/app-core/dist/components/TasksKanban.js', import.meta.url),
    'utf8'
  )
  const sheet = shell.slice(shell.indexOf('function KanbanMoveSheet('), shell.indexOf("window.addEventListener('zen:kanban-move', onMove)"))

  it("names a column by its header's title before the id map", () => {
    assert.match(sheet, /label: kanbanColumnHeaderTitle\(id\) \?\? kanbanColumnLabel\(groupBy, id\)/)
    assert.match(shell, /col\.querySelector\('\[data-kanban-column-header\] \.truncate'\)\?\.textContent\?\.trim\(\)/)
  })

  it('offers each column once when lanes repeat its id', () => {
    assert.match(sheet, /const targets = \[\.\.\.new Set\(cols\)\]/)
  })

  it('reads the title core puts in the column header', () => {
    assert.match(kanban, /"data-kanban-column-header": true/)
    assert.match(kanban, /className: "truncate text-xs font-semibold uppercase tracking-wide text-current\/70", children: column\.label/)
    assert.match(kanban, /"data-kanban-column-id": cell\.id, "data-kanban-lane-id": lane\.id/)
  })
})
