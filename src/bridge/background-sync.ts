/**
 * Background sync: Settings → Cloud → Sync in the background, on by default.
 *
 * When you leave ZenNotes, it finishes a sync before stopping, so an edit
 * made just before leaving reaches your other devices without opening the
 * app again. Android keeps a backgrounded app running for a few seconds
 * before its cached-app freezer stops it, WebView included, which is enough
 * for that final sync; no native help is needed. Changes from other devices
 * arrive when the app comes back.
 *
 * Nothing runs on a timer while the app is away. A WorkManager job every 15
 * minutes was built and tested against real Cloud: it fired on schedule, but
 * the job unfreezes the app's own process and not the WebView renderer the
 * sync engine runs in, so the sync never ran and the job waited out its
 * timeout. Only a foreground service with a notification, or a native sync
 * engine, could change that.
 *
 * Leaving used to stop every Cloud request at once (cloud-sync-client.ts
 * binds them to one lifetime), which abandoned a sync in progress. With the
 * setting on, the requests stop after that final sync instead; with it off,
 * or before this module is installed, leaving stops them at once, as before.
 * Signing out stops them at once either way. Kept close to the iPhone app's
 * copy, which also asks iOS for its grace period.
 */
import type { VaultChangeEvent } from '@zennotes/bridge-contract/ipc'
import { BACKGROUND_SYNC_KEY } from '../viewport'
// The package's request lifetime: the one its Cloud client and auth read.
import { resumeMobileCloudRequests, stopMobileCloudRequests } from '@zennotes/portable-vault/cloud-sync-client'

export { BACKGROUND_SYNC_KEY }

/** The editor writes a note 350 ms after the last keystroke (app-core's
 *  PATH_SAVE_DEBOUNCE_MS). Waiting a little longer lets an edit made just
 *  before leaving reach the disk before the sync reads the vault. */
const SAVE_SETTLE_MS = 500

/** A second pass runs only when the vault changed during the first. Never
 *  more: the sync's own rescan reports changes too. */
const MAX_PASSES = 2

/** What this module needs from the open vault (mobile-bridge.ts). */
export interface BackgroundSyncHost {
  /** Signed in, and the open vault is linked to this account's Cloud. */
  ready(): Promise<boolean>
  /** One sync pass of the open vault; joins a pass that is already running. */
  sync(): Promise<void>
  onVaultChange(listener: (event: VaultChangeEvent) => void): () => void
}

let host: BackgroundSyncHost | null = null
let active = true
let leaving: Promise<void> | null = null

export function backgroundSyncEnabled(): boolean {
  try {
    return localStorage.getItem(BACKGROUND_SYNC_KEY) !== 'off'
  } catch {
    return true
  }
}

export function setBackgroundSyncEnabled(enabled: boolean): void {
  try {
    // On is the default, so it removes the key: a fresh install and a reset
    // look the same.
    if (enabled) localStorage.removeItem(BACKGROUND_SYNC_KEY)
    else localStorage.setItem(BACKGROUND_SYNC_KEY, 'off')
  } catch {
    // Storage unavailable: the choice applies to this session only.
  }
}

export function installBackgroundSync(next: BackgroundSyncHost): void {
  host ??= next
}

/** The app left the screen (Capacitor's appStateChange, isActive false). */
export function leaveApp(): void {
  active = false
  const current = host
  if (!current || !backgroundSyncEnabled()) {
    stopMobileCloudRequests()
    return
  }
  leaving ??= finishSync(current).finally(() => {
    leaving = null
    if (!active) stopMobileCloudRequests()
  })
}

/** The app is back on screen. */
export function returnToApp(): void {
  active = true
  resumeMobileCloudRequests()
}

/** Settles once the final sync started by leaving has ended (tests). */
export function backgroundSyncSettled(): Promise<void> {
  return leaving ?? Promise.resolve()
}

async function finishSync(current: BackgroundSyncHost): Promise<void> {
  try {
    if (!(await current.ready())) return
    await delay(SAVE_SETTLE_MS)
    await syncPasses(current)
  } catch (error) {
    // The next foreground sync picks it up; nothing here can be shown.
    console.warn('Background sync did not finish', error)
  }
}

async function syncPasses(current: BackgroundSyncHost): Promise<void> {
  let changed = false
  const stopWatching = current.onVaultChange(() => {
    changed = true
  })
  try {
    for (let pass = 0; pass < MAX_PASSES; pass += 1) {
      changed = false
      await current.sync()
      if (!changed) break
    }
  } finally {
    stopWatching()
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
