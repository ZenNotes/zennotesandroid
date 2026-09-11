/** Manual browser fixture: npm run dev, then /tooling/android-ui-check.html.
 * Real CM editor, selection toolbar and sheet handle; no account or native
 * filesystem. This does NOT replace Android IME/selection/splash testing. */
import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { EditorView } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { EditorSelectionToolbar } from '@zennotes/app-core/components/EditorSelectionToolbar'
import { installSelectionToolbarSpace } from '../src/ui-mobile/selection-toolbar-space'
import { SheetHandle } from '../src/ui-mobile/SheetHandle'
import '@zennotes/app-core/styles/index.css'
import '../src/ui-mobile/mobile.css'

function Fixture() {
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<EditorView | null>(null)
  const [selection, setSelection] = useState(false)
  const [sheet, setSheet] = useState(false)
  const [result, setResult] = useState('Ready')
  useEffect(() => {
    const view = new EditorView({ parent: host.current!, state: EditorState.create({
      doc: Array.from({ length: 80 }, (_, i) => `Line ${i + 1}: a note with enough text to scroll and select.`).join('\n'),
      extensions: [EditorView.lineWrapping, EditorView.theme({ '&': { height: '100%' }, '.cm-scroller': { overflow: 'auto' } })]
    }) })
    editor.current = view
    const remove = installSelectionToolbarSpace(() => view.dom, () => {
      view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: 'nearest' }) })
    })
    return () => { remove(); view.destroy() }
  }, [])
  const measure = () => {
    const scroller = editor.current!.scrollDOM.getBoundingClientRect()
    const bar = document.querySelector('[data-selection-toolbar]')?.getBoundingClientRect()
    const fab = document.querySelector('.zn-mobile-fab')!.getBoundingClientRect()
    const footer = document.querySelector('[data-cloud-sync-status]')!.parentElement!.getBoundingClientRect()
    setResult(JSON.stringify({ editorClear: !bar || scroller.bottom <= bar.top,
      fabClear: fab.bottom <= footer.top, scrollerBottom: Math.round(scroller.bottom),
      menuTop: bar && Math.round(bar.top), footerHeight: footer.height }))
  }
  return <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column' }}>
    <div style={{ padding: 8, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
      <button onClick={() => { setSelection(!selection); document.documentElement.classList.toggle('zn-kb-open', !selection) }}>Toggle selection</button>
      <button onClick={() => setSheet(true)}>Open sheet</button>
      <button onClick={measure}>Check layout</button>
      <button onClick={() => {
        const light = document.documentElement.style.getPropertyValue('--z-bg') !== '250 250 250'
        document.documentElement.style.setProperty('--z-bg', light ? '250 250 250' : '29 32 33')
        document.documentElement.style.setProperty('--z-fg', light ? '30 30 30' : '235 219 178')
      }}>Toggle theme</button>
      <output style={{ width: '100%', fontSize: 12 }}>{result}</output>
    </div>
    <div ref={host} style={{ minHeight: 0, flex: 1 }} />
    <div className="h-8" style={{ display: 'flex', alignItems: 'center', padding: '0 12px', flexShrink: 0 }}>
      <span data-cloud-sync-status>Cloud disconnected</span><button data-cloud-sync-action style={{ marginLeft: 'auto' }}>Connect Cloud</button>
    </div>
    <button className="zn-mobile-fab" aria-label="Navigation">+</button>
    {selection && <><div className="zn-editor-toolbar" style={{ height: 52 }}>Keyboard toolbar</div>
      <EditorSelectionToolbar x={100} y={120} onWrap={() => {}} onLink={() => {}} onComment={() => {}} onBlockType={() => {}} onDismiss={() => setSelection(false)} />
    </>}
    {sheet && <><div className="zn-mobile-sheet-backdrop" onClick={() => setSheet(false)} />
      <div className="zn-mobile-sheet" role="dialog" aria-label="Fixture sheet">
        <SheetHandle onDismiss={() => { setSheet(false); setResult('Sheet dismissed') }} />
        <div className="zn-mobile-sheet-title">Vault actions</div>
        <div className="zn-mobile-sheet-scroll">{Array.from({ length: 20 }, (_, i) => <button key={i} className="zn-mobile-sheet-row">Menu item {i + 1}</button>)}</div>
      </div></>}
  </div>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
