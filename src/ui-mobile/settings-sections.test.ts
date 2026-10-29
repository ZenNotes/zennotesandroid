import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import {
  HIDDEN_SECTION_CLASS,
  HIDDEN_SETTING_RESULTS,
  hideSettingsSearchResults,
  hideSettingsSectionRows,
  isHiddenSettingResult,
  type SearchResultList,
  type SearchResultRow,
  type SectionList,
  type SectionRow
} from './settings-sections.ts'

class Row implements SectionRow {
  readonly classes = new Set<string>()
  readonly classList = { add: (token: string) => { this.classes.add(token) } }
  // A plain field, not a constructor parameter property: node --test strips
  // types only and refuses parameter properties.
  readonly textContent: string
  constructor(textContent: string) { this.textContent = textContent }
  get hidden(): boolean { return this.classes.has(HIDDEN_SECTION_CLASS) }
}

/** Core's section list, rebuilt with new rows the way a cleared search rebuilds it. */
class Aside implements SectionList {
  rows: Row[] = []
  constructor() { this.rebuild() }
  rebuild(): void {
    this.rows = ['Appearance', 'Typography', 'Editor', 'Tasks', 'Keymap', 'Vault', 'Cloud', 'Templates', 'MCP', 'CLI', 'About']
      .map((label) => new Row(` ${label} `))
  }
  querySelectorAll(): Iterable<SectionRow> { return this.rows }
  visible(): string[] { return this.rows.filter((row) => !row.hidden).map((row) => row.textContent.trim()) }
}

const PHONE = new Set(['MCP', 'CLI', 'Keymap'])

describe('hideSettingsSectionRows', () => {
  it('hides the desktop-only sections by their label', () => {
    const aside = new Aside()
    hideSettingsSectionRows(aside, PHONE)
    assert.deepEqual(aside.visible(), ['Appearance', 'Typography', 'Editor', 'Tasks', 'Vault', 'Cloud', 'Templates', 'About'])
  })

  it('hides them again after core rebuilds the list (a cleared search)', () => {
    const aside = new Aside()
    hideSettingsSectionRows(aside, PHONE)
    aside.rebuild()
    assert.ok(aside.visible().includes('Keymap'), 'the rebuilt list starts with every row')
    hideSettingsSectionRows(aside, PHONE)
    assert.ok(!aside.visible().some((label) => PHONE.has(label)))
  })

  it('is safe to run on every change', () => {
    const aside = new Aside()
    for (let i = 0; i < 3; i++) hideSettingsSectionRows(aside, PHONE)
    assert.equal(aside.visible().length, 8)
  })
})

describe('the Settings mobilizer', () => {
  const source = readFileSync(new URL('./MobileShell.tsx', import.meta.url), 'utf8')
  const clean = source.slice(source.indexOf('function cleanSettingsContent('), source.indexOf('function mobilizeSettingsPanel('))

  it('hides the section rows in the cleanup that re-runs on every change', () => {
    assert.match(clean, /hideSettingsSectionRows\(aside, HIDDEN_SETTINGS_SECTIONS\)/)
  })
})

const PHONE_SECTION_IDS = new Set(['mcp', 'cli', 'keymaps'])

class Result implements SearchResultRow {
  readonly classes = new Set<string>()
  readonly classList = { add: (token: string) => { this.classes.add(token) } }
  readonly dataset: { settingsResultCategory?: string }
  readonly title: string
  constructor(category: string, title: string) {
    this.dataset = { settingsResultCategory: category }
    this.title = title
  }
  querySelector(): { textContent: string } { return { textContent: ` ${this.title} ` } }
  get hidden(): boolean { return this.classes.has(HIDDEN_SECTION_CLASS) }
}

describe('isHiddenSettingResult', () => {
  it('hides the settings of a sub-tab the phone hides ("key" listed Vim and Quick capture)', () => {
    assert.equal(isHiddenSettingResult('editor', 'Exit insert mode with', PHONE_SECTION_IDS, true), true)
    assert.equal(isHiddenSettingResult('editor', 'Leader key hints', PHONE_SECTION_IDS, true), true)
    assert.equal(isHiddenSettingResult('editor', 'Quick capture hotkey', PHONE_SECTION_IDS, true), true)
    assert.equal(isHiddenSettingResult('vault', 'Inbox label', PHONE_SECTION_IDS, true), true)
  })

  it('hides every result of a hidden section', () => {
    assert.equal(isHiddenSettingResult('mcp', 'Review agent edits', PHONE_SECTION_IDS, true), true)
    assert.equal(isHiddenSettingResult('keymaps', 'Keymap', PHONE_SECTION_IDS, true), true)
  })

  it('keeps the results of visible sections and rows', () => {
    assert.equal(isHiddenSettingResult('appearance', 'Status bar', PHONE_SECTION_IDS, true), false)
    assert.equal(isHiddenSettingResult('cloud', 'End-to-end encryption', PHONE_SECTION_IDS, true), false)
    assert.equal(isHiddenSettingResult('editor', 'Quick Note prefix', PHONE_SECTION_IDS, true), false)
  })

  it('needs the section as well as the title', () => {
    assert.equal(isHiddenSettingResult('appearance', 'Vim mode', PHONE_SECTION_IDS, true), false)
  })

  it('gives a tablet back the Vim and Folders settings but not the desktop-only ones', () => {
    assert.equal(isHiddenSettingResult('editor', 'Vim mode', new Set(), false), false)
    assert.equal(isHiddenSettingResult('vault', 'Inbox label', new Set(), false), false)
    assert.equal(isHiddenSettingResult('editor', 'Quick capture hotkey', new Set(), false), true)
    assert.equal(isHiddenSettingResult('about', 'Updates', new Set(), false), true)
  })
})

describe('hideSettingsSearchResults', () => {
  it('hides the results that lead to hidden pages and keeps the rest', () => {
    const results = [
      new Result('editor', 'Exit insert mode with'),
      new Result('editor', 'Quick capture hotkey'),
      new Result('editor', 'Keep the input method out of normal mode'),
      new Result('cloud', 'End-to-end encryption'),
      new Result('mcp', 'Review agent edits')
    ]
    const list: SearchResultList = { querySelectorAll: () => results }
    hideSettingsSearchResults(list, PHONE_SECTION_IDS, true)
    hideSettingsSearchResults(list, PHONE_SECTION_IDS, true) // on every change: harmless
    assert.deepEqual(results.filter((r) => !r.hidden).map((r) => r.title), ['End-to-end encryption'])
  })
})

describe('the hidden results list', () => {
  const modal = readFileSync(new URL('../../node_modules/@zennotes/app-core/dist/components/SettingsModal.js', import.meta.url), 'utf8')

  it('names titles the installed core still uses (a rename fails here at the next adoption)', () => {
    const missing = HIDDEN_SETTING_RESULTS.filter((entry) => !modal.includes(`"${entry.title}"`)).map((entry) => entry.title)
    assert.deepEqual(missing, [])
  })

  it('names sections the installed core has', () => {
    for (const category of new Set(HIDDEN_SETTING_RESULTS.map((entry) => entry.category))) {
      assert.ok(modal.includes(`id: "${category}"`), category)
    }
  })

  it('is applied by the cleanup that re-runs on every change', () => {
    const shell = readFileSync(new URL('./MobileShell.tsx', import.meta.url), 'utf8')
    const clean = shell.slice(shell.indexOf('function cleanSettingsContent('), shell.indexOf('function mobilizeSettingsPanel('))
    assert.match(clean, /hideSettingsSearchResults\(panel, hiddenSectionIds, phone\)/)
  })
})
