import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

describe('the restore landing on the phone layout', () => {
  const source = readFileSync(new URL('./MobileShell.tsx', import.meta.url), 'utf8')
  const boot = source.slice(source.indexOf('function usePhoneLayoutBoot('), source.indexOf('function openWikilinkFromTouch('))

  it('lands under the read-open hold', () => {
    assert.match(boot, /void openToRead\(async \(\) => land\(\)\)/)
  })

  it('closes the restored sidebar inside that landing, where its focus hand-off is refused', () => {
    const land = boot.slice(boot.indexOf('const land = (): void => {'))
    assert.match(land, /configureWorkspacePresentation\(\{ sidebarVisible: false/)
    const apply = boot.slice(boot.indexOf('const apply = (): void => {'), boot.indexOf('const land = (): void => {'))
    assert.doesNotMatch(apply, /configureWorkspacePresentation/)
  })
})
