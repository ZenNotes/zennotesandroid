import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import postcss from 'postcss'

const css = postcss.parse(readFileSync(new URL('./mobile.css', import.meta.url), 'utf8'))
function declaration(selector: string, property: string): string | undefined {
  let result: string | undefined
  css.walkRules(selector, (rule) => {
    rule.walkDecls(property, (decl) => { result = decl.value })
  })
  return result
}

test('Cloud footer reserves a touch-sized row below the phone floating navigation (#48)', () => {
  assert.equal(declaration('.zn-phone:has([data-cloud-sync-status])', '--zn-cloud-footer-height'), '44px')
  assert.equal(declaration('.zn-phone .h-8:has([data-cloud-sync-status])', 'height'), 'var(--zn-cloud-footer-height)')
  assert.equal(declaration('.zn-phone [data-cloud-sync-action]', 'min-height'), '44px')
  for (const selector of ['.zn-mobile-fab', '.zn-mobile-fab-menu', '.zn-mobile-fab-create', '.zn-mobile-fab-hint']) {
    assert.ok(declaration(selector, 'bottom')?.includes('var(--zn-cloud-footer-height, 0px)'), selector)
  }
})

/** Like `declaration`, but finds a selector inside a comma-grouped rule. */
function groupedDeclaration(selector: string, property: string): string | undefined {
  let result: string | undefined
  css.walkRules((rule) => {
    if (!rule.selectors.includes(selector)) return
    rule.walkDecls(property, (decl) => { result = decl.value })
  })
  return result
}

test('the create row comes and goes with the dial: phone layout only, hidden by the keyboard (#101)', () => {
  for (const part of ['.zn-mobile-fab', '.zn-mobile-fab-menu', '.zn-mobile-fab-create']) {
    assert.equal(declaration(part, 'display'), 'none', part)
    assert.equal(groupedDeclaration(`.zn-phone ${part}`, 'display'), 'flex', part)
    assert.equal(groupedDeclaration(`.zn-mobile.zn-kb-open ${part}`, 'display'), 'none', part)
  }
})

test('Android editor compositing surfaces always paint the active theme (#49)', () => {
  for (const selector of ['.zn-mobile body', '.zn-mobile #root', '.zn-mobile .cm-editor']) {
    assert.equal(declaration(selector, 'background'), 'rgb(var(--z-bg))', selector)
  }
})

test('the wikilink hover preview card is hidden on touch, where no mouseout ever dismisses it', () => {
  let parentQuery: string | undefined
  let important = false
  css.walkRules('.zn-mobile .note-hover-preview', (rule) => {
    parentQuery = rule.parent?.type === 'atrule' ? (rule.parent as postcss.AtRule).params : undefined
    rule.walkDecls('display', (decl) => { important = decl.important === true })
  })
  assert.equal(declaration('.zn-mobile .note-hover-preview', 'display'), 'none')
  assert.equal(important, true)
  assert.equal(parentQuery, '(pointer: coarse)')
})

// Editor viewport clearance is owned by app-core's public host registration.
// Its installed-package browser check verifies the physical editor/menu bounds.

test('toasts on a phone sit where the dial column starts, clear of the ensō (#101)', () => {
  assert.equal(groupedDeclaration('.zn-phone [data-toast-host]', 'bottom'), declaration('.zn-mobile-fab-menu', 'bottom'))
  assert.equal(groupedDeclaration('.zn-phone [data-toast-host]', 'align-items'), 'center')
})

// Since WebView 140 the page draws under the system bars, so nothing may
// paint into an inset: Review sync changes left its last lines under the
// 3-button navigation bar, and a landscape bar covered right-edge buttons.
test('dialog sheets keep their content out of the navigation bar', () => {
  const sheet = ".zn-mobile.zn-phone .z-modal[role='presentation'] > [role='dialog']"
  assert.equal(groupedDeclaration(sheet, 'padding-bottom'), 'env(safe-area-inset-bottom)')
  assert.equal(groupedDeclaration(sheet, 'padding-left'), 'env(safe-area-inset-left)')
  assert.equal(groupedDeclaration(sheet, 'padding-right'), 'env(safe-area-inset-right)')
  // overflow:hidden would clip at the padding edge and let overflow paint
  // into the inset; a scroll puts the padding at the end instead.
  assert.equal(groupedDeclaration(sheet, 'overflow-y'), 'auto')
  const block = `${sheet}:not(.flex):not(.grid)`
  assert.equal(groupedDeclaration(block, 'display'), 'flex')
  assert.equal(groupedDeclaration(block, 'flex-direction'), 'column')
  let scrollerShrinks = false
  css.walkRules((rule) => {
    if (rule.selector.includes(':not(.flex):not(.grid)') && rule.selector.includes('overflow-y-auto')) {
      rule.walkDecls('min-height', (decl) => { scrollerShrinks = decl.value === '0' })
    }
  })
  assert.ok(scrollerShrinks, 'a vh-capped scroller in a block panel must be able to shrink')
})

test('full-screen phone surfaces clear every system bar edge, landscape sides included', () => {
  for (const selector of [
    '.zn-mobile.zn-phone .zn-app-shell',
    '.zn-mobile.zn-phone .z-palette > [role=\'dialog\']',
    '.zn-mobile.zn-phone [data-zn-settings]'
  ]) {
    const padding = groupedDeclaration(selector, 'padding') ?? ''
    for (const edge of ['top', 'right', 'bottom', 'left']) {
      assert.ok(padding.includes(`env(safe-area-inset-${edge})`), `${selector} ${edge}`)
    }
  }
  for (const selector of ['.zn-mobile-sheet', '.zn-phone .zn-mobile-drawer', '.zn-onboard']) {
    assert.ok(groupedDeclaration(selector, 'padding')?.includes('env(safe-area-inset-left)'), selector)
  }
})

test('a select row stacked in a column keeps its height; one on a toolbar line still fills it', () => {
  assert.equal(declaration('.zn-mobile.zn-phone .zn-app-shell div:has(> select)', 'flex'), '1')
  assert.equal(declaration('.zn-mobile.zn-phone .zn-app-shell .flex-col > div:has(> select)', 'flex'), 'none')
})

test('the date calendar hides its key help on phones and keeps Today on the right', () => {
  const hint = '.zn-mobile.zn-phone [data-date-picker] div.justify-between > span:first-child:not([data-date-picker-month])'
  assert.equal(declaration(hint, 'display'), 'none')
  assert.equal(declaration(`${hint} + button`, 'margin-left'), 'auto')
})

test("the Calendar sheet is the date calendar's full-screen phone sheet, with finger-sized days", () => {
  const panel = '.zn-mobile.zn-phone .zn-calendar-sheet > [data-calendar-panel]'
  assert.equal(groupedDeclaration(panel, 'position'), 'fixed')
  assert.ok(groupedDeclaration(panel, 'width')?.includes('100vw'))
  assert.equal(groupedDeclaration('.zn-mobile.zn-phone .zn-calendar-sheet button[data-cal-day]', 'min-height'), '42px')
})

test('a palette sub-list\'s Back row ends before the shell\'s Cancel', () => {
  assert.equal(declaration(".zn-mobile.zn-phone .z-palette [role='dialog'] div:has(> button[aria-label='Back to commands'])", 'padding-right'), '5rem')
  // The caption wraps; "‹ Back" stays on one line beside it.
  assert.equal(declaration(".zn-mobile.zn-phone .z-palette button[aria-label='Back to commands']", 'white-space'), 'nowrap')
  assert.equal(declaration(".zn-mobile.zn-phone .z-palette button[aria-label='Back to commands']", 'flex-shrink'), '0')
  const palette = readFileSync(new URL('../../node_modules/@zennotes/app-core/dist/components/CommandPalette.js', import.meta.url), 'utf8')
  assert.match(palette, /"aria-label": "Back to commands"/)
})

test("a database's selection bar fits a phone: the count on its own line, the actions under it", () => {
  assert.equal(declaration('.zn-mobile.zn-phone [data-db-selection-bar]', 'flex-wrap'), 'wrap')
  assert.equal(declaration('.zn-mobile.zn-phone [data-db-selection-bar] > span:first-child', 'flex-basis'), '100%')
  // Both of core's bars (rows selected, and editing picks) open with the count's span.
  const table = readFileSync(new URL('../../node_modules/@zennotes/app-core/dist/components/DatabaseTableView.js', import.meta.url), 'utf8')
  assert.equal(table.match(/"data-db-selection-bar": true, className: "flex [^"]*", children: \[_jsxs\("span"/g)?.length, 2)
  assert.match(table, /children: "Clear"/)
})
