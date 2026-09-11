import { useRef } from 'react'
import { shouldDismissSheet } from './sheet-drag'

/** Only the handle owns the gesture; scrolling menu content stays native. */
export function SheetHandle({ onDismiss }: { onDismiss: () => void }): React.JSX.Element {
  const drag = useRef<{ id: number; x: number; y: number; at: number; sheet: HTMLElement } | null>(null)
  const moved = useRef(false)
  const reset = (): void => {
    const sheet = drag.current?.sheet
    sheet?.style.removeProperty('--zn-sheet-drag')
    sheet?.removeAttribute('data-dragging')
    drag.current = null
  }
  return <button
    type="button"
    className="zn-mobile-sheet-handle"
    aria-label="Close menu"
    onPointerDown={(event) => {
      if (!event.isPrimary || event.button !== 0) return
      const sheet = event.currentTarget.closest<HTMLElement>('.zn-mobile-sheet')
      if (!sheet) return
      moved.current = false
      drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, at: event.timeStamp, sheet }
      sheet.setAttribute('data-dragging', '')
      event.currentTarget.setPointerCapture(event.pointerId)
    }}
    onPointerMove={(event) => {
      const start = drag.current
      if (!start || start.id !== event.pointerId) return
      const dy = event.clientY - start.y
      moved.current ||= Math.hypot(event.clientX - start.x, dy) > 4
      start.sheet.style.setProperty('--zn-sheet-drag', `${Math.max(0, dy)}px`)
    }}
    onPointerUp={(event) => {
      const start = drag.current
      if (!start || start.id !== event.pointerId) return
      const dx = event.clientX - start.x
      const dy = event.clientY - start.y
      moved.current ||= Math.hypot(dx, dy) > 4
      const dismiss = shouldDismissSheet(dx, dy, event.timeStamp - start.at)
      reset()
      if (dismiss) { moved.current = true; onDismiss() }
    }}
    onPointerCancel={() => { moved.current = true; reset() }}
    onLostPointerCapture={reset}
    onClick={(event) => {
      // Pointer click follows pointerup even after a short drag. Keyboard and
      // assistive-tech activation (detail 0) remain an accessible close action.
      if (!moved.current || event.detail === 0) onDismiss()
    }}
  ><span aria-hidden="true" /></button>
}
