/**
 * External-folder vault tier (spec 03 "advanced" tier): the user picks any
 * Files-app folder (iCloud Drive, On My iPhone, Working Copy, ...) via the
 * native document picker; a security-scoped bookmark keeps it accessible
 * across launches.
 *
 * Diverges from the iPhone shell (issue zennotes#584): Android keeps a
 * registry of every picked folder, not a single slot — SAF happily holds
 * hundreds of persisted tree grants, so nothing forces the one-bookmark
 * limit the iOS spec started with. The legacy single-ref key survives as
 * the "current external vault" pointer, which also migrates old installs.
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

const EXTERNAL_KEY = 'zn-mobile:external-vault' // current pointer (legacy slot)
const EXTERNAL_LIST_KEY = 'zn-mobile:external-vaults' // every known folder vault

export interface ExternalVaultRef {
  name: string
  bookmark: string
}

function readRef(raw: string | null): ExternalVaultRef | null {
  try {
    if (!raw) return null
    const parsed = JSON.parse(raw) as ExternalVaultRef
    return parsed.bookmark ? parsed : null
  } catch {
    return null
  }
}

/** Every folder vault the user has picked, oldest first. Seeds itself from
 *  the legacy single-slot key so pre-registry installs keep their vault. */
export function getExternalVaultRefs(): ExternalVaultRef[] {
  try {
    const raw = localStorage.getItem(EXTERNAL_LIST_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as ExternalVaultRef[]
      if (Array.isArray(parsed)) return parsed.filter((r) => r && r.bookmark)
    }
  } catch {
    // fall through to the legacy slot
  }
  const legacy = readRef(localStorage.getItem(EXTERNAL_KEY))
  const seeded = legacy ? [legacy] : []
  saveExternalVaultRefs(seeded)
  return seeded
}

function saveExternalVaultRefs(refs: ExternalVaultRef[]): void {
  localStorage.setItem(EXTERNAL_LIST_KEY, JSON.stringify(refs))
}

/** Add or refresh a registry entry, keyed by its bookmark URI. */
export function upsertExternalVaultRef(ref: ExternalVaultRef): void {
  const refs = getExternalVaultRefs()
  const at = refs.findIndex((r) => r.bookmark === ref.bookmark)
  if (at >= 0) refs[at] = ref
  else refs.push(ref)
  saveExternalVaultRefs(refs)
}

/** Drop a folder from the registry (its files are untouched). Clears the
 *  current pointer too when it named this folder. */
export function removeExternalVaultRef(bookmark: string): void {
  saveExternalVaultRefs(getExternalVaultRefs().filter((r) => r.bookmark !== bookmark))
  const current = getExternalVaultRef()
  if (current?.bookmark === bookmark) localStorage.removeItem(EXTERNAL_KEY)
}

/** The external vault that is (or was last) open — boot resolves this one. */
export function getExternalVaultRef(): ExternalVaultRef | null {
  return readRef(localStorage.getItem(EXTERNAL_KEY))
}

export function setExternalVaultRef(ref: ExternalVaultRef | null): void {
  if (ref) {
    // Register before repointing: on pre-registry installs the first read
    // seeds the list from the legacy slot, which must still hold the OLD
    // vault at that moment or it would be forgotten.
    upsertExternalVaultRef(ref)
    localStorage.setItem(EXTERNAL_KEY, JSON.stringify(ref))
  } else {
    localStorage.removeItem(EXTERNAL_KEY)
  }
}

/** Present the picker; on selection register the folder + flip storage. */
export async function pickExternalVault(): Promise<{ url: string; name: string } | null> {
  const result = await FolderPicker.pickFolder()
  if (result.cancelled || !result.url || !result.bookmark) return null
  setExternalVaultRef({ name: result.name ?? 'Vault', bookmark: result.bookmark })
  setStoragePref('external')
  return { url: result.url, name: result.name ?? 'Vault' }
}

/** Re-open a bookmarked folder (the current one when no bookmark is given),
 *  refreshing its stored name if the folder was renamed on disk. */
export async function resolveExternalVault(
  bookmark?: string
): Promise<{ url: string; name: string; bookmark: string } | null> {
  const target = bookmark ?? getExternalVaultRef()?.bookmark
  if (!target) return null
  try {
    const resolved = await FolderPicker.resolveBookmark({ bookmark: target })
    const fresh = { name: resolved.name, bookmark: resolved.bookmark ?? target }
    upsertExternalVaultRef(fresh)
    if (getExternalVaultRef()?.bookmark === target) {
      localStorage.setItem(EXTERNAL_KEY, JSON.stringify(fresh))
    }
    return { url: resolved.url, name: fresh.name, bookmark: fresh.bookmark }
  } catch {
    return null
  }
}
