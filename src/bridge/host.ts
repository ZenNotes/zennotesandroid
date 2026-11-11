/**
 * This app's side of @zennotes/portable-vault: the Capacitor plugins behind
 * the package's host interfaces. The vault layer and Cloud glue this repo
 * used to carry as src/bridge/ copies (shared, by hand, with the iPhone
 * shell) are the package's now; what is left here is what only Android does.
 * Where vaults live (app storage, a picked SAF folder) is mobile-bridge.ts's,
 * which adds `vaults` and installs the whole host.
 *
 * Storage identity is byte for byte what the copies used, so an update finds
 * everything an older build wrote: Cloud state as UTF-8 files in
 * Directory.Data under the package's `zennotes-cloud-sync/` keys, remote
 * profiles in Capacitor Preferences, secrets in the Keystore-backed secure
 * storage under the `zennotes.cloud.` prefix, the account key named by a
 * fingerprint of the account ('hashed').
 */
import { App as CapApp } from '@capacitor/app'
import { Capacitor, CapacitorHttp, type HttpOptions } from '@capacitor/core'
import { Clipboard } from '@capacitor/clipboard'
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import { Preferences } from '@capacitor/preferences'
import { Share } from '@capacitor/share'
import { KeychainAccess, SecureStorage } from '@aparajita/capacitor-secure-storage'
import type { ZenAppInfo } from '@zennotes/bridge-contract/bridge'
import { CLOUD_CONNECT_TIMEOUT_MS, CLOUD_STALL_TIMEOUT_MS } from '@zennotes/shared-domain/cloud-sync-stall'
import { isNotFoundError } from '@zennotes/portable-vault/fs-errors'
import type {
  AppLifecycle,
  HostShell,
  HostStorage,
  HttpTransport,
  PortableHost,
  SecretStorage
} from '@zennotes/portable-vault/host'
import { userCertificateConnectionHint } from '@zennotes/portable-vault/remote-client'
import { randomUUID } from '@zennotes/portable-vault/uuid'
import { waitAtBoot } from '../boot-wait'
import { isPhoneDevice } from '../viewport'
import { leaveApp, returnToApp } from './background-sync'
import { putFile } from './native-fs'

/**
 * The shipped version, read from the native app (versionName) at boot. The
 * literal is only the fallback for `npm run dev` in a plain browser, where
 * there is no native app to ask; the package reads appInfo() per call, so
 * nothing captures it before the native answer lands.
 */
let appVersion = '1.1.58'

export async function loadNativeAppVersion(): Promise<string> {
  try {
    // Bounded (boot-wait.ts): a late answer is dropped, so the version stays
    // the fallback Cloud sign-in is configured with.
    const info = await waitAtBoot('the app version', CapApp.getInfo())
    if (info.inTime && info.value.version) appVersion = info.value.version
  } catch {
    // No native layer (browser dev server): keep the fallback.
  }
  return appVersion
}

function appInfo(): ZenAppInfo {
  return {
    name: 'zennotes-android',
    productName: 'ZenNotes',
    version: appVersion,
    description: 'ZenNotes for Android',
    homepage: 'https://zennotes.org',
    runtime: 'web',
    hostKind: 'android',
    // The WebView's user agent names the Android version, the device model
    // and the Chrome build, the lines a bug report from a phone needs beside
    // the app version (#814); nothing else here is guessed.
    ...(typeof navigator !== 'undefined' && navigator.userAgent ? { engine: navigator.userAgent } : {})
  }
}

const shell: HostShell = {
  appInfo,
  // 'android' (with hostKind above) lets app-core tell native shells apart;
  // core only special-cases 'darwin', so Android still gets Ctrl-based keymaps
  // and no Mac-only chrome, the right defaults for hardware keyboards.
  platform: 'android',
  // WebView-safe system families plus the fonts the shell bundles itself
  // (public/fonts + index.html @font-face): Android offers no way to install
  // fonts app-wide, so shipping them is the only path to real choices here.
  listSystemFonts: async () => [
    'Cutive Mono',
    'Droid Sans Mono',
    'Georgia',
    'Noto Sans',
    'Noto Serif',
    'Roboto',
    'Roboto Serif',
    'Ubuntu Sans',
    'Ubuntu Sans Mono',
    'monospace',
    'sans-serif',
    'serif'
  ],
  updatesMessage: 'Updates are delivered through Google Play.',
  unavailableWhere: 'in the mobile app',
  // Drawings are view-only on a phone (spec 06 defers touch drawing). The
  // device decides, as on the iPhone, not the layout: a phone switched to the
  // desktop layout still has a phone's screen, and a tablet in the phone
  // layout still has room to draw.
  drawingsViewOnly: () => isPhoneDevice(),
  writeClipboard: async (text) => {
    await Clipboard.write({ string: text })
  },
  async saveDownload({ url, headers, fileName, title, connectTimeout, readTimeout }) {
    const path = `zennotes-cloud-backups/${randomUUID()}/${fileName}`
    await Filesystem.downloadFile({ url, path, directory: Directory.Cache, recursive: true, headers, connectTimeout, readTimeout })
    const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache })
    try {
      await Share.share({ title, files: [uri] })
    } catch (error) {
      if (!/cancel/i.test(error instanceof Error ? error.message : String(error))) throw error
    }
  },
  remoteConnectionHint: (baseUrl) => userCertificateConnectionHint(baseUrl),
  cloud: {
    platform: 'android',
    deviceName: 'ZenNotes Android',
    developmentBaseUrl: import.meta.env.VITE_ZENNOTES_CLOUD_DEV_URL,
    allowInsecureLoopback: import.meta.env.DEV,
    accountKeyScheme: 'hashed'
  }
}

const lifecycle: AppLifecycle = {
  async onOpenUrl(listener) {
    await CapApp.addListener('appUrlOpen', ({ url }) => listener(url))
  },
  async launchUrl() {
    return (await CapApp.getLaunchUrl())?.url ?? null
  },
  async onActiveChange(listener) {
    await CapApp.addListener('appStateChange', ({ isActive }) => listener(isActive))
  },
  // Leaving stops Cloud requests, after a final sync when background sync is
  // on (background-sync.ts, which stops the package's own request lifetime).
  leftApp: () => leaveApp(),
  returnedToApp: () => returnToApp()
}

const http: HttpTransport = {
  request: (options) => CapacitorHttp.request(options as HttpOptions),
  // Every object-storage PUT goes through ZenDirectUpload.put, in-memory
  // bodies included, as it always has here.
  putFile: (options) => putFile(options),
  putsInMemoryBodies: true,
  // Android's read timeout starts over with every byte that arrives, so it
  // is how long a request may go silent, not how long it may take: a big
  // page on a slow link keeps going as long as bytes move. A request that
  // waits on the service's own work says so in timeoutMs.
  cloudTimeouts: ({ timeoutMs }) => ({
    connectTimeout: CLOUD_CONNECT_TIMEOUT_MS,
    readTimeout: timeoutMs ?? CLOUD_STALL_TIMEOUT_MS
  })
}

/** Cloud link, sync state and scan cache: UTF-8 files in Directory.Data. */
const storage: HostStorage = {
  async read(key) {
    try {
      const result = await Filesystem.readFile({ path: key, directory: Directory.Data, encoding: Encoding.UTF8 })
      return typeof result.data === 'string' ? result.data : await result.data.text()
    } catch (error) {
      // Only a verified not-found reads as "no link / no state".
      if (isNotFoundError(error)) return null
      throw error
    }
  },
  async write(key, value) {
    await Filesystem.writeFile({ path: key, directory: Directory.Data, encoding: Encoding.UTF8, data: value, recursive: true })
  },
  async remove(key) {
    try {
      await Filesystem.deleteFile({ path: key, directory: Directory.Data })
    } catch (error) {
      if (!isNotFoundError(error)) throw error
    }
  }
}

/** Saved self-hosted profiles and the workspace mode: Capacitor Preferences. */
const preferences: HostStorage = {
  read: async (key) => (await Preferences.get({ key })).value,
  write: async (key, value) => {
    await Preferences.set({ key, value })
  },
  remove: async (key) => {
    await Preferences.remove({ key })
  }
}

const PREFIX = 'zennotes.cloud.'
const LEGACY_PREFIX = 'capacitor-storage_'
const AUTH_KEYS = ['credential', 'pending-auth']

async function configureSecureStorage(): Promise<void> {
  // The Capacitor proxy loads its implementation lazily. Parallel first
  // calls can initialize separate instances and lose the configured prefix;
  // the package runs this once, behind its ready gate, before any read.
  await SecureStorage.setKeyPrefix(PREFIX)
  await SecureStorage.setSynchronize(false)
  await SecureStorage.setDefaultKeychainAccess(KeychainAccess.whenUnlockedThisDeviceOnly)
  await migrateAuthStoragePrefix()
}

export async function migrateAuthStoragePrefix(): Promise<void> {
  const canonical = new Map<string, string | null>()
  for (const key of AUTH_KEYS) canonical.set(key, await SecureStorage.getItem(key))

  // Affected builds could persist auth under the plugin's default prefix.
  // All storage callers await setup, so none can see this temporary prefix.
  // CloudAuthFlow still validates every recovered record before using it.
  try {
    await SecureStorage.setKeyPrefix(LEGACY_PREFIX)
    const legacy = new Map<string, string>()
    for (const key of AUTH_KEYS) {
      const value = await SecureStorage.getItem(key)
      if (value !== null) legacy.set(key, value)
    }
    await SecureStorage.setKeyPrefix(PREFIX)
    for (const [key, value] of legacy) {
      if (canonical.get(key) === null) await SecureStorage.setItem(key, value)
    }
    // Remove superseded records as well, so logout cannot resurrect an older
    // credential on the next launch. Copying must finish before removal.
    await SecureStorage.setKeyPrefix(LEGACY_PREFIX)
    for (const key of legacy.keys()) await SecureStorage.removeItem(key)
  } finally {
    await SecureStorage.setKeyPrefix(PREFIX)
  }
}

/** The credential, the pending sign-in and the account key: the Keystore. */
const secrets: SecretStorage = {
  available: () => Capacitor.isNativePlatform(),
  prepare: () => configureSecureStorage(),
  get: (key) => SecureStorage.getItem(key),
  set: async (key, value) => {
    await SecureStorage.setItem(key, value)
  },
  remove: async (key) => {
    await SecureStorage.removeItem(key)
  },
  keys: () => SecureStorage.keys()
}

/** Everything but `vaults`, which mobile-bridge.ts adds with the tiers. */
export const androidHost: Omit<PortableHost, 'vaults'> = {
  shell,
  lifecycle,
  http,
  storage,
  preferences,
  secrets
}
