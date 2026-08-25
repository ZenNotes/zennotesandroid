import { Preferences } from '@capacitor/preferences'
import { HIDE_STATUS_BAR_KEY, LAYOUT_MODE_KEY } from './viewport'

const WEB_PREFERENCES_KEY = 'zen:prefs:v2'
const NATIVE_PREFERENCES_KEY = 'zn-app-preferences-v2'
// The layout override (#652) rides the same mirror: viewport.ts must read it
// synchronously at boot, and WebView storage alone is not trusted to survive.
const NATIVE_LAYOUT_MODE_KEY = 'zn-layout-mode'
// The fullscreen flag (#22) mirrors for the same durability reason.
const NATIVE_HIDE_STATUS_BAR_KEY = 'zn-hide-status-bar'
const MIRRORED_KEYS: Record<string, string> = {
  [WEB_PREFERENCES_KEY]: NATIVE_PREFERENCES_KEY,
  [LAYOUT_MODE_KEY]: NATIVE_LAYOUT_MODE_KEY,
  [HIDE_STATUS_BAR_KEY]: NATIVE_HIDE_STATUS_BAR_KEY
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

async function restoreNativePreferences(): Promise<void> {
  try {
    const nativePreferences = await Preferences.get({ key: NATIVE_PREFERENCES_KEY })
    const webPreferences = localStorage.getItem(WEB_PREFERENCES_KEY)

    if (nativePreferences.value) {
      localStorage.setItem(WEB_PREFERENCES_KEY, nativePreferences.value)
      applyStoredTheme(nativePreferences.value)
    } else if (webPreferences) {
      await Preferences.set({ key: NATIVE_PREFERENCES_KEY, value: webPreferences })
    }

    const nativeLayout = await Preferences.get({ key: NATIVE_LAYOUT_MODE_KEY })
    const webLayout = localStorage.getItem(LAYOUT_MODE_KEY)
    if (nativeLayout.value) {
      localStorage.setItem(LAYOUT_MODE_KEY, nativeLayout.value)
    } else if (webLayout) {
      await Preferences.set({ key: NATIVE_LAYOUT_MODE_KEY, value: webLayout })
    }

    const nativeStatusBar = await Preferences.get({ key: NATIVE_HIDE_STATUS_BAR_KEY })
    const webStatusBar = localStorage.getItem(HIDE_STATUS_BAR_KEY)
    if (nativeStatusBar.value) {
      localStorage.setItem(HIDE_STATUS_BAR_KEY, nativeStatusBar.value)
    } else if (webStatusBar) {
      await Preferences.set({ key: NATIVE_HIDE_STATUS_BAR_KEY, value: webStatusBar })
    }
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
