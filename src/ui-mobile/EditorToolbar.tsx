/**
 * The mobile editing toolbar (spec 06's marquee input feature): a horizontally
 * scrollable formatting row docked above the soft keyboard while the
 * CodeMirror editor is focused. Actions drive the shared editor through the
 * store's `editorViewRef` using app-core's own formatting helpers
 * (lib/cm-format.ts) plus stock @codemirror/commands — no editor logic is
 * duplicated, and no zennotes code changes.
 *
 * With the Capacitor Keyboard in `resize: native` mode the viewport shrinks
 * when the keyboard shows, so `bottom: 0` docks exactly on the keyboard's top.
 */
import React, { useEffect, useState } from 'react'
import { Keyboard } from '@capacitor/keyboard'
import type { EditorView } from '@codemirror/view'
import { indentLess, indentMore, redo, undo } from '@codemirror/commands'
import { EditorSelection } from '@codemirror/state'
import { useStore } from '@zennotes/app-core/store'
import { setBlockType, toggleWrap, wrapLink } from '@zennotes/app-core/lib/cm-format'

function view(): EditorView | null {
  return useStore.getState().editorViewRef
}

function withView(fn: (v: EditorView) => void): void {
  const v = view()
  if (!v) return
  fn(v)
  v.focus()
}

/** Insert text at the cursor, placing the caret `caretOffset` chars in. */
function insertSnippet(v: EditorView, text: string, caretOffset: number): void {
  const { from, to } = v.state.selection.main
  v.dispatch({
    changes: { from, to, insert: text },
    selection: EditorSelection.cursor(from + caretOffset)
  })
}

/** Cycle the current line's heading level: none → # → ## → ### → none. */
function cycleHeading(v: EditorView): void {
  const line = v.state.doc.lineAt(v.state.selection.main.from)
  const m = line.text.match(/^(#{1,6})\s/)
  const level = m ? m[1]!.length : 0
  const next = level >= 3 ? 'paragraph' : (['h1', 'h2', 'h3'] as const)[level]!
  setBlockType(v, next)
}

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
    run: () => withView((v) => undo(v))
  },
  {
    key: 'redo',
    label: 'Redo',
    d: 'M15 14l5-5-5-5M20 9H9.5A5.5 5.5 0 004 14.5v0A5.5 5.5 0 009.5 20H13',
    run: () => withView((v) => redo(v))
  },
  {
    key: 'todo',
    label: 'Checkbox',
    d: 'M9 11l3 3L22 4M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11',
    run: () => withView((v) => setBlockType(v, 'todo'))
  },
  {
    key: 'bullet',
    label: 'Bullet list',
    d: 'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01',
    run: () => withView((v) => setBlockType(v, 'bullet'))
  },
  {
    key: 'heading',
    label: 'Heading',
    glyph: 'H',
    d: '',
    run: () => withView((v) => cycleHeading(v))
  },
  {
    key: 'bold',
    label: 'Bold',
    glyph: 'B',
    d: '',
    run: () => withView((v) => toggleWrap(v, '**'))
  },
  {
    key: 'italic',
    label: 'Italic',
    glyph: 'I',
    d: '',
    run: () => withView((v) => toggleWrap(v, '*'))
  },
  {
    key: 'highlight',
    label: 'Highlight',
    d: 'M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z',
    run: () => withView((v) => toggleWrap(v, '=='))
  },
  {
    key: 'code',
    label: 'Inline code',
    d: 'M16 18l6-6-6-6M8 6l-6 6 6 6',
    run: () => withView((v) => toggleWrap(v, '`'))
  },
  {
    key: 'link',
    label: 'Link',
    d: 'M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71',
    run: () => withView((v) => wrapLink(v))
  },
  {
    key: 'wikilink',
    label: 'Wikilink',
    glyph: '[[',
    d: '',
    run: () => withView((v) => insertSnippet(v, '[[]]', 2))
  },
  {
    key: 'tag',
    label: 'Tag',
    glyph: '#',
    d: '',
    run: () => withView((v) => insertSnippet(v, '#', 1))
  },
  {
    key: 'outdent',
    label: 'Outdent',
    d: 'M11 8h10M11 12h10M11 16h10M7 8l-4 4 4 4',
    run: () => withView((v) => indentLess(v))
  },
  {
    key: 'indent',
    label: 'Indent',
    d: 'M11 8h10M11 12h10M11 16h10M3 8l4 4-4 4',
    run: () => withView((v) => indentMore(v))
  }
]

function isEditorFocused(): boolean {
  const active = document.activeElement
  return active instanceof HTMLElement && active.closest('.cm-editor') !== null
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
