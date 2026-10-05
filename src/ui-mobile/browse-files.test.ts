import assert from 'node:assert/strict'
import test from 'node:test'
import { drawerFileRows, fileExtensionLabel } from './browse-files.ts'

// What core's getBrowseDirectory hands the drawer: the pinned core (2.60.4)
// lists folders, databases and notes only, and newer cores add file rows.
const pinnedCore = { folders: [], databases: [], notes: [] }
const report = {
  path: 'zen://asset/inbox%2FWork%2FReport%202024.pdf',
  directory: 'Work',
  name: 'Report 2024.pdf',
  kind: 'pdf',
  updatedAt: 5
}
const scan = { ...report, path: 'zen://asset/inbox%2FWork%2FScan.png', name: 'Scan.png', kind: 'image' }

test('a core without file rows lists no files', () => {
  assert.deepEqual(drawerFileRows(pinnedCore), [])
})

test('a core with file rows lists them in its order, each with its opaque path', () => {
  assert.deepEqual(drawerFileRows({ ...pinnedCore, files: [report, scan] }), [report, scan])
})

test('a row the drawer cannot open or label is skipped rather than drawn broken', () => {
  assert.deepEqual(drawerFileRows({ ...pinnedCore, files: 'not a list' }), [])
  assert.deepEqual(
    drawerFileRows({
      ...pinnedCore,
      files: [null, 'Scan.png', { name: 'x.pdf' }, { path: 'zen://asset/x', name: '' }, report]
    }),
    [report]
  )
})

test('the extension label is the one the desktop sidebar prints beside a file', () => {
  assert.equal(fileExtensionLabel('Report 2024.pdf'), 'PDF')
  assert.equal(fileExtensionLabel('backup.tar.gz'), 'GZ')
  assert.equal(fileExtensionLabel('Makefile'), '')
  assert.equal(fileExtensionLabel('draft.'), '')
})
