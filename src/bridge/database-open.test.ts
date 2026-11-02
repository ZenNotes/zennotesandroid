import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { missingDatabaseAsNull } from './database-open.ts'

const doc = { relPath: 'inbox/Board.base/data.csv' } as never

describe('Opening a database whose folder is gone', () => {
  it('answers null for a missing database, so core forgets it and closes its tab', async () => {
    const open = missingDatabaseAsNull(async (rel) => {
      throw new Error(`Database not found: ${rel}`)
    })
    assert.equal(await open('inbox/Projects/Untitled Kanban.base/data.csv'), null)
  })

  it('passes a database through, and every other failure still throws', async () => {
    assert.equal(await missingDatabaseAsNull(async () => doc)('x'), doc)
    const unreadable = missingDatabaseAsNull(async () => {
      throw new Error('EACCES: permission denied')
    })
    await assert.rejects(unreadable('x'), /permission denied/)
  })

  it('is what the bridge hands core', () => {
    const bridge = readFileSync(new URL('./mobile-bridge.ts', import.meta.url), 'utf8')
    assert.match(bridge, /openDatabase: openDatabaseOrThrow,/)
    assert.match(bridge, /const openDatabase = missingDatabaseAsNull\(openDatabaseOrThrow\)/)
  })

  it('reads the contract core and the shared ops keep', () => {
    const pkg = (path: string): string =>
      readFileSync(new URL(`../../node_modules/@zennotes/${path}`, import.meta.url), 'utf8')
    // The shared ops throw for an absent data.csv ...
    assert.match(pkg('shared-domain/dist/database-ops.js'), /if \(csvText === null\)\n\s+throw new Error\(`Database not found: \$\{rel\}`\);/)
    // ... core forgets a database the bridge answers null for, and toasts a
    // throw once, recording it so the grid does not ask again (core 2.81.0).
    const store = pkg('app-core/dist/store.js')
    assert.match(store, /if \(!doc\) \{[\s\S]{0,240}await get\(\)\.forgetDatabase\(csvPath\);/)
    assert.match(store, /const message = humanIpcError\(err, 'Could not open database'\);[\s\S]{0,240}databasesLoadError[\s\S]{0,240}\.addToast\(message, 'error'\);/)
    assert.match(pkg('bridge-contract/dist/bridge.d.ts'), /openDatabase\(relPath: string\): Promise<DatabaseDoc \| null>;/)
  })
})
