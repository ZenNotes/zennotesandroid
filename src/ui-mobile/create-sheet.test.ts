import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

describe('The New… sheet', () => {
  const shell = readFileSync(new URL('./MobileShell.tsx', import.meta.url), 'utf8')
  const commands = readFileSync(
    new URL('../../node_modules/@zennotes/app-core/dist/lib/commands.js', import.meta.url),
    'utf8'
  )
  const sheet = shell.slice(shell.indexOf('function CreateSheet('), shell.indexOf('function showCalendar('))

  it('offers New Kanban right after New database, through core', () => {
    const database = sheet.indexOf("runCommand('database.new')")
    const kanban = sheet.indexOf("runCommand('database.new.kanban')")
    const folder = sheet.indexOf('newFolder())')
    assert.ok(database > 0, 'New database row')
    assert.ok(kanban > database, 'New Kanban comes after New database')
    assert.ok(folder > kanban, 'and before New folder')
    assert.match(sheet.slice(kanban), /^runCommand\('database\.new\.kanban'\)\)\}\n\s+>\n\s+<Icon d=\{ICONS\.\w+\} \/>\n\s+New Kanban\n/)
  })

  it('names a command the adopted core registers', () => {
    assert.match(commands, /id: 'database\.new\.kanban',\n\s+title: 'New Kanban'/)
  })
})
