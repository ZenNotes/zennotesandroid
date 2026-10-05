import { Keyboard } from '@capacitor/keyboard'
import { revealEditorCaret } from '@zennotes/app-core/editor'
import { installMobileEditorHost, refreshMobileEditorHost } from './editor-host'

const OVERLAYS = '.zn-editor-toolbar, [data-selection-toolbar]'
/** Longer than any pause between the scroll events of one drag and its fling. */
const SCROLL_PAUSE_MS = 150
let touching = false
let scrolledAt = Number.NEGATIVE_INFINITY
let settleFrame = 0
let settleTimers: number[] = []

export function revealCaretAboveKeyboard(): void {
  refreshMobileEditorHost()
  // The note is never moved while the reader is moving it.
  if (performance.now() - scrolledAt >= SCROLL_PAUSE_MS) revealEditorCaret()
}
function stopSettling(): void {
  cancelAnimationFrame(settleFrame)
  for (const timer of settleTimers) window.clearTimeout(timer)
  settleFrame = 0
  settleTimers = []
}
export function revealCaretAboveKeyboardSoon(): void {
  stopSettling()
  settleFrame = requestAnimationFrame(revealCaretAboveKeyboard)
  settleTimers = [150, 400, 800].map(ms => window.setTimeout(revealCaretAboveKeyboard, ms))
}
/**
 * The caret is revealed only when something can have covered it: the keyboard
 * landing, an overlay appearing or growing, the viewport getting smaller. Any
 * other DOM change includes CodeMirror drawing lines as the note scrolls, and
 * revealing on those pulled the reader back to the caret on every swipe, with
 * the keyboard up or merely dismissed (ZenNotes/zennotes#891).
 */
export function installEditorKeyboardScroll(): () => void {
  const release = installMobileEditorHost()
  let overlays: Element[] = []
  let frame = 0
  let reveal = false
  const schedule = (withReveal: boolean): void => {
    reveal ||= withReveal
    if (!frame) frame = requestAnimationFrame(() => {
      frame = 0
      if (reveal) revealCaretAboveKeyboard()
      else refreshMobileEditorHost()
      reveal = false
    })
  }
  // Observing an element reports its size once, so only overlays new to the
  // set are observed; re-observing all of them reported each as resized.
  const sizes = new ResizeObserver(() => schedule(true))
  const track = (): void => {
    const next = [...document.querySelectorAll(OVERLAYS)]
    const gone = overlays.filter(node => !next.includes(node))
    for (const node of gone) sizes.unobserve(node)
    for (const node of next) if (!overlays.includes(node)) sizes.observe(node)
    overlays = next
    // Space an overlay leaves behind cannot hide the caret, only its inset needs dropping.
    if (gone.length) schedule(false)
  }
  const mutations = new MutationObserver(records => {
    track()
    if (records.some(record => record.type === 'attributes')) schedule(false)
  })
  mutations.observe(document.body, { childList: true, subtree: true })
  mutations.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  track()
  // A taller viewport cannot hide a caret that was in view, and the keyboard
  // closing must not undo a scroll made while it was open.
  let { innerWidth: width, innerHeight: height } = window
  const onResize = (): void => {
    const shrank = window.innerWidth < width || window.innerHeight < height
    width = window.innerWidth
    height = window.innerHeight
    schedule(shrank)
  }
  const inNote = (event: Event): boolean => !!(event.target as Element | null)?.closest?.('.cm-editor')
  const onTouchStart = (event: TouchEvent): void => { touching ||= inNote(event) }
  const onTouchEnd = (event: TouchEvent): void => { if (!event.touches.length) touching = false }
  // The reader scrolls the note with a finger on it, and goes on scrolling for
  // as long as its fling runs without a pause; no touch event arrives during a
  // fling, so the scroll events themselves mark it. The keyboard often lands
  // mid-swipe, and the settle steps it leaves would pull the note back to the
  // caret the moment the fling stops.
  const onScroll = (event: Event): void => {
    if (!inNote(event)) return
    const now = performance.now()
    if (!touching && now - scrolledAt >= SCROLL_PAUSE_MS) return
    scrolledAt = now
    stopSettling()
  }
  const passive = { capture: true, passive: true }
  document.addEventListener('touchstart', onTouchStart, passive)
  document.addEventListener('touchend', onTouchEnd, passive)
  document.addEventListener('touchcancel', onTouchEnd, passive)
  document.addEventListener('scroll', onScroll, passive)
  const didShow = Keyboard.addListener('keyboardDidShow', revealCaretAboveKeyboardSoon)
  window.addEventListener('resize', onResize)
  return () => {
    cancelAnimationFrame(frame)
    mutations.disconnect(); sizes.disconnect(); release()
    void didShow.then(handle => handle.remove()).catch(() => {})
    window.removeEventListener('resize', onResize)
    document.removeEventListener('touchstart', onTouchStart, true)
    document.removeEventListener('touchend', onTouchEnd, true)
    document.removeEventListener('touchcancel', onTouchEnd, true)
    document.removeEventListener('scroll', onScroll, true)
  }
}
