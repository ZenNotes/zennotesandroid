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
 * of core's note lists (Home, Tasks, Quick Notes, Tags, Archive, Trash, the
 * Kanban board's cards) arms a short hold (keyboard-hold.ts) that refuses
 * the editor focus core follows the open with. Tapping into the text
 * releases it and raises the keyboard as always, and any other touch
 * releases it too, so whatever a tap elsewhere starts (a new note, the
 * ensō dial, the Calendar's "Add a task") focuses as before. Desktop-layout
 * tablets keep core's behavior. Same file in both phone shells.
 */
import { Keyboard } from '@capacitor/keyboard'
import { isPhoneViewport } from '../viewport'
import { KeyboardHold, READ_OPEN_WAIT_MS } from './keyboard-hold'
import { holdUntilSettled, type LandingEnd } from './landing-hold'
import { FocusHealGate, pageEventOf } from './focus-heal'

const hold = new KeyboardHold(() => Date.now())
/** When the screen was last touched: a touch ends every hold. */
let lastTouch = 0

/** Core's note rows that open their note on a tap. */
const READ_ROWS =
  '[data-home-nav] [data-home-item], [data-task-row], [data-quick-row], [data-tag-row], [data-archive-row], [data-trash-row], ' +
  // The folder Gallery's cards (core 2.79), which open their note on a tap.
  '[data-gallery-card]'
/** Controls inside a row that do something else (tick, pin, delete). */
const ROW_CONTROLS = 'button, a, input, [role="button"], [role="checkbox"]'
/** Menu rows after which core hands the editor the focus (desktop wants the
 *  caret back where it was), which on a phone is only the keyboard: the
 *  callout type menu's rows (core 2.79, EditorPane), and Remove callout in the
 *  editor menu. */
const KEEP_DOWN_MENU_ROWS = '[data-ctx-menu][aria-label="Callout type"] [role^="menuitem"]'
const KEEP_DOWN_MENU_LABELS = ['Remove callout']
/** Find fields core focuses as their menu opens, so typing filters at once on
 *  a desktop (DatabaseColumnsMenu, core 2.79). On a phone that focus is the
 *  keyboard over the menu; a tap into the field still raises it. */
const NO_AUTOFOCUS_FIELDS = 'input[aria-label="Find a column"]'
/** A Kanban card: a tap on the card, its title, its open arrow or one of its
 *  subtask lines (core 2.80) opens the note. Its checkboxes, its subtask bar
 *  and the move handle never focus the editor, so the hold they arm lapses
 *  unused. */
const READ_CARDS = '[data-kanban-task-id]'

function isEditor(el: Element): boolean {
  return el.closest('.cm-editor') !== null
}

/** A tap on a row that opens its note (not on one of the row's own
 *  controls), or anywhere on a Kanban card. */
function opensToRead(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  if (target.closest(READ_CARDS)) return true
  const row = target.closest(READ_ROWS)
  if (!row) return false
  const control = target.closest(ROW_CONTROLS)
  return !control || control === row || !row.contains(control) || control.matches('[aria-label^="Open "]')
}

/** A tap on a menu row whose pick core follows with an editor focus. */
function keepsKeyboardDown(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  if (target.closest(KEEP_DOWN_MENU_ROWS)) return true
  const row = target.closest('[data-ctx-menu] [role^="menuitem"]')
  return row !== null && KEEP_DOWN_MENU_LABELS.includes((row.textContent ?? '').trim())
}

/** The field the last touch went down on: a tap into a field focuses it
 *  natively, so a focus() call on any other field is core's own. */
let touchedField: Element | null = null

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
    if (isPhoneViewport() && this.matches(NO_AUTOFOCUS_FIELDS) && touchedField !== this) return
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
  document.addEventListener(
    'pointerdown',
    (event) => {
      lastTouch = Date.now()
      touchedField = event.target instanceof Element ? event.target.closest(NO_AUTOFOCUS_FIELDS) : null
      hold.release()
    },
    true
  )
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
      if (isPhoneViewport() && (opensToRead(event.target) || keepsKeyboardDown(event.target))) hold.arm()
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

/** The restore landing (usePhoneLayoutBoot): hold the keyboard down from
 *  before `land` runs until what it lands on is on screen, however long a
 *  slow vault takes, up to landing-hold.ts's cap. */
export function holdLanding(land: () => Promise<unknown>): Promise<LandingEnd | 'not-phone'> {
  if (!isPhoneViewport()) return land().then(() => 'not-phone' as const)
  const startedAt = Date.now()
  let landed!: () => void
  const settled = new Promise<void>((resolve) => { landed = resolve })
  const ending = holdUntilSettled(hold, settled, {
    rearmMs: READ_OPEN_WAIT_MS / 2,
    clock: {
      now: () => Date.now(),
      set: (callback, ms) => window.setTimeout(callback, ms),
      clear: (handle) => window.clearTimeout(handle as number)
    },
    touched: () => lastTouch >= startedAt
  })
  land().then(landed, landed)
  return ending
}
