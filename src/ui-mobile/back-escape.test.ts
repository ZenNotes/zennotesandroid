import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

const { escapeOrigin, sendEscape } = await import('./back-escape.ts')

/** An element that knows which elements it holds and records what it is sent. */
function element(name: string, children: object[] = []) {
  const sent: string[] = []
  return {
    name,
    sent,
    contains: (other: object) => children.includes(other),
    dispatchEvent: (event: { type: string; key: string; bubbles: boolean }) => {
      sent.push(`${event.type}:${event.key}:${event.bubbles}`)
      return true
    }
  }
}

describe('System back on a layer above the page', () => {
  it('starts the Escape at the focus inside the layer, else at the layer, else at the window', () => {
    const field = element('field')
    const menu = element('menu', [field])
    const outside = element('outside')
    const win = element('window')
    assert.equal(escapeOrigin(menu as never, field as never, win as never), field)
    assert.equal(escapeOrigin(menu as never, outside as never, win as never), menu)
    assert.equal(escapeOrigin(menu as never, null, win as never), menu)
    assert.equal(escapeOrigin(undefined, field as never, win as never), win)
  })

  it('sends a bubbling Escape keydown, so the window still hears what no layer handles', () => {
    const field = element('field')
    const modal = element('modal', [field])
    const win = element('window')
    class KeyboardEvent {
      readonly type: string
      readonly key: string
      readonly bubbles: boolean
      constructor(type: string, init: { key: string; bubbles?: boolean }) {
        this.type = type
        this.key = init.key
        this.bubbles = init.bubbles ?? false
      }
    }
    Object.assign(globalThis, { KeyboardEvent, window: win, document: { activeElement: field } })
    sendEscape(modal as never)
    sendEscape()
    assert.deepEqual(field.sent, ['keydown:Escape:true'])
    assert.deepEqual(win.sent, ['keydown:Escape:true'])
    assert.deepEqual(modal.sent, [])
  })

  it('closes the top-most menu or modal from inside it, and the shell sheets through zn:android-back', () => {
    const shell = readFileSync(new URL('./MobileShell.tsx', import.meta.url), 'utf8')
    const cascade = shell.slice(shell.indexOf('function useSystemBackClose('), shell.indexOf("CapApp.addListener('backButton', handle)"))
    assert.match(cascade, /const escape = sendEscape/)
    assert.match(cascade, /const menus = document\.querySelectorAll<HTMLElement>\('div\[role="menu"\]'\)\n\s+if \(menus\.length > 0 \|\| document\.querySelector\('\.z-nested, \.z-palette'\)\) \{\n\s+escape\(menus\[menus\.length - 1\]\)/)
    assert.match(cascade, /const modals = document\.querySelectorAll<HTMLElement>\('\.z-modal'\)\n\s+if \(modals\.length > 0\) \{\n\s+escape\(modals\[modals\.length - 1\]\)/)
    // Shell sheets with no Escape of their own close in step 1.
    const notes = readFileSync(new URL('./note-actions.tsx', import.meta.url), 'utf8')
    assert.match(notes, /if \(!target\) return\n\s+const onBack = \(e: Event\): void => \{\n\s+closeNoteMenu\(\)\n\s+e\.preventDefault\(\)/)
    const drawer = readFileSync(new URL('./MobileDrawer.tsx', import.meta.url), 'utf8')
    assert.match(drawer, /if \(folderMenu\) setFolderMenu\(null\)\n\s+else if \(sortOpen\) setSortOpen\(false\)\n\s+else return\n\s+e\.preventDefault\(\)/)
    assert.match(drawer, /window\.addEventListener\('zn:android-back', onBack\)/)
  })

  it('reads where core listens for Escape', () => {
    const core = (path: string): string =>
      readFileSync(new URL(`../../node_modules/@zennotes/app-core/dist/components/${path}`, import.meta.url), 'utf8')
    // The context menu: on its own element, never at the window.
    const menu = core('ContextMenu.js')
    assert.match(menu, /"data-ctx-menu": true, role: "menu", "aria-label": title, tabIndex: -1, onKeyDown: handleKeyDown/)
    assert.doesNotMatch(menu, /addEventListener\('keydown'/)
    // A dialog: at the window. A prompt turns that off and listens in its field.
    assert.match(core('ui/Modal.js'), /window\.addEventListener\('keydown', handler, true\)/)
    const prompt = core('PromptModal.js')
    assert.match(prompt, /onClose: onCancel, closeOnEsc: false/)
    assert.match(prompt, /else if \(e\.key === 'Escape'\) \{/)
  })
})
