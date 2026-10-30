import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

// Opening a note from a Kanban card raised the soft keyboard over it on a
// phone: core opens the note from a tap on the card, its title, its open
// arrow or (core 2.80) a subtask line, and follows the open with an editor
// focus, as the Tasks list does. The list's rows already arm read-open.ts's
// hold; the board's cards now do too.

const kanban = readFileSync(new URL('../../node_modules/@zennotes/app-core/dist/components/TasksKanban.js', import.meta.url), 'utf8')
const readOpen = readFileSync(new URL('./read-open.ts', import.meta.url), 'utf8')

describe('a Kanban card on a phone', () => {
  it('core opens the note from a tap on the card, its title, its arrow and a subtask line (a change there fails here at the next adoption)', () => {
    assert.match(kanban, /"data-kanban-task-id": taskDomId/)
    assert.match(kanban, /onClick: \(\) => \{\s*if \(shouldSuppressClick\(\)\)\s*return;\s*onClickRow\(\);\s*onOpen\(\);/)
    assert.match(kanban, /"aria-label": `Open \$\{task\.noteTitle\}`/)
    assert.match(kanban, /onFocusSubtask\?\.\(subtask\);\s*onOpenSubtask\?\.\(subtask\);/)
  })

  it('arms the read-open hold, so the note opens with the keyboard down', () => {
    assert.match(readOpen, /const READ_CARDS = '\[data-kanban-task-id\]'/)
    assert.match(readOpen, /function opensToRead\(target: EventTarget \| null\): boolean \{\s*if \(!\(target instanceof Element\)\) return false\s*if \(target\.closest\(READ_CARDS\)\) return true/)
  })
})
