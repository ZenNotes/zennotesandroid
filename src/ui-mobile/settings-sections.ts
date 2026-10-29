/**
 * Settings sections the phone layout keeps out of the section list (MCP, CLI
 * and Keymap; see HIDDEN_SETTINGS_SECTIONS in MobileShell).
 *
 * The rows were hidden once, when the Settings panel mounted. Core rebuilds
 * the section list whenever the Settings search empties, so typing anything
 * and clearing it brought MCP, CLI and Keymap back, and a tap opened those
 * desktop pages. The hide now runs with the panel's other cleanups, on every
 * change to the panel, so it holds across searches, clears and section
 * switches. Kept apart from the DOM types so node --test covers it. Same
 * helper as the iPhone shell's.
 */

export interface SectionRow {
  readonly textContent: string | null
  readonly classList: { add(token: string): void }
}

export interface SectionList {
  querySelectorAll(selector: 'button'): Iterable<SectionRow>
}

export const HIDDEN_SECTION_CLASS = 'zn-settings-hidden'

/** Hide each section row whose visible label is in `hidden`. Safe to repeat. */
export function hideSettingsSectionRows(aside: SectionList, hidden: ReadonlySet<string>): void {
  for (const row of aside.querySelectorAll('button')) {
    if (hidden.has((row.textContent ?? '').trim())) row.classList.add(HIDDEN_SECTION_CLASS)
  }
}

/**
 * Settings search results that open a page or a row the shell hides.
 *
 * Core lists the matching settings of every section and sub-tab, the hidden
 * ones too, and marks each result only with its section
 * (`data-settings-result-category`). A result for a hidden sub-tab (Vim,
 * Quick capture, Search, Workflows, Folders) or a hidden row opened a page
 * without it: "key" offered Exit insert mode with and Quick capture hotkey.
 * With no sub-tab or setting marker on the result, these are matched by
 * section and title, copied from core's subTabs searchIds and from the rows
 * mobile.css hides (settings-sections.test.ts checks every title is still
 * in the installed core). A data-settings-result-tab marker in core would
 * let this list go.
 */
export interface HiddenSettingResult {
  /** The result's section, as `data-settings-result-category` names it. */
  readonly category: string
  readonly title: string
  /** Hidden only in the phone layout; a tablet in the desktop layout shows it. */
  readonly phoneOnly?: boolean
}

const phoneOnly = (category: string, titles: string[]): HiddenSettingResult[] =>
  titles.map((title) => ({ category, title, phoneOnly: true }))
const always = (category: string, titles: string[]): HiddenSettingResult[] =>
  titles.map((title) => ({ category, title }))

export const HIDDEN_SETTING_RESULTS: readonly HiddenSettingResult[] = [
  // Editor's Search, Quick capture and Workflows sub-tabs, at any width.
  ...always('editor', ['Show tagged blocks in note search', 'Vault text search backend', 'ripgrep binary path', 'fzf binary path']),
  ...always('editor', ['Quick capture hotkey']),
  ...always('editor', ['Workflows', 'Event triggers', 'Built-in recipes', 'Guided tutorial']),
  // Rows mobile.css hides at any width.
  ...always('about', ['Updates']),
  ...always('appearance', ['Use theme for PDF export']),
  // Editor's Vim sub-tab and Vault's Folders sub-tab, on phones.
  ...phoneOnly('editor', [
    'Vim mode',
    'Wrapped line motions',
    'Exit insert mode with',
    'Sync clipboard with Vim registers',
    'Keep the input method out of normal mode',
    'Leader key hints',
    'Leader hint behavior',
    'Leader hint duration',
    'Scroll offset'
  ]),
  ...phoneOnly('vault', [
    'Inbox label',
    'Quick Notes label',
    'Archive label',
    'Trash label',
    'Tasks label',
    'Inbox path',
    'Quick Notes path',
    'Archive path',
    'Trash path'
  ]),
  // Rows mobile.css hides on phones.
  ...phoneOnly('vault', ['Primary notes location', 'View settings', 'Default drawings location']),
  ...phoneOnly('appearance', ['Dark sidebar', 'Sidebar arrows', 'Title bar'])
]

export interface SearchResultRow {
  readonly dataset: { settingsResultCategory?: string }
  readonly classList: { add(token: string): void }
  querySelector(selector: '.font-medium'): { readonly textContent: string | null } | null
}

export interface SearchResultList {
  querySelectorAll(selector: '[data-settings-result-category]'): Iterable<SearchResultRow>
}

/** Whether a result opens a section, sub-tab or row the shell hides. */
export function isHiddenSettingResult(
  category: string,
  title: string,
  hiddenSectionIds: ReadonlySet<string>,
  phone: boolean
): boolean {
  if (hiddenSectionIds.has(category)) return true
  return HIDDEN_SETTING_RESULTS.some(
    (entry) => entry.category === category && entry.title === title && (phone || !entry.phoneOnly)
  )
}

/** Hide every search result that would open a hidden page or row. Safe to repeat. */
export function hideSettingsSearchResults(
  panel: SearchResultList,
  hiddenSectionIds: ReadonlySet<string>,
  phone: boolean
): void {
  for (const result of panel.querySelectorAll('[data-settings-result-category]')) {
    const category = result.dataset.settingsResultCategory ?? ''
    const title = (result.querySelector('.font-medium')?.textContent ?? '').trim()
    if (isHiddenSettingResult(category, title, hiddenSectionIds, phone)) result.classList.add(HIDDEN_SECTION_CLASS)
  }
}

/**
 * Core's empty state for a search with no results, which core shows only when
 * nothing matched at all. A search whose every match is hidden left an empty
 * list instead; the shell adds the same element, copied from core's markup
 * (settings-sections.test.ts checks it still matches), and takes it away as
 * soon as a visible result is back.
 */
export const NO_MATCHES_TEXT = 'No settings match your search.'
export const NO_MATCHES_CLASS = 'rounded-xl border border-dashed border-paper-300/70 px-3 py-4 text-sm text-ink-500'
export const NO_MATCHES_ATTRIBUTE = 'data-zn-settings-no-matches'

export interface NoMatchesNode {
  className: string
  textContent: string | null
  setAttribute(name: string, value: string): void
  remove(): void
}

export interface ResultsNav<N extends NoMatchesNode> {
  querySelectorAll(selector: '[data-settings-result-category]'): Iterable<{
    readonly classList: { contains(token: string): boolean }
  }>
  querySelector(selector: `[${typeof NO_MATCHES_ATTRIBUTE}]`): NoMatchesNode | null
  appendChild(node: N): unknown
  readonly ownerDocument: { createElement(tag: 'div'): N }
}

/** Show core's "No settings match your search." when every result is hidden. Safe to repeat. */
export function syncNoMatchesState<N extends NoMatchesNode>(nav: ResultsNav<N>): void {
  const results = [...nav.querySelectorAll('[data-settings-result-category]')]
  const allHidden = results.length > 0 && results.every((row) => row.classList.contains(HIDDEN_SECTION_CLASS))
  const shown = nav.querySelector(`[${NO_MATCHES_ATTRIBUTE}]`)
  if (allHidden && !shown) {
    const node = nav.ownerDocument.createElement('div')
    node.className = NO_MATCHES_CLASS
    node.textContent = NO_MATCHES_TEXT
    node.setAttribute(NO_MATCHES_ATTRIBUTE, '')
    nav.appendChild(node)
  } else if (!allHidden && shown) {
    shown.remove()
  }
}
