import assert from 'node:assert/strict'
import test from 'node:test'
import type { WidgetNoteSource, WidgetTaskSource } from './widget-snapshot.ts'
import {
  FALLBACK_WIDGET_THEME,
  channelsToHex,
  filterLiveTasks,
  selectWidgetNotes,
  selectWidgetTasks,
  themeFromTokens
} from './widget-snapshot.ts'

function note(
  path: string,
  updatedAt: number,
  folder: WidgetNoteSource['folder'] = 'inbox',
  title = path.replace(/^.*\//, '').replace(/\.md$/, '')
): WidgetNoteSource {
  return { path, title, folder, updatedAt }
}

test('pinned notes lead in pin order, then recents newest first', () => {
  const notes = [
    note('inbox/Old.md', 100),
    note('inbox/Newest.md', 900),
    note('inbox/Pinned B.md', 300),
    note('inbox/Pinned A.md', 200),
    note('inbox/Middle.md', 500)
  ]
  const out = selectWidgetNotes(notes, ['inbox/Pinned B.md', 'inbox/Pinned A.md'])
  assert.deepEqual(
    out.map((n) => [n.path, n.pinned]),
    [
      ['inbox/Pinned B.md', true],
      ['inbox/Pinned A.md', true],
      ['inbox/Newest.md', false],
      ['inbox/Middle.md', false],
      ['inbox/Old.md', false]
    ]
  )
})

test('trash and archive never show; a stale pin is skipped; the cap holds', () => {
  const notes = [
    note('trash/Gone.md', 999, 'trash'),
    note('archive/Done.md', 998, 'archive'),
    note('inbox/A.md', 3),
    note('inbox/B.md', 2),
    note('inbox/C.md', 1)
  ]
  const out = selectWidgetNotes(notes, ['inbox/Missing.md', 'trash/Gone.md'], 2)
  assert.deepEqual(
    out.map((n) => n.path),
    ['inbox/A.md', 'inbox/B.md']
  )
  assert.equal(out.every((n) => !n.pinned), true)
})

test('an empty title reads Untitled and pins are not duplicated as recents', () => {
  const out = selectWidgetNotes([note('inbox/x.md', 1, 'inbox', '   ')], ['inbox/x.md'])
  assert.deepEqual(out, [
    { path: 'inbox/x.md', title: 'Untitled', folder: 'inbox', updatedAt: 1, pinned: true }
  ])
})

test('channel triplets become hex; anything else is rejected', () => {
  assert.equal(channelsToHex('29 32 33'), '#1d2021')
  assert.equal(channelsToHex(' 255 255 255 '), '#ffffff')
  assert.equal(channelsToHex('0 0 0'), '#000000')
  assert.equal(channelsToHex(''), null)
  assert.equal(channelsToHex('#1d2021'), null)
  assert.equal(channelsToHex('300 0 0'), null)
})

test('the theme reads every token it can and falls back per token', () => {
  const tokens: Record<string, string> = {
    '--z-bg': '251 241 199',
    '--z-accent': '195 94 10',
    '--z-red': 'not a color'
  }
  const theme = themeFromTokens((t) => tokens[t] ?? '', 'light')
  assert.equal(theme.mode, 'light')
  assert.equal(theme.bg, '#fbf1c7')
  assert.equal(theme.accent, '#c35e0a')
  assert.equal(theme.red, FALLBACK_WIDGET_THEME.red)
  assert.equal(theme.fg, FALLBACK_WIDGET_THEME.fg)
})

function task(
  id: string,
  content: string,
  extra: Partial<WidgetTaskSource> = {}
): WidgetTaskSource {
  const sourcePath = id.slice(0, id.lastIndexOf('#'))
  return {
    id,
    sourcePath,
    noteTitle: sourcePath.replace(/^.*\//, '').replace(/\.md$/, ''),
    content,
    inProgress: false,
    ...extra
  }
}

test('overdue tasks lead, the rest keep the bucket order, and counts cover the cut-off rows', () => {
  const today = [
    task('inbox/A.md#1', 'Due today', { due: '2026-09-08', inProgress: true }),
    task('inbox/B.md#0', '  Undated  ', { priority: 'high' }),
    task('inbox/A.md#0', 'Overdue thing', { due: '2026-09-05' }),
    task('inbox/C.md#0', 'Older overdue', { due: '2026-09-01' })
  ]
  const { tasks, counts } = selectWidgetTasks(today, 2, '2026-09-08', 3)
  assert.deepEqual(counts, { today: 4, overdue: 2 })
  assert.deepEqual(
    tasks.map((t) => t.content),
    ['Overdue thing', 'Older overdue', 'Due today']
  )
  assert.deepEqual(tasks[0], {
    id: 'inbox/A.md#0',
    path: 'inbox/A.md',
    noteTitle: 'A',
    content: 'Overdue thing',
    due: '2026-09-05',
    overdue: true,
    inProgress: false,
    priority: null
  })
  assert.equal(tasks[2]!.overdue, false)
  assert.equal(tasks[2]!.inProgress, true)
  const all = selectWidgetTasks(today, 2, '2026-09-08').tasks
  assert.equal(all[3]!.content, 'Undated')
  assert.equal(all[3]!.due, null)
  assert.equal(all[3]!.priority, 'high')
})

test('tasks from deleted or trashed notes are dropped', () => {
  const tasks = [
    { sourcePath: 'inbox/Keep.md', id: 'k' },
    { sourcePath: 'trash/Bin.md', id: 't' },
    { sourcePath: 'inbox/Gone.md', id: 'g' }
  ]
  const notes = [note('inbox/Keep.md', 1), note('trash/Bin.md', 1, 'trash')]
  assert.deepEqual(
    filterLiveTasks(tasks, notes).map((t) => t.id),
    ['k']
  )
})
