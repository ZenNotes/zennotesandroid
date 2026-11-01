/**
 * System back closes a layer the way Escape would (MobileShell's
 * useSystemBackClose). Where that Escape starts matters: nested editors,
 * palettes and dialogs listen for it at the window, but core's context menu
 * listens on itself, where it keeps the focus, and a prompt (New folder,
 * Rename, Move) cancels on an Escape in its field. Sent to the window, it
 * left those open through any number of Backs.
 *
 * So an Escape for a layer starts at the focused element inside it (else the
 * layer itself) and bubbles out to the window, which still hears whatever no
 * layer handled. With no layer, it goes to the window as before.
 */
export function escapeOrigin(
  layer: Element | undefined,
  focused: Element | null,
  win: EventTarget
): EventTarget {
  if (!layer) return win
  return focused && layer.contains(focused) ? focused : layer
}

/** Press Escape for `layer` (the top-most menu or modal), or at the window. */
export function sendEscape(layer?: HTMLElement): void {
  escapeOrigin(layer, document.activeElement, window).dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  )
}
