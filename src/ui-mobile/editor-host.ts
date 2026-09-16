import { captureMobileWorkspace } from './workspace-context'
import { installEditorHost, type EditorAssetImporter, type EditorHostRegistration } from '@zennotes/app-core/editor'
import { activeVault } from '../bridge/mobile-bridge'
import { selectionToolbarInset } from './selection-toolbar-space'

let registration: EditorHostRegistration | null = null
let owners = 0
/** One configuration owns typing and both overlay measurements together. */
export function installMobileEditorHost(): () => void {
  owners += 1
  if (!registration) registration = installEditorHost({
    nativeTyping: true,
    measureBottomInsets: viewport => {
      const selection = document.documentElement.classList.contains('zn-phone')
        ? document.querySelector<HTMLElement>('[data-selection-toolbar]') : null
      const keyboard = document.querySelector<HTMLElement>('.zn-editor-toolbar')
      return {
        layout: selectionToolbarInset(viewport.editor, selection?.getBoundingClientRect() ?? null),
        scroll: selectionToolbarInset(viewport.scroll, keyboard?.getBoundingClientRect() ?? null)
      }
    }
  })
  let live = true
  return () => {
    if (!live) return
    live = false
    if (--owners === 0) { registration?.dispose(); registration = null }
  }
}
export function refreshMobileEditorHost(): void { registration?.refresh() }
export function captureAssetImporter(): EditorAssetImporter | null {
  try {
    const vault = activeVault()
    const workspace = captureMobileWorkspace()
    return {
      isCurrent: () => { try { return workspace.isCurrent() && activeVault() === vault } catch { return false } },
      importFile: (path, file) => vault.importDroppedFile(path, file),
      importPastedImage: input => vault.importPastedImage(input)
    }
  } catch { return null }
}
