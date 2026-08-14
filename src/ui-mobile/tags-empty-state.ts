export type TagsEmptyState = 'loading' | 'tagless' | 'tagged'

export interface TagsHintNote {
  path: string
  folder: string
  tags: readonly string[]
}

export interface TagsHintActiveNote {
  path: string
  body: string
}

export interface TagsEmptyStateSnapshot {
  vaultRoot: string | null
  notes: readonly TagsHintNote[]
  activeNote: TagsHintActiveNote | null | undefined
  preambleFolder: string
  /** True once the bridge has completed at least one listNotes for this vault. */
  indexReady: boolean
}

type TagsForNote = (
  note: TagsHintNote,
  activeNote: TagsHintActiveNote | null | undefined,
  preambleFolder: string
) => readonly string[]

export interface TagsEmptyStateTracker {
  getState(): TagsEmptyState
  /** Returns true only when the empty-state copy needs to be reapplied. */
  update(next: TagsEmptyStateSnapshot): boolean
}

function sameActiveNote(
  left: TagsHintActiveNote | null | undefined,
  right: TagsHintActiveNote | null | undefined
): boolean {
  return left?.path === right?.path && left?.body === right?.body
}

/**
 * Tracks only the inputs used by app-core's TagView. The full note index is
 * rebuilt when the index itself changes; a live editor update checks only the
 * active note, and unrelated Zustand updates do no work.
 */
export function createTagsEmptyStateTracker(
  initial: TagsEmptyStateSnapshot,
  tagsForNote: TagsForNote
): TagsEmptyStateTracker {
  let vaultRoot = initial.vaultRoot
  let notes = initial.notes
  let activeNote = initial.activeNote
  let preambleFolder = initial.preambleFolder
  let indexReady = initial.indexReady || (vaultRoot !== null && notes.length > 0)
  let noteByPath = new Map<string, TagsHintNote>()
  let indexedTaggedPaths = new Set<string>()

  const rebuildIndex = (): void => {
    noteByPath = new Map()
    indexedTaggedPaths = new Set()
    for (const note of notes) {
      if (note.folder === 'trash') continue
      noteByPath.set(note.path, note)
      if (tagsForNote(note, null, preambleFolder).length > 0) {
        indexedTaggedPaths.add(note.path)
      }
    }
  }

  const deriveSettledState = (): TagsEmptyState => {
    let taggedNotes = indexedTaggedPaths.size
    const activeMeta = activeNote ? noteByPath.get(activeNote.path) : undefined
    if (activeMeta && activeNote) {
      if (indexedTaggedPaths.has(activeMeta.path)) taggedNotes -= 1
      if (tagsForNote(activeMeta, activeNote, preambleFolder).length > 0) taggedNotes += 1
    }
    return taggedNotes > 0 ? 'tagged' : 'tagless'
  }

  rebuildIndex()
  let state: TagsEmptyState = indexReady ? deriveSettledState() : 'loading'

  return {
    getState: () => state,
    update: (next) => {
      const vaultChanged = next.vaultRoot !== vaultRoot
      const notesChanged = next.notes !== notes
      const preambleChanged = next.preambleFolder !== preambleFolder
      const activeChanged = !sameActiveNote(next.activeNote, activeNote)
      if (!vaultChanged && !notesChanged && !preambleChanged && !activeChanged) return false

      const previousState = state
      vaultRoot = next.vaultRoot
      notes = next.notes
      activeNote = next.activeNote
      preambleFolder = next.preambleFolder

      if (vaultChanged) {
        // The store clears notes while switching vaults. Wait for the next
        // note-array replacement, which is refreshNotes landing (including an
        // authoritative empty array for a genuinely empty vault).
        indexReady = next.indexReady
        rebuildIndex()
        state = 'loading'
        return state !== previousState
      }

      if (notesChanged) indexReady = vaultRoot !== null
      if (notesChanged || preambleChanged) rebuildIndex()
      state = indexReady ? deriveSettledState() : 'loading'
      return state !== previousState
    }
  }
}
