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
import { attachFiles, captureEditorInsertion } from '@zennotes/app-core/editor'
import { captureAssetImporter } from './editor-host'

const INPUT_CLASS = 'zn-attach-input'
export function promptAttachFiles(): void {
  const importer = captureAssetImporter()
  const target = importer && captureEditorInsertion(importer)
  if (!target) return
  for (const stale of document.querySelectorAll(`.${INPUT_CLASS}`)) stale.remove()
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  input.className = INPUT_CLASS
  input.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none'
  document.body.appendChild(input)
  input.addEventListener('cancel', () => input.remove())
  input.addEventListener('change', () => {
    const files = Array.from(input.files ?? [])
    input.remove()
    if (!files.length) return
    void attachFiles(target, files).then(result => {
      if (result.status === 'failed') window.alert(result.error)
    })
  })
  input.click()
}
