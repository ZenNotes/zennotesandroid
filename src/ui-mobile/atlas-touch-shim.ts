/**
 * Touch gestures for the Atlas map (Discord feedback, 2026-08-20: "Zoom
 * in/out doesn't work in atlas view").
 *
 * App-core's AtlasView is a hand-rolled <canvas> renderer whose input is
 * mouse-only: mousedown/mousemove/mouseup for orbit/pan/click and a wheel
 * handler for zoom (AtlasView.tsx "Mouse:" effect). It registers no touch or
 * pointer handlers at all, so on a phone a drag scrolls nothing and a pinch
 * reaches the browser instead of the camera.
 *
 * Rather than forking the view, this shim translates touches on the atlas
 * canvas into the exact synthetic events that effect already listens for:
 *
 * - one-finger drag  → mousedown (canvas) + mousemove/mouseup (window),
 *   which AtlasView turns into orbit (3D) or pan (2D map);
 * - tap              → mousedown+mouseup at one point, i.e. AtlasView's
 *   click-to-focus (second tap on the focused node opens it);
 * - pinch            → wheel events on the canvas at the pinch midpoint,
 *   with deltaY derived from the finger-distance ratio so the zoom feel
 *   matches the desktop wheel (AtlasView does f = exp(deltaY * 0.0014));
 *   in 3D sky mode zooming in flies toward the midpoint, as on desktop.
 *
 * Everything is preventDefault-ed so the WebView neither scrolls nor
 * synthesizes its own compatibility mouse events (which would double-fire
 * the tap logic). Drop this shim if AtlasView ever grows pointer-event
 * support upstream.
 */
import { useEffect } from 'react'

/** exp(deltaY * WHEEL_ZOOM_RATE) is AtlasView's wheel-to-zoom curve. */
const WHEEL_ZOOM_RATE = 0.0014
/** Movement (px) before a touch stops being a tap and becomes a drag. */
const TAP_SLOP = 8
/** Ignore pinch frames where the fingers are implausibly close (noise). */
const MIN_PINCH_DIST = 30
/** Cap one frame's synthetic deltaY against fat-finger distance jumps. */
const MAX_WHEEL_DELTA = 600

const wired = new WeakSet<HTMLCanvasElement>()

/** The Atlas canvas is generic (`min-h-0 flex-1`); its wrapper's corner
 *  overlay ("Atlas · N notes · …") is the one stable discriminator. */
function isAtlasCanvas(canvas: HTMLCanvasElement): boolean {
  const label = canvas.parentElement?.querySelector('.pointer-events-none .uppercase')
  return (label?.textContent ?? '').trim() === 'Atlas'
}

function mouse(type: string, x: number, y: number): MouseEvent {
  return new MouseEvent(type, {
    clientX: x,
    clientY: y,
    button: 0,
    bubbles: true,
    cancelable: true
  })
}

function wire(canvas: HTMLCanvasElement): void {
  if (wired.has(canvas)) return
  wired.add(canvas)
  canvas.style.touchAction = 'none'

  type Mode = 'idle' | 'maybe-tap' | 'drag' | 'pinch'
  let mode: Mode = 'idle'
  let startX = 0
  let startY = 0
  let lastX = 0
  let lastY = 0
  let lastDist = 0

  const dist = (t: TouchList): number =>
    Math.hypot(t[0]!.clientX - t[1]!.clientX, t[0]!.clientY - t[1]!.clientY)

  const endDrag = (): void => {
    window.dispatchEvent(mouse('mouseup', lastX, lastY))
  }

  const onStart = (e: TouchEvent): void => {
    e.preventDefault()
    if (e.touches.length >= 2) {
      // A drag has moved past the slop already, so this mouseup can't be
      // mistaken for a click by AtlasView's moved-flag check.
      if (mode === 'drag') endDrag()
      mode = 'pinch'
      lastDist = dist(e.touches)
      return
    }
    const t = e.touches[0]!
    mode = 'maybe-tap'
    startX = lastX = t.clientX
    startY = lastY = t.clientY
  }

  const onMove = (e: TouchEvent): void => {
    e.preventDefault()
    if (mode === 'pinch' && e.touches.length >= 2) {
      const d = dist(e.touches)
      const midX = (e.touches[0]!.clientX + e.touches[1]!.clientX) / 2
      const midY = (e.touches[0]!.clientY + e.touches[1]!.clientY) / 2
      if (d > MIN_PINCH_DIST && lastDist > MIN_PINCH_DIST) {
        // Fingers apart → ratio < 1 → deltaY < 0 → zoom in, like wheel-up.
        const deltaY = Math.max(
          -MAX_WHEEL_DELTA,
          Math.min(MAX_WHEEL_DELTA, Math.log(lastDist / d) / WHEEL_ZOOM_RATE)
        )
        canvas.dispatchEvent(
          new WheelEvent('wheel', {
            deltaY,
            clientX: midX,
            clientY: midY,
            bubbles: true,
            cancelable: true
          })
        )
      }
      lastDist = d
      return
    }
    if (e.touches.length !== 1) return
    const t = e.touches[0]!
    if (mode === 'maybe-tap') {
      if (Math.hypot(t.clientX - startX, t.clientY - startY) < TAP_SLOP) return
      mode = 'drag'
      canvas.dispatchEvent(mouse('mousedown', startX, startY))
    }
    if (mode === 'drag') {
      lastX = t.clientX
      lastY = t.clientY
      window.dispatchEvent(mouse('mousemove', lastX, lastY))
    }
  }

  const onEnd = (e: TouchEvent): void => {
    e.preventDefault()
    if (e.touches.length >= 2) return
    if (e.touches.length === 1) {
      // Pinch (or drag) down to one finger: restart as a fresh possible tap.
      const t = e.touches[0]!
      if (mode === 'drag') endDrag()
      mode = 'maybe-tap'
      startX = lastX = t.clientX
      startY = lastY = t.clientY
      lastDist = 0
      return
    }
    if (mode === 'drag') {
      endDrag()
    } else if (mode === 'maybe-tap' && e.type !== 'touchcancel') {
      // AtlasView's click-to-focus: an unmoved mousedown+mouseup pair.
      canvas.dispatchEvent(mouse('mousedown', startX, startY))
      window.dispatchEvent(mouse('mouseup', startX, startY))
    }
    mode = 'idle'
    lastDist = 0
  }

  canvas.addEventListener('touchstart', onStart, { passive: false })
  canvas.addEventListener('touchmove', onMove, { passive: false })
  canvas.addEventListener('touchend', onEnd, { passive: false })
  canvas.addEventListener('touchcancel', onEnd, { passive: false })
  // No teardown: listeners die with the canvas element when the tab closes,
  // and the WeakSet lets the element (and them) be collected.
}

export function useAtlasTouchGestures(): void {
  useEffect(() => {
    let raf = 0
    const sweep = (): void => {
      for (const canvas of document.querySelectorAll<HTMLCanvasElement>('canvas')) {
        if (isAtlasCanvas(canvas)) wire(canvas)
      }
    }
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(sweep)
    })
    observer.observe(document.body, { childList: true, subtree: true })
    sweep()
    return () => {
      observer.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [])
}
