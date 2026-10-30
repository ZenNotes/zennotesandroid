import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { loadMobileModule } from '../../tooling/load-mobile-module.ts'

// Core 2.80.0 on the phone's own vault code. The template folder (#1024) is
// vault.json `templates.folder`: a save from this device keeps it, normalized
// the way desktop normalizes it, a folder rename carries it along, and its
// notes stay out of the task scan and text search, as on desktop and the
// self-hosted server. Subtasks (#1028) come from the shared parser this scan
// calls, so every task the phone lists carries the `parentId` the shared
// contract fixture expects, from a fresh read and from the scan's cache alike.

Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null } })
const { MobileVault } = await loadMobileModule(['./src/bridge/vault-fs'])

const SETTINGS = '.zennotes/vault.json'

class MemoryFs {
  files = new Map<string, string>()
  directories = new Set<string>()
  private isDirectory(path: string): boolean {
    return path === '' || this.directories.has(path) || [...this.files.keys()].some(key => key.startsWith(`${path}/`))
  }
  async statVerified(path: string) {
    return this.files.has(path) ? 'file' : this.isDirectory(path) ? 'directory' : null
  }
  async statOrNull(path: string) {
    const body = this.files.get(path)
    if (body !== undefined) return { type: 'file', size: body.length, mtime: 1, ctime: null, uri: path }
    return this.isDirectory(path) ? { type: 'directory', size: 0, mtime: 0, ctime: null, uri: path } : null
  }
  async readdir(path: string) {
    const prefix = path ? `${path}/` : ''
    const entries = new Map<string, { name: string; type: 'file' | 'directory'; size: number; mtime: number }>()
    for (const [key, body] of this.files) {
      if (!key.startsWith(prefix)) continue
      const [name, ...nested] = key.slice(prefix.length).split('/')
      entries.set(name!, nested.length
        ? { name: name!, type: 'directory', size: 0, mtime: 0 }
        : { name: name!, type: 'file', size: body.length, mtime: 1 })
    }
    return [...entries.values()]
  }
  async exists(path: string) { return await this.statVerified(path) !== null }
  async mkdir(path: string) { this.directories.add(path) }
  async readText(path: string) { if (!this.files.has(path)) throw new Error('ENOENT'); return this.files.get(path)! }
  async readTextOrNull(path: string) { return this.files.get(path) ?? null }
  async writeText(path: string, body: string) { this.files.set(path, body) }
  async deleteFile(path: string) { this.files.delete(path) }
  async rename(from: string, to: string) {
    assert.ok(await this.exists(from)); assert.equal(await this.exists(to), false)
    for (const [key, body] of [...this.files]) if (key === from || key.startsWith(`${from}/`)) {
      this.files.set(to + key.slice(from.length), body); this.files.delete(key)
    }
    for (const key of [...this.directories]) if (key === from || key.startsWith(`${from}/`)) {
      this.directories.add(to + key.slice(from.length)); this.directories.delete(key)
    }
  }
}

function fixture(settings: Record<string, unknown>) {
  const fs = new MemoryFs(), vault = new MobileVault('Fixture')
  fs.files.set(SETTINGS, JSON.stringify({ primaryNotesLocation: 'inbox', ...settings }))
  fs.files.set('inbox/Templates/Meeting.md', '# Meeting\n\n- [ ] Agenda item\n- [ ] Follow-up\n\nRetrospective notes\n')
  fs.files.set('inbox/Templates/Work/Standup.md', '# Standup\n\n- [ ] Yesterday\n')
  fs.files.set('inbox/Templates Old/Kept.md', '# Kept\n\n- [ ] a folder that only shares a prefix\n')
  fs.files.set('inbox/Projects/Site.md', '# Site\n\n- [ ] Launch\n  - [x] Write copy\n  - [ ] Ship\n\nRetrospective notes\n')
  Object.assign(vault, {
    fs,
    invalidateMeta: () => {},
    // The scanners walk listNotes(); answer from the memory files so a rename
    // shows up in the next scan. A fixed stamp lets the task cache serve.
    listNotes: async () => [...fs.files.keys()]
      .filter(path => path.endsWith('.md'))
      .map(path => ({
        path,
        title: path.split('/').pop()!.replace(/\.md$/, ''),
        folder: 'inbox',
        updatedAt: 1,
        size: fs.files.get(path)!.length
      }))
  })
  return { fs, vault }
}

const scanned = async (vault: any): Promise<string[]> =>
  [...new Set<string>((await vault.scanTasks()).map((task: { sourcePath: string }) => task.sourcePath))].sort()

const rescanned = async (vault: any, fs: MemoryFs): Promise<string[]> => {
  const out: string[] = []
  for (const path of [...fs.files.keys()].filter(path => path.endsWith('.md')).sort()) {
    if ((await vault.scanTasksForPath(path)).length > 0) out.push(path)
  }
  return out
}

test('a save from this device keeps the template folder a desktop set, normalized like desktop', async () => {
  const { fs, vault } = fixture({ templates: { folder: ' inbox//Templates/ ', note: 'dropped as desktop drops it' } })
  const settings = await vault.getVaultSettings()
  assert.deepEqual(settings.templates, { folder: 'inbox/Templates' })
  await vault.setVaultSettings({ ...settings, favorites: ['inbox/Projects/Site.md'] })
  const written = JSON.parse(fs.files.get(SETTINGS)!)
  assert.deepEqual(written.templates, { folder: 'inbox/Templates' })
  assert.deepEqual(written.favorites, ['inbox/Projects/Site.md'])
})

test('an unusable template folder leaves no templates stub in vault.json', async () => {
  for (const templates of [{ folder: '../outside' }, { folder: 'inbox/.hidden' }, { folder: '' }, 'Templates', []]) {
    const { fs, vault } = fixture({ templates })
    const settings = await vault.getVaultSettings()
    assert.equal('templates' in settings, false, JSON.stringify(templates))
    await vault.setVaultSettings(settings)
    assert.equal('templates' in JSON.parse(fs.files.get(SETTINGS)!), false, JSON.stringify(templates))
  }
})

test("the template folder's checkboxes stay out of Tasks, even inside a Task folder", async () => {
  const { fs, vault } = fixture({ templates: { folder: 'inbox/Templates' } })
  const expected = ['inbox/Projects/Site.md', 'inbox/Templates Old/Kept.md']
  assert.deepEqual(await scanned(vault), expected)
  // A single-note rescan agrees, or an edit to a template would list it again.
  assert.deepEqual(await rescanned(vault, fs), expected)

  const narrowed = fixture({ templates: { folder: 'inbox/Templates' }, tasks: { includedFolders: ['inbox'] } })
  assert.deepEqual(await scanned(narrowed.vault), expected)
})

test('without a template folder its notes are ordinary notes with tasks', async () => {
  const { vault } = fixture({})
  assert.deepEqual(await scanned(vault), [
    'inbox/Projects/Site.md', 'inbox/Templates Old/Kept.md', 'inbox/Templates/Meeting.md', 'inbox/Templates/Work/Standup.md'
  ])
})

test('text search leaves the template folder out', async () => {
  const { vault } = fixture({ templates: { folder: 'inbox/Templates' } })
  const hits = await vault.searchVaultText('Retrospective')
  assert.deepEqual(hits.map((hit: { path: string }) => hit.path), ['inbox/Projects/Site.md'])
  const plain = fixture({})
  const all = await plain.vault.searchVaultText('Retrospective')
  assert.deepEqual(all.map((hit: { path: string }) => hit.path).sort(), ['inbox/Projects/Site.md', 'inbox/Templates/Meeting.md'])
})

test('renaming the template folder, or a folder around it, carries the setting along', async () => {
  const { fs, vault } = fixture({ templates: { folder: 'inbox/Templates' } })
  await vault.renameFolder('inbox', 'Templates', 'Blueprints')
  assert.deepEqual(JSON.parse(fs.files.get(SETTINGS)!).templates, { folder: 'inbox/Blueprints' })
  assert.deepEqual(await scanned(vault), ['inbox/Projects/Site.md', 'inbox/Templates Old/Kept.md'])

  const nested = fixture({ templates: { folder: 'inbox/Templates/Work' } })
  await nested.vault.renameFolder('inbox', 'Templates', 'Library/Templates')
  assert.deepEqual(JSON.parse(nested.fs.files.get(SETTINGS)!).templates, { folder: 'inbox/Library/Templates/Work' })

  // A folder that only shares a name prefix leaves it alone.
  const other = fixture({ templates: { folder: 'inbox/Templates' } })
  await other.vault.renameFolder('inbox', 'Templates Old', 'Archive Old')
  assert.deepEqual(JSON.parse(other.fs.files.get(SETTINGS)!).templates, { folder: 'inbox/Templates' })
})

test('every scanned task carries the parentId of the shared subtasks fixture, cached or read', async () => {
  // The installed core's own copy; the package exports no path to it.
  const fixturePath = new URL('../../node_modules/@zennotes/bridge-contract/fixtures/task-subtasks.json', import.meta.url)
  const contract = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
    cases: { id: string; note: { path: string }; body: string; expectedTasks: { id: string; parentId?: string }[] }[]
  }
  assert.ok(contract.cases.length > 0)
  for (const contractCase of contract.cases) {
    const { fs, vault } = fixture({})
    fs.files.clear()
    fs.files.set(SETTINGS, JSON.stringify({ primaryNotesLocation: 'inbox' }))
    fs.files.set(contractCase.note.path, contractCase.body)
    for (const pass of ['read', 'cached']) {
      const tasks = (await vault.scanTasks()) as { id: string; parentId?: string }[]
      assert.deepEqual(
        tasks.map(task => (task.parentId ? { id: task.id, parentId: task.parentId } : { id: task.id })),
        contractCase.expectedTasks,
        `${contractCase.id} (${pass})`
      )
    }
  }
})
