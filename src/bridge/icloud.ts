/**
 * iCloud Drive vault tier (spec 03): the vault directory lives in the app's
 * ubiquity container and the OS syncs it. This module wraps the native
 * ICloudVault plugin and owns the storage preference. Enabling MOVES the
 * local vault into iCloud (Apple's setUbiquitous migration) — a vault is
 * either local or iCloud, never both (running two sync systems on one vault
 * is a documented Obsidian corruption class).
 */
import { registerPlugin } from '@capacitor/core'
import { Filesystem } from '@capacitor/filesystem'
import { VAULTS_DIR, vaultsRoot } from './native-fs'

export interface ICloudStatus {
  available: boolean
  /** file:// URL of the iCloud `.../Documents/ZenNotes` folder. */
  rootUrl?: string
  vaults?: string[]
}

interface ICloudVaultPlugin {
  status(): Promise<ICloudStatus>
  enable(options: { localPath: string; name: string }): Promise<{ url: string; adopted: boolean }>
  disable(options: { name: string; localPath: string }): Promise<{ path: string }>
  ensureDownloaded(options: { url: string; timeoutMs?: number }): Promise<{ pending: number }>
}

export const ICloudVault = registerPlugin<ICloudVaultPlugin>('ICloudVault')

const STORAGE_KEY = 'zn-mobile:storage'

export type VaultStorage = 'local' | 'icloud' | 'external'

export function getStoragePref(): VaultStorage {
  const raw = localStorage.getItem(STORAGE_KEY)
  return raw === 'icloud' || raw === 'external' ? raw : 'local'
}

export function setStoragePref(next: VaultStorage): void {
  localStorage.setItem(STORAGE_KEY, next)
}

export async function icloudStatus(): Promise<ICloudStatus> {
  try {
    return await ICloudVault.status()
  } catch {
    return { available: false }
  }
}

/** Bounded wait for evicted `.icloud` stubs below `url` to materialize. */
export async function ensureDownloaded(url: string, timeoutMs = 20000): Promise<number> {
  try {
    const { pending } = await ICloudVault.ensureDownloaded({ url, timeoutMs })
    return pending
  } catch {
    return 0
  }
}

/** POSIX path of a local vault (for setUbiquitous), e.g. before migration. */
export async function localVaultPath(name: string): Promise<string> {
  const { uri } = await Filesystem.getUri({ directory: vaultsRoot(), path: VAULTS_DIR })
  return `${decodeURIComponent(uri.replace('file://', ''))}/${name}`
}

/** Move the named local vault into iCloud and flip the storage pref. */
export async function enableICloud(name: string): Promise<{ adopted: boolean }> {
  const status = await ICloudVault.status()
  if (!status.available) {
    throw new Error('iCloud is not available. Sign in to iCloud and turn on iCloud Drive.')
  }
  const localPath = await localVaultPath(name)
  const result = await ICloudVault.enable({ localPath, name })
  setStoragePref('icloud')
  return { adopted: result.adopted }
}

/** Move the named iCloud vault back to this device and flip the pref. */
export async function disableICloud(name: string): Promise<void> {
  const localPath = await localVaultPath(name)
  await ICloudVault.disable({ name, localPath })
  setStoragePref('local')
}
