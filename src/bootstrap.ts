import { Preferences } from '@capacitor/preferences'

const WEB_PREFERENCES_KEY = 'zen:prefs:v2'
const NATIVE_PREFERENCES_KEY = 'zn-app-preferences-v2'

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
  } catch {
    // Continue with WebView storage when native preferences are unavailable.
  }
}

function mirrorWebPreferencesToNativeStorage(): void {
  const originalSetItem = Storage.prototype.setItem
  const originalRemoveItem = Storage.prototype.removeItem

  Storage.prototype.setItem = function (key: string, value: string): void {
    originalSetItem.call(this, key, value)

    if (this === window.localStorage && key === WEB_PREFERENCES_KEY) {
      enqueuePersistence(() =>
        Preferences.set({ key: NATIVE_PREFERENCES_KEY, value }).then(() => undefined)
      )
    }
  }

  Storage.prototype.removeItem = function (key: string): void {
    originalRemoveItem.call(this, key)

    if (this === window.localStorage && key === WEB_PREFERENCES_KEY) {
      enqueuePersistence(() =>
        Preferences.remove({ key: NATIVE_PREFERENCES_KEY }).then(() => undefined)
      )
    }
  }
}

async function bootstrap(): Promise<void> {
  await restoreNativePreferences()
  mirrorWebPreferencesToNativeStorage()
  await import('./main')
}

void bootstrap()
