import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

describe('the restore landing on the phone layout', () => {
  const source = readFileSync(new URL('./MobileShell.tsx', import.meta.url), 'utf8')
  const boot = source.slice(source.indexOf('function usePhoneLayoutBoot('), source.indexOf('function openWikilinkFromTouch('))

  it('lands under the read-open hold, held until the landing is on screen', () => {
    assert.match(boot, /void holdLanding\(async \(\) => \{\n\s+land\(\)\n\s+await landingOnScreen\(\)\n\s+\}\)/)
  })

  it('arms the hold before the landing runs', () => {
    const readOpen = readFileSync(new URL('./read-open.ts', import.meta.url), 'utf8')
    const holdLanding = readOpen.slice(readOpen.indexOf('export function holdLanding('))
    assert.ok(holdLanding.indexOf('holdUntilSettled(hold') < holdLanding.indexOf('land().then(landed, landed)'))
  })

  it('closes the restored sidebar inside that landing, where its focus hand-off is refused', () => {
    const land = boot.slice(boot.indexOf('const land = (): void => {'))
    assert.match(land, /configureWorkspacePresentation\(\{ sidebarVisible: false/)
    const apply = boot.slice(boot.indexOf('const apply = (): void => {'), boot.indexOf('const land = (): void => {'))
    assert.doesNotMatch(apply, /configureWorkspacePresentation/)
  })
})
