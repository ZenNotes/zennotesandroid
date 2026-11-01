import { Keyboard } from '@capacitor/keyboard'

/**
 * A field outside the note that the soft keyboard lands on is brought above
 * it once the keyboard is up.
 *
 * Phones resize the WebView for the keyboard (KeyboardResize.Native), and
 * Chromium then scrolls the focused field into view, but only one the
 * keyboard covers completely. A field it covers in part stays where it was,
 * typing included: Settings → Tasks opens with the folder board's "Group by
 * the folders inside" field just above where the keyboard's top lands, so a
 * tap on it left the field's lower half under the keyboard's suggestion
 * strip and its folder list flipped above it. Any Settings field near the
 * bottom of the screen did the same.
 *
 * So when the keyboard has landed (or the viewport has shrunk), a focused
 * field that does not show in full inside each scrolling box around it is
 * centred in what shows of that box, as Chromium centres one it does reveal.
 * Core's folder list places itself from the field on scroll, so it comes
 * along, on whichever side has room. A field tapped while the keyboard is
 * already up needs nothing: Chromium scrolls a field it focuses into view.
 *
 * The note's editor is left alone: its caret has its own reveal, which must
 * never fight a reader's scroll (editor-keyboard-scroll.ts, zennotes#891).
 * The editor's search panel lives inside `.cm-editor` too.
 */

/** Room kept between a revealed field and the edge of what shows. */
const MARGIN = 12

/** Input types the soft keyboard types into. */
const TYPED_INPUTS = new Set(['', 'text', 'search', 'url', 'email', 'tel', 'password', 'number'])

export interface Span {
  top: number
  bottom: number
}

/** How far to scroll so `field` shows inside `visible` (both in viewport
 *  coordinates): 0 when it already does, else enough to centre it there. A
 *  field taller than what shows lines up with its top. */
export function revealOffset(field: Span, visible: Span, margin = MARGIN): number {
  const top = visible.top + margin
  const bottom = visible.bottom - margin
  if (field.top >= top && field.bottom <= bottom) return 0
  if (field.bottom - field.top > bottom - top) return field.top - top
  return (field.top + field.bottom) / 2 - (top + bottom) / 2
}

/** A field outside the note that the keyboard types into. */
export function isRevealableField(el: Element | null): el is HTMLElement {
  if (!el || el.closest('.cm-editor')) return false
  if (el.tagName === 'TEXTAREA') return true
  if (el.tagName === 'INPUT') return TYPED_INPUTS.has(((el as HTMLInputElement).type ?? '').toLowerCase())
  return (el as HTMLElement).isContentEditable === true
}

/** The boxes that scroll `el` up and down, innermost first. */
function scrollBoxes(el: HTMLElement): HTMLElement[] {
  const boxes: HTMLElement[] = []
  for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) boxes.push(node)
  }
  return boxes
}

/** Bring the focused field into what shows of each box that scrolls it. */
export function revealFocusedField(): void {
  const field = document.activeElement
  if (!isRevealableField(field)) return
  // The viewport ends at the keyboard's top: phones resize for it.
  const viewportBottom = window.innerHeight
  for (const box of scrollBoxes(field)) {
    const frame = box.getBoundingClientRect()
    const visible = { top: Math.max(frame.top, 0), bottom: Math.min(frame.bottom, viewportBottom) }
    const offset = revealOffset(field.getBoundingClientRect(), visible)
    if (offset) box.scrollTop += offset
  }
}

/** Phones only (the WebView resizes for the keyboard there). */
export function installFieldKeyboardReveal(): () => void {
  let frame = 0
  const soon = (): void => {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => {
      frame = 0
      revealFocusedField()
    })
  }
  // A taller viewport is the keyboard leaving, which hides nothing.
  let height = window.innerHeight
  const onResize = (): void => {
    const shrank = window.innerHeight < height
    height = window.innerHeight
    if (shrank) soon()
  }
  const didShow = Keyboard.addListener('keyboardDidShow', soon)
  window.addEventListener('resize', onResize)
  return () => {
    cancelAnimationFrame(frame)
    window.removeEventListener('resize', onResize)
    void didShow.then((handle) => handle.remove()).catch(() => {})
  }
}
