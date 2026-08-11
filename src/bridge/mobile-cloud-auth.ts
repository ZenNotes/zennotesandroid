import { App as CapApp } from '@capacitor/app'
import { Capacitor, CapacitorHttp } from '@capacitor/core'
import {
  KeychainAccess,
  SecureStorage
} from '@aparajita/capacitor-secure-storage'
import type {
  CloudAccountConnectResult,
  CloudAccountStatus,
  CloudPublishedNote,
  CloudPublishedNoteResult,
  CloudPublishNoteInput,
  CloudServiceAccount,
  CloudSyncVault
} from '@zennotes/bridge-contract/cloud-sync'
import {
  CloudAuthFlow,
  parseCloudAuthCallback,
  type CloudAuthCredential,
  type CloudAuthExchangeRequest,
  type CloudAuthPending,
  type CloudAuthStorage
} from '@zennotes/shared-domain/cloud-auth-flow'
import { createCloudSyncClient } from './cloud-sync-client'

const DEVELOPMENT_CLOUD_BASE_URL = import.meta.env.VITE_ZENNOTES_CLOUD_DEV_URL?.trim()
const DEFAULT_CLOUD_BASE_URL = DEVELOPMENT_CLOUD_BASE_URL || 'https://zennotes.laravel.cloud'
const PENDING_AUTH_KEY = 'pending-auth'
const CREDENTIAL_KEY = 'credential'
const accountListeners = new Set<(status: CloudAccountStatus) => void>()

let authFlow: CloudAuthFlow | null = null
let callbackQueue = Promise.resolve()

const secureStorageReady = Capacitor.isNativePlatform()
  ? Promise.all([
      SecureStorage.setKeyPrefix('zennotes.cloud.'),
      SecureStorage.setSynchronize(false),
      SecureStorage.setDefaultKeychainAccess(KeychainAccess.whenUnlockedThisDeviceOnly)
    ]).then(() => undefined)
  : Promise.resolve()

const storage: CloudAuthStorage = {
  async loadPending(): Promise<unknown> {
    if (!Capacitor.isNativePlatform()) return null
    await secureStorageReady
    return parseStoredJson(await SecureStorage.getItem(PENDING_AUTH_KEY))
  },
  async savePending(pending: CloudAuthPending): Promise<void> {
    assertNativeCloudAuth()
    await secureStorageReady
    await SecureStorage.setItem(PENDING_AUTH_KEY, JSON.stringify(pending))
  },
  async deletePending(): Promise<void> {
    if (!Capacitor.isNativePlatform()) return
    await secureStorageReady
    await SecureStorage.removeItem(PENDING_AUTH_KEY)
  },
  async loadCredential(): Promise<unknown> {
    if (!Capacitor.isNativePlatform()) return null
    await secureStorageReady
    return parseStoredJson(await SecureStorage.getItem(CREDENTIAL_KEY))
  },
  async saveCredential(credential: CloudAuthCredential): Promise<void> {
    assertNativeCloudAuth()
    await secureStorageReady
    await SecureStorage.setItem(CREDENTIAL_KEY, JSON.stringify(credential))
  },
  async deleteCredential(): Promise<void> {
    if (!Capacitor.isNativePlatform()) return
    await secureStorageReady
    await SecureStorage.removeItem(CREDENTIAL_KEY)
  }
}

export async function configureMobileCloudAuth(appVersion: string): Promise<void> {
  if (authFlow) return

  authFlow = new CloudAuthFlow({
    platform: 'android',
    appVersion,
    deviceName: 'ZenNotes Android',
    storage,
    openExternal: openExternalBrowser,
    exchange: exchangeCloudAuthCode,
    allowInsecureLoopback: import.meta.env.DEV,
    allowedInsecureOrigins: DEVELOPMENT_CLOUD_BASE_URL
      ? [DEVELOPMENT_CLOUD_BASE_URL]
      : undefined
  })

  await CapApp.addListener('appUrlOpen', ({ url }) => scheduleAuthCallback(url))
  const launch = await CapApp.getLaunchUrl()
  if (launch?.url) scheduleAuthCallback(launch.url)
}

export async function getMobileCloudAccountStatus(): Promise<CloudAccountStatus> {
  return requireAuthFlow().status()
}

export async function connectMobileCloudAccount(
  baseUrl = DEFAULT_CLOUD_BASE_URL
): Promise<CloudAccountConnectResult> {
  assertNativeCloudAuth()
  const result = await requireAuthFlow().connect(baseUrl)
  await notifyAccountListeners()
  return result
}

export async function logoutMobileCloudAccount(): Promise<CloudAccountStatus> {
  const status = await requireAuthFlow().logout()
  notify(status)
  return status
}

export function onMobileCloudAccountChange(
  listener: (status: CloudAccountStatus) => void
): () => void {
  accountListeners.add(listener)
  return () => accountListeners.delete(listener)
}

export async function getMobileCloudServiceAccount(): Promise<CloudServiceAccount> {
  return (await authenticatedClient()).account().then((response) => response.data)
}

export async function listMobileCloudPublishedNotes(): Promise<CloudPublishedNote[]> {
  return (await authenticatedClient()).listPublishedNotes().then((response) => response.data)
}

export async function publishMobileCloudNote(
  input: CloudPublishNoteInput
): Promise<CloudPublishedNoteResult> {
  return (await authenticatedClient()).publishNote(input)
}

export async function updateMobileCloudPublishedNote(
  shareId: number,
  input: CloudPublishNoteInput
): Promise<CloudPublishedNoteResult> {
  return (await authenticatedClient()).updatePublishedNote(shareId, input)
}

export async function unpublishMobileCloudNote(shareId: number): Promise<void> {
  await (await authenticatedClient()).unpublishNote(shareId)
}

export async function listMobileCloudVaults(): Promise<CloudSyncVault[]> {
  return (await authenticatedClient()).listVaults().then((response) => response.data)
}

export async function authenticatedClient() {
  const credential = await authenticatedCredential()
  return createCloudSyncClient(credential.base_url, credential.token)
}

export async function authenticatedCredential(): Promise<CloudAuthCredential> {
  const credential = await requireAuthFlow().credential()
  if (!credential) throw new Error('Connect ZenNotes Cloud before using sync.')
  return credential
}

function scheduleAuthCallback(rawUrl: string): void {
  const callback = parseCloudAuthCallback(rawUrl)
  if (!callback) return

  callbackQueue = callbackQueue
    .then(async () => {
      const status = await requireAuthFlow().complete(callback)
      notify(status)
    })
    .catch(() => undefined)
}

async function notifyAccountListeners(): Promise<void> {
  notify(await requireAuthFlow().status())
}

function notify(status: CloudAccountStatus): void {
  for (const listener of accountListeners) listener(status)
}

function requireAuthFlow(): CloudAuthFlow {
  if (!authFlow) throw new Error('ZenNotes Cloud is not ready yet.')
  return authFlow
}

function assertNativeCloudAuth(): void {
  if (!Capacitor.isNativePlatform()) {
    throw new Error('ZenNotes Cloud sign-in is only available in the native app.')
  }
}

async function openExternalBrowser(url: string): Promise<void> {
  window.open(url, '_blank', 'noopener,noreferrer')
}

async function exchangeCloudAuthCode(
  baseUrl: string,
  request: CloudAuthExchangeRequest
): Promise<unknown> {
  const response = await CapacitorHttp.post({
    url: `${baseUrl}/api/v1/app/exchange`,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    data: request,
    connectTimeout: 30_000,
    readTimeout: 30_000
  })

  if (response.status < 200 || response.status >= 300) {
    const payload = isRecord(response.data) ? response.data : {}
    const error = isRecord(payload.error) ? payload.error : {}
    const message =
      typeof error.message === 'string'
        ? error.message
        : typeof payload.message === 'string'
          ? payload.message
          : 'ZenNotes Cloud rejected this sign-in request.'
    throw new Error(message)
  }

  return response.data
}

function parseStoredJson(value: string | null): unknown {
  if (value === null) return null
  try {
    return JSON.parse(value) as unknown
  } catch {
    return {}
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object'
}
