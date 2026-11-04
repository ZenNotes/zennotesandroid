import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dismissRootNotice, noteVaultRefreshed, onVaultRefreshed, rootNoticeDismissed, showRootNotes } from './drawer-root-notice.ts'

function memoryStore(): Pick<Storage, 'getItem' | 'setItem'> {
  const values = new Map<string, string>()
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => void values.set(key, value) }
}

test('dismissing applies to that vault only', () => {
  const store = memoryStore()
  assert.equal(rootNoticeDismissed('/a', store), false)
  dismissRootNotice('/a', store)
  assert.equal(rootNoticeDismissed('/a', store), true)
  assert.equal(rootNoticeDismissed('/b', store), false)
})

test('storage that refuses never breaks the drawer', () => {
  const broken = { getItem: () => { throw new Error('no') }, setItem: () => { throw new Error('no') } }
  assert.equal(rootNoticeDismissed('/a', broken), false)
  assert.doesNotThrow(() => dismissRootNotice('/a', broken))
})

test('showing root notes changes the layout and keeps the other settings', async () => {
  let saved: unknown = null
  await showRootNotes({
    getVaultSettings: async () => ({ primaryNotesLocation: 'inbox', displayName: 'Mine' }),
    setVaultSettings: async (settings) => { saved = settings }
  })
  assert.deepEqual(saved, { primaryNotesLocation: 'root', displayName: 'Mine' })
})

test('a rescan tells whoever is listening, until they stop', () => {
  let heard = 0
  const stop = onVaultRefreshed(() => { heard += 1 })
  noteVaultRefreshed()
  noteVaultRefreshed()
  assert.equal(heard, 2)
  stop()
  noteVaultRefreshed()
  assert.equal(heard, 2)
})
