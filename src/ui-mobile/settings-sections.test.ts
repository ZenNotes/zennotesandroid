import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import {
  HIDDEN_SECTION_CLASS,
  HIDDEN_SETTING_RESULTS,
  NO_MATCHES_ATTRIBUTE,
  NO_MATCHES_CLASS,
  NO_MATCHES_TEXT,
  syncNoMatchesState,
  type NoMatchesNode,
  type ResultsNav,
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

/** A result button: hidden or not, as the shell left it. */
class ShownResult {
  readonly classes = new Set<string>()
  readonly classList = { contains: (token: string) => this.classes.has(token) }
  constructor(hidden: boolean) { if (hidden) this.classes.add(HIDDEN_SECTION_CLASS) }
}

class Marker implements NoMatchesNode {
  className = ''
  textContent: string | null = null
  readonly attributes = new Map<string, string>()
  parent: Nav | null = null
  setAttribute(name: string, value: string): void { this.attributes.set(name, value) }
  remove(): void {
    if (!this.parent) return
    this.parent.children = this.parent.children.filter((child) => child !== this)
    this.parent = null
  }
}

/** Core's results nav, holding result buttons and whatever the shell appended. */
class Nav implements ResultsNav<Marker> {
  results: ShownResult[] = []
  children: Marker[] = []
  readonly ownerDocument = { createElement: (): Marker => new Marker() }
  querySelectorAll(): Iterable<ShownResult> { return this.results }
  querySelector(): Marker | null { return this.children.find((child) => child.attributes.has(NO_MATCHES_ATTRIBUTE)) ?? null }
  appendChild(node: Marker): void { node.parent = this; this.children.push(node) }
}

describe('syncNoMatchesState', () => {
  it('shows core\'s empty state when every match is hidden ("updates" on a phone)', () => {
    const nav = new Nav()
    nav.results = [new ShownResult(true), new ShownResult(true)]
    syncNoMatchesState(nav)
    assert.equal(nav.children.length, 1)
    assert.equal(nav.children[0]!.className, NO_MATCHES_CLASS)
    assert.equal(nav.children[0]!.textContent, NO_MATCHES_TEXT)
  })

  it('adds it once however often the panel changes', () => {
    const nav = new Nav()
    nav.results = [new ShownResult(true)]
    for (let i = 0; i < 3; i++) syncNoMatchesState(nav)
    assert.equal(nav.children.length, 1)
  })

  it('takes it away as soon as a visible result is back', () => {
    const nav = new Nav()
    nav.results = [new ShownResult(true)]
    syncNoMatchesState(nav)
    nav.results = [new ShownResult(true), new ShownResult(false)]
    syncNoMatchesState(nav)
    assert.equal(nav.children.length, 0)
  })

  it('leaves a search with visible results, and one with none at all (core\'s own empty state), alone', () => {
    const some = new Nav()
    some.results = [new ShownResult(false), new ShownResult(true)]
    syncNoMatchesState(some)
    assert.equal(some.children.length, 0)
    const none = new Nav()
    syncNoMatchesState(none)
    assert.equal(none.children.length, 0)
  })
})

describe('the no-matches state', () => {
  const modal = readFileSync(new URL('../../node_modules/@zennotes/app-core/dist/components/SettingsModal.js', import.meta.url), 'utf8')
  const shell = readFileSync(new URL('./MobileShell.tsx', import.meta.url), 'utf8')
  const clean = shell.slice(shell.indexOf('function cleanSettingsContent('), shell.indexOf('function mobilizeSettingsPanel('))

  it('copies core\'s own empty state (a restyle or reword in core fails here at the next adoption)', () => {
    assert.ok(modal.includes(`className: "${NO_MATCHES_CLASS}", children: "${NO_MATCHES_TEXT}"`))
  })

  it('sits where core\'s own box sits, with no list spacing above it', () => {
    // Core's results list spaces its children; the hidden results before the
    // shell's box count as siblings there, so mobile.css takes that margin off.
    assert.match(modal, /_jsxs\("nav", \{ className: "space-y-1", children: \[searchResults\.map/)
    const css = readFileSync(new URL('./mobile.css', import.meta.url), 'utf8')
    assert.match(css, new RegExp(`\\.zn-mobile nav > \\[${NO_MATCHES_ATTRIBUTE}\\] \\{\\s*margin-top: 0 !important;`))
  })

  it('is synced on the results list after the hide, on every change', () => {
    const hide = clean.indexOf('hideSettingsSearchResults(')
    const sync = clean.indexOf("const results = panel.querySelector('aside nav')")
    assert.ok(hide >= 0 && sync > hide)
    assert.match(clean, /if \(results\) syncNoMatchesState<HTMLDivElement>\(results\)/)
  })
})
