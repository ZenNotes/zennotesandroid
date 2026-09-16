import { Keyboard } from '@capacitor/keyboard'
import { revealEditorCaret } from '@zennotes/app-core/editor'
import { installMobileEditorHost, refreshMobileEditorHost } from './editor-host'

export function revealCaretAboveKeyboard(): void {
  refreshMobileEditorHost()
  revealEditorCaret()
}
export function revealCaretAboveKeyboardSoon(): void {
  requestAnimationFrame(revealCaretAboveKeyboard)
  for (const ms of [150, 400, 800]) window.setTimeout(revealCaretAboveKeyboard, ms)
}
export function installEditorKeyboardScroll(): () => void {
  const release = installMobileEditorHost()
  let frame = 0
  const refresh = (): void => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; revealCaretAboveKeyboard() }) }
  const sizes = new ResizeObserver(refresh)
  const observe = (): void => {
    sizes.disconnect()
    for (const node of document.querySelectorAll('.zn-editor-toolbar, [data-selection-toolbar]')) sizes.observe(node)
    refresh()
  }
  const mutations = new MutationObserver(observe)
  mutations.observe(document.body, { childList: true, subtree: true })
  mutations.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  observe()
  const didShow = Keyboard.addListener('keyboardDidShow', revealCaretAboveKeyboardSoon)
  window.addEventListener('resize', refresh)
  return () => {
    cancelAnimationFrame(frame)
    mutations.disconnect(); sizes.disconnect(); release()
    void didShow.then(handle => handle.remove()).catch(() => {})
    window.removeEventListener('resize', refresh)
  }
}
