/**
 * Shell-local note/folder pinning for the Browse drawer (Discord feedback,
 * 2026-08-17: "Notes can't be pinned. Maybe it can be extended to folders as
 * well."). App-core has no note-level pin concept (tab.pin and the pinned
 * reference pane are different things), so this is a mobile-shell feature:
 * pinned items sort to the top of their drawer group and carry a pin glyph.
 *
 * State lives in Capacitor Preferences directly — NOT localStorage — so
 * WebView storage eviction can't drop it (the 1.1.3 theme-reset lesson), and
 * NOT inside app-core's `zen:prefs:v2` blob, whose normalizer strips keys it
 * doesn't know. Pins are keyed per vault root; paths are vault-relative note
 * paths and inbox-relative folder subpaths, exactly as the drawer already
 * addresses rows. A pin whose path no longer exists simply never matches a
 * row — harmless — and is pruned the next time something in that vault is
 * toggled.
 */
import { useSyncExternalStore } from 'react'
import { Preferences } from '@capacitor/preferences'

const STORE_KEY = 'zn-mobile-pins-v1'

interface VaultPins {
  notes: string[]
  folders: string[]
}

type PinsFile = Record<string, VaultPins>

const EMPTY: VaultPins = { notes: [], folders: [] }

let file: PinsFile = {}
let loaded = false
const subscribers = new Set<() => void>()
// Snapshot cache per vault key — useSyncExternalStore needs a stable
// reference while nothing changed.
const snapshots = new Map<string, VaultPins>()

function notify(): void {
  for (const cb of subscribers) cb()
}

function sanitize(v: unknown): VaultPins | null {
  if (typeof v !== 'object' || v === null) return null
  const notes = (v as VaultPins).notes
  const folders = (v as VaultPins).folders
  if (!Array.isArray(notes) || !Array.isArray(folders)) return null
  return {
    notes: notes.filter((p): p is string => typeof p === 'string'),
    folders: folders.filter((p): p is string => typeof p === 'string')
  }
}

/** Load once at shell mount; safe to await multiple times. */
export async function loadPins(): Promise<void> {
  if (loaded) return
  loaded = true
  try {
    const raw = (await Preferences.get({ key: STORE_KEY })).value
    if (!raw) return
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null) return
    const next: PinsFile = {}
    for (const [vault, pins] of Object.entries(parsed)) {
      const clean = sanitize(pins)
      if (clean && (clean.notes.length || clean.folders.length)) next[vault] = clean
    }
    file = next
    snapshots.clear()
    notify()
  } catch {
    // Unreadable pin state is not worth surfacing — start empty.
  }
}

function persist(): void {
  void Preferences.set({ key: STORE_KEY, value: JSON.stringify(file) }).catch(() => {})
}

function pinsFor(vaultKey: string | null): VaultPins {
  if (!vaultKey) return EMPTY
  return file[vaultKey] ?? EMPTY
}

export function isNotePinned(vaultKey: string | null, path: string): boolean {
  return pinsFor(vaultKey).notes.includes(path)
}

/** Non-reactive read (gesture handlers). */
export function getPinnedNotes(vaultKey: string | null): readonly string[] {
  return pinsFor(vaultKey).notes
}

export function isFolderPinned(vaultKey: string | null, subpath: string): boolean {
  return pinsFor(vaultKey).folders.includes(subpath)
}

function toggle(
  vaultKey: string,
  kind: keyof VaultPins,
  path: string,
  livePaths?: readonly string[]
): void {
  const cur = pinsFor(vaultKey)
  const had = cur[kind].includes(path)
  const next: VaultPins = {
    notes: [...cur.notes],
    folders: [...cur.folders]
  }
  next[kind] = had ? next[kind].filter((p) => p !== path) : [...next[kind], path]
  // Opportunistic prune: drop pins for paths that no longer exist in the
  // vault (renames/moves/deletes orphan them silently).
  if (livePaths) {
    const live = new Set(livePaths)
    live.add(path)
    next[kind] = next[kind].filter((p) => live.has(p))
  }
  if (next.notes.length || next.folders.length) file = { ...file, [vaultKey]: next }
  else {
    const { [vaultKey]: _drop, ...rest } = file
    file = rest
  }
  snapshots.delete(vaultKey)
  persist()
  notify()
}

export function toggleNotePin(
  vaultKey: string,
  path: string,
  livePaths?: readonly string[]
): void {
  toggle(vaultKey, 'notes', path, livePaths)
}

export function toggleFolderPin(
  vaultKey: string,
  subpath: string,
  livePaths?: readonly string[]
): void {
  toggle(vaultKey, 'folders', subpath, livePaths)
}

/** Reactive pins for a vault; stable snapshot while nothing changes. */
export function usePins(vaultKey: string | null): VaultPins {
  return useSyncExternalStore(
    (cb) => {
      subscribers.add(cb)
      return () => subscribers.delete(cb)
    },
    () => {
      if (!vaultKey) return EMPTY
      let snap = snapshots.get(vaultKey)
      if (!snap) {
        const cur = file[vaultKey]
        snap = cur ? { notes: [...cur.notes], folders: [...cur.folders] } : EMPTY
        snapshots.set(vaultKey, snap)
      }
      return snap
    }
  )
}
