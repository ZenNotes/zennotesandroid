import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

describe("The drawer's folder sheet", () => {
  const drawer = readFileSync(new URL('./MobileDrawer.tsx', import.meta.url), 'utf8')
  const shell = readFileSync(new URL('./MobileShell.tsx', import.meta.url), 'utf8')
  const core = (path: string): string =>
    readFileSync(new URL(`../../node_modules/@zennotes/app-core/dist/${path}`, import.meta.url), 'utf8')
  const sheet = drawer.slice(drawer.indexOf("aria-label={folderMenu.kind === 'database'"), drawer.indexOf('Move to…'))

  it("offers a folder New Kanban after Open as Gallery, with the New sheet's glyph and wording", () => {
    const gallery = sheet.indexOf('Open as Gallery')
    const kanban = sheet.indexOf('New Kanban')
    const rename = sheet.indexOf('Rename')
    assert.ok(gallery > 0 && kanban > gallery && rename > kanban, 'Open as Gallery, New Kanban, Rename')
    assert.match(
      sheet,
      /\{folderMenu\.kind === 'folder' && \(\n\s+<button\n\s+type="button"\n\s+className="zn-mobile-sheet-row"\n\s+onClick=\{\(\) => newKanbanIn\(folderMenu\.subpath\)\}\n\s+>\n\s+<Icon d=\{D\.kanban\} \/>\n\s+New Kanban\n/
    )
    const glyph = (source: string, key: string): string | undefined =>
      source.match(new RegExp(`\\n\\s+${key}: '([^']+)'`))?.[1]
    assert.ok(glyph(drawer, 'kanban'))
    assert.equal(glyph(drawer, 'kanban'), glyph(shell, 'tabs'))
    assert.match(shell, /<Icon d=\{ICONS\.tabs\} \/>\n\s+New Kanban\n/)
  })

  it('creates the board in that folder through core, on the host captured with the sheet', () => {
    assert.match(
      drawer,
      /const newKanbanIn = \(subpath: string\): void => \{\n\s+const host = folderMenu\?\.host \?\? captureMobileWorkspace\(\)\n\s+setFolderMenu\(null\)\n\s+go\(\(\) => createBrowseKanban\(host, subpath\)\.catch\(reportActionError\)\)\n\s+\}/
    )
    assert.match(drawer, /openBrowseFolderGallery, createBrowseKanban \} from '@zennotes\/app-core\/browse'/)
  })

  it('names a create the adopted core exports, placed in the folder it is given', () => {
    assert.match(core('browse.d.ts'), /export \{[^}]*\bcreateBrowseKanban\b[^}]*\} from '\.\/lib\/browse-actions\.js'/)
    const actions = core('lib/browse-actions.js')
    assert.match(actions, /export async function createBrowseKanban\(host, directory\) \{\n\s+return createDatabaseFromBrowse\(host, directory, \(folder, subpath, isCurrent\) => useStore\.getState\(\)\.createKanban\(folder, subpath, isCurrent\)\);/)
    assert.match(actions, /: \{ folder: 'inbox', subpath: directory \};\n\s+if \(directory !== undefined && formDirContaining\(target\.subpath\)\)\n\s+return 'unavailable';/)
  })
})
