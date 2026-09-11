type Options = { hasSelection: () => boolean; open: (target: string) => void; now?: () => number }

export function installWikilinkTouchNavigation(root: Document, options: Options): () => void {
  const now = options.now ?? Date.now
  let tap: { target: string; id: number; x: number; y: number; at: number } | null = null
  let suppressMouseUntil = 0
  let touchingLink = false
  const linkAt = (event: Event): HTMLElement | null =>
    (event.target as HTMLElement | null)?.closest?.<HTMLElement>('.cm-wikilink') ?? null
  const cancel = (): void => { tap = null }
  const start = (event: TouchEvent): void => {
    tap = null
    const target = linkAt(event)?.dataset.target
    if (event.touches.length === 1) touchingLink = Boolean(target)
    else touchingLink ||= Boolean(target)
    if (!target) return
    suppressMouseUntil = now() + 800
    if (event.touches.length !== 1 || options.hasSelection()) return
    const touch = event.touches[0]
    tap = { target, id: touch.identifier, x: touch.clientX, y: touch.clientY, at: now() }
    // Do not cancel touchstart: native scrolling and long-press selection
    // must be able to take ownership. Save the target before CM reveals its
    // Markdown source (and removes the link element).
  }
  const move = (event: TouchEvent): void => {
    if (!tap) return
    const touch = Array.from(event.touches).find((touch) => touch.identifier === tap?.id)
    if (event.touches.length !== 1 || !touch || options.hasSelection() ||
        Math.hypot(touch.clientX - tap.x, touch.clientY - tap.y) > 10) cancel()
  }
  const end = (event: TouchEvent): void => {
    if (touchingLink) suppressMouseUntil = now() + 800
    if (event.touches.length === 0) touchingLink = false
    const candidate = tap
    tap = null
    if (!candidate || event.touches.length !== 0 || options.hasSelection()) return
    const touch = Array.from(event.changedTouches).find((touch) => touch.identifier === candidate.id)
    if (!touch || now() - candidate.at > 350 ||
        Math.hypot(touch.clientX - candidate.x, touch.clientY - candidate.y) > 10) return
    event.preventDefault()
    event.stopPropagation()
    options.open(candidate.target)
  }
  const mouse = (event: MouseEvent): void => {
    // The desktop extension follows mousedown. Never let a touch's delayed
    // compatibility event follow a link that we rejected as a drag/selection.
    if (now() >= suppressMouseUntil || !linkAt(event)) return
    const capabilities = (event as MouseEvent & { sourceCapabilities?: { firesTouchEvents: boolean } }).sourceCapabilities
    if (capabilities?.firesTouchEvents === false) return
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  root.addEventListener('touchstart', start, { capture: true, passive: true })
  root.addEventListener('touchmove', move, { capture: true, passive: true })
  root.addEventListener('touchend', end, { capture: true, passive: false })
  root.addEventListener('touchcancel', cancel, { capture: true })
  root.addEventListener('scroll', cancel, { capture: true })
  root.addEventListener('mousedown', mouse, { capture: true })
  root.addEventListener('click', mouse, { capture: true })
  return () => {
    root.removeEventListener('touchstart', start, { capture: true })
    root.removeEventListener('touchmove', move, { capture: true })
    root.removeEventListener('touchend', end, { capture: true })
    root.removeEventListener('touchcancel', cancel, { capture: true })
    root.removeEventListener('scroll', cancel, { capture: true })
    root.removeEventListener('mousedown', mouse, { capture: true })
    root.removeEventListener('click', mouse, { capture: true })
  }
}
