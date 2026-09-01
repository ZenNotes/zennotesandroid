/**
 * Fullscreen writing: hide Android system chrome while ZenNotes is open.
 * Two tiers — hide just the status bar (#22), or Immersive Mode (#42),
 * which hides the navigation bar too so notes get the entire screen. The
 * bars stay reachable either way: MainActivity sets the transient-by-swipe
 * system-bar behavior, so a swipe from a hidden bar's edge peeks it and it
 * slides away again on its own.
 *
 * The preference is a localStorage flag mirrored to native storage by
 * bootstrap.ts (same mechanism as the layout override): WebView storage
 * alone is not trusted to survive engine updates. Applying it is idempotent
 * and cheap, so the shell re-asserts it on app resume — Android occasionally
 * restores system bars when a backgrounded activity comes forward.
 *
 * The status bar keeps going through the @capacitor/status-bar plugin
 * (shipped behavior since 1.1.12, config in capacitor.config.ts); only the
 * navigation bar goes through core's SystemBars plugin, which the StatusBar
 * plugin has no reach into. Both drive the same WindowInsetsController, so
 * the split is invisible to the OS. With targetSdk 36 the app is
 * edge-to-edge and Capacitor's insets pipeline re-runs on every change, so
 * hidden bars leave no solid background strips, and transiently revealed
 * bars draw translucent over the content (the issue-#42 transparency ask).
 */
import { SystemBars, SystemBarType } from '@capacitor/core'
import { StatusBar } from '@capacitor/status-bar'
import { HIDE_STATUS_BAR_KEY } from '../viewport'
import {
  storedFromSystemBarsMode,
  systemBarsModeFromStored,
  type SystemBarsMode
} from './system-bars-mode'

export type { SystemBarsMode } from './system-bars-mode'

export function getSystemBarsMode(): SystemBarsMode {
  try {
    return systemBarsModeFromStored(localStorage.getItem(HIDE_STATUS_BAR_KEY))
  } catch {
    return 'shown'
  }
}

export function setSystemBarsMode(mode: SystemBarsMode): void {
  try {
    const stored = storedFromSystemBarsMode(mode)
    if (stored === null) localStorage.removeItem(HIDE_STATUS_BAR_KEY)
    else localStorage.setItem(HIDE_STATUS_BAR_KEY, stored)
  } catch {
    // Storage unavailable: the choice applies to this session only.
  }
  void applySystemBarsPreference()
}

export async function applySystemBarsPreference(): Promise<void> {
  const mode = getSystemBarsMode()
  try {
    if (mode === 'shown') await StatusBar.show()
    else await StatusBar.hide()
  } catch {
    // Plugin unavailable (plain browser dev): visible chrome is the default.
  }
  try {
    if (mode === 'immersive') await SystemBars.hide({ bar: SystemBarType.NavigationBar })
    else await SystemBars.show({ bar: SystemBarType.NavigationBar })
  } catch {
    // Same fallback; core's web SystemBars stub is a no-op anyway.
  }
}
