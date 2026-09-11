import assert from 'node:assert/strict'
import { it } from 'node:test'
import { loadMobileModule } from '../../tooling/load-mobile-module.ts'

Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null } })
const { MobileVault, onVaultChange } = await loadMobileModule(['./src/bridge/vault-fs', './src/bridge/events'])

it('batches a foreground/cloud refresh into one resync without triggering local autosync events', async () => {
  const events: unknown[] = []
  const unsubscribe = onVaultChange((event: unknown) => events.push(event))
  const invalidated: string[] = []
  const vault = {
    settingsCache: {},
    metaCache: new Map([
      ['deleted.md', { meta: { updatedAt: 1 }, size: 1 }],
      ['changed.md', { meta: { updatedAt: 1 }, size: 1 }]
    ]),
    listNotes: async () => [
      { path: 'changed.md', updatedAt: 2, size: 2, folder: 'inbox' },
      { path: 'new.md', updatedAt: 2, size: 2, folder: 'inbox' }
    ],
    invalidateMeta: (path: string) => invalidated.push(path),
    folderOf: async () => 'inbox'
  }
  try {
    await MobileVault.prototype.rescan.call(vault)
    assert.deepEqual(events, [{ kind: 'change', path: '', folder: 'inbox', scope: 'resync' }])
    assert.deepEqual(invalidated, ['deleted.md'])
    assert.equal(vault.settingsCache, null)
  } finally { unsubscribe() }
})
