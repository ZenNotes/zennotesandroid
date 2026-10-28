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
