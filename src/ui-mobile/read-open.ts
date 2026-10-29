/**
 * Opening a note to read it does not raise the soft keyboard on a phone.
 *
 * App-core hands the editor the keyboard focus whenever it opens a note
 * from a list or jumps to a task (#863, #415): right on desktop, where
 * focus decides where typing goes and nothing covers the screen. On a phone
 * that focus is the soft keyboard over half the note, with the caret parked
 * on the first line. Android raised it for Home's Recent rows and the Tasks
 * list (a focus inside the tap's gesture shows the keyboard), the iPhone for
 * a widget's task link too (Capacitor's WKWebView shows it for any focus).
 * Core 2.57 brought those hand-offs to the phones with no phone decision
 * behind them; the shells already keep the keyboard down for their own
 * navigation (wikilink taps, Back, sheets).
 *
 * So on the phone layout, a note opened from a zennotes:// link or from one
 * of core's note lists (Home, Tasks, Quick Notes, Tags, Archive, Trash)
 * arms a short hold (keyboard-hold.ts) that refuses the editor focus core
 * follows the open with. Tapping into the text releases it and raises the
 * keyboard as always, and any other touch releases it too, so whatever a
 * tap elsewhere starts (a new note, the ensō dial, the Calendar's "Add a
 * task") focuses as before. Desktop-layout tablets keep core's behavior.
 * Same file in both phone shells.
 */
import { Keyboard } from '@capacitor/keyboard'
import { isPhoneViewport } from '../viewport'
import { KeyboardHold } from './keyboard-hold'
import { FocusHealGate, pageEventOf } from './focus-heal'

const hold = new KeyboardHold(() => Date.now())

/** Core's note rows that open their note on a tap. */
const READ_ROWS =
  '[data-home-nav] [data-home-item], [data-task-row], [data-quick-row], [data-tag-row], [data-archive-row], [data-trash-row]'
/** Controls inside a row that do something else (tick, pin, delete). */
const ROW_CONTROLS = 'button, a, input, [role="button"], [role="checkbox"]'

function isEditor(el: Element): boolean {
  return el.closest('.cm-editor') !== null
}

/** A tap on a row that opens its note (not on one of the row's own controls). */
function opensToRead(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  const row = target.closest(READ_ROWS)
  if (!row) return false
  const control = target.closest(ROW_CONTROLS)
  return !control || control === row || !row.contains(control) || control.matches('[aria-label^="Open "]')
}

let installed = false

export function installReadOpenGuard(): void {
  if (installed) return
  installed = true
  // CodeMirror's view.focus() is contentDOM.focus(): refusing the call keeps
  // the keyboard from ever starting up, with no focus and blur for the
  // editor to react to.
  const focus = HTMLElement.prototype.focus
  HTMLElement.prototype.focus = function (this: HTMLElement, options?: FocusOptions): void {
    if (isEditor(this) && hold.refuse()) return
    focus.call(this, options)
  }
  // Any other way focus lands in the editor while held, undone at once.
  document.addEventListener(
    'focusin',
    (event) => {
      const target = event.target
      if (!(target instanceof HTMLElement) || !isEditor(target) || !hold.refuse()) return
      target.blur()
      void Keyboard.hide().catch(() => {})
    },
    true
  )
  document.addEventListener('pointerdown', () => hold.release(), true)
  // Core's focus heal answers the window regaining focus and the page
  // becoming visible (focus-heal.ts). These listeners run in the capture
  // phase, before core's: leaving notes whether the editor was focused, and
  // coming back to a note that was being read holds the keyboard down
  // through the heal's tries.
  const gate = new FocusHealGate()
  const editorFocused = (): boolean => {
    const active = document.activeElement
    return active instanceof Element && isEditor(active)
  }
  const holdThroughHeal = (event: Event): void => {
    const kind = pageEventOf(event, window, document.visibilityState)
    if (kind === 'leave') gate.left(editorFocused())
    else if (kind === 'return' && gate.returned({ phone: isPhoneViewport(), editorFocused: editorFocused() })) {
      hold.arm()
      hold.opened()
    }
  }
  window.addEventListener('blur', holdThroughHeal, true)
  window.addEventListener('pagehide', holdThroughHeal, true)
  window.addEventListener('focus', holdThroughHeal, true)
  document.addEventListener('visibilitychange', holdThroughHeal, true)
  // After the pointerdown that released it: the row's own click arms it.
  document.addEventListener(
    'click',
    (event) => {
      if (isPhoneViewport() && opensToRead(event.target)) hold.arm()
    },
    true
  )
}

/** Open a note to read it (a widget or zennotes:// link). */
export async function openToRead<T>(open: () => Promise<T>): Promise<T> {
  if (!isPhoneViewport()) return open()
  hold.arm()
  try {
    return await open()
  } finally {
    hold.opened()
  }
}
