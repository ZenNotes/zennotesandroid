/**
 * Attach a file to the open note (zennotes#690: "how do I add an image or
 * PDF to a note on Android?" — until now the honest answer was "paste an
 * image, or `![[`-embed something already in the vault").
 *
 * No native plugin needed: the WebView routes `<input type="file">` through
 * Android's system document picker (Capacitor's chrome client implements
 * onShowFileChooser), and the picked Files flow through the SAME import path
 * as desktop drag-drop — `importDroppedFile` on the active vault (bytes in,
 * unique name, change event; MobileVault and RemoteVault both implement it)
 * — then land at the cursor via app-core's own insertion formatting, exactly
 * as EditorPane inserts drops on desktop.
 *
 * Module-level rather than toolbar-local on purpose: opening the picker
 * pauses the activity, the keyboard drops, and the focus-gated toolbar
 * unmounts — a component-owned input would never deliver its change event.
 * The insertion targets the store's editorViewRef, which survives all of
 * that; refocusing it afterwards brings the keyboard back.
 */
import { formatImportedAssetsForInsertion } from '@zennotes/app-core/lib/editor-drops'
import { useStore } from '@zennotes/app-core/store'
import type { ImportedAsset } from '@bridge-contract/ipc'
import { activeVault } from '../bridge/mobile-bridge'

const INPUT_CLASS = 'zn-attach-input'

export function promptAttachFiles(): void {
  const notePath = useStore.getState().selectedPath
  if (!notePath || notePath.startsWith('zen://')) return

  // Old WebViews never fire `cancel` on file inputs, so a dismissed picker
  // can strand its element — sweep leftovers instead of guarding re-entry
  // (the picker activity is modal; a second tap while it's up goes nowhere).
  for (const stale of document.querySelectorAll(`.${INPUT_CLASS}`)) stale.remove()

  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  input.className = INPUT_CLASS
  // Not display:none — WebKit (the iOS shell) declines to present the picker
  // for an input that isn't rendered; Android's WebView doesn't care, but the
  // two shells share this file line for line. Off-screen and transparent.
  input.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none'
  document.body.appendChild(input)

  input.addEventListener('cancel', () => input.remove())
  input.addEventListener('change', () => {
    const files = Array.from(input.files ?? [])
    input.remove()
    if (files.length === 0) return
    void importAndInsert(notePath, files)
  })
  input.click()
}

async function importAndInsert(notePath: string, files: File[]): Promise<void> {
  try {
    const imported: ImportedAsset[] = []
    for (const file of files) {
      imported.push(await activeVault().importDroppedFile(notePath, file))
    }
    insertAtCursor(imported)
  } catch (error) {
    window.alert(error instanceof Error ? error.message : 'Could not attach the file.')
  }
}

/** Mirrors EditorPane's insertImportedAssets, minus drop coordinates: the
 *  markdown goes to the cursor, with the same before/after spacing rules. */
function insertAtCursor(imported: ImportedAsset[]): void {
  if (imported.length === 0) return
  const view = useStore.getState().editorViewRef
  if (!view) return
  const insertAt = view.state.selection.main.head
  const doc = view.state.doc
  const before = insertAt > 0 ? doc.sliceString(insertAt - 1, insertAt) : ''
  const after = insertAt < doc.length ? doc.sliceString(insertAt, insertAt + 1) : ''
  const insert = formatImportedAssetsForInsertion(imported, before, after)
  view.dispatch({
    changes: { from: insertAt, to: insertAt, insert },
    selection: { anchor: insertAt + insert.length }
  })
  view.focus()
}
