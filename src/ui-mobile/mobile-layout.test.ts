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
