/**
 * Mobile-only chrome layered over the shared app-core UI (spec 07): bottom
 * navigation (capture is the hero action), an iOS-style action sheet that
 * reuses the shared command registry, drawer behavior for the sidebar, and a
 * "mobilizer" that turns the desktop two-pane Settings dialog into a paged
 * full-screen flow. Rendered into its own React root so app-core stays
 * untouched; state is driven through the shared Zustand store.
 */
import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { Haptics, ImpactStyle } from '@capacitor/haptics'
import { Keyboard } from '@capacitor/keyboard'
import { useStore } from '@zennotes/app-core/store'
import type { TaskMutation } from '@zennotes/app-core/store'
import type { VaultTask } from '@shared/tasks'
import { toIsoDateLocal } from '@shared/tasks'
import { buildCommands } from '@zennotes/app-core/lib/commands'
import { findLeaf, updateLeaf } from '@zennotes/app-core/lib/pane-layout'
import {
  paneModeForPath,
  paneModesWithPathMode,
  requestPaneMode
} from '@zennotes/app-core/lib/pane-mode'
import {
  isSameFileHeadingLink,
  resolveWikilinkTarget,
  wikilinkHeadingAnchor
} from '@zennotes/app-core/lib/wikilinks'
import {
  openDatabaseFromWikilink,
  openWikilinkHeading
} from '@zennotes/app-core/lib/wikilink-navigation'
import { MobileEditorToolbar } from './EditorToolbar'
import { promptApp } from '@zennotes/app-core/lib/prompt-requests'
import { confirmApp } from '@zennotes/app-core/lib/confirm-requests'
import { notePathWithinFolder } from '@zennotes/app-core/lib/vault-layout'
import { csvPathFromDatabaseTab, formDirFromCsvPath } from '@zennotes/shared-domain/databases'
import { MobileDrawer } from './MobileDrawer'
import { isDrawerOpen, setDrawerOpen, useDrawerOpen } from './drawer-state'
import { goHome } from './nav'
import { useYouTubeLiteEmbeds } from './youtube-embed-shim'
import { VaultsSheet, promptNewVault } from './MobileDrawer'
import { listSwitchableVaults, type MobileVaultEntry } from '../bridge/mobile-bridge'
import { closeMobileSheet, openMobileSheet, useMobileSheet } from './sheet-state'
import { WELCOME_PENDING_KEY, FAB_HINT_KEY } from './Onboarding'
import { WELCOME_NOTE_PATH } from '../bridge/welcome-note'
import ensoUrl from '../assets/enso.png'
import { getStoragePref } from '../bridge/icloud'

const PHONE_BREAKPOINT = 768

function isPhoneWidth(): boolean {
  return window.innerWidth < PHONE_BREAKPOINT
}

/** Run a command from the shared registry by id (same path the palette uses). */
function runCommand(id: string): void {
  const cmd = buildCommands({ includeUnavailable: true }).find((c) => c.id === id)
  if (!cmd) return
  if (cmd.when && !cmd.when()) return
  void cmd.run()
}

function Icon({ d, filled }: { d: string; filled?: boolean }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  )
}

const ICONS = {
  sidebar: 'M3 5.5h18M3 12h18M3 18.5h12',
  back: 'M14.5 5l-7 7 7 7',
  capture: 'M12 5v14M5 12h14',
  search: 'M21 21l-4.35-4.35M17 10.5a6.5 6.5 0 11-13 0 6.5 6.5 0 0113 0z',
  more: 'M5.5 12h.01M12 12h.01M18.5 12h.01',
  palette: 'M4 5h16M4 10h16M4 15h10M4 20h6',
  cloud: 'M17.5 19a4.5 4.5 0 001.03-8.88 6 6 0 00-11.77 1.13A3.75 3.75 0 007.25 19h10.25z',
  server:
    'M4 4h16a1 1 0 011 1v4a1 1 0 01-1 1H4a1 1 0 01-1-1V5a1 1 0 011-1zM4 14h16a1 1 0 011 1v4a1 1 0 01-1 1H4a1 1 0 01-1-1v-4a1 1 0 011-1zM7 7h.01M7 17h.01',
  folder: 'M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z',
  calendar:
    'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2z',
  note: 'M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9l-6-6zM14 3v6h6',
  template: 'M4 4h16v16H4zM4 9h16M9 9v11',
  database: 'M12 8c4.97 0 9-1.34 9-3s-4.03-3-9-3-9 1.34-9 3 4.03 3 9 3zM3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3',
  folderPlus: 'M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7zM12 11v6M9 14h6',
  tabs: 'M4 6h16M4 6v12h16V6M9 6v12',
  outline: 'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01',
  rename: 'M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7zM12 15a3 3 0 100-6 3 3 0 000 6z',
  move: 'M5 8V6a2 2 0 012-2h3l2 2h7a2 2 0 012 2v10a2 2 0 01-2 2H7a2 2 0 01-2-2v-4M2 13h9m0 0l-3-3m3 3l-3 3',
  link: 'M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71',
  archive: 'M21 8v13H3V8M1 3h22v5H1zM10 12h4',
  trash: 'M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6M10 11v6M14 11v6',
  settings:
    'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33h0a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51h0a1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82v0a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z',
  textSearch: 'M21 21l-4.35-4.35M17 10.5a6.5 6.5 0 11-13 0 6.5 6.5 0 0113 0zM8 9h5M8 12h3'
}

interface SheetRow {
  id: string
  label: string
  icon: string
  danger?: boolean
}

const RESTORE_ICON = 'M3 9l4-4m-4 4l4 4M3 9h13a5 5 0 015 5v0a5 5 0 01-5 5H9'

function noteRowsFor(folder: string | null): SheetRow[] {
  const base: SheetRow[] = [
    { id: 'nav.outline', label: 'Outline', icon: ICONS.outline },
    { id: 'note.rename', label: 'Rename', icon: ICONS.rename },
    { id: 'note.move', label: 'Move to…', icon: ICONS.move },
    { id: 'note.copy-wikilink', label: 'Copy wikilink', icon: ICONS.link }
  ]
  if (folder === 'archive') {
    base.push({ id: 'note.unarchive', label: 'Unarchive', icon: RESTORE_ICON })
  } else if (folder === 'trash') {
    base.push({ id: 'note.restore', label: 'Restore', icon: RESTORE_ICON })
  } else {
    base.push({ id: 'note.archive', label: 'Archive', icon: ICONS.archive })
  }
  if (folder !== 'trash') {
    base.push({ id: 'note.trash', label: 'Delete', icon: ICONS.trash, danger: true })
  }
  return base
}

const APP_ROWS: SheetRow[] = [
  // Trimmed for mobile (Adib: "not all is needed"). Removed from here:
  //  - "Open notes" — app-core's buffer/tab switcher; a desktop tabs concept
  //    that dumped raw zen:// buffers, all flagged HIDDEN, on phones.
  //  - "Open folder as vault…" — a rare setup action, and it already lives in
  //    Settings → Vault → Location.
  // "All commands…" was trimmed too, then restored in 1.1 (Adib): it is the
  // only touch path to palette-only features (Assets view, Help, daily
  // rollover, connections/comments panels) and keeps future desktop-parity
  // commands reachable without redesigning this sheet each release.
  { id: 'nav.search-text', label: 'Search in all notes', icon: ICONS.textSearch },
  { id: 'zn.palette', label: 'All commands…', icon: ICONS.palette },
  // One vault entry (1.1): "iCloud Sync" and "Remote Vault" both folded into
  // the Vaults manager — per-vault Move to iCloud and the Remote section.
  { id: 'zn.vaults', label: 'Vaults', icon: ICONS.cloud },
  { id: 'app.settings', label: 'Settings', icon: ICONS.settings }
]

function ActionSheet({ onClose }: { onClose: () => void }): React.JSX.Element {
  const selectedPath = useStore((s) => s.selectedPath)
  const workspaceMode = useStore((s) => s.workspaceMode)
  // Virtual tabs (zen://help, zen://tasks, ...) aren't notes — their rows
  // (rename/trash/...) would silently no-op.
  const hasNote = Boolean(selectedPath) && !selectedPath?.startsWith('zen://')
  const noteFolder = useStore((s) => {
    if (!s.selectedPath) return null
    return s.notes.find((n) => n.path === s.selectedPath)?.folder ?? null
  })
  const calendarAvailable = useStore(
    (s) => s.vaultSettings.dailyNotes.enabled || s.vaultSettings.weeklyNotes.enabled
  )
  // With a database tab open, offer its removal — every open thing should be
  // deletable from •••.
  const dbFormDir = useStore((s) => {
    const csv = csvPathFromDatabaseTab(s.selectedPath)
    return csv ? formDirFromCsvPath(csv) : null
  })
  const dbTitle = dbFormDir
    ? (dbFormDir.split('/').pop() ?? '').replace(/\.base$/i, '')
    : null
  const title = useStore((s) => {
    if (!s.selectedPath) return 'ZenNotes'
    const note = s.notes.find((n) => n.path === s.selectedPath)
    return note?.title ?? 'ZenNotes'
  })

  const deleteOpenDatabase = (): void => {
    const formDir = dbFormDir
    const label = dbTitle
    if (!formDir || label === null) return
    onClose()
    window.setTimeout(() => {
      void (async () => {
        const ok = await confirmApp({
          title: `Delete "${label}"?`,
          description: 'All records will be permanently deleted. This cannot be undone.',
          confirmLabel: 'Delete',
          danger: true
        })
        if (!ok) return
        // Remap-aware: the inbox may live in a renamed directory
        // (vault.json systemFolderPaths), so strip the RESOLVED prefix.
        const subpath = notePathWithinFolder(
          formDir,
          'inbox',
          useStore.getState().vaultSettings
        )
        await useStore.getState().deleteFolder('inbox', subpath)
      })()
    }, 30)
  }

  const run = (id: string): void => {
    onClose()
    // Let the sheet unmount before the command opens palettes/prompts, so
    // focus lands in the right place.
    window.setTimeout(() => {
      if (id === 'zn.palette') {
        useStore.getState().setCommandPaletteOpen(true)
        return
      }
      if (id === 'zn.vaults') {
        openMobileSheet('vaults')
        return
      }
      if (id === 'zn.pickfolder') {
        void useStore.getState().openVaultPicker()
        return
      }
      if (id === 'note.trash') {
        // Own the confirm copy ("Delete") — app-core's command would show its
        // desktop "Move to Trash?" dialog. The bridge's unlink event closes
        // the tab via applyChange.
        void (async () => {
          const st = useStore.getState()
          const path = st.selectedPath
          if (!path) return
          const noteTitle = st.notes.find((n) => n.path === path)?.title
          const ok = await confirmApp({
            title: `Delete "${noteTitle ?? 'this note'}"?`,
            description: 'It will move to the trash.',
            confirmLabel: 'Delete',
            danger: true
          })
          if (ok) await window.zen.moveToTrash(path)
        })()
        return
      }
      runCommand(id)
    }, 30)
  }

  return (
    <>
      <div className="zn-mobile-sheet-backdrop" onClick={onClose} role="presentation" />
      <div className="zn-mobile-sheet" role="menu" aria-label="Note actions">
        <div className="zn-mobile-sheet-title">{dbTitle ?? title}</div>
        {hasNote && (
          <div className="zn-mobile-seg" role="group" aria-label="View mode">
            <button type="button" onClick={() => run('view.mode.edit')}>
              Edit
            </button>
            <button type="button" onClick={() => run('view.mode.preview')}>
              Read
            </button>
          </div>
        )}
        <div className="zn-mobile-sheet-scroll">
          {hasNote && calendarAvailable && (
            <div className="zn-mobile-sheet-group">
              <button
                type="button"
                className="zn-mobile-sheet-row"
                onClick={() => {
                  onClose()
                  window.setTimeout(
                    () => window.dispatchEvent(new Event('zen:toggle-calendar')),
                    30
                  )
                }}
              >
                <Icon d={ICONS.calendar} />
                Calendar
              </button>
            </div>
          )}
          {dbFormDir && (
            <div className="zn-mobile-sheet-group">
              <button
                type="button"
                className="zn-mobile-sheet-row zn-danger"
                onClick={deleteOpenDatabase}
              >
                <Icon d={ICONS.trash} />
                Delete
              </button>
            </div>
          )}
          {hasNote && (
            <div className="zn-mobile-sheet-group">
              {noteRowsFor(noteFolder).map((row) => (
                <button
                  key={row.id}
                  type="button"
                  className={`zn-mobile-sheet-row${row.danger ? ' zn-danger' : ''}`}
                  onClick={() => run(row.id)}
                >
                  <Icon d={row.icon} />
                  {row.label}
                </button>
              ))}
            </div>
          )}
          <div className="zn-mobile-sheet-group">
            {APP_ROWS.map((row) => (
              <button
                key={row.id}
                type="button"
                className="zn-mobile-sheet-row"
                onClick={() => run(row.id)}
              >
                <Icon d={row.icon} />
                {row.label}
                {row.id === 'zn.vaults' && workspaceMode === 'remote' && (
                  <span className="zn-mobile-sheet-row-detail">Remote</span>
                )}
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  )
}

/**
 * The ⊕ create sheet — desktop's create menu (New note / template / database
 * / folder) minus drawing (view-only on phones), with quick capture as the
 * hero first row. Daily note rides along when enabled: the home screen's
 * quick-action chips are hidden on phones, so this is its one-tap home.
 */
function CreateSheet({ onClose }: { onClose: () => void }): React.JSX.Element {
  const dailyEnabled = useStore((s) => s.vaultSettings.dailyNotes.enabled)
  const run = (fn: () => unknown): void => {
    onClose()
    window.setTimeout(() => void fn(), 30)
  }

  const newFolder = async (): Promise<void> => {
    const name = await promptApp({
      title: 'New folder',
      placeholder: 'Folder name',
      okLabel: 'Create',
      validate: (v: string) => (v.includes('/') ? 'Folder name cannot contain "/"' : null)
    })
    const clean = name?.trim().replace(/^\/+|\/+$/g, '')
    if (!clean) return
    await useStore.getState().createFolder('inbox', clean)
  }

  return (
    <>
      <div className="zn-mobile-sheet-backdrop" onClick={onClose} role="presentation" />
      <div className="zn-mobile-sheet" role="menu" aria-label="Create">
        <div className="zn-mobile-sheet-title">Create</div>
        <div className="zn-mobile-sheet-scroll">
          <div className="zn-mobile-sheet-group">
            <button
              type="button"
              className="zn-mobile-sheet-row"
              onClick={() => run(() => runCommand('note.new.quick'))}
            >
              <Icon d={ICONS.capture} />
              Quick note
            </button>
            <button
              type="button"
              className="zn-mobile-sheet-row"
              onClick={() => run(() => runCommand('note.new.inbox'))}
            >
              <Icon d={ICONS.note} />
              New note
            </button>
            {dailyEnabled && (
              <button
                type="button"
                className="zn-mobile-sheet-row"
                onClick={() => run(() => useStore.getState().openTodayDailyNote())}
              >
                <Icon d={ICONS.calendar} />
                Daily note
              </button>
            )}
            <button
              type="button"
              className="zn-mobile-sheet-row"
              onClick={() => run(() => useStore.getState().setTemplatePaletteOpen(true))}
            >
              <Icon d={ICONS.template} />
              New from template
            </button>
            <button
              type="button"
              className="zn-mobile-sheet-row"
              onClick={() => run(() => runCommand('database.new'))}
            >
              <Icon d={ICONS.database} />
              New database
            </button>
            <button
              type="button"
              className="zn-mobile-sheet-row"
              onClick={() => run(() => newFolder())}
            >
              <Icon d={ICONS.folderPlus} />
              New folder
            </button>
          </div>
        </div>
      </div>
    </>
  )
}

function MobileNav(): React.JSX.Element | null {
  const vault = useStore((s) => s.vault)
  const setSearchOpen = useStore((s) => s.setSearchOpen)
  // A real note is open (not Home/Tasks/Tags/a database) → offer the Edit/Read
  // toggle in the dial. `activeNote` is the loaded markdown note's meta.
  const hasOpenNote = useStore((s) => Boolean(s.activeNote))
  // Effective mode mirrors EditorPane: the pane's sticky mode wins only when
  // "keep view mode across notes" is on; otherwise it's the per-note mode.
  // Selector returns a primitive string, so no fresh-object re-render footgun.
  const isPreview = useStore((s) => {
    const path = s.selectedPath
    if (!path) return false
    const sticky = s.paneStickyModes[s.activePaneId]
    const mode =
      s.keepViewModeAcrossNotes && sticky
        ? sticky
        : paneModeForPath(s.paneModes[s.activePaneId] ?? {}, path)
    return mode === 'preview'
  })
  const [sheetOpen, setSheetOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [fabOpen, setFabOpen] = useState(false)
  // First-run coach mark: the unlabeled ensō reads as a loading spinner to
  // new users (real-user tested). Set by onboarding, cleared on first tap.
  const [fabHint, setFabHint] = useState(
    () => localStorage.getItem(FAB_HINT_KEY) === 'pending'
  )

  if (!vault) return null

  const dismissHint = (): void => {
    if (!fabHint) return
    localStorage.removeItem(FAB_HINT_KEY)
    setFabHint(false)
  }

  const toggleFab = (): void => {
    void Haptics.impact({ style: ImpactStyle.Light }).catch(() => {})
    dismissHint()
    setFabOpen((v) => !v)
  }

  // One floating circle bottom-right; tapping it fans out the nav actions
  // (Adib: "very minimal and clean" — no persistent bar eating the screen).
  // Order: thumb-nearest first. All entries are "do" verbs — Back is
  // navigation, not an action, and lives in the note header instead
  // (useHeaderBackButton): burying it in a modal dial felt off to Adib.
  const fabActions: Array<{ label: string; icon: string; run: () => void }> = [
    // Edit/Read is note-only: switch the open note between reading and editing
    // without digging into the ••• sheet (Adib's ask). Shows the mode you'd
    // switch TO.
    ...(hasOpenNote
      ? [
          {
            label: isPreview ? 'Edit' : 'Read',
            icon: isPreview ? ICONS.rename : ICONS.eye,
            run: () => requestPaneMode(isPreview ? 'edit' : 'preview')
          }
        ]
      : []),
    { label: 'More', icon: ICONS.more, run: () => setSheetOpen(true) },
    { label: 'Browse', icon: ICONS.sidebar, run: () => setDrawerOpen(true) },
    { label: 'Search', icon: ICONS.search, run: () => setSearchOpen(true) },
    { label: 'New', icon: ICONS.capture, run: () => setCreateOpen(true) }
  ]

  return (
    <>
      {fabOpen && (
        <>
          <div
            className="zn-mobile-fab-backdrop"
            role="presentation"
            onClick={() => setFabOpen(false)}
          />
          <div className="zn-mobile-fab-menu" role="menu" aria-label="Navigation">
            {fabActions.map((action) => (
              <button
                key={action.label}
                type="button"
                role="menuitem"
                onClick={() => {
                  setFabOpen(false)
                  action.run()
                }}
              >
                {action.label}
                <Icon d={action.icon} />
              </button>
            ))}
          </div>
        </>
      )}
      {fabHint && !fabOpen && (
        <button type="button" className="zn-mobile-fab-hint" onClick={toggleFab}>
          Everything starts here
          <span>notes · search · settings</span>
        </button>
      )}
      <button
        type="button"
        aria-label={fabOpen ? 'Close menu' : 'Open menu'}
        aria-expanded={fabOpen}
        className={`zn-mobile-fab${fabOpen ? ' open' : ''}${fabHint ? ' hinting' : ''}`}
        onClick={toggleFab}
      >
        <img src={ensoUrl} alt="" aria-hidden="true" />
      </button>
      {sheetOpen && <ActionSheet onClose={() => setSheetOpen(false)} />}
      {createOpen && <CreateSheet onClose={() => setCreateOpen(false)} />}
    </>
  )
}

/**
 * Phone-layout normalization, applied every time a workspace finishes
 * restoring — app launch AND vault switches/creates/connects (the restore
 * cycle flips workspaceRestored false→true on each). The desktop-sized
 * panels close on every edge; where the user LANDS depends on which edge
 * this is (#2):
 *
 * - Cold launch honors the restored workspace: the note (or virtual view)
 *   that was active when iOS killed the app shows again, and a null
 *   activeTab means the user left from Home, so Home renders. Backgrounding
 *   must not cost the user their place.
 * - Vault switches/creates/connects land on Home. The old vault's note tabs
 *   are gone, but vault-independent virtual tabs (zen://tasks…) survive a
 *   switch — without this, every new vault greeted the user with the
 *   previous vault's Tasks view.
 */
function usePhoneLayoutBoot(): void {
  useEffect(() => {
    if (!isPhoneWidth()) return
    let wasRestored = false
    let firstLanding = true
    // The Home witness, captured BEFORE the store's restore runs. Mobile's
    // Home state persists as `activeTab: null` with tabs kept open behind it
    // — a state desktop can't reach, so the store's restore sanitizer
    // coerces that null to the first open tab and the restored store can't
    // tell "left from Home" apart from "left in a note". Only the raw
    // snapshot knows, and it must be read now: after restore, the first
    // persist rewrites it with the coerced tab. (Kill-during-debounce
    // caveat: the file trails the store's localStorage cache by up to
    // 1.5s of debounce, so a kill inside that window can land one launch
    // in the note the user had just left. Once, and recoverable — the
    // cache itself is keyed by a vault root the shell doesn't know yet.)
    let persistedHome: boolean | null = null
    void (async () => {
      try {
        const raw = await window.zen.readWorkspaceState()
        if (!raw) {
          persistedHome = true
          return
        }
        const snap = JSON.parse(raw) as {
          paneLayout?: unknown
          activePaneId?: unknown
        }
        const leaf = findLeaf(
          snap.paneLayout as Parameters<typeof findLeaf>[0],
          typeof snap.activePaneId === 'string' ? snap.activePaneId : ''
        )
        persistedHome = !leaf || leaf.activeTab === null
      } catch {
        persistedHome = true
      }
    })()
    const apply = (): void => {
      const s = useStore.getState()
      const restored = Boolean(s.vault) && s.workspaceRestored
      const edge = restored && !wasRestored
      wasRestored = restored
      if (!edge) return
      // Panels close, and daily/weekly notes must not auto-summon the
      // calendar over a phone-sized editor (it's one tap away in •••).
      useStore.setState({ sidebarOpen: false, noteListOpen: false, autoCalendarPanel: false })
      if (!firstLanding) {
        goHome()
        return
      }
      firstLanding = false
      // Cold launch: land where the user left (#2). A persisted null
      // activeTab (or no snapshot, or an unreadable one) means Home;
      // anything else keeps the restored note/view on screen. `null` — the
      // witness read somehow still in flight — falls back to Home, the
      // pre-#2 behavior, rather than guessing a note.
      if (persistedHome !== false) goHome()
      // First run only: land IN the seeded welcome note (reading mode — no
      // keyboard) instead of on a Home screen with nothing to do. Home stays
      // one Back tap away. The pane mode is set through the store before the
      // note opens so the pane never flashes edit mode.
      if (localStorage.getItem(WELCOME_PENDING_KEY)) {
        localStorage.removeItem(WELCOME_PENDING_KEY)
        const after = useStore.getState()
        useStore.setState({
          paneModes: {
            ...after.paneModes,
            [after.activePaneId]: paneModesWithPathMode(
              after.paneModes[after.activePaneId] ?? {},
              WELCOME_NOTE_PATH,
              'preview'
            )
          }
        })
        after.selectNote(WELCOME_NOTE_PATH).catch(() => {})
      }
    }
    const unsub = useStore.subscribe(apply)
    apply()
    return () => unsub()
  }, [])
}

/**
 * Mirror of the editor's `openWikilink` (cm-wikilink-render.ts, not exported)
 * built from the same shared helpers, minus the desktop editor-refocus (we
 * don't want the soft keyboard popping up after a navigation tap).
 */
function openWikilinkFromTouch(target: string): void {
  const s = useStore.getState()
  const anchor = wikilinkHeadingAnchor(target)
  const resolved = resolveWikilinkTarget(s.notes, target)
  if (!resolved) {
    if (anchor && isSameFileHeadingLink(target) && s.selectedPath) {
      void openWikilinkHeading(s.selectedPath, anchor)
      return
    }
    openDatabaseFromWikilink(target)
    return
  }
  if (!anchor) {
    void s.selectNote(resolved.path)
    return
  }
  void openWikilinkHeading(resolved.path, anchor)
}

/**
 * Tap-to-follow wikilinks in the editor. The shared extension follows links
 * on `mousedown`, but on iOS the preceding touch moves the CodeMirror
 * selection, which reveals the raw `[[...]]` source and removes the rendered
 * link before any mouse event fires — so taps just placed the caret (spec 06
 * wants tap = navigate). Intercepting `touchstart` runs before CodeMirror.
 */
function useWikilinkTapNavigation(): void {
  useEffect(() => {
    const onTouchStart = (e: TouchEvent): void => {
      const el = (e.target as HTMLElement | null)?.closest?.('.cm-wikilink')
      const target = el instanceof HTMLElement ? el.dataset.target : undefined
      if (!target) return
      e.preventDefault()
      e.stopPropagation()
      openWikilinkFromTouch(target)
    }
    document.addEventListener('touchstart', onTouchStart, { capture: true, passive: false })
    return () =>
      document.removeEventListener('touchstart', onTouchStart, { capture: true } as never)
  }, [])
}

/**
 * Breadcrumb navigation (phone): tapping a folder crumb runs the shared
 * `setView({ folder, subpath })` — invisible on a phone — so the shell opens
 * the mobile drawer as the visible response, SCOPED to the folder that was
 * tapped (reading the subpath setView just wrote to the store) rather than
 * always resetting to the vault root.
 */
function useBreadcrumbDrawerNav(): void {
  useEffect(() => {
    if (!isPhoneWidth()) return
    const onClick = (e: MouseEvent): void => {
      const crumb = (e.target as HTMLElement | null)?.closest?.('button[data-crumb-menu]')
      if (!crumb) return
      // Defer so app-core's own onClick (setView) has run; then the store's
      // view holds the tapped folder's subpath, which is exactly the drawer's
      // drill-down path (both are relative to the primary notes area).
      window.setTimeout(() => {
        const view = useStore.getState().view
        const subpath = view?.kind === 'folder' ? view.subpath : ''
        setDrawerOpen(true, subpath)
      }, 0)
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [])
}

/**
 * Long-press → context menu. Desktop flows (folder/note actions, tag filters,
 * tab menus) hang off `onContextMenu`. Unlike iOS (where the iPhone shell must
 * synthesize the event from a 450ms press timer), the Android WebView fires a
 * real `contextmenu` on long-press, so React's handlers run on their own.
 * What Android still needs from the shim: a haptic tick on chrome surfaces,
 * and swallowing the post-lift synthetic mousedown/mouseup/click burst —
 * ContextMenu closes on window mousedown, so without the suppression the
 * menu vanishes the instant the finger lifts.
 *
 * The task surfaces (list rows, kanban cards, calendar day cells) joined in
 * upstream 2.21: the shared task menu is where "Mark in progress" lives, so
 * without them a task state that desktop right-clicks into existence would be
 * unreachable on the phone. The calendar's per-task rows carry no stable
 * selector upstream; those tasks offer the same menu from the List view.
 */
const LONG_PRESS_SURFACES =
  'aside.glass-sidebar, header.glass-header, section.glass-column, [data-tab-menu-target], ' +
  '[data-task-row], [data-kanban-task-id], [data-cal-day]'

function useLongPressContextMenu(): void {
  useEffect(() => {
    let suppressNextClickUntil = 0

    const onContextMenu = (e: MouseEvent): void => {
      const t = e.target as HTMLElement | null
      if (!t || typeof t.closest !== 'function') return
      if (t.closest('.cm-editor') || t.closest('input, textarea')) return
      if (!t.closest(LONG_PRESS_SURFACES)) return
      void Haptics.impact({ style: ImpactStyle.Medium }).catch(() => {})
      suppressNextClickUntil = Date.now() + 700
    }

    const suppressMouse = (e: MouseEvent): void => {
      if (Date.now() < suppressNextClickUntil) {
        e.preventDefault()
        e.stopPropagation()
        if (e.type === 'click') suppressNextClickUntil = 0
      }
    }

    // Chrome also starts an HTML5 drag from a long-press on draggable
    // elements (kanban cards, task rows carry draggable for desktop mouse
    // flows). The phantom drag drops in place over the editor and trips
    // EditorPane's file-drop error alert. Drag is not a phone gesture — the
    // context menu owns long-press there — so kill it at dragstart; tablets
    // (≥768px, desktop-like layout) keep native drag behavior.
    const suppressDrag = (e: DragEvent): void => {
      if (isPhoneWidth()) e.preventDefault()
    }

    document.addEventListener('contextmenu', onContextMenu, true)
    document.addEventListener('mousedown', suppressMouse, true)
    document.addEventListener('mouseup', suppressMouse, true)
    document.addEventListener('click', suppressMouse, true)
    document.addEventListener('dragstart', suppressDrag, true)
    return () => {
      document.removeEventListener('contextmenu', onContextMenu, true)
      document.removeEventListener('mousedown', suppressMouse, true)
      document.removeEventListener('mouseup', suppressMouse, true)
      document.removeEventListener('click', suppressMouse, true)
      document.removeEventListener('dragstart', suppressDrag, true)
    }
  }, [])
}

/**
 * Placeholders like "Filter…  /  to focus" carry a keyboard hint that just
 * truncates on a phone — trim them as the inputs mount.
 */
function usePlaceholderCleanup(): void {
  useEffect(() => {
    if (!isPhoneWidth()) return
    const clean = (root: ParentNode): void => {
      for (const input of root.querySelectorAll<HTMLInputElement>(
        'input[placeholder*="to focus"]'
      )) {
        input.placeholder = input.placeholder.split('/')[0]!.trim()
      }
    }
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node instanceof HTMLElement) clean(node)
        }
      }
    })
    observer.observe(document.body, { childList: true, subtree: true })
    clean(document)
    return () => observer.disconnect()
  }, [])
}

/**
 * Edge-swipe drawer gestures (spec 07): swipe right from the left screen edge
 * to open the sidebar drawer; swipe left anywhere on the open drawer to close
 * it. Edge-start only, so editor text selection and horizontal scrollers
 * (kanban, toolbars) are never hijacked. (A swipe-to-go-back variant was
 * tried 2026-07-16 and reverted at Adib's request — back lives in the
 * header chevron.)
 */
function useEdgeSwipeDrawer(): void {
  useEffect(() => {
    if (!isPhoneWidth()) return
    const EDGE = 28
    const TRIGGER = 55
    const SLOP = 40
    let tracking: 'open' | 'close' | null = null
    let startX = 0
    let startY = 0

    const onTouchStart = (e: TouchEvent): void => {
      if (e.touches.length !== 1) return
      const t = e.touches[0]!
      startX = t.clientX
      startY = t.clientY
      if (!isDrawerOpen() && t.clientX <= EDGE) {
        tracking = 'open'
      } else if (
        isDrawerOpen() &&
        (e.target as HTMLElement | null)?.closest?.('.zn-mobile-drawer')
      ) {
        tracking = 'close'
      } else {
        tracking = null
      }
    }

    const onTouchMove = (e: TouchEvent): void => {
      if (!tracking) return
      const t = e.touches[0]!
      const dx = t.clientX - startX
      const dy = Math.abs(t.clientY - startY)
      if (dy > SLOP) {
        tracking = null
        return
      }
      if (tracking === 'open' && dx > TRIGGER) {
        tracking = null
        setDrawerOpen(true)
      } else if (tracking === 'close' && dx < -TRIGGER) {
        tracking = null
        setDrawerOpen(false)
      }
    }

    const onTouchEnd = (): void => {
      tracking = null
    }

    document.addEventListener('touchstart', onTouchStart, { passive: true, capture: true })
    document.addEventListener('touchmove', onTouchMove, { passive: true, capture: true })
    document.addEventListener('touchend', onTouchEnd, { passive: true, capture: true })
    return () => {
      document.removeEventListener('touchstart', onTouchStart, { capture: true } as never)
      document.removeEventListener('touchmove', onTouchMove, { capture: true } as never)
      document.removeEventListener('touchend', onTouchEnd, { capture: true } as never)
    }
  }, [])
}

/**
 * Right-hand panels (calendar/outline/connections/comments) render as
 * full-screen sheets on phones (CSS) — this injects a floating Done button
 * that dispatches app-core's own `zen:close-right-panel` event, since the
 * panels' open state lives inside EditorPane.
 */
/**
 * Desktop-only commands that app-core registers without a runtime gate. None
 * of these can work on iOS (App Store owns updates; no app zoom, floating
 * windows, or PDF export pipeline) — hide their palette rows on any device
 * width. Matched by title prefix against each row's text.
 */
const DESKTOP_ONLY_COMMAND_TITLES = [
  'Open Help',
  'Check for Updates',
  'Zoom In',
  'Zoom Out',
  'Reset Zoom',
  'Open in Floating Window',
  'Export Note as PDF',
  'Show Onboarding Wizard'
]

/** Additionally hidden on phones: splits/panes and the (replaced) sidebar
 *  exist on iPad but not in the phone layout. */
const PHONE_ONLY_HIDDEN_COMMAND_TITLES = [
  'Split Right',
  'Split Down',
  'Switch to Split Mode',
  'Focus Pane Left',
  'Focus Pane Below',
  'Focus Pane Above',
  'Focus Pane Right',
  'Focus Sidebar',
  'Toggle Sidebar',
  'Show Tags in Sidebar',
  'Hide Tags in Sidebar',
  'Toggle Note List Column',
  // Drawings are view-only on phones — creating one opens an uneditable
  // canvas. ('New Drawing' also catches 'Embed New Drawing' via the
  // .includes row match; 'Embed Existing Drawing…' stays, embeds render.)
  'New Drawing',
  'Embed New Drawing'
]

function useDesktopCommandCleanup(): void {
  useEffect(() => {
    let raf = 0
    const titles = isPhoneWidth()
      ? [...DESKTOP_ONLY_COMMAND_TITLES, ...PHONE_ONLY_HIDDEN_COMMAND_TITLES]
      : DESKTOP_ONLY_COMMAND_TITLES
    const sweep = (): void => {
      const palette = document.querySelector('.z-palette')
      if (!palette) return
      for (const row of palette.querySelectorAll<HTMLElement>('button')) {
        // Row text is "<CATEGORY><Title><shortcut>", so match by inclusion.
        const text = row.textContent ?? ''
        if (titles.some((t) => text.includes(t))) {
          row.style.display = 'none'
        }
      }
    }
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(sweep)
    })
    observer.observe(document.body, { childList: true, subtree: true })
    sweep()
    return () => {
      observer.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [])
}

/**
 * Tasks calendar (phone): a 6-week month grid eats the whole screen, so the
 * shell adds a Week/Month scope. Week mode hides every `data-cal-day` cell
 * outside the week of the selected (or today's) cell — the grid is one flat
 * 42-cell list, so a week is a contiguous 7-cell run. A Week|Month segmented
 * control is injected next to the calendar's own Today button (a single
 * action-labeled pill read as a status chip, not a button — Adib's feedback).
 */
const CAL_SCOPE_KEY = 'zn-mobile:cal-scope'

function useCalendarWeekMode(): void {
  useEffect(() => {
    if (!isPhoneWidth()) return
    let control: HTMLDivElement | null = null
    let raf = 0

    const scope = (): 'week' | 'month' =>
      localStorage.getItem(CAL_SCOPE_KEY) === 'month' ? 'month' : 'week'

    const apply = (): void => {
      const cells = Array.from(
        document.querySelectorAll<HTMLButtonElement>('button[data-cal-day]')
      )
      const todayBtn = document.querySelector<HTMLElement>("button[title='Today (gt)']")
      if (cells.length === 0 || !todayBtn) {
        control?.remove()
        control = null
        document.documentElement.classList.remove('zn-cal-week')
        return
      }
      if (!control || !control.isConnected) {
        control = document.createElement('div')
        control.className = 'zn-cal-scope'
        control.setAttribute('role', 'group')
        control.setAttribute('aria-label', 'Calendar scope')
        for (const s of ['week', 'month'] as const) {
          const btn = document.createElement('button')
          btn.type = 'button'
          btn.dataset.scope = s
          btn.textContent = s === 'week' ? 'Week' : 'Month'
          btn.addEventListener('click', () => {
            localStorage.setItem(CAL_SCOPE_KEY, s)
            apply()
          })
          control.appendChild(btn)
        }
        todayBtn.insertAdjacentElement('afterend', control)
      }
      const week = scope() === 'week'
      for (const btn of control.querySelectorAll<HTMLButtonElement>('button')) {
        const active = btn.dataset.scope === (week ? 'week' : 'month')
        btn.classList.toggle('is-active', active)
        btn.setAttribute('aria-pressed', String(active))
      }
      document.documentElement.classList.toggle('zn-cal-week', week)
      if (!week) {
        for (const cell of cells) cell.style.display = ''
        return
      }
      // Anchor: the selected cell (accent ring) if present, else today, else
      // the second row (first row is often entirely the previous month).
      const now = new Date()
      const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
      const anchor =
        cells.find((c) => c.className.includes('ring-2')) ??
        cells.find((c) => c.dataset.calDay === todayIso) ??
        cells[7]
      const idx = Math.max(0, cells.indexOf(anchor ?? cells[0]))
      const start = Math.floor(idx / 7) * 7
      cells.forEach((cell, i) => {
        cell.style.display = i >= start && i < start + 7 ? '' : 'none'
      })
    }

    const schedule = (): void => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(apply)
    }
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true })
    // Selection changes flip cell classes without adding nodes — reapply on
    // taps anywhere in the grid.
    const onClick = (e: MouseEvent): void => {
      if ((e.target as HTMLElement | null)?.closest?.('[data-cal-day], .zn-cal-scope')) schedule()
    }
    document.addEventListener('click', onClick, true)
    schedule()
    return () => {
      observer.disconnect()
      document.removeEventListener('click', onClick, true)
      cancelAnimationFrame(raf)
      control?.remove()
      document.documentElement.classList.remove('zn-cal-week')
    }
  }, [])
}

const RIGHT_PANEL_SELECTOR =
  '[data-calendar-panel], [data-connections-panel], [data-comments-panel], .zn-app-shell section[class*="border-l"][class*="shrink-0"], .zn-app-shell aside[class*="border-l"][class*="shrink-0"], .zn-app-shell div[class*="border-l"][class*="shrink-0"][class*="flex-col"]'

function useRightPanelCloseButton(): void {
  useEffect(() => {
    if (!isPhoneWidth()) return
    let button: HTMLButtonElement | null = null
    let raf = 0
    const sync = (): void => {
      const open = document.querySelector(RIGHT_PANEL_SELECTOR) !== null
      if (open && !button) {
        // Panels are full-screen sheets — a keyboard left over from editing
        // (or a palette hand-off) would cover their lower half.
        ;(document.activeElement as HTMLElement | null)?.blur?.()
        void Keyboard.hide().catch(() => {})
        button = document.createElement('button')
        button.type = 'button'
        button.className = 'zn-panel-close'
        button.textContent = 'Done'
        button.addEventListener('click', () => {
          window.dispatchEvent(new Event('zen:close-right-panel'))
        })
        document.body.appendChild(button)
      } else if (!open && button) {
        button.remove()
        button = null
      }
    }
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(sync)
    })
    observer.observe(document.body, { childList: true, subtree: true })
    sync()
    return () => {
      observer.disconnect()
      cancelAnimationFrame(raf)
      button?.remove()
    }
  }, [])
}

/** Close the drawer whenever a note gets selected through any path (search,
 *  wikilinks, deep links) — at phone width it's navigation, not a pane. */
function useDrawerAutoClose(): void {
  useEffect(() => {
    if (!isPhoneWidth()) return
    let lastSelected = useStore.getState().selectedPath
    return useStore.subscribe(() => {
      const s = useStore.getState()
      if (s.selectedPath !== lastSelected) {
        lastSelected = s.selectedPath
        if (s.selectedPath) setDrawerOpen(false)
      }
    })
  }, [])
}

// ---------------------------------------------------------------------------
// Settings mobilizer — turns the desktop two-pane Settings dialog into a
// paged flow (section list → detail with a back button). The dialog is a CSS
// grid of <aside> (nav) + content; mobile.css shows one pane at a time based
// on data-zn-view, and this hook drives the attribute + injects the back
// button. Desktop-only sections (MCP, CLI) are hidden by label.
// ---------------------------------------------------------------------------

// MCP/CLI are desktop-only integrations; Keymap records hardware keyboard
// shortcuts, which has no meaning on a soft keyboard (iPad keeps it — hardware
// keyboards are common there and the desktop settings layout applies ≥768px).
const HIDDEN_SETTINGS_SECTIONS = new Set(['MCP', 'CLI', 'Keymap'])

/** Sub-tabs that are desktop features: 'Search' (ripgrep/fzf binaries don't
 *  exist on iOS), 'Quick capture' (its only content is the system-wide
 *  hotkey recorder — no iOS equivalent) and 'Workflows' (not offered on
 *  mobile — the bridge stubs its methods, so the toggle would only reveal an
 *  empty read-only canvas) at any width; 'Vim' (soft keyboards can't do
 *  modal editing) and 'Folders' (renaming system folders — the Vault sub-tab
 *  titled 'System' before the 2.13 settings reorg) on phones; iPads keep
 *  those two. */
function hiddenSubTabTitles(): Set<string> {
  return isPhoneWidth()
    ? new Set(['Search', 'Vim', 'Folders', 'Quick capture', 'Workflows'])
    : new Set(['Search', 'Quick capture', 'Workflows'])
}

/**
 * Content cleanups that must re-apply as the panel re-renders (switching
 * categories/sub-tabs): hide desktop-only sub-tabs (clicking a visible
 * sibling when the hidden one is active) and the custom-theme authoring
 * block (themes are ~/.config folders — a desktop workflow).
 */
function cleanSettingsContent(panel: HTMLElement): void {
  const hidden = hiddenSubTabTitles()
  const tabs = [...panel.querySelectorAll<HTMLElement>('[role="tab"]')]
  for (const tab of tabs) {
    const title = (tab.textContent ?? '').trim()
    if (!hidden.has(title)) continue
    tab.classList.add('zn-settings-hidden')
    if (tab.getAttribute('aria-selected') === 'true') {
      const fallback = tabs.find(
        (t) => t !== tab && !hidden.has((t.textContent ?? '').trim())
      )
      fallback?.click()
    }
  }
  for (const btn of panel.querySelectorAll<HTMLElement>('button')) {
    const label = (btn.textContent ?? '').trim()
    // Theme authoring and CSS override folders are desktop-filesystem
    // concepts — hide their whole blocks.
    if (label === 'New theme' || label === 'Open overrides folder') {
      const block = btn.closest<HTMLElement>('div.mb-2')?.parentElement
      block?.classList.add('zn-settings-hidden')
    }
    // "Learn how …" links open the Help view, which is hidden on mobile —
    // a dead end.
    if (label.startsWith('Learn how ')) btn.classList.add('zn-settings-hidden')
  }
}

function mobilizeSettingsPanel(panel: HTMLElement): void {
  if (panel.dataset.znSettings === 'true') return
  panel.dataset.znSettings = 'true'

  // Device-level cleanups (phone AND iPad), re-applied on every re-render.
  cleanSettingsContent(panel)
  let raf = 0
  const contentObserver = new MutationObserver(() => {
    cancelAnimationFrame(raf)
    raf = requestAnimationFrame(() => cleanSettingsContent(panel))
  })
  contentObserver.observe(panel, { childList: true, subtree: true })

  // Everything below is the phone-only paged treatment.
  if (!isPhoneWidth()) return
  panel.dataset.znView = 'nav'

  const aside = panel.querySelector('aside')
  if (!aside) return

  // Hide desktop-only nav entries (matched by their visible label). Category
  // buttons are plain buttons in the scrollable list — not inside <nav>,
  // which only wraps search results.
  for (const btn of aside.querySelectorAll<HTMLElement>('button')) {
    const label = (btn.textContent ?? '').trim()
    if (HIDDEN_SETTINGS_SECTIONS.has(label)) btn.classList.add('zn-settings-hidden')
  }

  // Any tap on a category row (or a search result) advances to the detail
  // page. Category rows live in `.space-y-0.5` groups; search results in nav.
  aside.addEventListener(
    'click',
    (e) => {
      const target = e.target as HTMLElement
      if (target.closest('[class*="space-y-0.5"] button') || target.closest('nav button')) {
        panel.dataset.znView = 'detail'
      }
    },
    true
  )

  // Injected iOS-style back affordance for the detail page.
  const back = document.createElement('button')
  back.type = 'button'
  back.className = 'zn-settings-back'
  back.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 5l-7 7 7 7"/></svg>Settings'
  back.addEventListener('click', () => {
    panel.dataset.znView = 'nav'
  })
  panel.appendChild(back)

  // The desktop dialog closes via backdrop click; full-screen has no visible
  // backdrop, so the section list gets an explicit Done.
  const done = document.createElement('button')
  done.type = 'button'
  done.className = 'zn-settings-done'
  done.textContent = 'Done'
  done.addEventListener('click', () => {
    useStore.getState().setSettingsOpen(false)
  })
  panel.appendChild(done)
}

function useSettingsMobilizer(): void {
  useEffect(() => {
    // Runs at every width: device-level cleanups apply on iPad too; the
    // paged-navigation treatment inside is phone-gated.
    let raf = 0
    const scan = (attempt: number): void => {
      // The Settings dialog is the only z-modal panel using a two-column grid;
      // it's portaled to document.body, so a global query finds it.
      const panel = document.querySelector<HTMLElement>('.z-modal > div[class*="grid-cols-"]')
      if (panel) {
        mobilizeSettingsPanel(panel)
        return
      }
      if (attempt < 30) raf = requestAnimationFrame(() => scan(attempt + 1))
    }
    const unsub = useStore.subscribe(() => {
      if (useStore.getState().settingsOpen) {
        cancelAnimationFrame(raf)
        scan(0)
      }
    })
    return () => {
      unsub()
      cancelAnimationFrame(raf)
    }
  }, [])
}

/**
 * Palettes (notes search / commands / templates) render full-screen on phones
 * (mobile.css) — with no visible backdrop left to tap, inject a Cancel button
 * next to the input. Escape is dispatched at window level, where every
 * ModalRoot binds its close handler.
 */
function useMobilePaletteCancel(): void {
  useEffect(() => {
    if (!isPhoneWidth()) return
    let raf = 0
    const apply = (): void => {
      for (const dialog of document.querySelectorAll<HTMLElement>('.z-palette [role="dialog"]')) {
        if (dialog.querySelector('.zn-palette-cancel')) continue
        const input = dialog.querySelector('input')
        if (!input) continue
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'zn-palette-cancel'
        btn.textContent = 'Cancel'
        btn.addEventListener('click', () => {
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
        })
        input.insertAdjacentElement('afterend', btn)
      }
    }
    const schedule = (): void => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(apply)
    }
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true })
    schedule()
    return () => {
      observer.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [])
}

/**
 * iOS-style back chevron at the START of the note/database header (the
 * breadcrumb row) on phones — one tap, where thumbs expect it, instead of
 * two taps deep in the FAB dial. Jump history when there is one, otherwise
 * pop "up" to Home (history isn't persisted across launches, so without the
 * fallback the button reads as broken after a cold start). Injected per
 * header (panes come and go), like the panel Done buttons.
 */
function useHeaderBackButton(): void {
  useEffect(() => {
    if (!isPhoneWidth()) return
    let raf = 0
    const goBack = (): void => {
      if (useStore.getState().noteBackstack.length > 0) runCommand('nav.back')
      else goHome()
    }
    const apply = (): void => {
      for (const header of document.querySelectorAll<HTMLElement>(
        '.zn-app-shell header.glass-header'
      )) {
        if (header.querySelector('.zn-header-back')) continue
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'zn-header-back'
        btn.setAttribute('aria-label', 'Go back')
        btn.innerHTML =
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 5l-7 7 7 7"/></svg>'
        btn.addEventListener('click', goBack)
        header.insertAdjacentElement('afterbegin', btn)
      }
    }
    const schedule = (): void => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(apply)
    }
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true })
    schedule()
    return () => {
      observer.disconnect()
      cancelAnimationFrame(raf)
      for (const btn of document.querySelectorAll('.zn-header-back')) btn.remove()
    }
  }, [])
}

// --- Kanban card move (touch) ----------------------------------------------
// Desktop moves cards by drag or Shift+H/L; neither works on a phone. Each
// card gets a small move handle that opens a column picker, then edits the
// task's line so it lands in the chosen column. The per-column edits mirror
// app-core's TasksKanban.dropMutationsFor (kept in sync manually).

const KANBAN_NO_VALUE_COLUMN = '__none__'
const KANBAN_MOVE_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 7l-4 5 4 5M16 7l4 5-4 5M4 12h16"/></svg>'

function kanbanColumnLabel(groupBy: string, id: string): string {
  const status: Record<string, string> = {
    today: 'Today',
    upcoming: 'Upcoming',
    waiting: 'Waiting',
    done: 'Done'
  }
  const priority: Record<string, string> = { high: 'High', med: 'Medium', low: 'Low', none: 'None' }
  if (groupBy === 'status') return status[id] ?? id
  if (groupBy === 'priority') return priority[id] ?? id
  if (id === KANBAN_NO_VALUE_COLUMN) return `No ${groupBy.replace('field:', '')}`
  return id
}

function kanbanDropMutations(
  groupBy: string,
  columnId: string,
  task: VaultTask
): TaskMutation[] | null {
  if (groupBy === 'status') {
    const todayIso = toIsoDateLocal(new Date())
    switch (columnId) {
      case 'today':
        return [
          { kind: 'set-checked', checked: false },
          { kind: 'set-waiting', waiting: false },
          { kind: 'set-due', due: todayIso }
        ]
      case 'upcoming': {
        const tomorrow = new Date()
        tomorrow.setDate(tomorrow.getDate() + 1)
        return [
          { kind: 'set-checked', checked: false },
          { kind: 'set-waiting', waiting: false },
          {
            kind: 'set-due',
            due: task.due && task.due > todayIso ? task.due : toIsoDateLocal(tomorrow)
          }
        ]
      }
      case 'waiting':
        return [
          { kind: 'set-checked', checked: false },
          { kind: 'set-waiting', waiting: true }
        ]
      case 'done':
        return [{ kind: 'set-checked', checked: true }]
      default:
        return null
    }
  }
  if (groupBy === 'priority') {
    if (columnId === 'high') return [{ kind: 'set-priority', priority: 'high' }]
    if (columnId === 'med') return [{ kind: 'set-priority', priority: 'med' }]
    if (columnId === 'low') return [{ kind: 'set-priority', priority: 'low' }]
    if (columnId === 'none') return [{ kind: 'set-priority', priority: null }]
    return null
  }
  if (groupBy.startsWith('field:')) {
    const key = groupBy.slice('field:'.length)
    return [{ kind: 'set-field', key, value: columnId === KANBAN_NO_VALUE_COLUMN ? null : columnId }]
  }
  // Folder grouping is read-only (moving means moving the note).
  return null
}

/** Inject a move handle into every Kanban card; on tap it dispatches the task
 *  id + current column so the shell's move sheet can offer the other columns.
 *  Skipped on folder boards (moving isn't defined there). */
function useKanbanMoveHandles(): void {
  useEffect(() => {
    if (!isPhoneWidth()) return
    let raf = 0
    const onHandle = (e: Event): void => {
      e.stopPropagation()
      e.preventDefault()
      const card = (e.currentTarget as HTMLElement).closest<HTMLElement>('[data-kanban-task-id]')
      const taskId = card?.getAttribute('data-kanban-task-id')
      if (!taskId) return
      const currentCol =
        card
          ?.closest<HTMLElement>('[data-kanban-column-id]')
          ?.getAttribute('data-kanban-column-id') ?? null
      window.dispatchEvent(new CustomEvent('zen:kanban-move', { detail: { taskId, currentCol } }))
    }
    const ensure = (): void => {
      if (useStore.getState().kanbanGroupBy === 'folder') {
        for (const b of document.querySelectorAll('.zn-kanban-move')) b.remove()
        return
      }
      for (const card of document.querySelectorAll<HTMLElement>('[data-kanban-task-id]')) {
        if (card.querySelector('.zn-kanban-move')) continue
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'zn-kanban-move'
        btn.setAttribute('aria-label', 'Move to column')
        btn.innerHTML = KANBAN_MOVE_SVG
        btn.addEventListener('click', onHandle)
        // Don't let the press start a card drag or open the note.
        btn.addEventListener('pointerdown', (ev) => ev.stopPropagation())
        card.appendChild(btn)
      }
    }
    const schedule = (): void => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(ensure)
    }
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true })
    schedule()
    return () => {
      observer.disconnect()
      cancelAnimationFrame(raf)
      for (const b of document.querySelectorAll('.zn-kanban-move')) b.remove()
    }
  }, [])
}

function kanbanApplyMove(taskId: string, columnId: string): void {
  const groupBy = useStore.getState().kanbanGroupBy
  const task = useStore.getState().vaultTasks.find((t) => t.id === taskId)
  if (!task) return
  const muts = kanbanDropMutations(groupBy, columnId, task)
  if (muts && muts.length > 0) void useStore.getState().applyTaskMutation(task, muts)
}

/**
 * Long-press-and-drag to move a Kanban card between columns (the second,
 * gesture-based option alongside the ↔ handle). app-core's own card drag is
 * pointer-based but never engages on touch — any finger move becomes a native
 * scroll before the drag threshold is crossed. A ~350ms long-press
 * disambiguates: hold to lift the card (haptic + a floating ghost), then drag
 * over a column and release. Native scrolling is only suppressed once a drag
 * is actually underway, so the board still scrolls normally otherwise. Phone
 * only; on the card body we stop the pointerdown so app-core's (dead-on-touch)
 * drag doesn't also fire.
 */
function useKanbanCardDrag(): void {
  useEffect(() => {
    if (!isPhoneWidth()) return
    let timer = 0
    let dragging = false
    let ghost: HTMLElement | null = null
    let card: HTMLElement | null = null
    let taskId: string | null = null
    let sourceCol: string | null = null
    let pointerId = -1
    let startX = 0
    let startY = 0
    let lastX = 0
    let lastY = 0
    let offsetX = 0
    let offsetY = 0
    let suppressClickUntil = 0
    let autoScrollRaf = 0

    const boardEl = (): HTMLElement | null =>
      document.querySelector<HTMLElement>('[data-kanban-column-id]')?.parentElement ?? null

    const clearHighlight = (except?: Element | null): void => {
      for (const c of document.querySelectorAll('.zn-kanban-drop-target')) {
        if (c !== except) c.classList.remove('zn-kanban-drop-target')
      }
    }

    const reset = (): void => {
      if (timer) {
        window.clearTimeout(timer)
        timer = 0
      }
      cancelAnimationFrame(autoScrollRaf)
      ghost?.remove()
      ghost = null
      if (card) card.style.opacity = ''
      clearHighlight()
      dragging = false
      card = null
      taskId = null
      sourceCol = null
      pointerId = -1
    }

    const startDrag = (): void => {
      if (!card) return
      dragging = true
      void Haptics.impact({ style: ImpactStyle.Medium }).catch(() => {})
      // Clone before dimming the source, or the ghost inherits the dim.
      const clone = card.cloneNode(true) as HTMLElement
      clone.querySelector('.zn-kanban-move')?.remove()
      clone.classList.add('zn-kanban-ghost')
      clone.style.width = `${card.offsetWidth}px`
      clone.style.pointerEvents = 'none'
      document.body.appendChild(clone)
      ghost = clone
      card.style.opacity = '0.3'
      moveGhost(lastX, lastY)
      autoScrollRaf = requestAnimationFrame(autoScroll)
    }

    const moveGhost = (x: number, y: number): void => {
      if (!ghost) return
      ghost.style.left = `${x - offsetX}px`
      ghost.style.top = `${y - offsetY}px`
    }

    const columnUnder = (x: number, y: number): HTMLElement | null => {
      const el = document.elementFromPoint(x, y)
      return el instanceof HTMLElement ? el.closest<HTMLElement>('[data-kanban-column-id]') : null
    }

    const highlight = (x: number, y: number): void => {
      const col = columnUnder(x, y)
      const id = col?.getAttribute('data-kanban-column-id') ?? null
      if (col && id && id !== sourceCol) {
        clearHighlight(col)
        col.classList.add('zn-kanban-drop-target')
      } else {
        clearHighlight()
      }
    }

    const autoScroll = (): void => {
      if (!dragging) return
      const b = boardEl()
      if (b) {
        const r = b.getBoundingClientRect()
        const edge = 44
        if (lastX < r.left + edge) b.scrollLeft -= 14
        else if (lastX > r.right - edge) b.scrollLeft += 14
      }
      autoScrollRaf = requestAnimationFrame(autoScroll)
    }

    const onPointerDown = (e: PointerEvent): void => {
      if (dragging) return
      const target = e.target as HTMLElement | null
      if (!target || typeof target.closest !== 'function') return
      const c = target.closest<HTMLElement>('[data-kanban-task-id]')
      if (!c) return
      // Leave interactive controls (checkbox, ↔ handle, links) to their own taps.
      if (target.closest('button, a, input, [role="checkbox"]')) return
      // Own the gesture — app-core's card drag can't function on touch.
      e.stopPropagation()
      card = c
      taskId = c.getAttribute('data-kanban-task-id')
      sourceCol =
        c.closest<HTMLElement>('[data-kanban-column-id]')?.getAttribute('data-kanban-column-id') ??
        null
      pointerId = e.pointerId
      startX = lastX = e.clientX
      startY = lastY = e.clientY
      const rect = c.getBoundingClientRect()
      offsetX = e.clientX - rect.left
      offsetY = e.clientY - rect.top
      timer = window.setTimeout(() => {
        timer = 0
        startDrag()
      }, 350)
    }

    const onPointerMove = (e: PointerEvent): void => {
      if (pointerId !== -1 && e.pointerId !== pointerId) return
      lastX = e.clientX
      lastY = e.clientY
      if (!dragging) {
        // A move before the long-press fires means the user is scrolling.
        if (timer && Math.hypot(e.clientX - startX, e.clientY - startY) > 10) {
          window.clearTimeout(timer)
          timer = 0
          card = null
          taskId = null
          pointerId = -1
        }
        return
      }
      moveGhost(e.clientX, e.clientY)
      highlight(e.clientX, e.clientY)
    }

    const onPointerUp = (e: PointerEvent): void => {
      if (pointerId !== -1 && e.pointerId !== pointerId) return
      // Drop at the release point (a pointerup can land slightly off the last
      // move).
      lastX = e.clientX
      lastY = e.clientY
      if (dragging) {
        const col = columnUnder(lastX, lastY)?.getAttribute('data-kanban-column-id') ?? null
        if (col && col !== sourceCol && taskId) kanbanApplyMove(taskId, col)
        suppressClickUntil = Date.now() + 400
      }
      reset()
    }

    // Only block native scroll once a drag is actually underway.
    const onTouchMove = (e: TouchEvent): void => {
      if (dragging) e.preventDefault()
    }
    // Swallow the click that a finger-lift after a drag would synthesize (it
    // would otherwise open the note).
    const onClick = (e: MouseEvent): void => {
      if (Date.now() < suppressClickUntil) {
        e.preventDefault()
        e.stopPropagation()
      }
    }

    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('pointermove', onPointerMove, true)
    document.addEventListener('pointerup', onPointerUp, true)
    document.addEventListener('pointercancel', onPointerUp, true)
    document.addEventListener('touchmove', onTouchMove, { passive: false })
    document.addEventListener('click', onClick, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('pointermove', onPointerMove, true)
      document.removeEventListener('pointerup', onPointerUp, true)
      document.removeEventListener('pointercancel', onPointerUp, true)
      document.removeEventListener('touchmove', onTouchMove)
      document.removeEventListener('click', onClick, true)
      reset()
    }
  }, [])
}

interface KanbanMoveState {
  taskId: string
  groupBy: string
  targets: Array<{ id: string; label: string }>
}

function KanbanMoveSheet(): React.JSX.Element | null {
  const [state, setState] = useState<KanbanMoveState | null>(null)
  useEffect(() => {
    const onMove = (e: Event): void => {
      const detail = (e as CustomEvent<{ taskId?: string; currentCol?: string | null }>).detail
      const taskId = detail?.taskId
      if (!taskId) return
      const groupBy = useStore.getState().kanbanGroupBy
      if (groupBy === 'folder') return
      const cols = [...document.querySelectorAll<HTMLElement>('[data-kanban-column-id]')]
        .map((el) => el.getAttribute('data-kanban-column-id'))
        .filter((id): id is string => !!id)
      const targets = cols
        .filter((id) => id !== detail?.currentCol)
        .map((id) => ({ id, label: kanbanColumnLabel(groupBy, id) }))
      if (targets.length === 0) return
      setState({ taskId, groupBy, targets })
    }
    window.addEventListener('zen:kanban-move', onMove)
    return () => window.removeEventListener('zen:kanban-move', onMove)
  }, [])

  if (!state) return null

  const pick = (columnId: string): void => {
    const id = state.taskId
    setState(null)
    kanbanApplyMove(id, columnId)
  }

  return (
    <>
      <div
        className="zn-mobile-sheet-backdrop"
        onClick={() => setState(null)}
        role="presentation"
      />
      <div className="zn-mobile-sheet" role="menu" aria-label="Move task to column">
        <div className="zn-mobile-sheet-title">Move to…</div>
        <div className="zn-mobile-sheet-scroll">
          <div className="zn-mobile-sheet-group">
            {state.targets.map((t) => (
              <button
                key={t.id}
                type="button"
                className="zn-mobile-sheet-row"
                onClick={() => pick(t.id)}
              >
                <Icon d={ICONS.sidebar} />
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  )
}

/** Context-menu entries with no meaning on iOS, stripped wherever a menu
 *  opens (device-wide): there are no floating windows on iPadOS/iOS. */
const DEVICE_HIDDEN_MENU_ITEMS = new Set(['Open in Floating Window'])

function useContextMenuCleanup(): void {
  useEffect(() => {
    let raf = 0
    const apply = (): void => {
      for (const menu of document.querySelectorAll<HTMLElement>('div[role="menu"]')) {
        for (const item of menu.querySelectorAll<HTMLElement>('button, [role="menuitem"]')) {
          if (DEVICE_HIDDEN_MENU_ITEMS.has((item.textContent ?? '').trim())) item.remove()
        }
      }
    }
    const schedule = (): void => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(apply)
    }
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true })
    schedule()
    return () => {
      observer.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [])
}

/**
 * Settings → Vault → Location grows the mobile vault features (the desktop
 * switcher and remote-workspace sections are runtime-gated off there): a
 * quick-switch list of every reachable vault when there is more than one,
 * plus "New Vault…" and "Remote Vault…" actions. Mounted as a React island
 * inside the location card (mobilizer pattern, no app-core changes).
 * Switching keeps Settings open — the location card updates in place.
 */
function SettingsVaultQuickSwitch(): React.JSX.Element {
  const currentName = useStore((s) => s.vault?.name ?? null)
  const currentRoot = useStore((s) => s.vault?.root ?? '')
  const workspaceMode = useStore((s) => s.workspaceMode)
  const remoteProfileId = useStore((s) => s.remoteWorkspaceInfo?.profileId ?? null)
  const remoteProfiles = useStore((s) => s.remoteWorkspaceProfiles)
  const [entries, setEntries] = useState<MobileVaultEntry[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    void listSwitchableVaults()
      .then((v) => alive && setEntries(v))
      .catch(() => {})
    void useStore.getState().refreshRemoteWorkspaceProfiles()
    return () => {
      alive = false
    }
  }, [currentRoot])

  // Storage pref tracks the open tier through every switch path — including
  // external Files-app folders, whose friendly root varies by provider.
  const currentTier = workspaceMode === 'remote' ? 'remote' : getStoragePref()

  const run = (key: string, fn: () => Promise<unknown>): void => {
    setBusy(key)
    setError('')
    void fn()
      .catch((err) => setError(String((err as Error)?.message ?? err)))
      .finally(() => setBusy(null))
  }

  const hostOf = (baseUrl: string): string => baseUrl.replace(/^https?:\/\//, '')

  // One quiet list: name left, location right, a check on the current row —
  // the whole row is the tap target (Adib: the buttons-everywhere first cut
  // was "too busy"). Listing order is stable — switching must not reorder
  // rows under the user's finger; only the check moves.
  type Row = {
    key: string
    name: string
    loc: string
    current: boolean
    switchTo: () => Promise<unknown>
  }
  const rows: Row[] = [
    ...entries.map((e) => ({
      key: e.root,
      name: e.name,
      loc: e.tier === 'icloud' ? 'iCloud Drive' : e.tier === 'external' ? 'Folder' : 'On this device',
      current: currentTier === e.tier && e.name === currentName,
      switchTo: () => useStore.getState().openLocalVault(e.root)
    })),
    ...remoteProfiles.map((p) => {
      const host = hostOf(p.baseUrl)
      return {
        key: p.id,
        name: p.name.replace(` (${host})`, '').trim() || p.name,
        loc: host,
        current: workspaceMode === 'remote' && p.id === remoteProfileId,
        switchTo: () => useStore.getState().connectRemoteWorkspaceProfile(p.id)
      }
    })
  ]

  return (
    <div className="zn-settings-vaults">
      {error && <div className="zn-settings-vaults-error">{error}</div>}
      {rows.length > 1 &&
        rows.map((row) => (
          <button
            key={row.key}
            type="button"
            className="zn-settings-vaults-row"
            disabled={row.current || busy !== null}
            onClick={() => run(row.key, row.switchTo)}
          >
            <span className="zn-truncate">{row.name}</span>
            <span className="zn-settings-vaults-loc">
              {busy === row.key ? 'Opening…' : row.loc}
            </span>
            <span className="zn-settings-vaults-check">{row.current ? '✓' : ''}</span>
          </button>
        ))}
      <div className="zn-settings-vaults-btns">
        <button
          type="button"
          className="rounded-xl border border-paper-300/70 bg-paper-100/80 px-3.5 py-2 text-xs font-medium text-ink-800"
          disabled={busy !== null}
          onClick={() =>
            run('new', () => promptNewVault(currentTier === 'icloud' ? 'icloud' : 'local'))
          }
        >
          New Vault…
        </button>
        <button
          type="button"
          className="rounded-xl border border-paper-300/70 bg-paper-100/80 px-3.5 py-2 text-xs font-medium text-ink-800"
          disabled={busy !== null}
          onClick={() => {
            // The manager is the one canonical surface — rename, move, delete,
            // remote, external folders all live there. It replaces Settings
            // rather than stacking under it.
            useStore.getState().setSettingsOpen(false)
            window.setTimeout(() => openMobileSheet('vaults'), 30)
          }}
        >
          Manage…
        </button>
      </div>
    </div>
  )
}

function useVaultSettingsRows(): void {
  useEffect(() => {
    if (!isPhoneWidth()) return
    let container: HTMLElement | null = null
    let root: ReturnType<typeof ReactDOM.createRoot> | null = null
    const sync = (): void => {
      const host = document.querySelector<HTMLElement>(
        '[data-settings-search-id="vault-location"]'
      )
      // Settings closed: keep the root alive but detached — remounting on
      // every open (or on every SettingsModal re-render that replaces the
      // host row, e.g. a vault switch) blanks and re-fetches the island,
      // which reads as the whole card blinking. Moving the same container
      // back in preserves the live React tree and its state.
      if (!host) return
      if (container?.parentElement === host) return
      if (!container) {
        container = document.createElement('div')
        // This wrapper — not the list inside it — is the row's flex child, so
        // it is what has to claim the full line (see mobile.css).
        container.className = 'zn-settings-vaults-host'
        root = ReactDOM.createRoot(container)
        root.render(<SettingsVaultQuickSwitch />)
      }
      // The host is the desktop two-column row (label + "Change…" button),
      // which the phone stylesheet wraps into a stack. Mount between the label
      // and the row's own buttons, so the card reads location → picker list →
      // actions and mobile.css can hide those buttons in favor of the
      // island's own action group.
      const firstBtn = host.querySelector('button')
      if (firstBtn) host.insertBefore(container, firstBtn)
      else host.appendChild(container)
    }
    const observer = new MutationObserver(() => sync())
    observer.observe(document.body, { childList: true, subtree: true })
    sync()
    return () => {
      observer.disconnect()
      root?.unmount()
      container?.remove()
    }
  }, [])
}

function MobileShellRoot(): React.JSX.Element {
  usePhoneLayoutBoot()
  useDrawerAutoClose()
  useSettingsMobilizer()
  useWikilinkTapNavigation()
  useBreadcrumbDrawerNav()
  useLongPressContextMenu()
  usePlaceholderCleanup()
  useEdgeSwipeDrawer()
  useRightPanelCloseButton()
  useCalendarWeekMode()
  useDesktopCommandCleanup()
  useMobilePaletteCancel()
  useHeaderBackButton()
  useContextMenuCleanup()
  useKanbanMoveHandles()
  useKanbanCardDrag()
  useYouTubeLiteEmbeds()
  useVaultSettingsRows()
  const sheet = useMobileSheet()
  return (
    <>
      <MobileNav />
      <MobileDrawer />
      {sheet === 'vaults' && <VaultsSheet onClose={closeMobileSheet} />}
      <MobileEditorToolbar />
      <KanbanMoveSheet />
    </>
  )
}

export function mountMobileShell(): void {
  document.documentElement.classList.add('zn-mobile')
  const host = document.createElement('div')
  host.id = 'zn-mobile-shell'
  document.body.appendChild(host)
  ReactDOM.createRoot(host).render(
    <React.StrictMode>
      <MobileShellRoot />
    </React.StrictMode>
  )
}
