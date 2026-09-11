import assert from 'node:assert/strict'
import test from 'node:test'
import { runImagePaste, type PasteContext } from './image-paste-session.ts'

function setup() {
  let context: PasteContext | null = { vault: {}, editor: {}, document: {}, path: 'note.md', from: 3, to: 3 }
  const events: string[] = []
  return {
    events, change: (patch: Partial<PasteContext>) => { context = { ...context!, ...patch } },
    options: {
      current: () => context,
      read: async () => { events.push('read'); return 'image' },
      save: async (_: PasteContext, image: string) => { events.push(`save:${image}`); return 'asset' },
      insert: (_: PasteContext, asset: string) => { events.push(`insert:${asset}`) }
    }
  }
}
test('keyboard paste reads, saves in the captured vault and inserts once (#54)', async () => {
  const s = setup()
  await runImagePaste(s.options)
  assert.deepEqual(s.events, ['read', 'save:image', 'insert:asset'])
})
for (const patch of [{ path: 'other.md' }, { vault: {} }, { editor: {} }, { document: {} }, { from: 10 }]) {
  test(`note/context change during image read cancels before saving: ${Object.keys(patch)[0]}`, async () => {
    const s = setup()
    await assert.rejects(runImagePaste({ ...s.options, read: async () => { s.change(patch); return 'image' } }), /changed/)
    assert.deepEqual(s.events, [])
  })
}
test('switching notes during storage write never inserts into the new note', async () => {
  const s = setup()
  await assert.rejects(runImagePaste({ ...s.options, save: async () => { s.change({ path: 'other.md' }); return 'asset' } }), /saved/)
  assert.deepEqual(s.events, ['read'])
})
test('storage failure does not insert a broken reference', async () => {
  const s = setup()
  await assert.rejects(runImagePaste({ ...s.options, save: async () => { throw new Error('Disk full') } }), /Disk full/)
  assert.deepEqual(s.events, ['read'])
})
