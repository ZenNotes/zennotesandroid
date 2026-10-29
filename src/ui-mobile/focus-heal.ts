/**
 * When the read-open hold (read-open.ts) stands in front of core's focus heal.
 *
 * Core re-grabs the editor's focus whenever the window regains focus or the
 * page becomes visible again, if its store says the editor was the last
 * surface and the editor does not hold the DOM focus (App.tsx, desktop #350).
 * On a phone that store flag is also set by a note opened to read, where only
 * the DOM focus was refused, so the heal raised the keyboard over the note on
 * every return to the app.
 *
 * So the shell notes, as the app is left (the window's blur, the page going
 * hidden, pagehide), whether the editor held the focus. On the way back, a
 * note that was being read arms the hold briefly, and the heal's burst of
 * focus tries is refused like an open's; a touch releases it. Someone who was
 * typing gets the keyboard back from the heal, as before. A fresh page (a
 * cold launch, the Layout reload) left nothing, which counts as reading.
 * Kept apart from the DOM so node --test covers it.
 */

export type PageEvent = 'leave' | 'return' | 'other'

/** What a window or document event means here. A window `focus` or `blur`
 *  listener in the capture phase also hears every element's focus and blur on
 *  their way down; only the window's own count. */
export function pageEventOf(event: { type: string; target: unknown }, win: unknown, visibility: string): PageEvent {
  switch (event.type) {
    case 'blur':
      return event.target === win ? 'leave' : 'other'
    case 'pagehide':
      return 'leave'
    case 'focus':
      return event.target === win ? 'return' : 'other'
    case 'visibilitychange':
      return visibility === 'hidden' ? 'leave' : visibility === 'visible' ? 'return' : 'other'
    default:
      return 'other'
  }
}

export interface ReturnState {
  /** The phone layout (isPhoneViewport): tablets keep core's focus. */
  phone: boolean
  /** The editor holds the DOM focus now. */
  editorFocused: boolean
}

export class FocusHealGate {
  private away = false
  private typingWhenLeft = false

  /** One of the events that leave the app; leaving fires several in a row
   *  (blur, then hidden), and any of them seeing the editor focused counts. */
  left(editorFocused: boolean): void {
    if (!this.away) {
      this.away = true
      this.typingWhenLeft = false
    }
    this.typingWhenLeft = this.typingWhenLeft || editorFocused
  }

  /** One of the events that come back (visible, then focus). True: hold the
   *  keyboard down through core's heal. */
  returned(state: ReturnState): boolean {
    this.away = false
    return state.phone && !state.editorFocused && !this.typingWhenLeft
  }
}
