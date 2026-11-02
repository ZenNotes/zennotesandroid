import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { loadMobileModule } from '../../tooling/load-mobile-module.ts'

type Listener = (...args: any[]) => void

function define(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
}

interface Node {
  tagName: string
  type?: string
  parentElement: Node | null
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  overflowY: string
  inNote?: boolean
  rect(): { top: number; bottom: number }
}

/**
 * The real module over a scripted page: Settings' scrolling detail pane
 * (168 px to the viewport's bottom, 2268 px of content) holding a field at
 * `fieldTop` of the pane's content. Frames run only when a test says so.
 */
async function setup(fieldTop: number, opts: { inNote?: boolean; tag?: string; type?: string } = {}) {
  const viewport = { height: 914 }
  const frames = new Map<number, Listener>()
  const windowListeners = new Map<string, Listener>()
  const keyboard = new Map<string, Listener>()
  let ids = 0
  const body: Node = { tagName: 'BODY', parentElement: null, scrollTop: 0, scrollHeight: 914, clientHeight: 914, overflowY: 'visible', rect: () => ({ top: 0, bottom: 914 }) }
  const pane: Node = {
    tagName: 'DIV',
    parentElement: body,
    scrollTop: 0,
    scrollHeight: 2268,
    get clientHeight() { return viewport.height - 168 },
    overflowY: 'auto',
    rect: () => ({ top: 168, bottom: viewport.height })
  }
  const row: Node = { tagName: 'DIV', parentElement: pane, scrollTop: 0, scrollHeight: 60, clientHeight: 60, overflowY: 'visible', rect: () => ({ top: 0, bottom: 0 }) }
  const field = {
    tagName: opts.tag ?? 'INPUT',
    type: opts.type ?? 'text',
    parentElement: row,
    closest: (selector: string) => (opts.inNote && selector === '.cm-editor' ? {} : null),
    getBoundingClientRect: () => {
      const top = 168 + fieldTop - pane.scrollTop
      return { top, bottom: top + 34 }
    }
  }
  for (const node of [body, pane, row] as (Node & { getBoundingClientRect?: unknown })[]) {
    node.getBoundingClientRect = node.rect
  }
  define('requestAnimationFrame', (run: Listener) => { frames.set(++ids, run); return ids })
  define('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  define('getComputedStyle', (node: Node) => ({ overflowY: node.overflowY }))
  define('window', {
    get innerHeight() { return viewport.height },
    addEventListener: (type: string, run: Listener) => { windowListeners.set(type, run) },
    removeEventListener: (type: string, run: Listener) => { if (windowListeners.get(type) === run) windowListeners.delete(type) }
  })
  define('document', { body, activeElement: field })
  const reveal = await loadMobileModule('./src/ui-mobile/field-keyboard-reveal.ts', {
    '@capacitor/keyboard': {
      Keyboard: {
        addListener: (event: string, run: Listener) => {
          keyboard.set(event, run)
          return Promise.resolve({ remove: () => { keyboard.delete(event) } })
        }
      }
    }
  })
  const uninstall: () => void = reveal.installFieldKeyboardReveal()
  return {
    reveal,
    uninstall,
    pane,
    field,
    windowListeners,
    keyboardListeners: keyboard,
    frame() {
      const due = [...frames.values()]
      frames.clear()
      for (const run of due) run()
    },
    /** The keyboard lands: the WebView shrinks to its top, then the plugin says so. */
    keyboardUp(height = 578) {
      viewport.height = height
      windowListeners.get('resize')?.()
      keyboard.get('keyboardDidShow')?.()
    },
    keyboardDown() {
      viewport.height = 914
      windowListeners.get('resize')?.()
    }
  }
}

test('a field the keyboard covers in part is centred in what shows above it', async () => {
  // Settings › Tasks: "Group by the folders inside" sits at 559 to 593, the
  // keyboard's top lands at 578, and Chromium leaves a field it only partly
  // covers where it is.
  const s = await setup(391)
  assert.deepEqual(s.field.getBoundingClientRect(), { top: 559, bottom: 593 })
  s.keyboardUp()
  s.frame()
  const { top, bottom } = s.field.getBoundingClientRect()
  assert.ok(bottom <= 578 - 12, `the field ends above the keyboard (${bottom})`)
  assert.ok(Math.abs((top + bottom) / 2 - (168 + 578) / 2) < 1, `centred in the pane above it (${top})`)
  s.uninstall()
})

test('a field already in full view, or the keyboard leaving, scrolls nothing', async () => {
  const s = await setup(100)
  s.keyboardUp()
  s.frame()
  assert.equal(s.pane.scrollTop, 0)
  s.keyboardDown()
  s.frame()
  assert.equal(s.pane.scrollTop, 0)
  s.uninstall()
})

test("the note's editor keeps its own caret reveal (zennotes#891)", async () => {
  const s = await setup(391, { inNote: true, tag: 'DIV' })
  s.keyboardUp()
  s.frame()
  assert.equal(s.pane.scrollTop, 0)
  s.uninstall()
})

test('only fields the keyboard types into are revealed', async () => {
  const { reveal } = await setup(0)
  const el = (tagName: string, type?: string, extra: object = {}) => ({ tagName, type, closest: () => null, ...extra })
  assert.equal(reveal.isRevealableField(el('INPUT', 'text')), true)
  assert.equal(reveal.isRevealableField(el('INPUT', 'search')), true)
  assert.equal(reveal.isRevealableField(el('TEXTAREA')), true)
  assert.equal(reveal.isRevealableField(el('DIV', undefined, { isContentEditable: true })), true)
  assert.equal(reveal.isRevealableField(el('INPUT', 'checkbox')), false)
  assert.equal(reveal.isRevealableField(el('BUTTON')), false)
  assert.equal(reveal.isRevealableField(null), false)
})

test('the offset centres a hidden field, keeps a visible one, and tops a tall one', async () => {
  const { reveal } = await setup(0)
  const visible = { top: 168, bottom: 578 }
  assert.equal(reveal.revealOffset({ top: 300, bottom: 334 }, visible), 0)
  assert.equal(reveal.revealOffset({ top: 559, bottom: 593 }, visible), 576 - 373)
  assert.equal(reveal.revealOffset({ top: 100, bottom: 134 }, visible), 117 - 373)
  assert.equal(reveal.revealOffset({ top: 400, bottom: 1000 }, visible), 400 - 180)
})

test('uninstalling removes its listeners, and the shell installs it on phones only', async () => {
  const s = await setup(0)
  s.uninstall()
  await Promise.resolve()
  assert.equal(s.windowListeners.size, 0)
  assert.equal(s.keyboardListeners.size, 0)
  const shell = readFileSync(new URL('./MobileShell.tsx', import.meta.url), 'utf8')
  assert.match(shell, /useEffect\(\(\) => \(isPhoneWidth\(\) \? installFieldKeyboardReveal\(\) : undefined\), \[\]\)/)
  assert.match(shell, /useEditorKeyboardScroll\(\)\n\s+useFieldKeyboardReveal\(\)/)
})
