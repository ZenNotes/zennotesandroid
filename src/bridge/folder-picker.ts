/**
 * External-folder vault tier (spec 03 "advanced" tier): the user picks any
 * Files-app folder (iCloud Drive, On My iPhone, Working Copy, ...) via the
 * native document picker; a security-scoped bookmark keeps it accessible
 * across launches.
 */
import { registerPlugin } from '@capacitor/core'
import { setStoragePref } from './icloud'

interface FolderPickerPlugin {
  pickFolder(): Promise<{
    cancelled: boolean
    url?: string
    name?: string
    bookmark?: string
  }>
  resolveBookmark(options: {
    bookmark: string
  }): Promise<{ url: string; name: string; bookmark?: string }>
}

export const FolderPicker = registerPlugin<FolderPickerPlugin>('FolderPicker')

const EXTERNAL_KEY = 'zn-mobile:external-vault'

export interface ExternalVaultRef {
  name: string
  bookmark: string
}

export function getExternalVaultRef(): ExternalVaultRef | null {
  try {
    const raw = localStorage.getItem(EXTERNAL_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as ExternalVaultRef
    return parsed.bookmark ? parsed : null
  } catch {
    return null
  }
}

export function setExternalVaultRef(ref: ExternalVaultRef | null): void {
  if (ref) localStorage.setItem(EXTERNAL_KEY, JSON.stringify(ref))
  else localStorage.removeItem(EXTERNAL_KEY)
}

/** Present the picker; on selection persist the bookmark + flip storage. */
export async function pickExternalVault(): Promise<{ url: string; name: string } | null> {
  const result = await FolderPicker.pickFolder()
  if (result.cancelled || !result.url || !result.bookmark) return null
  setExternalVaultRef({ name: result.name ?? 'Vault', bookmark: result.bookmark })
  setStoragePref('external')
  return { url: result.url, name: result.name ?? 'Vault' }
}

/** Re-open the bookmarked folder at boot (refreshing a stale bookmark). */
export async function resolveExternalVault(): Promise<{ url: string; name: string } | null> {
  const ref = getExternalVaultRef()
  if (!ref) return null
  try {
    const resolved = await FolderPicker.resolveBookmark({ bookmark: ref.bookmark })
    if (resolved.bookmark) {
      setExternalVaultRef({ name: resolved.name, bookmark: resolved.bookmark })
    }
    return { url: resolved.url, name: resolved.name }
  } catch {
    return null
  }
}
