/**
 * One source of truth for "is this a phone".
 *
 * The shell used to answer that with `window.innerWidth < 768` in JS and
 * `@media (max-width: 767px)` in CSS. Both are the *current* width, which a
 * phone crosses the moment it rotates: a 1080x2400 @ 420dpi handset is 411 CSS
 * px in portrait but 914 in landscape. Past 768 the whole phone layout switched
 * off mid-session — app-core's desktop title bar (with its non-functional
 * minimise/maximise/close buttons), the desktop tab strip and the left-crammed
 * formatting toolbar all appeared, and the editor lost its keyboard handling
 * (issue #12). Worse, the two gates disagreed: the CSS one re-evaluated on
 * rotation while wireKeyboard's JS one was sampled once at boot, so the
 * keyboard resize mode and the CSS that assumes it drifted apart.
 *
 * The fix is Android's own tablet heuristic — smallestWidth, the *shorter* side
 * of the display, which doesn't change when the device rotates. CSS can't
 * express that (a media query only ever sees the current viewport), so the
 * decision is made here and published to CSS as a class on <html>, which is
 * also what makes it impossible for the two to disagree again.
 */

/** Below this many CSS px on the short side, the device is a phone. */
export const PHONE_BREAKPOINT = 768

/** Class mirrored onto <html> so mobile.css can gate on the same decision. */
export const PHONE_CLASS = 'zn-phone'

/**
 * Shorter side of the display in CSS px.
 *
 * `screen` is preferred over `innerWidth`/`innerHeight` because the soft
 * keyboard shrinks the inner viewport under KeyboardResize.Native — in
 * landscape that can drop the inner height to ~200px, and a phone must not be
 * reclassified just because someone started typing. Falls back to the inner
 * dimensions where `screen` is unavailable or reports nonsense (0 in some
 * WebView states).
 */
export function smallestViewportSide(): number {
  const { screen } = window
  if (screen && screen.width > 0 && screen.height > 0) {
    return Math.min(screen.width, screen.height)
  }
  return Math.min(window.innerWidth, window.innerHeight)
}

/** True on phone-sized displays, in either orientation. */
export function isPhoneViewport(): boolean {
  return smallestViewportSide() < PHONE_BREAKPOINT
}

/** Publish the current decision to CSS. Safe to call repeatedly. */
export function syncPhoneClass(): void {
  document.documentElement.classList.toggle(PHONE_CLASS, isPhoneViewport())
}

/**
 * Keep the published class in step with the display. smallestWidth only
 * really changes on a foldable unfolding or a desktop-mode window resize, but
 * the listeners are cheap and make the class self-healing.
 */
export function watchPhoneClass(onChange?: (isPhone: boolean) => void): void {
  let last = isPhoneViewport()
  syncPhoneClass()
  const reevaluate = (): void => {
    const next = isPhoneViewport()
    syncPhoneClass()
    if (next !== last) {
      last = next
      onChange?.(next)
    }
  }
  window.addEventListener('resize', reevaluate)
  window.addEventListener('orientationchange', reevaluate)
}
