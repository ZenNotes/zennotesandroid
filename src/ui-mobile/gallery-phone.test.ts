import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

describe('the folder Gallery on the phone layout', () => {
  const gallery = readFileSync(new URL('../../node_modules/@zennotes/app-core/dist/components/GalleryView.js', import.meta.url), 'utf8')

  it('opens a card\'s note to read, like core\'s other note lists', () => {
    const readOpen = readFileSync(new URL('./read-open.ts', import.meta.url), 'utf8')
    const rows = readOpen.slice(readOpen.indexOf('const READ_ROWS ='), readOpen.indexOf('/** Controls inside a row'))
    assert.match(rows, /'\[data-gallery-card\]'/)
    // The marker is core's own: a rename there fails here at the next adoption.
    assert.match(gallery, /"data-gallery-card"/)
  })

  it('lets the Gallery header grow when its controls wrap', () => {
    // Core's header wraps (flex-wrap) and grows from min-h-12; the phone's
    // fixed pane-header height must not hold it to one line.
    assert.match(gallery, /glass-header flex min-h-12 shrink-0 flex-wrap/)
    const css = readFileSync(new URL('./mobile.css', import.meta.url), 'utf8')
    assert.match(css, /\.zn-mobile\.zn-phone header\.glass-header\.flex-wrap \{\s*height: auto;/)
  })
})

describe('the folder sheet', () => {
  it('opens a folder as a Gallery, the desktop folder menu\'s Open as Gallery (core 2.80)', () => {
    const browse = readFileSync(new URL('../../node_modules/@zennotes/app-core/dist/browse.d.ts', import.meta.url), 'utf8')
    assert.match(browse, /\bopenBrowseFolderGallery\b/)
    const drawer = readFileSync(new URL('./MobileDrawer.tsx', import.meta.url), 'utf8')
    const sheet = drawer.slice(drawer.indexOf("aria-label={folderMenu.kind === 'database'"), drawer.indexOf('zn-mobile-drawer-footer'))
    // A folder row, not a database's: a database lists its pages in its own grid.
    assert.match(sheet, /folderMenu\.kind === 'folder' && \(\s*<button[^]*?openFolderGallery\(folderMenu\.subpath\)[^]*?Open as Gallery/)
    assert.match(drawer, /go\(\(\) => openBrowseFolderGallery\(host, subpath\)/)
  })
})
