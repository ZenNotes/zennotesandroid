/**
 * The command palette never highlights, steps onto or runs a row the shell
 * hid.
 *
 * The shell hides desktop-only palette commands by setting their rows to
 * display: none (useDesktopCommandCleanup in MobileShell.tsx). Core does not
 * know that list: its highlight is an index into every result, hidden rows
 * included, and the arrow keys and Return go by that index. Typing
 * "timeline" left the highlight on the hidden Toggle Timeline, and the soft
 * keyboard's Return opened the Timeline the phone layout hides. So the
 * shell keeps the highlight on a visible row, makes the arrows skip hidden
 * ones, and lets Return run only a visible row; with nothing visible,
 * Return does nothing and the palette stays open. Taps only reach visible
 * rows anyway.
 *
 * Core's palette is reached through its markup: rows are
 * `[data-cmd-idx]` buttons, the highlighted one carries the `bg-paper-200`
 * class, and a row takes the highlight on `mousemove` (core's onMouseMove),
 * which is how the highlight is moved here.
 */

export interface PaletteRow {
  hidden: boolean
  active: boolean
}

/** Where a hidden highlight belongs: the first visible row. -1 when nothing
 *  has to move (no row is hidden, or the highlight is on a visible row or on
 *  none) or no row is visible. */
export function settleTarget(rows: readonly PaletteRow[]): number {
  const active = rows.findIndex((row) => row.active)
  if (active < 0 || !rows[active]!.hidden) return -1
  return rows.findIndex((row) => !row.hidden)
}

/** The row an arrow (or Ctrl+N/P, Ctrl+J/K) lands on: the next visible row
 *  in `dir`. At either end it stays put, as core's own clamp does; from a
 *  hidden highlight with nothing further it falls back to the first visible
 *  row. -1 when no row is visible. */
export function stepTarget(rows: readonly PaletteRow[], dir: 1 | -1): number {
  const active = rows.findIndex((row) => row.active)
  for (let i = active + dir; i >= 0 && i < rows.length; i += dir) {
    if (!rows[i]!.hidden) return i
  }
  if (active >= 0 && !rows[active]!.hidden) return active
  return rows.findIndex((row) => !row.hidden)
}

export type EnterPlan = { run: 'core' } | { run: 'row'; index: number } | { run: 'none' }

/** What Return does: core runs a visible highlight as always; a hidden one
 *  gives way to the first visible row; with no visible row, nothing runs. */
export function enterPlan(rows: readonly PaletteRow[]): EnterPlan {
  const active = rows.findIndex((row) => row.active)
  if (active >= 0 && !rows[active]!.hidden) return { run: 'core' }
  const first = rows.findIndex((row) => !row.hidden)
  return first >= 0 ? { run: 'row', index: first } : { run: 'none' }
}

/** Core's palette-nav.ts keys, which core does not export to the shell. */
function stepDirection(event: KeyboardEvent): 1 | -1 | 0 {
  const key = event.key.toLowerCase()
  const ctrlOnly = event.ctrlKey && !event.metaKey && !event.altKey
  if (event.key === 'ArrowDown' || (ctrlOnly && (key === 'n' || key === 'j'))) return 1
  if (event.key === 'ArrowUp' || (ctrlOnly && (key === 'p' || key === 'k'))) return -1
  return 0
}

const ROW = '[data-cmd-idx]'

function paletteRows(palette: Element): HTMLElement[] {
  return [...palette.querySelectorAll<HTMLElement>(ROW)]
}

function rowState(row: HTMLElement): PaletteRow {
  return { hidden: row.getClientRects().length === 0, active: row.classList.contains('bg-paper-200') }
}

/** Give core's highlight to `row` the way a pointer would. */
function highlight(row: HTMLElement): void {
  row.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
}

function settle(palette: Element): void {
  const rows = paletteRows(palette)
  const target = settleTarget(rows.map(rowState))
  if (target >= 0) highlight(rows[target]!)
}

let installed = false

export function installPaletteHiddenRowGuard(): void {
  if (installed) return
  installed = true

  // Capture on the document runs before core's onKeyDown on the palette's
  // input, so a key handled here never reaches it.
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.isComposing || event.keyCode === 229) return
      const target = event.target as Element | null
      const palette = target?.closest?.('.z-palette')
      if (!palette) return
      const rows = paletteRows(palette)
      const states = rows.map(rowState)
      if (!states.some((row) => row.hidden)) return
      const dir = stepDirection(event)
      if (dir !== 0) {
        event.preventDefault()
        event.stopPropagation()
        const next = stepTarget(states, dir)
        if (next >= 0) {
          highlight(rows[next]!)
          rows[next]!.scrollIntoView({ block: 'nearest' })
        }
        return
      }
      if (event.key !== 'Enter') return
      const plan = enterPlan(states)
      if (plan.run === 'core') return
      event.preventDefault()
      event.stopPropagation()
      if (plan.run === 'row') {
        highlight(rows[plan.index]!)
        // Alt+Enter records a key for the highlighted row: with the highlight
        // just moved, it waits for the next press rather than guess.
        if (!event.altKey) rows[plan.index]!.click()
      }
    },
    true
  )

  // Results change as the query does, and core puts the highlight back on
  // the first result each time, hidden or not: settle it after every change
  // to the open palette's rows, their classes and their display.
  let watched: Element | null = null
  let rowObserver: MutationObserver | null = null
  let raf = 0
  const schedule = (palette: Element): void => {
    cancelAnimationFrame(raf)
    raf = requestAnimationFrame(() => settle(palette))
  }
  const watch = (): void => {
    const palette = document.querySelector('.z-palette')
    if (palette === watched) return
    rowObserver?.disconnect()
    rowObserver = null
    watched = palette
    if (!palette) return
    rowObserver = new MutationObserver(() => schedule(palette))
    rowObserver.observe(palette, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style']
    })
    schedule(palette)
  }
  new MutationObserver(watch).observe(document.body, { childList: true, subtree: true })
  watch()
}
