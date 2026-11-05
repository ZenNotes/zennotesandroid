import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadMobileModule } from '../../tooling/load-mobile-module.ts'

Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } })
const { MobileVault } = await loadMobileModule(['./src/bridge/vault-fs'])
const { WELCOME_NOTE_BODY, isUntouchedInboxWelcome, sha256OfText } = await loadMobileModule(['./src/bridge/welcome-note'])

// The desktop's settleSeededInbox (ZenNotes 4e8c13f8), mirrored: an inbox that only
// holds the untouched Welcome says nothing about the layout, and goes once there
// is something else to look at.
const SEED = 'inbox/Welcome to ZenNotes.md'
const COMMENTS = `.zennotes/comments/${SEED}.comments.json`

function memoryVault(initial: Record<string, string>, dirs: string[] = []) {
  const files = new Map(Object.entries(initial))
  const folders = new Set(dirs)
  for (const rel of files.keys()) {
    const parts = rel.split('/')
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'))
  }
  const hooks: { afterRename?: (from: string, to: string) => void } = {}
  const fs = {
    rootPath: '/memory',
    readdir: async (dir: string) => {
      const prefix = dir ? `${dir}/` : ''
      const out = new Map<string, 'file' | 'directory'>()
      for (const rel of files.keys()) if (rel.startsWith(prefix) && !rel.slice(prefix.length).includes('/')) out.set(rel.slice(prefix.length), 'file')
      for (const rel of folders) if (rel.startsWith(prefix) && rel !== dir && !rel.slice(prefix.length).includes('/')) out.set(rel.slice(prefix.length), 'directory')
      return [...out].map(([name, type]) => ({ name, type }))
    },
    readTextOrNull: async (rel: string) => files.get(rel) ?? null,
    statVerified: async (rel: string) => (files.has(rel) ? 'file' : folders.has(rel) ? 'directory' : null),
    rename: async (from: string, to: string) => {
      files.set(to, files.get(from)!)
      files.delete(from)
      hooks.afterRename?.(from, to)
    },
    deleteFile: async (rel: string) => { files.delete(rel) },
    rmdirIfEmpty: async (dir: string) => {
      if ([...files.keys(), ...folders].some((rel) => rel.startsWith(`${dir}/`))) throw new Error('not empty')
      folders.delete(dir)
    },
    rmdir: async () => { throw new Error('never the recursive rmdir') },
    mkdir: async (dir: string) => { folders.add(dir) },
    writeText: async (rel: string, text: string) => { files.set(rel, text) }
  }
  const vault = new MobileVault('Memory')
  Object.assign(vault, { fs })
  return { vault, files, folders, hooks }
}
const stated = (primary?: string) => JSON.stringify(primary ? { primaryNotesLocation: primary } : { favorites: [] })
const layout = async (vault: InstanceType<typeof MobileVault>) => (await vault.getVaultSettings()).primaryNotesLocation

test('both seeds are known by their own hashes, each under its own name', async () => {
  assert.equal(isUntouchedInboxWelcome('Welcome to ZenNotes.md', await sha256OfText(WELCOME_NOTE_BODY)), true)
  // The desktop's current seed text (ZenNotes 4e8c13f8 vault.ts WELCOME_NOTE).
  const desktop = '50c264c87b2790dbb685cd9a699118e1d62e84eb5532701e96d5b1ab55373fac'
  assert.equal(isUntouchedInboxWelcome('Welcome.md', desktop), true)
  assert.equal(isUntouchedInboxWelcome('Welcome to ZenNotes.md', desktop), false)
  assert.equal(isUntouchedInboxWelcome('Welcome.md', await sha256OfText(WELCOME_NOTE_BODY)), false)
})

test('an inbox holding only the untouched Welcome reads as empty for the layout', async () => {
  const { vault } = memoryVault({ [SEED]: WELCOME_NOTE_BODY, 'Trips/Rome.md': '# Rome' })
  assert.equal(await layout(vault), 'root')
})

test('a Welcome someone edited or commented on still says inbox mode', async () => {
  assert.equal(await layout(memoryVault({ [SEED]: `${WELCOME_NOTE_BODY}mine`, 'Trips/Rome.md': '' }).vault), 'inbox')
  assert.equal(await layout(memoryVault({ [SEED]: WELCOME_NOTE_BODY, [COMMENTS]: '[]', 'Trips/Rome.md': '' }).vault), 'inbox')
})

test('a fresh vault with only its Welcome stays inbox mode', async () => {
  const { vault, files } = memoryVault({ [SEED]: WELCOME_NOTE_BODY }, ['quick', 'archive', 'trash'])
  assert.equal(await layout(vault), 'inbox')
  assert.equal(await vault.settleSeededInbox(), false)
  assert.ok(files.has(SEED))
})

test('folders copied in beside the seed take the Welcome and the inbox away', async () => {
  const { vault, files, folders } = memoryVault({ [SEED]: WELCOME_NOTE_BODY, 'inbox/.DS_Store': '', 'Trips/Rome.md': '# Rome' })
  assert.equal(await vault.settleSeededInbox(), true)
  assert.equal(files.has(SEED), false)
  assert.equal(files.has('inbox/.DS_Store'), false)
  assert.equal(folders.has('inbox'), false)
  assert.equal(files.get('Trips/Rome.md'), '# Rome')
  assert.equal(await layout(vault), 'root')
})

test("a Welcome is only a seed under its own app's name", async () => {
  const { vault, folders } = memoryVault({ 'inbox/Welcome.md': WELCOME_NOTE_BODY, 'Notes/A.md': '' })
  assert.equal(await vault.settleSeededInbox(), false)
  assert.ok(folders.has('inbox'))
})

test('an edited Welcome, a comment thread or a second note keeps the inbox', async () => {
  const cases: Record<string, string>[] = [
    { [SEED]: `${WELCOME_NOTE_BODY}\nmine` },
    { [SEED]: WELCOME_NOTE_BODY, [COMMENTS]: '[]' },
    { [SEED]: WELCOME_NOTE_BODY, 'inbox/Second.md': '' }
  ]
  for (const extra of cases) {
    const { vault, files, folders } = memoryVault({ ...extra, 'Trips/Rome.md': '' })
    assert.equal(await vault.settleSeededInbox(), false)
    assert.ok(files.has(SEED))
    assert.ok(folders.has('inbox'))
  }
})

test('an empty inbox is never removed on the automatic path', async () => {
  const { vault, folders } = memoryVault({ 'Trips/Rome.md': '' }, ['inbox'])
  assert.equal(await vault.settleSeededInbox(), false)
  assert.ok(folders.has('inbox'))
})

test('a vault.json that states inbox mode, or exists without saying, keeps the inbox', async () => {
  for (const json of [stated('inbox'), stated()]) {
    const { vault, files } = memoryVault({ '.zennotes/vault.json': json, [SEED]: WELCOME_NOTE_BODY, 'Trips/Rome.md': '' })
    assert.equal(await vault.settleSeededInbox(), false)
    assert.ok(files.has(SEED))
  }
  const { vault, files } = memoryVault({ '.zennotes/vault.json': stated('root'), [SEED]: WELCOME_NOTE_BODY, 'Trips/Rome.md': '' })
  assert.equal(await vault.settleSeededInbox(), true)
  assert.equal(files.has(SEED), false)
})

test('an edit carried by the rename goes back, and the inbox stays', async () => {
  const { vault, files, folders, hooks } = memoryVault({ [SEED]: WELCOME_NOTE_BODY, 'Trips/Rome.md': '' })
  hooks.afterRename = (from, to) => {
    if (from === SEED) files.set(to, `${WELCOME_NOTE_BODY}\nsaved just now`)
    hooks.afterRename = undefined
  }
  assert.equal(await vault.settleSeededInbox(), false)
  assert.equal(files.get(SEED), `${WELCOME_NOTE_BODY}\nsaved just now`)
  assert.ok(folders.has('inbox'))
  assert.deepEqual([...files.keys()].filter((rel) => rel.includes('settling')), [])
})

test('switching to root mode takes the seed only beside something else', async () => {
  const lone = memoryVault({ '.zennotes/vault.json': stated('inbox'), [SEED]: WELCOME_NOTE_BODY })
  await lone.vault.setVaultSettings({ ...(await lone.vault.getVaultSettings()), primaryNotesLocation: 'root' })
  assert.ok(lone.files.has(SEED), 'a vault switched before anything is in it keeps its Welcome')

  const beside = memoryVault({ '.zennotes/vault.json': stated('inbox'), [SEED]: WELCOME_NOTE_BODY, 'Trips/Rome.md': '' })
  await beside.vault.setVaultSettings({ ...(await beside.vault.getVaultSettings()), primaryNotesLocation: 'root' })
  assert.equal(beside.files.has(SEED), false)
  assert.equal(beside.folders.has('inbox'), false)
})

test('a folder the inbox was remapped to is never touched', async () => {
  const json = JSON.stringify({ primaryNotesLocation: 'root', systemFolderPaths: { inbox: '01 - Entry' } })
  const { vault, files } = memoryVault({ '.zennotes/vault.json': json, '01 - Entry/Welcome to ZenNotes.md': WELCOME_NOTE_BODY, 'Trips/Rome.md': '' })
  assert.equal(await vault.settleSeededInbox(), false)
  assert.ok(files.has('01 - Entry/Welcome to ZenNotes.md'))
})
