/**
 * The mobile editing toolbar (spec 06's marquee input feature): a horizontally
 * scrollable formatting row docked above the soft keyboard while the
 * CodeMirror editor is focused. Actions drive the shared editor through the
 * public semantic commands, without owning editor state or formatting logic.
 *
 * With the Capacitor Keyboard in `resize: native` mode the viewport shrinks
 * when the keyboard shows, so `bottom: 0` docks exactly on the keyboard's top.
 */
import React, { useEffect, useState } from 'react'
import { Keyboard } from '@capacitor/keyboard'
import { runEditorCommand } from '@zennotes/app-core/editor'
import { promptAttachFiles } from './attach'
import { revealCaretAboveKeyboardSoon } from './editor-keyboard-scroll'

interface ToolButton {
  key: string
  label: string
  d: string
  run: () => void
  /** Bigger text glyph instead of an SVG path. */
  glyph?: string
}

const BUTTONS: ToolButton[] = [
  {
    key: 'undo',
    label: 'Undo',
    d: 'M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 015.5 5.5v0a5.5 5.5 0 01-5.5 5.5H11',
    run: () => runEditorCommand('undo')
  },
  {
    key: 'redo',
    label: 'Redo',
    d: 'M15 14l5-5-5-5M20 9H9.5A5.5 5.5 0 004 14.5v0A5.5 5.5 0 009.5 20H13',
    run: () => runEditorCommand('redo')
  },
  {
    key: 'find',
    label: 'Find in note',
    d: 'M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z',
    // No withView here: openSearchPanel focuses the panel's own input, and
    // withView's editor refocus would immediately steal it back. Focus moves
    // input-to-input, so the keyboard stays up (Discord feedback, 2026-08-20:
    // "I have to exit the note to search for a word").
    run: () => { runEditorCommand('open-search') }
  },
  {
    key: 'attach',
    label: 'Attach file',
    d: 'M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l8.57-8.57A4 4 0 0118 8.84l-8.59 8.57a2 2 0 01-2.83-2.83l8.49-8.48',
    // No withView: the system document picker takes over the screen anyway;
    // the insertion path refocuses the editor when the pick lands (#690).
    run: () => promptAttachFiles()
  },
  {
    key: 'todo',
    label: 'Checkbox',
    d: 'M9 11l3 3L22 4M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11',
    run: () => runEditorCommand('set-task-list')
  },
  {
    key: 'bullet',
    label: 'Bullet list',
    d: 'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01',
    run: () => runEditorCommand('set-bullet-list')
  },
  {
    key: 'heading',
    label: 'Heading',
    glyph: 'H',
    d: '',
    run: () => runEditorCommand('cycle-heading')
  },
  {
    key: 'bold',
    label: 'Bold',
    glyph: 'B',
    d: '',
    run: () => runEditorCommand('toggle-bold')
  },
  {
    key: 'italic',
    label: 'Italic',
    glyph: 'I',
    d: '',
    run: () => runEditorCommand('toggle-italic')
  },
  {
    key: 'strike',
    label: 'Strikethrough',
    d: 'M16 4H9a3 3 0 00-2.83 4M14 12a4 4 0 010 8H6M4 12h16',
    run: () => runEditorCommand('toggle-strikethrough')
  },
  {
    key: 'highlight',
    label: 'Highlight',
    d: 'M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z',
    run: () => runEditorCommand('toggle-highlight')
  },
  {
    key: 'code',
    label: 'Inline code',
    d: 'M16 18l6-6-6-6M8 6l-6 6 6 6',
    run: () => runEditorCommand('toggle-inline-code')
  },
  {
    key: 'link',
    label: 'Link',
    d: 'M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71',
    run: () => runEditorCommand('insert-link')
  },
  {
    key: 'wikilink',
    label: 'Wikilink',
    glyph: '[[',
    d: '',
    run: () => runEditorCommand('insert-wikilink')
  },
  {
    key: 'tag',
    label: 'Tag',
    glyph: '#',
    d: '',
    run: () => runEditorCommand('insert-tag')
  },
  {
    key: 'outdent',
    label: 'Outdent',
    d: 'M11 8h10M11 12h10M11 16h10M7 8l-4 4 4 4',
    run: () => runEditorCommand('outdent')
  },
  {
    key: 'indent',
    label: 'Indent',
    d: 'M11 8h10M11 12h10M11 16h10M3 8l4 4-4 4',
    run: () => runEditorCommand('indent')
  }
]

function isEditorFocused(): boolean {
  const active = document.activeElement
  return (
    active instanceof HTMLElement &&
    active.closest('.cm-editor') !== null &&
    // The search panel's field lives inside .cm-editor too — while the user
    // is typing a query, the format row would only cover the panel it
    // belongs to. Formatting comes back when focus returns to the note.
    active.closest('.cm-panel') === null
  )
}

export function MobileEditorToolbar(): React.JSX.Element | null {
  const [kbOpen, setKbOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const show = Keyboard.addListener('keyboardWillShow', () => {
      setKbOpen(true)
      setEditing(isEditorFocused())
    })
    const hide = Keyboard.addListener('keyboardWillHide', () => setKbOpen(false))
    const refresh = (): void => setEditing(isEditorFocused())
    document.addEventListener('focusin', refresh)
    document.addEventListener('focusout', refresh)
    return () => {
      void show.then((h) => h.remove()).catch(() => {})
      void hide.then((h) => h.remove()).catch(() => {})
      document.removeEventListener('focusin', refresh)
      document.removeEventListener('focusout', refresh)
    }
  }, [])

  // Opening a note blurs and refocuses the editor (and a palette's keyboard
  // may hand off mid-flight), so `kbOpen && editing` flaps for a few frames —
  // rendered directly, that's a visible flicker. Debounce BOTH directions:
  // only a state that survives 100ms reaches the DOM. 100ms is invisible
  // next to the ~250ms keyboard slide.
  useEffect(() => {
    const desired = kbOpen && editing
    const t = window.setTimeout(() => {
      setVisible(desired)
    }, 100)
    return () => window.clearTimeout(t)
  }, [kbOpen, editing])

  // The toolbar overlays the bottom of the editor: once it's in the DOM, make
  // sure the caret isn't under it (editor-keyboard-scroll.ts measures it).
  useEffect(() => {
    if (visible) revealCaretAboveKeyboardSoon()
  }, [visible])

  if (!visible) return null

  return (
    <div className="zn-editor-toolbar" role="toolbar" aria-label="Formatting">
      <div className="zn-editor-toolbar-scroll">
        {BUTTONS.map((b) => (
          <button
            key={b.key}
            type="button"
            aria-label={b.label}
            // preventDefault keeps focus (and the keyboard) in the editor.
            onPointerDown={(e) => e.preventDefault()}
            onMouseDown={(e) => e.preventDefault()}
            onClick={b.run}
          >
            {b.glyph ? (
              <span className={`zn-glyph zn-glyph-${b.key}`}>{b.glyph}</span>
            ) : (
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d={b.d} />
              </svg>
            )}
          </button>
        ))}
      </div>
      <button
        type="button"
        aria-label="Dismiss keyboard"
        className="zn-editor-toolbar-dismiss"
        onPointerDown={(e) => e.preventDefault()}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          // Blur first: Android's Keyboard.hide() is hideSoftInputFromWindow
          // only — it does NOT resign focus like iOS's endEditing, and a
          // still-focused editor's input connection re-summons the keyboard
          // right after (issue #7). Blurring also flips `editing`, so the
          // toolbar itself closes with the keyboard.
          const active = document.activeElement
          if (active instanceof HTMLElement) active.blur()
          void Keyboard.hide().catch(() => {})
        }}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M6 10l6 6 6-6" />
        </svg>
      </button>
    </div>
  )
}
