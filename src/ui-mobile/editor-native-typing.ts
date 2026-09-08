/**
 * The keyboard's autocorrect, suggestion strip and sentence capitalization
 * in the note body — Gboard and friends on Android, the QuickType bar on
 * iOS (Adib, iPhone device testing 2026-09-08: "autocorrect and predictive
 * bar is still not showing"; ported for parity).
 *
 * CodeMirror stamps `spellcheck="false" autocorrect="off" autocapitalize="off"
 * writingsuggestions="false"` on its content element by default — right for
 * code, but on a phone it makes the note body the one text field on the
 * device without the system's typing help: no suggestion strip, no
 * corrections, no capitalization (Chromium maps spellcheck=false and
 * autocorrect=off to the IME's no-suggestions flag). app-core doesn't
 * touch these, so the shell overrides them per editor view through
 * CodeMirror's own `contentAttributes` facet, appended with
 * StateEffect.appendConfig (the public hook for adding config to a live
 * view); any facet value wins over CodeMirror's base defaults. WebKit reads
 * the traits when the element gains focus (Chromium builds the IME's
 * EditorInfo the same way), and the view is configured the moment app-core
 * publishes it — before the first tap lands — so the keyboard comes up
 * with them from the start.
 */
import { EditorView } from '@codemirror/view'
import { StateEffect } from '@codemirror/state'
import { useStore } from '@zennotes/app-core/store'

/** What a native text field gets by default. `writingsuggestions` is
 *  WebKit-only (iOS inline predictions); Chromium ignores it. Kept so the
 *  two shells stay identical. */
const NATIVE_TYPING: Record<string, string> = {
  autocorrect: 'on',
  autocapitalize: 'sentences',
  spellcheck: 'true',
  writingsuggestions: 'true'
}

const nativeTypingExtension = EditorView.contentAttributes.of(NATIVE_TYPING)

function ensureNativeTyping(view: EditorView): void {
  // Checked against the live facet, not a seen-set: a full reconfigure
  // upstream would drop appended config, and this re-appends on the next
  // sighting instead of silently losing the traits.
  if (view.state.facet(EditorView.contentAttributes).includes(NATIVE_TYPING)) return
  view.dispatch({ effects: StateEffect.appendConfig.of(nativeTypingExtension) })
}

/** Apply to the current editor view and every one app-core publishes after
 *  it. Returns the uninstaller. */
export function installEditorNativeTyping(): () => void {
  const initial = useStore.getState().editorViewRef
  if (initial) ensureNativeTyping(initial)
  return useStore.subscribe((state, prev) => {
    if (state.editorViewRef && state.editorViewRef !== prev.editorViewRef) {
      ensureNativeTyping(state.editorViewRef)
    }
  })
}
