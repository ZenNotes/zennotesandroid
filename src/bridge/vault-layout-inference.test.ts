import assert from 'node:assert/strict'
import { test } from 'node:test'
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
