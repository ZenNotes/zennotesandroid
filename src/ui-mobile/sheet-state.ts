/**
 * Which app-level mobile sheet (the Vaults manager) is open, shared
 * module-wide like drawer-state so any surface can summon it: the drawer
 * header, the ••• action sheet, and the injected Settings rows.
 */
import { useSyncExternalStore } from 'react'
import { Keyboard } from '@capacitor/keyboard'

export type MobileSheetKind = 'vaults'

let current: MobileSheetKind | null = null
const subscribers = new Set<() => void>()

export function openMobileSheet(kind: MobileSheetKind): void {
  if (current === kind) return
  current = kind
  // Sheets can be summoned over a live editing session (or right after a
  // prompt whose input unmounted without blurring — WKWebView then leaves
  // the keyboard up under the sheet). Same treatment as drawer-state.
  ;(document.activeElement as HTMLElement | null)?.blur?.()
  void Keyboard.hide().catch(() => {})
  for (const cb of subscribers) cb()
}

export function isMobileSheetOpen(): boolean {
  return current !== null
}

export function closeMobileSheet(): void {
  if (current === null) return
  current = null
  for (const cb of subscribers) cb()
}

export function useMobileSheet(): MobileSheetKind | null {
  return useSyncExternalStore(
    (cb) => {
      subscribers.add(cb)
      return () => subscribers.delete(cb)
    },
    () => current
  )
}
