import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createTagsEmptyStateTracker,
  type TagsEmptyStateSnapshot,
  type TagsHintActiveNote,
  type TagsHintNote
} from './tags-empty-state.ts'

const liveTags = (
  note: TagsHintNote,
  active: TagsHintActiveNote | null | undefined
): readonly string[] => {
  if (active?.path !== note.path) return note.tags
  return [...active.body.matchAll(/(?:^|\s)#([\w/-]+)/g)].map((match) => match[1]!)
}

const snapshot = (
  notes: readonly TagsHintNote[],
  activeNote: TagsHintActiveNote | null = null,
  vaultRoot = '/vault',
  indexReady = false
): TagsEmptyStateSnapshot => ({
  vaultRoot,
  notes,
  activeNote,
  preambleFolder: 'Preambles',
  indexReady
})

test('settles an indexed empty vault as tagless', () => {
  const initial = snapshot([])
  const tracker = createTagsEmptyStateTracker(initial, liveTags)

  assert.equal(tracker.getState(), 'loading')
  assert.equal(tracker.update(snapshot([])), true)
  assert.equal(tracker.getState(), 'tagless')
})

test('recognizes an empty index that landed before the tracker mounted', () => {
  const tracker = createTagsEmptyStateTracker(snapshot([], null, '/vault', true), liveTags)

  assert.equal(tracker.getState(), 'tagless')
})

test('uses the live active-note buffer instead of stale indexed tags', () => {
  const notes = [{ path: 'inbox/Note.md', folder: 'inbox', tags: ['old'] }]
  const tracker = createTagsEmptyStateTracker(snapshot(notes), liveTags)

  assert.equal(tracker.getState(), 'tagged')
  assert.equal(
    tracker.update(snapshot(notes, { path: 'inbox/Note.md', body: 'tag removed' })),
    true
  )
  assert.equal(tracker.getState(), 'tagless')
  assert.equal(
    tracker.update(snapshot(notes, { path: 'inbox/Note.md', body: 'now #fresh' })),
    true
  )
  assert.equal(tracker.getState(), 'tagged')
})

test('does not rescan the note index for unrelated updates or each active edit', () => {
  const notes = [
    { path: 'inbox/One.md', folder: 'inbox', tags: [] },
    { path: 'inbox/Two.md', folder: 'inbox', tags: ['keep'] },
    { path: 'inbox/Three.md', folder: 'inbox', tags: [] }
  ]
  let calls = 0
  const countingTags = (
    note: TagsHintNote,
    active: TagsHintActiveNote | null | undefined
  ): readonly string[] => {
    calls += 1
    return liveTags(note, active)
  }
  const initial = snapshot(notes, { path: 'inbox/One.md', body: '' })
  const tracker = createTagsEmptyStateTracker(initial, countingTags)
  const initialCalls = calls

  assert.equal(tracker.update(initial), false)
  assert.equal(calls, initialCalls)

  assert.equal(
    tracker.update(snapshot(notes, { path: 'inbox/One.md', body: 'ordinary edit' })),
    false
  )
  assert.equal(calls, initialCalls + 1)
  assert.equal(tracker.getState(), 'tagged')
})

test('returns to loading until the newly selected vault index lands', () => {
  const notes = [{ path: 'inbox/Note.md', folder: 'inbox', tags: ['tag'] }]
  const tracker = createTagsEmptyStateTracker(snapshot(notes), liveTags)

  assert.equal(tracker.update(snapshot([], null, '/other-vault')), true)
  assert.equal(tracker.getState(), 'loading')
  assert.equal(tracker.update(snapshot([], null, '/other-vault')), true)
  assert.equal(tracker.getState(), 'tagless')
})
