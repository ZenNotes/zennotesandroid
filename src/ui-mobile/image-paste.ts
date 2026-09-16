import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import { captureEditorInsertion, insertPastedImage, subscribeEditorPresentation } from '@zennotes/app-core/editor'
import { captureAssetImporter } from './editor-host'
import { decodeCloudSyncBase64 } from '../bridge/cloud-sync-work'

const ImagePaste = registerPlugin<{
  setEnabled(options: { enabled: boolean }): Promise<void>
  read(options: { id: string }): Promise<{ base64: string; mimeType: string }>
  discard(options: { id: string }): Promise<void>
  addListener(event: 'image', listener: (event: { id: string }) => void): Promise<PluginListenerHandle>
}>('ImagePaste')

function current() {
  if (document.querySelector('[role="dialog"], [data-ctx-menu]')) return null
  const importer = captureAssetImporter()
  return importer ? captureEditorInsertion(importer, { requireFocus: true }) : null
}
export function installImagePaste(): () => void {
  if (Capacitor.getPlatform() !== 'android') return () => {}
  let live = true, enabled = false, busy = false
  const sync = (): void => {
    if (!live) return
    const next = current() !== null
    if (next === enabled) return
    enabled = next
    void ImagePaste.setEnabled({ enabled }).catch(() => { enabled = false })
  }
  const onFocus = (): void => { queueMicrotask(sync) }
  const listener = ImagePaste.addListener('image', ({ id }) => {
    const target = live && !busy ? current() : null
    if (!target) { void ImagePaste.discard({ id }).catch(() => {}); return }
    busy = true
    void (async () => {
      const result = await ImagePaste.read({ id })
      const { bytes } = await decodeCloudSyncBase64(result.base64)
      if (!live) return
      const inserted = await insertPastedImage(target, { data: bytes.buffer as ArrayBuffer, mimeType: result.mimeType, suggestedName: null })
      if (inserted.status === 'failed') window.alert(inserted.error)
    })().catch(error => {
      if (live) window.alert(error instanceof Error ? error.message : 'Could not paste the image.')
    }).finally(() => { busy = false; void ImagePaste.discard({ id }).catch(() => {}); sync() })
  })
  void listener.then(sync).catch(() => {})
  document.addEventListener('focusin', onFocus)
  document.addEventListener('focusout', onFocus)
  const unsubscribe = subscribeEditorPresentation(sync)
  return () => {
    live = false; unsubscribe()
    document.removeEventListener('focusin', onFocus); document.removeEventListener('focusout', onFocus)
    void listener.then(handle => handle.remove()).catch(() => {})
    void ImagePaste.setEnabled({ enabled: false }).catch(() => {})
  }
}
