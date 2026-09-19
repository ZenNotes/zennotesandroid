/**
 * The phone's note options: one bottom sheet for every note row on the
 * phone — the drawer's rows, app-core's Home / Quick Notes / Tags lists and
 * the Archive / Trash views — opened by a long-press (MobileDrawer's rows,
 * note-row-gestures.ts for app-core's) so "long-press a note, see its
 * options" holds everywhere (Adib, 2026-09-08). The sheet used to live
 * inside the drawer; it moved here so the app-core lists could share it, and
 * the drawer's swipe actions go through the same helpers.
 *
 * Ported from the iPhone shell (note-actions.tsx there); only the pin key
 * differs.
 *
 * Kinds: 'note' mirrors the ••• sheet (Pin, Favorite, Rename, Move to…,
 * Copy wikilink, Archive, Delete); 'archived' is Restore / Delete; 'trashed'
 * is Restore / Delete permanently, the sets app-core's own views expose on
 * desktop. Pin is this phone's own list order; Favorite is the vault's list
 * (vault.json), the one Home and the desktop sidebar show, which a phone can
 * otherwise only reach through the ••• sheet's palette command (#810).
 * Prompts and confirms overlay whatever is open (Modal layers above the
 * drawer and the sheet), and the lists refresh in place via the vault
 * change events every mutating bridge call emits.
 */
import React, { useSyncExternalStore } from 'react'
import { Keyboard } from '@capacitor/keyboard'
import { getShellSnapshot, useShellSnapshot } from '@zennotes/app-core/shell'
import { requestRenameNote, requestMoveNote, requestArchiveNote, requestTrashNote,
  restoreNote as restoreCoreNote, requestDeleteNotePermanently, requestToggleNoteFavorite,
  type NoteActionHost } from '@zennotes/app-core/notes'
import { captureMobileWorkspace, reportActionError } from './workspace-context'
import { getPinnedNotes, toggleNotePin, usePins } from './pins'
import { SheetHandle } from './SheetHandle'

export type NoteRowKind = 'note' | 'archived' | 'trashed'

export interface NoteMenuTarget {
  path: string
  title: string
  kind: NoteRowKind
}

const s = getShellSnapshot

/** Pins are keyed by the vault root on Android (pins.ts, same as the drawer). */
const vaultKey = (): string | null => s().vault?.root ?? null

// ---------------------------------------------------------------------------
// Sheet state (module-wide, like sheet-state.ts, so any surface can summon it)
// ---------------------------------------------------------------------------

let current: (NoteMenuTarget & { host: NoteActionHost }) | null = null
const subscribers = new Set<() => void>()

function notify(): void {
  for (const cb of subscribers) cb()
}

export function openNoteMenu(target: NoteMenuTarget, host = captureMobileWorkspace()): void {
  if (!host.isCurrent()) return
  current = { ...target, host }
  // Summoned over a live editing session the keyboard would stay up under
  // the sheet (same treatment as sheet-state / drawer-state).
  ;(document.activeElement as HTMLElement | null)?.blur?.()
  void Keyboard.hide().catch(() => {})
  notify()
}

export function closeNoteMenu(): void {
  if (current === null) return
  current = null
  notify()
}

export function isNoteMenuOpen(): boolean {
  return current !== null
}

function useNoteMenu(): typeof current {
  return useSyncExternalStore(
    (cb) => {
      subscribers.add(cb)
      return () => subscribers.delete(cb)
    },
    () => current
  )
}

// ---------------------------------------------------------------------------
// Actions (shared by the sheet, the drawer's SwipeRow and note-row-gestures)
// ---------------------------------------------------------------------------

export function isNotePinned(path: string): boolean {
  return getPinnedNotes(vaultKey()).includes(path)
}

export function pinNote(path: string): void {
  const key = vaultKey()
  if (!key) return
  toggleNotePin(
    key,
    path,
    s().notes.map((n) => n.path)
  )
}

export function isNoteFavorite(path: string): boolean {
  return s().favorites.includes(path)
}

export function favoriteNote(path: string, host = captureMobileWorkspace()): void {
  void requestToggleNoteFavorite(host, path).catch(reportActionError)
}

export function renameNote(path: string, _title: string, host = captureMobileWorkspace()): void {
  void requestRenameNote(host, path).catch(reportActionError)
}
export function moveNote(path: string, host = captureMobileWorkspace()): void {
  void requestMoveNote(host, path).catch(reportActionError)
}
export function copyWikilink(title: string): void {
  void navigator.clipboard.writeText(`[[${title}]]`).catch(() => {})
}
export function archiveNote(path: string, host = captureMobileWorkspace()): void {
  void requestArchiveNote(host, path).catch(reportActionError)
}
export function trashNote(path: string, _title: string, host = captureMobileWorkspace()): void {
  void requestTrashNote(host, path).catch(reportActionError)
}
export function restoreNote(path: string, _from: 'archived' | 'trashed', host = captureMobileWorkspace()): void {
  void restoreCoreNote(host, path).catch(reportActionError)
}
export function deleteNoteForever(path: string, _title: string, host = captureMobileWorkspace()): void {
  void requestDeleteNotePermanently(host, path).catch(reportActionError)
}

// ---------------------------------------------------------------------------
// The sheet
// ---------------------------------------------------------------------------

const D = {
  pin: 'M12 17v5M9 3h6l-1 7 3 2v3H7v-3l3-2-1-7z',
  star: 'M12 3l2.7 6.2 6.8.6-5.1 4.5 1.5 6.7L12 17.5 6.1 21l1.5-6.7L2.5 9.8l6.8-.6z',
  rename: 'M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z',
  move: 'M5 8V6a2 2 0 012-2h3l2 2h7a2 2 0 012 2v10a2 2 0 01-2 2H7a2 2 0 01-2-2v-4M2 13h9m0 0l-3-3m3 3l-3 3',
  link: 'M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71',
  archive: 'M21 8v13H3V8M1 3h22v5H1zM10 12h4',
  trash: 'M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6',
  restore: 'M3 12a9 9 0 109-9 9 9 0 00-6.36 2.64L3 8M3 3v5h5'
}

function Icon({ d }: { d: string }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  )
}

interface SheetRow {
  label: string
  icon: string
  danger?: boolean
  run: () => void
}

function rowsFor(
  target: NoteMenuTarget & { host: NoteActionHost },
  pinned: boolean,
  favorite: boolean
): SheetRow[] {
  const { path, title, kind, host } = target
  if (kind === 'archived') {
    return [
      { label: 'Restore', icon: D.restore, run: () => restoreNote(path, 'archived', host) },
      { label: 'Delete', icon: D.trash, danger: true, run: () => trashNote(path, title, host) }
    ]
  }
  if (kind === 'trashed') {
    return [
      { label: 'Restore', icon: D.restore, run: () => restoreNote(path, 'trashed', host) },
      {
        label: 'Delete permanently',
        icon: D.trash,
        danger: true,
        run: () => deleteNoteForever(path, title, host)
      }
    ]
  }
  return [
    { label: pinned ? 'Unpin' : 'Pin', icon: D.pin, run: () => { if (host.isCurrent()) pinNote(path) } },
    {
      label: favorite ? 'Remove from Favorites' : 'Add to Favorites',
      icon: D.star,
      run: () => favoriteNote(path, host)
    },
    { label: 'Rename', icon: D.rename, run: () => renameNote(path, title, host) },
    { label: 'Move to…', icon: D.move, run: () => moveNote(path, host) },
    { label: 'Copy wikilink', icon: D.link, run: () => copyWikilink(title) },
    { label: 'Archive', icon: D.archive, run: () => archiveNote(path, host) },
    { label: 'Delete', icon: D.trash, danger: true, run: () => trashNote(path, title, host) }
  ]
}

/** Mounted once by the shell root; renders nothing until openNoteMenu. */
export function NoteActionSheet(): React.JSX.Element | null {
  const target = useNoteMenu()
  const pins = usePins(vaultKey())
  const favorites = useShellSnapshot().favorites
  if (!target) return null
  const rows = rowsFor(target, pins.notes.includes(target.path), favorites.includes(target.path))
  return (
    <>
      <div className="zn-mobile-sheet-backdrop" onClick={closeNoteMenu} role="presentation" />
      {/* data-ctx-menu: app-core's isAppOverlayOpen() marker for its context
          menus. While the sheet is up, app-core's focus "heal" (App.tsx, on
          window focus — which a native long-press on the drawer triggers)
          must not pull focus back into the editor and raise the keyboard
          under the sheet, and the list views' keyboard shortcuts must not
          fire through it — exactly what the marker gates for its own menus. */}
      <div className="zn-mobile-sheet" role="menu" aria-label="Note actions" data-ctx-menu="">
        <SheetHandle onDismiss={closeNoteMenu} />
        <div className="zn-mobile-sheet-title zn-truncate">{target.title}</div>
        <div className="zn-mobile-sheet-scroll">
          <div className="zn-mobile-sheet-group">
            {rows.map((row) => (
              <button
                key={row.label}
                type="button"
                className={`zn-mobile-sheet-row${row.danger ? ' zn-danger' : ''}`}
                onClick={() => {
                  closeNoteMenu()
                  row.run()
                }}
              >
                <Icon d={row.icon} />
                {row.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  )
}
