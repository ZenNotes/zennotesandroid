/**
 * Where a cold launch lands (user request relayed by Adib, 2026-09-08: "I
 * wish there was a feature to set the home screen as the start screen
 * instead of the last note when turning the app off and on again").
 *
 * 'last' (the default) keeps the #2 behaviour: the note or view that was
 * open when iOS killed the app comes back, and Home comes back if that is
 * where the user left. 'home' lands on Home on every cold launch. Switching
 * away and back is not a launch and never moves the user — the landing
 * logic in usePhoneLayoutBoot runs once per process.
 *
 * Read lazily, like gestures.ts; the Settings card writes through
 * setStartScreen and the next launch picks it up. The default removes the
 * key so a fresh install and a reset look identical.
 */
import { START_SCREEN_KEY } from '../viewport.ts'

export type StartScreen = 'last' | 'home'

export const DEFAULT_START_SCREEN: StartScreen = 'last'

export function getStartScreen(): StartScreen {
  try {
    return localStorage.getItem(START_SCREEN_KEY) === 'home' ? 'home' : DEFAULT_START_SCREEN
  } catch {
    return DEFAULT_START_SCREEN
  }
}

export function setStartScreen(next: StartScreen): void {
  try {
    if (next === DEFAULT_START_SCREEN) localStorage.removeItem(START_SCREEN_KEY)
    else localStorage.setItem(START_SCREEN_KEY, next)
  } catch {
    // Storage unavailable: the choice applies to this session only.
  }
}
