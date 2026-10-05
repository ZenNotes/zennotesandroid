import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadMobileModule } from '../../tooling/load-mobile-module.ts'

// A note's two app-owned sidecars, at the paths desktop writes them
// (apps/desktop/src/main/note-sidecars.ts and note-creation-metadata.ts). A
// rename or move that leaves either behind loses the comments and the
// creation date on every device, and Cloud sync carries the orphan around.
const comments = (rel: string): string => `.zennotes/comments/${rel}.comments.json`
const created = (rel: string): string => `.zennotes/note-metadata/${rel}.metadata.json`

Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null } })
const { MobileVault, DEFAULT_VAULT_SETTINGS } = await loadMobileModule([
  './src/bridge/vault-fs', './src/bridge/native-fs', '@zennotes/bridge-contract/ipc'
])

/** The NativeFs surface MobileVault uses. Like the providers, a rename never
 *  overwrites and a delete of a missing file fails. */
class MemoryFs {
  files = new Map<string, string>()
  directories = new Set<string>()
  failMove: ((from: string, to: string) => boolean) | null = null
  async statVerified(path: string): Promise<'file' | 'directory' | null> {
    if (this.files.has(path)) return 'file'
    const inside = (key: string): boolean => key.startsWith(`${path}/`)
    return this.directories.has(path) || [...this.files.keys()].some(inside) ? 'directory' : null
  }
  async exists(path: string): Promise<boolean> { return await this.statVerified(path) !== null }
  async mkdir(path: string): Promise<void> { this.directories.add(path) }
  async readText(path: string): Promise<string> {
    const body = this.files.get(path)
    if (body === undefined) throw new Error(`File does not exist: ${path}`)
    return body
  }
  async readTextOrNull(path: string): Promise<string | null> { return this.files.get(path) ?? null }
  async writeText(path: string, body: string): Promise<void> { this.files.set(path, body) }
  async deleteFile(path: string): Promise<void> {
    if (!this.files.delete(path)) throw new Error(`File does not exist: ${path}`)
  }
  async rmdir(path: string): Promise<void> {
    for (const key of [...this.files.keys()]) if (key === path || key.startsWith(`${path}/`)) this.files.delete(key)
    for (const key of [...this.directories]) if (key === path || key.startsWith(`${path}/`)) this.directories.delete(key)
  }
  async rename(from: string, to: string): Promise<void> {
    if (this.failMove?.(from, to)) throw new Error('Provider refused move')
    assert.ok(await this.exists(from), `nothing to move at ${from}`)
    assert.equal(await this.exists(to), false, `a move must never overwrite ${to}`)
    const moved = (key: string): boolean => key === from || key.startsWith(`${from}/`)
    for (const [key, body] of [...this.files]) {
      if (!moved(key)) continue
      this.files.delete(key)
      this.files.set(to + key.slice(from.length), body)
    }
    for (const key of [...this.directories]) {
      if (!moved(key)) continue
      this.directories.delete(key)
      this.directories.add(to + key.slice(from.length))
    }
  }
}

const NOTE_BODY = '# One\n\nExact café 日本語.\n'
const COMMENTS_BODY = '{"version":1,"comments":[{"id":"c1","body":"keep me"}]}'
const CREATED_BODY = '{"version":1,"createdAt":1726000000000}\n'

/** One note with both sidecars, in a vault whose system folders are remapped
 *  (inbox `Notes`, archive `Old`, trash `Bin`), or with the inbox at the root. */
function fixture(rootMode = false) {
  const fs = new MemoryFs()
  const vault = new MobileVault('Fixture')
  Object.assign(vault, {
    fs,
    settingsCache: {
      ...structuredClone(DEFAULT_VAULT_SETTINGS),
      primaryNotesLocation: rootMode ? 'root' : 'inbox',
      systemFolderPaths: { inbox: 'Notes', archive: 'Old', trash: 'Bin', quick: 'Capture' }
    },
    listNotes: async () => [],
    invalidateMeta: () => {},
    metaForPath: async (path: string) => ({ path, title: path.split('/').pop() })
  })
  const primary = rootMode ? '' : 'Notes/'
  const note = `${primary}Work/One.md`
  fs.files.set(note, NOTE_BODY)
  fs.files.set(comments(note), COMMENTS_BODY)
  fs.files.set(created(note), CREATED_BODY)
  return { fs, vault, primary, note, original: new Map(fs.files) }
}

/** The note and both sidecars sit at `to`, byte for byte, and nothing at `from`. */
function assertCarried(fs: MemoryFs, from: string, to: string): void {
  assert.equal(fs.files.get(to), NOTE_BODY)
  assert.equal(fs.files.get(comments(to)), COMMENTS_BODY)
  assert.equal(fs.files.get(created(to)), CREATED_BODY)
  for (const left of [from, comments(from), created(from)]) {
    assert.equal(fs.files.has(left), false, `${left} was left behind`)
  }
}

for (const rootMode of [false, true]) {
  test(`renaming a note carries its comments and creation date (root=${rootMode})`, async () => {
    const s = fixture(rootMode)
    const result = await s.vault.renameNote(s.note, 'Two')
    assert.equal(result.path, `${s.primary}Work/Two.md`)
    assertCarried(s.fs, s.note, result.path)
  })

  test(`archive, trash and restore carry the creation date through remapped folders (root=${rootMode})`, async () => {
    const s = fixture(rootMode)
    const archived = await s.vault.archiveNote(s.note)
    assert.equal(archived.path, 'Old/Work/One.md')
    assertCarried(s.fs, s.note, archived.path)
    const unarchived = await s.vault.unarchiveNote(archived.path)
    assert.equal(unarchived.path, s.note)
    const trashed = await s.vault.moveToTrash(s.note)
    assert.equal(trashed.path, 'Bin/Work/One.md')
    assertCarried(s.fs, s.note, trashed.path)
    const restored = await s.vault.restoreFromTrash(trashed.path)
    assert.equal(restored.path, s.note)
    assert.deepEqual(s.fs.files, s.original)
  })
}

test('moving a note to another folder carries its creation date', async () => {
  const s = fixture()
  const result = await s.vault.moveNote(s.note, 'inbox', 'Elsewhere/Deeper')
  assert.equal(result.path, 'Notes/Elsewhere/Deeper/One.md')
  assertCarried(s.fs, s.note, result.path)
})

test('renaming a folder carries the creation dates of every note inside it', async () => {
  const s = fixture()
  s.fs.files.set('Notes/Work/Deep/Two.md', '# Two\n')
  s.fs.files.set(created('Notes/Work/Deep/Two.md'), '{"version":1,"createdAt":1}\n')
  await s.vault.renameFolder('inbox', 'Work', 'Moved')
  assertCarried(s.fs, s.note, 'Notes/Moved/One.md')
  assert.equal(s.fs.files.get(created('Notes/Moved/Deep/Two.md')), '{"version":1,"createdAt":1}\n')
  assert.equal([...s.fs.files.keys()].some(key => key.includes('/Work/')), false)
})

test('a moved note with no sidecars moves alone and gains none', async () => {
  const s = fixture()
  s.fs.files.delete(comments(s.note))
  s.fs.files.delete(created(s.note))
  await s.vault.renameNote(s.note, 'Two')
  assert.deepEqual([...s.fs.files.keys()], ['Notes/Work/Two.md'])
})

// ZenNotes #839: a creation date with no note beside it belongs to nobody
// (its note was moved or deleted outside ZenNotes). Desktop discards it, the
// way creating a note does, instead of handing it to the next note there.
test('a creation date left at the destination by a vanished note is discarded, not inherited', async () => {
  const s = fixture()
  s.fs.files.set(created('Notes/Work/Two.md'), '{"version":1,"createdAt":5}\n')
  await s.vault.renameNote(s.note, 'Two')
  assertCarried(s.fs, s.note, 'Notes/Work/Two.md')

  const bare = fixture()
  bare.fs.files.delete(created(bare.note))
  bare.fs.files.set(created('Notes/Elsewhere/One.md'), '{"version":1,"createdAt":5}\n')
  await bare.vault.moveNote(bare.note, 'inbox', 'Elsewhere')
  assert.equal(bare.fs.files.has(created('Notes/Elsewhere/One.md')), false)
  assert.equal(bare.fs.files.get(comments('Notes/Elsewhere/One.md')), COMMENTS_BODY)
})

// Taking over another note's discussion and deleting it are both wrong, so
// leftover comments refuse the move, in desktop's words, naming the file.
test('leftover comments at the destination refuse a rename or move and change nothing', async () => {
  const s = fixture()
  s.fs.files.set(comments('Notes/Work/Two.md'), 'an earlier discussion')
  s.fs.files.set(comments('Notes/Elsewhere/One.md'), 'another discussion')
  const before = new Map(s.fs.files)
  await assert.rejects(s.vault.renameNote(s.note, 'Two'), {
    message: 'Comments from an earlier note named “Two” are still in .zennotes/comments/Notes/Work/Two.md.comments.json. Move or delete that file to use this name.'
  })
  await assert.rejects(s.vault.moveNote(s.note, 'inbox', 'Elsewhere'), {
    message: 'Comments from an earlier note named “One” are still in .zennotes/comments/Notes/Elsewhere/One.md.comments.json. Move or delete that file to use this name.'
  })
  assert.deepEqual(s.fs.files, before)
})

test('a creation date that cannot move puts the note and its comments back', async () => {
  const s = fixture()
  s.fs.failMove = from => from.startsWith('.zennotes/note-metadata/')
  await assert.rejects(s.vault.renameNote(s.note, 'Two'), /Provider refused move/)
  assert.deepEqual(s.fs.files, s.original)
  await assert.rejects(s.vault.renameFolder('inbox', 'Work', 'Moved'), /Provider refused move/)
  assert.deepEqual(s.fs.files, s.original)
})

// Desktop's relocateFolderTrees refuses any existing destination tree.
test('renaming a folder onto a leftover creation-date tree refuses and changes nothing', async () => {
  const s = fixture()
  s.fs.files.set(created('Notes/Moved/Ghost.md'), '{"version":1,"createdAt":5}\n')
  const before = new Map(s.fs.files)
  await assert.rejects(
    s.vault.renameFolder('inbox', 'Work', 'Moved'),
    /Destination already exists: \.zennotes\/note-metadata\/Notes\/Moved$/
  )
  assert.deepEqual(s.fs.files, before)
})

// Deleting takes the creation date along, as on desktop. Otherwise the phone
// would plant the leftover trees that refuse a later folder rename.
test('deleting a note, a folder or the trash leaves no creation date behind', async () => {
  const note = fixture()
  await note.vault.deleteNote(note.note)
  assert.equal(note.fs.files.size, 0)

  const folder = fixture()
  await folder.vault.deleteFolder('inbox', 'Work')
  assert.equal(folder.fs.files.size, 0)

  const trash = fixture()
  await trash.vault.moveToTrash(trash.note)
  await trash.vault.emptyTrash()
  assert.equal(trash.fs.files.size, 0)
})

test('a folder deleted on the phone does not block renaming another folder onto its name', async () => {
  const s = fixture()
  s.fs.files.set('Notes/Gone/Old.md', '# Old\n')
  s.fs.files.set(created('Notes/Gone/Old.md'), '{"version":1,"createdAt":5}\n')
  await s.vault.deleteFolder('inbox', 'Gone')
  await s.vault.renameFolder('inbox', 'Work', 'Gone')
  assertCarried(s.fs, s.note, 'Notes/Gone/One.md')
  assert.equal(s.fs.files.has(created('Notes/Gone/Old.md')), false)
})
