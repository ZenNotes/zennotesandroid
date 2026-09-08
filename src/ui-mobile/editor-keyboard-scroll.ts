/**
 * Keep the caret above the soft keyboard's formatting toolbar (Adib, device
 * testing 2026-09-08: "when the page becomes long enough I can't see what's
 * under the keyboard anymore, as if it's stuck").
 *
 * Two things conspired on phones. Under Native keyboard resize the WebView
 * shrinks only AFTER the keyboard animation, and nothing re-reveals the caret
 * then: WebKit scrolled it into view at focus time against the tall
 * viewport, CodeMirror only scrolls on its own transactions, so a caret in
 * the lower half of the screen ends up under the keyboard until the user
 * scrolls by hand. And the formatting toolbar (EditorToolbar) is a fixed
 * overlay on the bottom 52px of the shrunken editor that CodeMirror knows
 * nothing about, so even its own scroll-into-view on typing parks the caret
 * line exactly under the toolbar — the last line of a long note could never
 * be seen while editing it, which is the "stuck" feel; blank lines pushed
 * the real text up past the overlay, hence the workaround.
 *
 * Fix, layered on from the shell (no app-core change):
 * - Every editor view gets an `EditorView.scrollMargins` source appended to
 *   its config (StateEffect.appendConfig is CodeMirror's public hook for
 *   this) that reports the toolbar's live height as bottom clearance while
 *   the toolbar is showing, and nothing otherwise — so CodeMirror's own
 *   scroll-into-view on typing keeps the caret above the overlay. The
 *   scroller's 20vh end padding (app-core) gives the last line room to move.
 * - When the keyboard has finished showing (the WebView has resized by
 *   then) and when the toolbar mounts, the caret is scrolled into view
 *   explicitly, using those same margins.
 */
import { Keyboard } from '@capacitor/keyboard'
import { EditorView } from '@codemirror/view'
import { StateEffect } from '@codemirror/state'
import { useStore } from '@zennotes/app-core/store'

const TOOLBAR = '.zn-editor-toolbar'

/** Bottom clearance CodeMirror must keep clear: the toolbar's height while it
 *  is mounted (it renders only while the keyboard is up over the editor). */
function toolbarClearance(): number {
  const bar = document.querySelector<HTMLElement>(TOOLBAR)
  if (!bar) return 0
  // Extra so the caret line isn't flush against the toolbar's top edge.
  return Math.round(bar.getBoundingClientRect().height) + 8
}

function marginSource(): { bottom: number } | null {
  const bottom = toolbarClearance()
  return bottom > 0 ? { bottom } : null
}

const marginsExtension = EditorView.scrollMargins.of(marginSource)

function ensureMargins(view: EditorView): void {
  // Checked against the live facet (not a seen-set): a full reconfigure
  // upstream would drop appended config, and this re-appends on the next
  // sighting instead of silently losing the margin.
  if (view.state.facet(EditorView.scrollMargins).includes(marginSource)) return
  view.dispatch({ effects: StateEffect.appendConfig.of(marginsExtension) })
}

/** Scroll the caret into view honoring the toolbar clearance, if the editor
 *  is the focused element. A no-op when the caret already sits clear of the
 *  toolbar (`nearest`), so repeating it is free. */
export function revealCaretAboveKeyboard(): void {
  const view = useStore.getState().editorViewRef
  if (!view || !view.hasFocus) return
  ensureMargins(view)
  view.dispatch({
    effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: 'nearest' })
  })
}

/**
 * The keyboard's final geometry lands in stages — the predictive bar joins
 * after the keys and grows the keyboard, the WebView's Native resize follows
 * the animation, the toolbar mounts on its own debounce — and a single
 * reveal measured against an intermediate state left the caret under the
 * toolbar on the first keyboard of a freshly opened note (seen once while
 * recording, 2026-09-08). Re-run it over a short window; each pass is a
 * no-op once the caret is clear.
 */
export function revealCaretAboveKeyboardSoon(): void {
  requestAnimationFrame(revealCaretAboveKeyboard)
  for (const ms of [150, 400, 800]) window.setTimeout(revealCaretAboveKeyboard, ms)
}

/** Wire the margin source to every editor view and the reveal to the
 *  keyboard lifecycle. Returns the uninstaller. */
export function installEditorKeyboardScroll(): () => void {
  const initial = useStore.getState().editorViewRef
  if (initial) ensureMargins(initial)
  const unsubscribe = useStore.subscribe((state, prev) => {
    if (state.editorViewRef && state.editorViewRef !== prev.editorViewRef) {
      ensureMargins(state.editorViewRef)
    }
  })
  // keyboardDidShow lands after the slide, by which point Native resize has
  // shrunk the WebView — the geometry the reveal must be measured against.
  const didShow = Keyboard.addListener('keyboardDidShow', revealCaretAboveKeyboardSoon)
  // A resize with the keyboard up (rotation, or the WebView shrinking late)
  // moves the keyboard-relative geometry too.
  const onResize = (): void => {
    if (document.documentElement.classList.contains('zn-kb-open')) revealCaretAboveKeyboardSoon()
  }
  window.addEventListener('resize', onResize)
  return () => {
    unsubscribe()
    void didShow.then((h) => h.remove()).catch(() => {})
    window.removeEventListener('resize', onResize)
  }
}
