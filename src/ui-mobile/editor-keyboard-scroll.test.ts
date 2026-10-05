import assert from 'node:assert/strict'
import test from 'node:test'
import { loadMobileModule } from '../../tooling/load-mobile-module.ts'

type Listener = (...args: any[]) => void

function define(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
}

/** The real module over a scripted DOM: frames, timers, observers and the clock move only when a test says so. */
async function setup() {
  const counts = { reveals: 0, refreshes: 0, observed: 0, released: 0 }
  const frames = new Map<number, Listener>()
  const timers = new Map<number, Listener>()
  const windowListeners = new Map<string, Listener>()
  const documentListeners = new Map<string, Listener>()
  const keyboard = new Map<string, Listener>()
  const viewport = { width: 412, height: 839 }
  const clock = { now: 1000 }
  let ids = 0
  let overlays: object[] = []
  let onMutations: Listener = () => {}
  let onSizes: Listener = () => {}
  define('performance', { now: () => clock.now })
  define('requestAnimationFrame', (run: Listener) => { frames.set(++ids, run); return ids })
  define('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  define('window', {
    get innerWidth() { return viewport.width },
    get innerHeight() { return viewport.height },
    setTimeout: (run: Listener) => { timers.set(++ids, run); return ids },
    clearTimeout: (id: number) => { timers.delete(id) },
    addEventListener: (type: string, run: Listener) => { windowListeners.set(type, run) },
    removeEventListener: (type: string, run: Listener) => { if (windowListeners.get(type) === run) windowListeners.delete(type) }
  })
  define('document', {
    body: {},
    documentElement: {},
    querySelectorAll: () => overlays,
    addEventListener: (type: string, run: Listener) => { documentListeners.set(type, run) },
    removeEventListener: (type: string, run: Listener) => { if (documentListeners.get(type) === run) documentListeners.delete(type) }
  })
  define('MutationObserver', class {
    constructor(run: Listener) { onMutations = run }
    observe() {}
    disconnect() { onMutations = () => {} }
  })
  define('ResizeObserver', class {
    constructor(run: Listener) { onSizes = run }
    observe() { counts.observed++ }
    unobserve() {}
    disconnect() { onSizes = () => {} }
  })
  const scroll = await loadMobileModule('./src/ui-mobile/editor-keyboard-scroll.ts', {
    '@capacitor/keyboard': {
      Keyboard: {
        addListener: (event: string, run: Listener) => {
          keyboard.set(event, run)
          return Promise.resolve({ remove: () => { keyboard.delete(event) } })
        }
      }
    },
    '@zennotes/app-core/editor': { revealEditorCaret: () => { counts.reveals++; return true } },
    './editor-host': {
      installMobileEditorHost: () => () => { counts.released++ },
      refreshMobileEditorHost: () => { counts.refreshes++ }
    }
  })
  const uninstall: () => void = scroll.installEditorKeyboardScroll()
  const target = (inNote: boolean) => ({ closest: (selector: string) => (inNote && selector === '.cm-editor' ? {} : null) })
  return {
    counts,
    uninstall,
    windowListeners,
    documentListeners,
    keyboardListeners: keyboard,
    /** One rendering frame: observer reports first, as in the browser, then animation frames. */
    frame(sized: object[] = []) {
      if (sized.length) onSizes(sized.map((node) => ({ target: node })))
      const due = [...frames.values()]
      frames.clear()
      for (const run of due) run(clock.now)
    },
    timers() {
      const due = [...timers.values()]
      timers.clear()
      for (const run of due) run()
    },
    advance(ms: number) { clock.now += ms },
    mutate(type: 'childList' | 'attributes' = 'childList') { onMutations([{ type }]) },
    setOverlays(next: object[]) { overlays = next },
    resize(width: number, height: number) {
      viewport.width = width
      viewport.height = height
      windowListeners.get('resize')?.()
    },
    keyboard: (event: string) => keyboard.get(event)?.(),
    touchStart: (inNote = true) => documentListeners.get('touchstart')?.({ target: target(inNote), touches: [{}] }),
    touchEnd: () => documentListeners.get('touchend')?.({ target: target(true), touches: [] }),
    scrollNote: () => documentListeners.get('scroll')?.({ target: target(true) })
  }
}

test('DOM changes while a note scrolls never pull it back to the caret (ZenNotes/zennotes#891)', async () => {
  const s = await setup()
  // CodeMirror redraws lines as the note scrolls: every swipe is a run of childList batches.
  for (let i = 0; i < 20; i++) { s.mutate(); s.frame() }
  assert.equal(s.counts.reveals, 0)

  const toolbar = {}
  s.setOverlays([toolbar])
  s.mutate()
  s.frame([toolbar])
  s.frame()
  assert.equal(s.counts.reveals, 1, 'the keyboard toolbar arriving keeps the caret above it')
  for (let i = 0; i < 20; i++) { s.mutate(); s.frame() }
  assert.equal(s.counts.reveals, 1, 'scrolling with the keyboard up stays where the reader put it')
  assert.equal(s.counts.observed, 1, 'an overlay is observed once, not re-reported on every mutation')
  s.uninstall()
})

test('an overlay growing reveals the caret; one leaving or a class change only re-measures', async () => {
  const s = await setup()
  const toolbar = {}
  const bubble = {}
  s.setOverlays([toolbar])
  s.mutate()
  s.frame([toolbar])
  s.frame()
  s.setOverlays([toolbar, bubble])
  s.mutate()
  s.frame([bubble])
  s.frame()
  s.frame([bubble])
  s.frame()
  assert.equal(s.counts.reveals, 3)

  const refreshes = s.counts.refreshes
  s.setOverlays([toolbar])
  s.mutate()
  s.frame()
  s.mutate('attributes')
  s.frame()
  assert.equal(s.counts.reveals, 3)
  assert.equal(s.counts.refreshes, refreshes + 2)
  s.uninstall()
})

test('only a smaller viewport reveals the caret, so closing the keyboard keeps the scroll', async () => {
  const s = await setup()
  s.resize(412, 527)
  s.frame()
  assert.equal(s.counts.reveals, 1, 'the keyboard opening shrinks the viewport')
  s.resize(412, 839)
  s.frame()
  assert.equal(s.counts.reveals, 1, 'the keyboard closing grows it')
  s.resize(915, 412)
  s.frame()
  assert.equal(s.counts.reveals, 2, 'rotating to landscape shortens it')
  s.resize(412, 839)
  s.frame()
  assert.equal(s.counts.reveals, 3, 'rotating back narrows it, which rewraps lines')
  s.uninstall()
})

test('the keyboard settles the caret into view, but never while the reader scrolls the note', async () => {
  const s = await setup()
  s.keyboard('keyboardDidShow')
  s.frame()
  s.timers()
  assert.equal(s.counts.reveals, 4, 'one reveal per settle step while the keyboard lands')

  // A swipe begun right after the tap that raised the keyboard, which lands mid-swipe.
  s.touchStart()
  s.scrollNote()
  s.keyboard('keyboardDidShow')
  s.frame()
  s.touchEnd()
  for (let i = 0; i < 4; i++) { s.advance(100); s.scrollNote() }
  s.advance(500)
  s.timers()
  assert.equal(s.counts.reveals, 4, 'not under the finger, through the fling, or once the fling stops')

  s.keyboard('keyboardDidShow')
  s.frame()
  assert.equal(s.counts.reveals, 5, 'the keyboard landing again after the fling reveals again')
  s.advance(1000)
  s.scrollNote()
  s.keyboard('keyboardDidShow')
  s.frame()
  assert.equal(s.counts.reveals, 6, 'a scroll no finger started, such as a reveal, does not hold reveals back')
  s.uninstall()
})

test('a long press that selects without scrolling still reveals what it selected', async () => {
  const s = await setup()
  const bubble = {}
  s.touchStart()
  s.setOverlays([bubble])
  s.mutate()
  s.frame([bubble])
  s.frame()
  assert.equal(s.counts.reveals, 1)
  s.touchEnd()

  s.touchStart(false)
  s.scrollNote()
  s.resize(412, 527)
  s.frame()
  assert.equal(s.counts.reveals, 2, 'a finger outside the note is not the reader scrolling it')
  s.uninstall()
})

test('uninstalling removes every listener and releases the editor host', async () => {
  const s = await setup()
  s.uninstall()
  await Promise.resolve()
  assert.equal(s.windowListeners.size, 0)
  assert.equal(s.documentListeners.size, 0)
  assert.equal(s.keyboardListeners.size, 0)
  assert.equal(s.counts.released, 1)
})
