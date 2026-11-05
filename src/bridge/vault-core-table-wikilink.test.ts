import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { loadMobileModule } from '../../tooling/load-mobile-module.ts'

// A table writes a wikilink as `[[C\|d]]`, because GFM needs the escape to keep
// the pipe in its cell. Read as `C\`, C listed no backlink. The desktop fixed its
// copy in ZenNotes/zennotes de50f31d (#1052); this is the phones' copy.
const { bodyHasLocalAsset, extractAssetEmbeds, extractWikilinks } = await loadMobileModule(['./src/bridge/vault-core'])
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } })
const { MobileVault } = await loadMobileModule(['./src/bridge/vault-fs'])

describe('a table cell writes a link with an escaped pipe', () => {
  it('names the note, not the note and a backslash', () => {
    assert.deepEqual(extractWikilinks('| [[Note\\|alias]] | x |'), ['Note'])
    assert.deepEqual(extractWikilinks('| [[Work/Note\\|alias]] | x |'), ['Work/Note'])
  })

  it('reads an unescaped link as it always did', () => {
    assert.deepEqual(extractWikilinks('[[Note|alias]] and [[Other]]'), ['Note', 'Other'])
  })

  it('finds no target in a link that has none', () => {
    assert.deepEqual(extractWikilinks('[[\\|d]] and [[ |d]]'), [])
  })

  it('counts an escaped embed of a file as an attachment', () => {
    assert.deepEqual(extractAssetEmbeds('| ![[pic.png\\|200]] | x |'), ['pic.png'])
    assert.equal(bodyHasLocalAsset('| ![[pic.png\\|200]] | x |'), true)
  })
})

describe('the note metadata cache', () => {
  async function loaded(payload: unknown): Promise<number> {
    const vault = new MobileVault('Fixture') as unknown as {
      fs: unknown
      metaCache: Map<string, unknown>
      loadMetaCache(): Promise<void>
    }
    vault.fs = { readTextOrNull: async () => JSON.stringify(payload), rootPath: '/fixture' }
    await vault.loadMetaCache()
    return vault.metaCache.size
  }

  it('drops what an older build indexed, which holds `Note\\` as a target', async () => {
    assert.equal(await loaded({ version: 1, entries: { 'a.md': {} } }), 0)
  })

  it('keeps what this build wrote', async () => {
    assert.equal(await loaded({ version: 2, entries: { 'a.md': {} } }), 1)
  })
})
