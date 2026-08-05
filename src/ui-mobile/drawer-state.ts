/**
 * Open/closed state for the mobile navigation drawer, shared between the
 * FAB dial, edge-swipe gesture, breadcrumb taps, and the drawer itself.
 */
import { useSyncExternalStore } from 'react'
import { Keyboard } from '@capacitor/keyboard'

let drawerOpen = false
// Folder subpath (relative to the primary notes area) the drawer should show
// when it next opens; '' means the root Quick Access view. Set by a folder
// breadcrumb tap so the drawer opens scoped INTO that folder, then consumed
// (cleared) by the drawer on open so a later plain open lands at the root.
let pendingPath = ''
const subscribers = new Set<() => void>()

export function setDrawerOpen(open: boolean, atPath = ''): void {
  if (open) pendingPath = atPath
  if (drawerOpen === open) return
  drawerOpen = open
  if (open) {
    // The drawer can open over a live editing session (edge swipe or a
    // breadcrumb tap while the keyboard is up) — dismiss the keyboard so
    // it doesn't cover the drawer's lower half.
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    void Keyboard.hide().catch(() => {})
  }
  for (const cb of subscribers) cb()
}

/** Read-and-clear the folder the drawer should open into ('' = root). */
export function takeDrawerPath(): string {
  const p = pendingPath
  pendingPath = ''
  return p
}

export function isDrawerOpen(): boolean {
  return drawerOpen
}

export function useDrawerOpen(): boolean {
  return useSyncExternalStore(
    (cb) => {
      subscribers.add(cb)
      return () => subscribers.delete(cb)
    },
    () => drawerOpen
  )
}
