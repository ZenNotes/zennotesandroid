/**
 * Swipeable drawer row (spec 07 gestures, Discord feedback 2026-08-17).
 *
 * - Swipe LEFT reveals action buttons (Archive / Delete for notes) that stay
 *   open until an action is tapped, the row is tapped, or another row swipes.
 * - Swipe RIGHT past the trigger pins/unpins immediately on release — the
 *   accent-tinted pin chip under the row is its own confirmation.
 *
 * Coexistence rules, all load-bearing:
 * - The drawer's own swipe-left-to-close gesture (MobileShell) skips touches
 *   that start inside [data-zn-swipe] — otherwise every left row-swipe would
 *   also close the drawer.
 * - The rows' long-press action sheet uses pointer events with a 12px slop;
 *   a horizontal drag cancels it there, so the two never both fire.
 * - Vertical scrolling wins: the gesture only claims the touch once |dx|
 *   clearly beats |dy|, and once claimed it calls preventDefault so the
 *   scroller doesn't pan underneath (touch-action: pan-y on the wrapper
 *   makes that contract explicit).
 * - Only one row holds its actions open at a time (module-level closer).
 */
import React, { useEffect, useRef, useState } from 'react'

const ACTION_WIDTH = 72 // px per revealed action button
const PIN_TRIGGER = 64 // px of right-swipe that commits a pin toggle
const CLAIM = 10 // px of horizontal movement before the row claims the touch

let closeOpenRow: (() => void) | null = null

export interface SwipeAction {
  label: string
  icon: React.ReactNode
  danger?: boolean
  onAction: () => void
}

export function SwipeRow(props: {
  /** Revealed by a left swipe; empty array disables left swipe. */
  leftActions: SwipeAction[]
  /** Fired by a committed right swipe (pin/unpin). */
  onPinSwipe: () => void
  pinned: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const { leftActions, onPinSwipe, pinned, children } = props
  const [dx, setDx] = useState(0)
  const [settling, setSettling] = useState(false)
  const openWidth = leftActions.length * ACTION_WIDTH
  const open = dx === -openWidth && openWidth > 0

  const touch = useRef<{
    x: number
    y: number
    claimed: boolean
    dead: boolean
    fromDx: number
  } | null>(null)
  const rowRef = useRef<HTMLDivElement | null>(null)

  const settleTo = (target: number): void => {
    setSettling(true)
    setDx(target)
  }

  useEffect(() => {
    if (!open) return
    const close = (): void => settleTo(0)
    closeOpenRow?.()
    closeOpenRow = close
    return () => {
      if (closeOpenRow === close) closeOpenRow = null
    }
  }, [open])

  // Native listener because React's onTouchMove is passive — preventDefault
  // there is ignored, and the scroller would pan under a claimed swipe.
  useEffect(() => {
    const el = rowRef.current
    if (!el) return
    const onMove = (e: TouchEvent): void => {
      const t = touch.current
      if (!t || t.dead || e.touches.length !== 1) return
      const cx = e.touches[0]!.clientX
      const cy = e.touches[0]!.clientY
      const mx = cx - t.x
      const my = cy - t.y
      if (!t.claimed) {
        if (Math.abs(my) > Math.abs(mx) && Math.abs(my) > CLAIM) {
          t.dead = true // vertical scroll wins
          return
        }
        if (Math.abs(mx) <= CLAIM) return
        t.claimed = true
        setSettling(false)
      }
      e.preventDefault()
      let next = t.fromDx + mx
      // Clamp with rubber-banding past the functional range.
      const min = -openWidth
      const max = PIN_TRIGGER + 24
      if (next < min) next = min + (next - min) / 3
      if (next > max) next = max + (next - max) / 3
      // A row with no left actions never moves left.
      if (openWidth === 0 && next < 0) next = next / 4
      setDx(next)
    }
    el.addEventListener('touchmove', onMove, { passive: false })
    return () => el.removeEventListener('touchmove', onMove)
  }, [openWidth])

  const onTouchStart = (e: React.TouchEvent): void => {
    if (e.touches.length !== 1) return
    if (closeOpenRow && !open) closeOpenRow()
    touch.current = {
      x: e.touches[0]!.clientX,
      y: e.touches[0]!.clientY,
      claimed: false,
      dead: false,
      fromDx: open ? -openWidth : 0
    }
  }

  const onTouchEnd = (): void => {
    const t = touch.current
    touch.current = null
    if (!t || !t.claimed) return
    if (dx > PIN_TRIGGER) {
      onPinSwipe()
      settleTo(0)
    } else if (openWidth > 0 && dx < -openWidth / 2) {
      settleTo(-openWidth)
    } else {
      settleTo(0)
    }
  }

  const suppressWhileOpen = (e: React.MouseEvent): void => {
    // A tap on a swiped-open row closes it instead of navigating.
    if (open || dx !== 0) {
      e.preventDefault()
      e.stopPropagation()
      settleTo(0)
    }
  }

  return (
    <div className="zn-swipe" data-zn-swipe ref={rowRef}>
      <div className="zn-swipe-pin" aria-hidden="true" style={{ opacity: dx > 8 ? 1 : 0 }}>
        <span className={dx > PIN_TRIGGER ? 'is-armed' : ''}>
          {pinned ? 'Unpin' : 'Pin'}
        </span>
      </div>
      {leftActions.length > 0 && (
        <div className="zn-swipe-actions" style={{ width: openWidth }}>
          {leftActions.map((a) => (
            <button
              key={a.label}
              type="button"
              className={a.danger ? 'zn-danger' : ''}
              tabIndex={open ? 0 : -1}
              onClick={() => {
                settleTo(0)
                a.onAction()
              }}
            >
              {a.icon}
              {a.label}
            </button>
          ))}
        </div>
      )}
      <div
        className={`zn-swipe-content${settling ? ' is-settling' : ''}`}
        style={{ transform: `translateX(${dx}px)` }}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
        onClickCapture={suppressWhileOpen}
        onTransitionEnd={() => setSettling(false)}
      >
        {children}
      </div>
    </div>
  )
}
