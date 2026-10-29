import './random-uuid-polyfill'
import { Preferences } from '@capacitor/preferences'
import { BACKGROUND_SYNC_KEY, GESTURES_KEY, HIDE_STATUS_BAR_KEY, LAYOUT_MODE_KEY, START_SCREEN_KEY } from './viewport'
import { waitAtBoot } from './boot-wait'
import { applyNativePreferences, readNativePreferences, type MirroredPreference } from './boot-preferences'

const WEB_PREFERENCES_KEY = 'zen:prefs:v2'
const NATIVE_PREFERENCES_KEY = 'zn-app-preferences-v2'
// The layout override (#652) rides the same mirror: viewport.ts must read it
// synchronously at boot, and WebView storage alone is not trusted to survive.
const NATIVE_LAYOUT_MODE_KEY = 'zn-layout-mode'
// The fullscreen flag (#22) mirrors for the same durability reason.
const NATIVE_HIDE_STATUS_BAR_KEY = 'zn-hide-status-bar'
// The swipe-gesture assignments (#24) ride along too.
const NATIVE_GESTURES_KEY = 'zn-gestures'
// And the Start screen choice (start-screen.ts): read at cold launch, so it
// must be back in localStorage before main.tsx evaluates.
const NATIVE_START_SCREEN_KEY = 'zn-start-screen'
// And Sync in the background (bridge/background-sync.ts), so an evicted
// WebView store does not quietly turn it back on.
const NATIVE_BACKGROUND_SYNC_KEY = 'zn-background-sync'
const MIRRORED_KEYS: Record<string, string> = {
  [WEB_PREFERENCES_KEY]: NATIVE_PREFERENCES_KEY,
  [LAYOUT_MODE_KEY]: NATIVE_LAYOUT_MODE_KEY,
  [HIDE_STATUS_BAR_KEY]: NATIVE_HIDE_STATUS_BAR_KEY,
  [GESTURES_KEY]: NATIVE_GESTURES_KEY,
  [START_SCREEN_KEY]: NATIVE_START_SCREEN_KEY,
  [BACKGROUND_SYNC_KEY]: NATIVE_BACKGROUND_SYNC_KEY
}

let persistenceQueue = Promise.resolve()

function enqueuePersistence(operation: () => Promise<void>): void {
  persistenceQueue = persistenceQueue.then(operation, operation).catch(() => undefined)
}

function applyStoredTheme(rawPreferences: string): void {
  try {
    const preferences = JSON.parse(rawPreferences) as {
      themeId?: unknown
      themeMode?: unknown
    }
    const themeId =
      typeof preferences.themeId === 'string' && preferences.themeId
        ? preferences.themeId
        : 'dark-hard'
    const themeMode =
      preferences.themeMode === 'light' || preferences.themeMode === 'dark'
        ? preferences.themeMode
        : preferences.themeMode === 'auto'
          ? window.matchMedia('(prefers-color-scheme: dark)').matches
            ? 'dark'
            : 'light'
          : 'dark'

    document.documentElement.dataset.theme = themeId
    document.documentElement.dataset.themeMode = themeMode
  } catch {
    // The app-core preference normalizer will recover malformed web preferences.
  }
}

// Restored at boot, in this order: the app-core preferences first (their
// theme is applied before anything draws), then the shell's own choices.
const RESTORED_PREFERENCES: readonly MirroredPreference[] = [
  { web: WEB_PREFERENCES_KEY, native: NATIVE_PREFERENCES_KEY },
  { web: LAYOUT_MODE_KEY, native: NATIVE_LAYOUT_MODE_KEY },
  { web: HIDE_STATUS_BAR_KEY, native: NATIVE_HIDE_STATUS_BAR_KEY },
  { web: GESTURES_KEY, native: NATIVE_GESTURES_KEY },
  { web: START_SCREEN_KEY, native: NATIVE_START_SCREEN_KEY }
]

/** Put native values back into localStorage before the app reads them. A
 *  native call that never answered once left a blank page after rapid Layout
 *  reloads, so the reads are bounded (boot-wait.ts) and a late answer is
 *  dropped whole (boot-preferences.ts says why). */
async function restoreNativePreferences(): Promise<void> {
  try {
    const answer = await waitAtBoot('native preferences', readNativePreferences(RESTORED_PREFERENCES, Preferences))
    if (!answer.inTime) return
    applyNativePreferences(
      RESTORED_PREFERENCES,
      answer.value,
      window.localStorage,
      (key, value) => enqueuePersistence(() => Preferences.set({ key, value })),
      (pair, value) => {
        if (pair.web === WEB_PREFERENCES_KEY) applyStoredTheme(value)
      }
    )
  } catch {
    // Continue with WebView storage when native preferences are unavailable.
  }
}

function mirrorWebPreferencesToNativeStorage(): void {
  const originalSetItem = Storage.prototype.setItem
  const originalRemoveItem = Storage.prototype.removeItem

  Storage.prototype.setItem = function (key: string, value: string): void {
    originalSetItem.call(this, key, value)

    const nativeKey = MIRRORED_KEYS[key]
    if (this === window.localStorage && nativeKey) {
      enqueuePersistence(() => Preferences.set({ key: nativeKey, value }).then(() => undefined))
    }
  }

  Storage.prototype.removeItem = function (key: string): void {
    originalRemoveItem.call(this, key)

    const nativeKey = MIRRORED_KEYS[key]
    if (this === window.localStorage && nativeKey) {
      enqueuePersistence(() => Preferences.remove({ key: nativeKey }).then(() => undefined))
    }
  }
}

async function bootstrap(): Promise<void> {
  await restoreNativePreferences()
  mirrorWebPreferencesToNativeStorage()
  await import('./main')
}

void bootstrap()
