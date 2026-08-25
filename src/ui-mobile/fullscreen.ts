/**
 * Fullscreen writing: hide the Android status bar while ZenNotes is open
 * (#22). The bar stays reachable — MainActivity sets the transient-by-swipe
 * system-bar behavior, so a swipe from the top edge peeks it (clock, battery,
 * notifications) and it slides away again on its own.
 *
 * The preference is a localStorage flag mirrored to native storage by
 * bootstrap.ts (same mechanism as the layout override): WebView storage
 * alone is not trusted to survive engine updates. Applying it is idempotent
 * and cheap, so the shell re-asserts it on app resume — Android occasionally
 * restores system bars when a backgrounded activity comes forward.
 */
import { StatusBar } from '@capacitor/status-bar'
import { HIDE_STATUS_BAR_KEY } from '../viewport'

export function isStatusBarHidden(): boolean {
  try {
    return localStorage.getItem(HIDE_STATUS_BAR_KEY) === '1'
  } catch {
    return false
  }
}

export function setStatusBarHidden(hidden: boolean): void {
  try {
    if (hidden) localStorage.setItem(HIDE_STATUS_BAR_KEY, '1')
    else localStorage.removeItem(HIDE_STATUS_BAR_KEY)
  } catch {
    // Storage unavailable: the choice applies to this session only.
  }
  void applyStatusBarPreference()
}

export async function applyStatusBarPreference(): Promise<void> {
  try {
    if (isStatusBarHidden()) await StatusBar.hide()
    else await StatusBar.show()
  } catch {
    // Plugin unavailable (plain browser dev): visible chrome is the default.
  }
}
