import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

const shell = readFileSync(new URL('./MobileShell.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('./mobile.css', import.meta.url), 'utf8')

describe('Home names the open vault', () => {
  it('mounts in the Home header, on a phone only', () => {
    const hook = shell.slice(shell.indexOf('function useHomeVaultChip'), shell.indexOf('function useVaultSettingsRows'))
    assert.match(hook, /if \(!isPhoneWidth\(\)\) return/)
    assert.match(hook, /\[data-home-nav\] header/)
    assert.match(shell, /\n  useHomeVaultChip\(\)\n/)
  })

  it('shows the vault, and opens the switcher', () => {
    const chip = shell.slice(shell.indexOf('function HomeVaultChip'), shell.indexOf('function useHomeVaultChip'))
    assert.match(chip, /useBrowseSnapshot\(\)\.vault\?\.name/)
    assert.match(chip, /openMobileSheet\('vaults'\)/)
  })

  it('keeps a long name from pushing the greeting off screen', () => {
    assert.match(css, /\.zn-home-vault-host \{[^}]*max-width: 45%/)
    assert.match(css, /\.zn-home-vault-chip \{[^}]*min-height: 44px/)
    assert.match(css, /\.zn-home-vault-chip span \{[^}]*white-space: nowrap/)
  })
})

describe('the way back to a hidden sidebar', () => {
  it('stays off a phone, which has no sidebar', () => {
    assert.match(css, /\.zn-mobile\.zn-phone \[data-sidebar-restore\] \{\s*display: none;/)
  })
})
