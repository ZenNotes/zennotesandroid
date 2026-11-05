import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { loadMobileModule } from '../../tooling/load-mobile-module.ts'

Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } })
const { MobileVault } = await loadMobileModule(['./src/bridge/vault-fs'])

// A folder opened before its notes arrived (#1023): this app makes `inbox/` on
// first open, and nothing may keep the notes that land beside it out of view.
function fixture(files: string[], dirs: string[] = []) {
  const vault = new MobileVault('Fixture')
  const children = (dir: string) => {
    const prefix = dir ? `${dir}/` : ''
    const names = new Map<string, 'file' | 'directory'>()
    for (const file of files) {
      if (!file.startsWith(prefix)) continue
      const [head, ...rest] = file.slice(prefix.length).split('/')
      names.set(head!, rest.length ? 'directory' : 'file')
    }
    for (const entry of dirs) {
      if (!entry.startsWith(prefix)) continue
      const [head, ...rest] = entry.slice(prefix.length).split('/')
      if (head && !rest.length) names.set(head, 'directory')
    }
    return [...names].map(([name, type]) => ({ name, type }))
  }
  Object.assign(vault, {
    fs: { readdir: async (dir: string) => children(dir), readTextOrNull: async () => null, rootPath: '/fixture' }
  })
  return vault
}
const layout = async (vault: InstanceType<typeof MobileVault>) => (await vault.getVaultSettings()).primaryNotesLocation

test('an empty inbox does not hold back folders that arrived beside it', async () => {
  assert.equal(await layout(fixture(['Trips/Rome.md', 'Work/Plan.md'], ['inbox', 'quick', 'archive', 'trash'])), 'root')
})

test('an empty inbox does not hold back a loose note at the root', async () => {
  assert.equal(await layout(fixture(['Loose.md'], ['inbox'])), 'root')
})

test('dotfiles inside the inbox are not notes', async () => {
  assert.equal(await layout(fixture(['inbox/.DS_Store', 'Trips/Rome.md'], ['inbox'])), 'root')
})

test('an inbox with anything in it stays inbox mode, loose folders or not', async () => {
  assert.equal(await layout(fixture(['inbox/Welcome.md', 'Daily/2026-11-04.md'])), 'inbox')
})

test('an empty vault and a media-only vault stay inbox mode', async () => {
  assert.equal(await layout(fixture([], ['inbox'])), 'inbox')
  assert.equal(await layout(fixture(['VID_1.mp4'], ['inbox'])), 'inbox')
})

test('the banner sees notes an inbox-mode vault.json hides when the inbox is empty', async () => {
  const vault = fixture(['Trips/Rome.md'], ['inbox'])
  Object.assign(vault, { settingsCache: { ...(await vault.getVaultSettings()), primaryNotesLocation: 'inbox' } })
  assert.equal(await vault.rootContentHiddenByInboxMode(), true)
})

test('the banner speaks up when an inbox with a note hides folders beside it', async () => {
  const vault = fixture(['inbox/First.md', 'Trips/Rome.md'])
  assert.equal(await layout(vault), 'inbox')
  assert.equal(await vault.rootContentHiddenByInboxMode(), true)
})

test('the banner stays quiet with nothing loose at the root', async () => {
  const vault = fixture(['inbox/First.md', 'VID_1.mp4'], ['quick', 'archive', 'trash'])
  assert.equal(await vault.rootContentHiddenByInboxMode(), false)
})

test('a resume that settles the layout re-reads it', async () => {
  const files: string[] = []
  const vault = fixture(files, ['inbox'])
  assert.equal(await layout(vault), 'inbox')
  files.push('Trips/Rome.md')
  Object.assign(vault, { listNotes: async () => [] })
  await vault.rescan()
  assert.equal(await layout(vault), 'root')
})

// The inbox as an empty folder among the notes, once the vault reads root mode.
// An in-memory vault, so a rename, a delete and a non-recursive rmdir behave as on disk.
const DESKTOP_WELCOME = readFileSync(new URL('./fixtures/desktop-welcome.md', import.meta.url), 'utf8')

function memoryVault(entries: Record<string, string | null | undefined>) {
  const files = new Map<string, string>()
  const dirs = new Set<string>([''])
  const addParents = (path: string) => {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'))
  }
  for (const [path, body] of Object.entries(entries)) {
    if (body === undefined) continue
    addParents(path)
    if (body === null) dirs.add(path)
    else files.set(path, body)
  }
  const children = (dir: string) => {
    const prefix = dir ? `${dir}/` : ''
    const out = new Map<string, 'file' | 'directory'>()
    for (const d of dirs) if (d.startsWith(prefix) && d !== dir && !d.slice(prefix.length).includes('/')) out.set(d.slice(prefix.length), 'directory')
    for (const f of files.keys()) if (f.startsWith(prefix) && !f.slice(prefix.length).includes('/')) out.set(f.slice(prefix.length), 'file')
    return [...out].map(([name, type]) => ({ name, type }))
  }
  const made: string[] = []
  const hooks: { afterRename?: (to: string) => void } = {}
  const fs = {
    rootPath: '/fixture',
    readdir: async (dir: string) => (dirs.has(dir) ? children(dir) : []),
    readText: async (path: string) => {
      const body = files.get(path)
      if (body === undefined) throw new Error(`missing ${path}`)
      return body
    },
    readTextOrNull: async (path: string) => files.get(path) ?? null,
    writeText: async (path: string, body: string) => { addParents(path); files.set(path, body) },
    mkdir: async (dir: string) => { made.push(dir); addParents(`${dir}/x`); dirs.add(dir) },
    statOrNull: async (path: string) => (files.has(path) ? { type: 'file' } : dirs.has(path) ? { type: 'directory' } : null),
    rename: async (from: string, to: string) => {
      const body = files.get(from)
      if (body === undefined) throw new Error(`missing ${from}`)
      files.delete(from)
      files.set(to, body)
      hooks.afterRename?.(to)
    },
    deleteFile: async (path: string) => {
      if (!files.delete(path)) throw new Error(`missing ${path}`)
    },
    rmdirIfEmpty: async (dir: string) => {
      if (children(dir).length > 0) throw new Error('not empty')
      dirs.delete(dir)
    },
    rmdir: async () => { throw new Error('never the recursive rmdir') }
  }
  const vault = new MobileVault('Fixture')
  Object.assign(vault, { fs })
  return { vault, files, dirs, made, hooks }
}
const stated = (primary: string, extra: object = {}) => JSON.stringify({ primaryNotesLocation: primary, ...extra })
const VAULT_JSON = '.zennotes/vault.json'
const toRoot = async (vault: InstanceType<typeof MobileVault>) =>
  vault.setVaultSettings({ ...(await vault.getVaultSettings()), primaryNotesLocation: 'root' })

test('the fixture is the Welcome desktop seeds today, which the list must hold', async () => {
  const { isUntouchedDesktopWelcome, sha256OfText } = await loadMobileModule(['./src/bridge/welcome-note'])
  assert.equal(isUntouchedDesktopWelcome(await sha256OfText(DESKTOP_WELCOME)), true)
  assert.equal(isUntouchedDesktopWelcome(await sha256OfText(`${DESKTOP_WELCOME}x`)), false)
})

test('a folder that states no layout gets no inbox on open', async () => {
  const { vault, made } = memoryVault({})
  await vault.ensureVaultLayout()
  assert.deepEqual(made, ['quick', 'archive', 'trash'])
})

test('a vault that states inbox mode still gets its inbox on open', async () => {
  const { vault, made } = memoryVault({ [VAULT_JSON]: stated('inbox') })
  await vault.ensureVaultLayout()
  assert.deepEqual(made, ['inbox', 'quick', 'archive', 'trash'])
})

test('an inbox holding only an untouched desktop Welcome reads as empty for the layout', async () => {
  assert.equal(await layout(memoryVault({ 'inbox/Welcome.md': DESKTOP_WELCOME, 'Trips/Rome.md': '# Rome\n' }).vault), 'root')
  assert.equal(await layout(memoryVault({ 'inbox/Welcome.md': `${DESKTOP_WELCOME}mine\n`, 'Trips/Rome.md': '# Rome\n' }).vault), 'inbox')
  assert.equal(await layout(memoryVault({ 'inbox/Welcome.md': DESKTOP_WELCOME, 'inbox/Mine.md': '# Mine\n', 'Trips/Rome.md': '# Rome\n' }).vault), 'inbox')
})

test('opening takes away the system inbox holding only an untouched Welcome, beside other notes', async () => {
  const { vault, files, dirs } = memoryVault({
    'inbox/Welcome.md': DESKTOP_WELCOME,
    '.zennotes/note-metadata/inbox/Welcome.md.metadata.json': '{}',
    'Trips/Rome.md': '# Rome\n'
  })
  await vault.ensureVaultLayout()
  assert.equal(dirs.has('inbox'), false)
  assert.equal(files.has('.zennotes/note-metadata/inbox/Welcome.md.metadata.json'), false)
  assert.equal(files.get('Trips/Rome.md'), '# Rome\n')
})

test('a rescan settles a vault that filled up after it opened', async () => {
  const { vault, files, dirs } = memoryVault({ 'inbox/Welcome.md': DESKTOP_WELCOME })
  await vault.ensureVaultLayout()
  assert.equal(dirs.has('inbox'), true, 'alone, the Welcome stays')
  files.set('Loose.md', '# Loose\n')
  Object.assign(vault, { listNotes: async () => [] })
  await vault.rescan()
  assert.equal(dirs.has('inbox'), false)
})

test('an automatic look never removes an empty inbox: it may be a capture tool\'s', async () => {
  const { vault, dirs } = memoryVault({ inbox: null, 'Loose.md': '# Loose\n' })
  assert.equal(await vault.settleSeededInbox(), false)
  assert.equal(dirs.has('inbox'), true)
})

test('keeps an edited Welcome, a commented one, and one beside another note', async () => {
  for (const extra of [
    { 'inbox/Welcome.md': `${DESKTOP_WELCOME}mine\n` },
    { 'inbox/Welcome.md': DESKTOP_WELCOME, '.zennotes/comments/inbox/Welcome.md.comments.json': '{}' },
    { 'inbox/Welcome.md': DESKTOP_WELCOME, 'inbox/Mine.md': '# Mine\n' }
  ]) {
    const { vault, files } = memoryVault({ ...extra, 'Loose.md': '# Loose\n' })
    assert.equal(await vault.settleSeededInbox(), false)
    assert.equal(files.has('inbox/Welcome.md'), true)
  }
})

test('keeps an edit that lands while the Welcome is being looked at', async () => {
  const { vault, files, hooks } = memoryVault({ 'inbox/Welcome.md': DESKTOP_WELCOME, 'Loose.md': '# Loose\n' })
  hooks.afterRename = (to) => { if (to.includes('.Welcome.settling-')) files.set(to, `${DESKTOP_WELCOME}typed\n`) }
  assert.equal(await vault.settleSeededInbox(), false)
  assert.equal(files.get('inbox/Welcome.md'), `${DESKTOP_WELCOME}typed\n`)
})

test('keeps a Welcome saved while the seed is out of the way, and the folder with it', async () => {
  const { vault, files, dirs, hooks } = memoryVault({ 'inbox/Welcome.md': DESKTOP_WELCOME, 'Loose.md': '# Loose\n' })
  hooks.afterRename = (to) => {
    if (!to.includes('.Welcome.settling-')) return
    files.set(to, `${DESKTOP_WELCOME}typed\n`)
    files.set('inbox/Welcome.md', '# Newer\n')
  }
  assert.equal(await vault.settleSeededInbox(), false)
  assert.equal(files.get('inbox/Welcome.md'), '# Newer\n')
  assert.ok([...files.keys()].some((path) => /^inbox\/Welcome .+\.md$/.test(path)))
  assert.equal(dirs.has('inbox'), true)
})

test('does nothing in a vault that states inbox mode, a remapped inbox or a capitalized one', async () => {
  for (const entries of [
    { [VAULT_JSON]: stated('inbox'), 'inbox/Welcome.md': DESKTOP_WELCOME },
    { [VAULT_JSON]: stated('root', { systemFolderPaths: { inbox: '01 - Entry' } }), 'inbox/Welcome.md': DESKTOP_WELCOME },
    { 'Inbox/Welcome.md': DESKTOP_WELCOME }
  ]) {
    const { vault, files } = memoryVault({ ...entries, 'Loose.md': '# Loose\n' })
    assert.equal(await vault.settleSeededInbox(), false)
    assert.ok(files.has('inbox/Welcome.md') || files.has('Inbox/Welcome.md'))
  }
})

test('going to root mode takes an empty inbox, and what Finder left in it, with it', async () => {
  for (const extra of [{ inbox: null }, { 'inbox/.DS_Store': 'x' }]) {
    const { vault, dirs } = memoryVault({ [VAULT_JSON]: stated('inbox'), ...extra })
    await toRoot(vault)
    assert.equal(dirs.has('inbox'), false)
  }
})

test('going to root mode leaves an inbox holding a note, or another dotfile', async () => {
  for (const extra of [{ 'inbox/Mine.md': '# Mine\n' }, { 'inbox/.hidden': 'x' }]) {
    const { vault, dirs } = memoryVault({ [VAULT_JSON]: stated('inbox'), ...extra })
    await toRoot(vault)
    assert.equal(dirs.has('inbox'), true)
  }
})

test('going to root mode keeps the Welcome until there is something else to look at', async () => {
  const { vault, files } = memoryVault({ [VAULT_JSON]: stated('inbox'), 'inbox/Welcome.md': DESKTOP_WELCOME })
  await toRoot(vault)
  assert.equal(files.has('inbox/Welcome.md'), true)
  files.set('Loose.md', '# Loose\n')
  assert.equal(await vault.settleSeededInbox(), true)
  assert.equal(files.has('inbox/Welcome.md'), false)
})

test('going to root mode takes a seed-only inbox, and keeps one with an edited Welcome', async () => {
  const seeded = memoryVault({ [VAULT_JSON]: stated('inbox'), 'inbox/Welcome.md': DESKTOP_WELCOME, 'Loose.md': '# Loose\n' })
  await toRoot(seeded.vault)
  assert.equal(seeded.dirs.has('inbox'), false)
  const edited = memoryVault({ [VAULT_JSON]: stated('inbox'), 'inbox/Welcome.md': `${DESKTOP_WELCOME}mine\n`, 'Loose.md': '# Loose\n' })
  await toRoot(edited.vault)
  assert.equal(edited.files.has('inbox/Welcome.md'), true)
})

test('a vault already in root mode keeps a folder of its own named inbox', async () => {
  const { vault, dirs } = memoryVault({ [VAULT_JSON]: stated('root'), inbox: null })
  await toRoot(vault)
  assert.equal(dirs.has('inbox'), true)
})

test('going to root mode leaves a folder the inbox was remapped to', async () => {
  const { vault, dirs } = memoryVault({ [VAULT_JSON]: stated('inbox', { systemFolderPaths: { inbox: '01 - Entry' } }), '01 - Entry': null })
  await toRoot(vault)
  assert.equal(dirs.has('01 - Entry'), true)
})
