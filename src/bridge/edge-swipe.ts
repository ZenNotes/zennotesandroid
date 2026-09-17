/**
 * Android gesture navigation claims every swipe that starts at a screen edge
 * as Back, so the shell's left-edge swipe never reached the WebView. The
 * native side excludes a mid-screen band of the left edge from that gesture
 * while the shell asks for it (EdgeSwipePlugin.java has the full story).
 * Android-only: there is no iOS counterpart and no web implementation, so
 * every call is best-effort.
 */
import { registerPlugin } from '@capacitor/core'

interface EdgeSwipePlugin {
  setLeftEdgeClaimed(options: { claimed: boolean }): Promise<void>
}

const EdgeSwipe = registerPlugin<EdgeSwipePlugin>('EdgeSwipe')

export function setLeftEdgeClaimed(claimed: boolean): void {
  void EdgeSwipe.setLeftEdgeClaimed({ claimed }).catch(() => {})
}
