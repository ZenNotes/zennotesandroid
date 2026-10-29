import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

describe('the System bars row (Settings, Appearance)', () => {
  const shell = readFileSync(new URL('./MobileShell.tsx', import.meta.url), 'utf8')
  const choices = shell.slice(shell.indexOf('const SYSTEM_BARS_CHOICES'), shell.indexOf('function SettingsSystemBarsRow('))
  const row = shell.slice(shell.indexOf('function SettingsSystemBarsRow('), shell.indexOf('// Settings → Appearance → Swipe gestures'))

  it('does not call Android\'s top bar a status bar beside core\'s Status bar switch', () => {
    assert.doesNotMatch(choices, /label: '[^']*status bar[^']*'/i)
    assert.match(choices, /label: 'No top bar'/)
  })

  it('says which bar it hides', () => {
    assert.match(row, /Hide Android’s status bar along the top/)
  })
})
