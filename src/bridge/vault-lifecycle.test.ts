import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadMobileModule } from '../../tooling/load-mobile-module.ts'

Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null } })
const { MobileVault, NativeFs, DEFAULT_VAULT_SETTINGS } = await loadMobileModule([
  './src/bridge/vault-fs', './src/bridge/native-fs', '@zennotes/bridge-contract/ipc'
])

class MemoryFs {
  files = new Map<string, string>()
  directories = new Set<string>()
  failMove: ((from: string, to: string) => boolean) | null = null
  failWrite = false
  async statVerified(path: string) {
    return this.files.has(path) ? 'file' : this.directories.has(path) || [...this.files.keys()].some(key => key.startsWith(`${path}/`)) ? 'directory' : null
  }
  async exists(path: string) { return await this.statVerified(path) !== null }
  async mkdir(path: string) { this.directories.add(path) }
  async readText(path: string) { if (!this.files.has(path)) throw new Error('ENOENT'); return this.files.get(path)! }
  async readTextOrNull(path: string) { return this.files.get(path) ?? null }
  async writeText(path: string, body: string) {
    if (this.failWrite) { this.failWrite = false; throw new Error('Settings write refused') }
    this.files.set(path, body)
  }
  async deleteFile(path: string) { this.files.delete(path) }
  async rmdir(path: string) {
    for (const key of this.files.keys()) if (key === path || key.startsWith(`${path}/`)) this.files.delete(key)
    for (const key of this.directories) if (key === path || key.startsWith(`${path}/`)) this.directories.delete(key)
  }
  async rename(from: string, to: string) {
    if (this.failMove?.(from, to)) throw new Error('Provider refused move')
    assert.ok(await this.exists(from)); assert.equal(await this.exists(to), false)
    for (const [key, body] of [...this.files]) if (key === from || key.startsWith(`${from}/`)) {
      this.files.set(to + key.slice(from.length), body); this.files.delete(key)
    }
    for (const key of [...this.directories]) if (key === from || key.startsWith(`${from}/`)) {
      this.directories.add(to + key.slice(from.length)); this.directories.delete(key)
    }
  }
}
function fixture(rootMode = false) {
  const fs = new MemoryFs(), vault = new MobileVault('Fixture')
  Object.assign(vault, {
    fs, settingsCache: { ...structuredClone(DEFAULT_VAULT_SETTINGS), primaryNotesLocation: rootMode ? 'root' : 'inbox',
      systemFolderPaths: { inbox: 'Notes', archive: 'Old', trash: 'Bin', quick: 'Capture' } },
    listNotes: async () => [], invalidateMeta: () => {},
    metaForPath: async (path: string) => ({ path, title: path.split('/').pop() })
  })
  const note = `${rootMode ? '' : 'Notes/'}Work/One.md`
  fs.files.set(note, '# One\n\nExact café 日本語.  \n')
  fs.files.set(`.zennotes/comments/${note}.comments.json`, '{malformed but preserved sidecar}')
  return { fs, vault, note, original: new Map(fs.files) }
}
for (const rootMode of [false, true]) {
  test(`native move and restore preserve bytes and sidecars with remapping (root=${rootMode})`, async () => {
    const s = fixture(rootMode), result = await s.vault.moveToTrash(s.note)
    assert.equal(result.path, 'Bin/Work/One.md')
    assert.equal(s.fs.files.get(result.path), s.original.get(s.note))
    assert.equal(s.fs.files.get(`.zennotes/comments/${result.path}.comments.json`), '{malformed but preserved sidecar}')
    const restored = await s.vault.restoreFromTrash(result.path)
    assert.equal(restored.path, s.note)
    assert.deepEqual(s.fs.files, s.original)
  })
}
test('native note relocation restores content when the comments provider fails', async () => {
  const s = fixture()
  s.fs.failMove = from => from.startsWith('.zennotes/comments/')
  await assert.rejects(s.vault.moveToTrash(s.note), /Provider refused move/)
  assert.deepEqual(s.fs.files, s.original)
})
test('native folder rename moves database files and nested sidecars together', async () => {
  const s = fixture()
  s.fs.files.set('Notes/Work/Projects.base/data.csv', 'ID,Name\n1,One\n')
  s.fs.files.set('Notes/Work/Projects.base/schema.json', '{"pages":{"1":"One.md"}}')
  await s.vault.renameFolder('inbox', 'Work', 'Moved')
  assert.equal(s.fs.files.get('Notes/Moved/Projects.base/data.csv'), 'ID,Name\n1,One\n')
  assert.equal(s.fs.files.get('.zennotes/comments/Notes/Moved/One.md.comments.json'), '{malformed but preserved sidecar}')
  assert.equal(s.fs.files.has(s.note), false)
})
test('native folder rename restores content, comments and settings on metadata failure', async () => {
  const s = fixture()
  s.fs.files.set('.zennotes/vault.json', '{"keep":"exact settings"}\n')
  s.original.set('.zennotes/vault.json', '{"keep":"exact settings"}\n')
  s.fs.failWrite = true
  await assert.rejects(s.vault.renameFolder('inbox', 'Work', 'Moved'), /Settings write refused/)
  assert.deepEqual(s.fs.files, s.original)
})
test('native Empty Trash rolls back if comments cannot detach, then deletes nested comments on retry', async () => {
  const s = fixture()
  await s.vault.moveToTrash(s.note)
  const before = new Map(s.fs.files)
  s.fs.failMove = from => from === '.zennotes/comments/Bin'
  await assert.rejects(s.vault.emptyTrash(), /Provider refused move/)
  assert.deepEqual(s.fs.files, before)
  s.fs.failMove = null
  await s.vault.emptyTrash()
  assert.equal(s.fs.files.size, 0)
  await s.vault.emptyTrash()
})
test('native deletion does not report success after a failed sidecar move', async () => {
  const s = fixture()
  s.fs.failMove = from => from.startsWith('.zennotes/comments/')
  await assert.rejects(s.vault.deleteNote(s.note), /Provider refused move/)
  assert.deepEqual(s.fs.files, s.original)
})
test('native absent-file reads propagate provider failures instead of allowing schema adoption', async () => {
  const permission = new Error('Permission denied')
  await assert.rejects(NativeFs.prototype.readTextOrNull.call({ readText: async () => { throw permission } }, 'schema.json'), permission)
})
