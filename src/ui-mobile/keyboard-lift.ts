/**
 * How far a tablet lifts the formatting toolbar (and pads the note) for the
 * keyboard: `--zn-kb-height`, read only by the tablet rules in mobile.css.
 *
 * wireKeyboard (main.tsx) asks tablets not to resize the WebView for the
 * keyboard, so that the CSS could lift the toolbar by the keyboard's height
 * instead. Capacitor's Android Keyboard plugin never honours that request
 * (setResizeMode is unimplemented on Android), and SystemBars shrinks the
 * WebView for the keyboard on every device. On a tablet the toolbar then
 * rose twice, once with the viewport and once by the lift, and floated a
 * keyboard's height above the keyboard, mid-screen.
 *
 * So the lift is only the part of the keyboard the viewport has not already
 * given up: none where the WebView shrank for all of it, the whole keyboard
 * where it did not shrink at all. The viewport's height with the keyboard
 * down is remembered per width, so neither a resize that lands before the
 * keyboard event nor a rotation passes for the keyboard-down height.
 */
export class KeyboardLift {
  /** The viewport's height with the keyboard down, by viewport width. */
  private readonly resting = new Map<number, number>()
  private width: number
  private keyboard = 0

  constructor(width: number, height: number) {
    this.width = width
    this.resting.set(width, height)
  }

  /** The lift for the viewport now: 0 with the keyboard down. A width never
   *  seen with the keyboard down (a rotation under it) counts as shrunk for
   *  all of it, as the WebView is on Android. */
  private lift(height: number): number {
    if (this.keyboard <= 0) return 0
    const resting = this.resting.get(this.width) ?? height + this.keyboard
    return Math.max(0, this.keyboard - Math.max(0, resting - height))
  }

  /** The viewport changed size; returns the lift to apply. */
  resized(width: number, height: number): number {
    this.width = width
    if (this.keyboard <= 0) {
      // At a known width, a shorter viewport with no keyboard reported yet is
      // the keyboard arriving ahead of its event, not a new resting height.
      this.resting.set(width, Math.max(this.resting.get(width) ?? 0, height))
    }
    return this.lift(height)
  }

  /** The keyboard reported its height (will show or did show). */
  shown(keyboardHeight: number, height: number): number {
    this.keyboard = Math.max(0, keyboardHeight)
    return this.lift(height)
  }

  /** The keyboard is going away. */
  hidden(): number {
    this.keyboard = 0
    return 0
  }
}
