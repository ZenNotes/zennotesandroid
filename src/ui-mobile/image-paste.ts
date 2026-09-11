import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import type { EditorView } from '@codemirror/view'
import { useStore } from '@zennotes/app-core/store'
import { formatImportedAssetsForInsertion } from '@zennotes/app-core/lib/editor-drops'
import { activeVault } from '../bridge/mobile-bridge'
import { decodeCloudSyncBase64 } from '../bridge/cloud-sync-work'
import { runImagePaste, type PasteContext } from './image-paste-session'

const ImagePaste = registerPlugin<{
  setEnabled(options: { enabled: boolean }): Promise<void>;
  read(options: { id: string }): Promise<{ base64: string; mimeType: string }>;
  discard(options: { id: string }): Promise<void>;
  addListener(event: 'image', listener: (event: { id: string }) => void): Promise<PluginListenerHandle>;
}>('ImagePaste')

function current(): PasteContext | null {
  const state = useStore.getState()
  const view = state.editorViewRef
  const path = state.selectedPath
  if (!state.vault || !view?.hasFocus || view.state.readOnly || !path || path.startsWith('zen://') ||
      !view.contentDOM.contains(document.activeElement) || document.querySelector('[role="dialog"], [data-ctx-menu]')) return null
  return { vault: activeVault(), editor: view, document: view.state.doc, path,
    from: view.state.selection.main.from, to: view.state.selection.main.to }
}

export function installImagePaste(): () => void {
  if (Capacitor.getPlatform() !== 'android') return () => {}
  let live = true
  let enabled = false
  let busy = false
  const sync = (): void => {
    if (!live) return
    // Do not restart the IME mid-paste when a store update arrives. The
    // receiver's single-flight guard rejects overlapping image operations.
    const next = current() !== null
    if (next === enabled) return
    enabled = next
    void ImagePaste.setEnabled({ enabled }).catch(() => { enabled = false })
  }
  const onFocus = (): void => { queueMicrotask(sync) }
  const listener = ImagePaste.addListener('image', ({ id }) => {
    if (!live || busy || !current()) { void ImagePaste.discard({ id }).catch(() => {}); return }
    busy = true
    void runImagePaste({
      current: () => live ? current() : null,
      read: async () => {
        const result = await ImagePaste.read({ id })
        const { bytes } = await decodeCloudSyncBase64(result.base64)
        return { data: bytes.buffer, mimeType: result.mimeType, suggestedName: null }
      },
      save: (context, image) => (context.vault as ReturnType<typeof activeVault>).importPastedImage(image),
      insert: (context, asset) => {
        const view = context.editor as EditorView
        const before = context.from > 0 ? view.state.doc.sliceString(context.from - 1, context.from) : ''
        const after = view.state.doc.sliceString(context.to, context.to + 1)
        const insert = formatImportedAssetsForInsertion([asset], before, after)
        view.dispatch({ changes: { from: context.from, to: context.to, insert },
          selection: { anchor: context.from + insert.length } })
        view.focus()
      }
    }).catch((error) => {
      if (live) window.alert(error instanceof Error ? error.message : 'Could not paste the image.')
    }).finally(() => { busy = false; sync() })
  })
  void listener.then(sync).catch(() => {})
  document.addEventListener('focusin', onFocus)
  document.addEventListener('focusout', onFocus)
  const unsubscribe = useStore.subscribe(sync)
  return () => {
    live = false
    unsubscribe()
    document.removeEventListener('focusin', onFocus)
    document.removeEventListener('focusout', onFocus)
    void listener.then((handle) => handle.remove()).catch(() => {})
    void ImagePaste.setEnabled({ enabled: false }).catch(() => {})
  }
}
