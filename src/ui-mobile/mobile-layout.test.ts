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
  for (const selector of ['.zn-mobile-fab', '.zn-mobile-fab-menu', '.zn-mobile-fab-hint']) {
    assert.ok(declaration(selector, 'bottom')?.includes('var(--zn-cloud-footer-height, 0px)'), selector)
  }
})

test('Android editor compositing surfaces always paint the active theme (#49)', () => {
  for (const selector of ['.zn-mobile body', '.zn-mobile #root', '.zn-mobile .cm-editor']) {
    assert.equal(declaration(selector, 'background'), 'rgb(var(--z-bg))', selector)
  }
})

test('selection toolbar space shrinks the viewport instead of hiding text (#51)', () => {
  assert.equal(declaration('.zn-phone .cm-editor', 'padding-bottom'), 'var(--zn-selection-clearance, 0px)')
  assert.equal(declaration('.zn-phone .cm-editor', 'box-sizing'), 'border-box')
})
