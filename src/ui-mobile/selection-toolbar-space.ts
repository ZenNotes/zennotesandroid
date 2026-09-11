type Rect = Pick<DOMRect, 'top' | 'bottom' | 'left' | 'right'>

export function selectionToolbarInset(editor: Rect, toolbar: Rect | null): number {
  if (!toolbar || toolbar.top >= editor.bottom || toolbar.bottom <= editor.top ||
      toolbar.left >= editor.right || toolbar.right <= editor.left) return 0
  return Math.ceil(Math.min(editor.bottom - editor.top, editor.bottom - toolbar.top + 8))
}

/** Reserve space in the flex editor itself. Padding inside its scroller is
 * not sufficient: native selection handles can still enter an overlaid area.
 * Measure the editor's border box, which stays stable as its scroller shrinks. */
export function installSelectionToolbarSpace(getEditor: () => HTMLElement | null, reveal: () => void): () => void {
  let editor: HTMLElement | null = null
  let toolbar: HTMLElement | null = null
  let frame = 0
  const schedule = (): void => { if (!frame) frame = requestAnimationFrame(update) }
  const sizes = new ResizeObserver(schedule)
  function update(): void {
    frame = 0
    const nextEditor = getEditor()
    const nextToolbar = document.documentElement.classList.contains('zn-phone')
      ? document.querySelector<HTMLElement>('[data-selection-toolbar]') : null
    if (editor !== nextEditor || toolbar !== nextToolbar) {
      sizes.disconnect()
      editor?.style.removeProperty('--zn-selection-clearance')
      editor = nextEditor
      toolbar = nextToolbar
      if (editor) sizes.observe(editor)
      if (toolbar) sizes.observe(toolbar)
    }
    if (!editor) return
    const inset = selectionToolbarInset(editor.getBoundingClientRect(), toolbar?.getBoundingClientRect() ?? null)
    const value = `${inset}px`
    if (editor.style.getPropertyValue('--zn-selection-clearance') !== value) {
      editor.style.setProperty('--zn-selection-clearance', value)
      reveal()
    }
  }
  const mutations = new MutationObserver(schedule)
  mutations.observe(document.body, { childList: true, subtree: true })
  mutations.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  window.addEventListener('resize', schedule)
  update()
  return () => {
    cancelAnimationFrame(frame)
    sizes.disconnect()
    mutations.disconnect()
    window.removeEventListener('resize', schedule)
    editor?.style.removeProperty('--zn-selection-clearance')
  }
}
