import { dirOf } from './note-order'
/**
 * The phone navigation drawer — a purpose-built mobile surface that REPLACES
 * app-core's desktop sidebar below 768px (which is hidden by CSS). Flat,
 * iOS-style rows over the same Zustand store: search, the vault's main
 * destinations, and a drill-down folder browser. No trees, no chevron
 * forests, no icon clusters.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { getShellSnapshot, useShellSnapshot, setNoteSortOrder, type NoteSortOrder } from '@zennotes/app-core/shell'
import { getBrowseSnapshot, useBrowseSnapshot, getBrowseDirectory, requestCreateBrowseFolder,
  requestRenameBrowseFolder, requestRenameBrowseDatabase, requestMoveBrowseDirectory,
  requestDeleteBrowseDirectory } from '@zennotes/app-core/browse'
import { useWorkspaceSnapshot, openLocalVault, pickLocalVault, refreshRemoteProfiles, connectRemoteWorkspace,
  connectRemoteProfile, changeRemoteVaultPath, deleteRemoteProfile } from '@zennotes/app-core/workspace'
import { openNote, openAppPage } from '@zennotes/app-core/navigation'
import { showSearch } from '@zennotes/app-core/commands'
import { setSettingsVisible } from '@zennotes/app-core/settings'
import { confirm as confirmApp, prompt as promptApp } from '@zennotes/app-core/dialogs'
import { captureMobileWorkspace, reportActionError } from './workspace-context'
import { Keyboard } from '@capacitor/keyboard'
import { setDrawerOpen, takeDrawerPath, useDrawerOpen } from './drawer-state'
import { openMobileSheet } from './sheet-state'
import { goHome } from './nav'
import { usePins, toggleNotePin, toggleFolderPin } from './pins'
import { archiveNote, openNoteMenu, trashNote } from './note-actions'
import { refreshVault } from './refresh'
import { SwipeRow } from './SwipeRow'
import { SheetHandle } from './SheetHandle'
import { getStoragePref } from '../bridge/icloud'
import {
  ICLOUD_VAULT_ROOT_PREFIX,
  VAULT_ROOT_PREFIX,
  currentVaultFolderName,
  listSwitchableVaults,
  renameVault,
  deleteVault,
  forgetExternalVault,
  currentExternalVaultRoot,
  type MobileVaultEntry
} from '../bridge/mobile-bridge'
import { sanitizeNoteTitle } from '../bridge/vault-core'

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

const D = {
  search: 'M21 21l-4.35-4.35M17 10.5a6.5 6.5 0 11-13 0 6.5 6.5 0 0113 0z',
  home: 'M3 10.5L12 3l9 7.5M5.5 9v11h13V9',
  tasks: 'M9 11l3 3L22 4M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11',
  quick: 'M13 2L4.5 12.5H11L10 22l8.5-10.5H12L13 2',
  tag: 'M20 10l-8.5 8.5a2 2 0 01-2.83 0L3 12.83V5a2 2 0 012-2h7.83L20 10zM7.5 7.5h.01',
  archive: 'M21 8v13H3V8M1 3h22v5H1zM10 12h4',
  trash: 'M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6',
  folder: 'M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z',
  note: 'M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9l-6-6zM14 3v6h6',
  back: 'M14.5 5l-7 7 7 7',
  settings:
    'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33h0a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51h0a1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82v0a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z',
  calendar:
    'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2z',
  database:
    'M12 8c4.97 0 9-1.34 9-3s-4.03-3-9-3-9 1.34-9 3 4.03 3 9 3zM3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3',
  sort: 'M4 6h16M4 12h10M4 18h5',
  check: 'M20 6L9 17l-5-5',
  folderPlus: 'M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7zM12 11v6M9 14h6',
  move: 'M5 8V6a2 2 0 012-2h3l2 2h7a2 2 0 012 2v10a2 2 0 01-2 2H7a2 2 0 01-2-2v-4M2 13h9m0 0l-3-3m3 3l-3 3',
  rename: 'M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z',
  link: 'M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71',
  files:
    'M19 3H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2V5a2 2 0 00-2-2zM8.5 10a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM21 15l-5-5L5 21',
  cloud: 'M17.5 19a4.5 4.5 0 001.03-8.88 6 6 0 00-11.77 1.13A3.75 3.75 0 007.25 19h10.25z',
  server:
    'M4 4h16a1 1 0 011 1v4a1 1 0 01-1 1H4a1 1 0 01-1-1V5a1 1 0 011-1zM4 14h16a1 1 0 011 1v4a1 1 0 01-1 1H4a1 1 0 01-1-1v-4a1 1 0 011-1zM7 7h.01M7 17h.01',
  phone:
    'M8 2h8a2 2 0 012 2v16a2 2 0 01-2 2H8a2 2 0 01-2-2V4a2 2 0 012-2zM12 18h.01',
  plus: 'M12 5v14M5 12h14',
  chevDown: 'M6 9l6 6 6-6',
  more: 'M6 12h.01M12 12h.01M18 12h.01',
  pencil: 'M17 3a2.85 2.85 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z',
  pin: 'M12 17v5M9 3h6l-1 7 3 2v3H7v-3l3-2-1-7z'
}

/** WKWebView leaves the soft keyboard up when a focused input unmounts
 *  without a blur — every sheet path that swaps views must call this. */
function dismissKeyboard(): void {
  ;(document.activeElement as HTMLElement | null)?.blur?.()
  void Keyboard.hide().catch(() => {})
}

// A note's path relative to the primary notes area comes from app-core's
// notePathWithinFolder, which honors vault.json `systemFolderPaths` — with
// the inbox remapped to `01 - Entry/`, a hardcoded 'inbox/' strip left every
// note un-matched and the drawer empty.

// noteComparator/dirOf live in note-order.ts, shared with the editor's
// swipe-between-notes gesture so the flick order matches the drawer's.

const SORT_OPTIONS: Array<[NoteSortOrder, string]> = [
  ['name-asc', 'Name (A–Z)'],
  ['name-desc', 'Name (Z–A)'],
  ['updated-desc', 'Recently edited'],
  ['updated-asc', 'Oldest edited'],
  ['created-desc', 'Recently created'],
  ['created-asc', 'Oldest created']
]

/**
 * Vault switcher (tap the drawer's vault name). One-tap rows for every vault
 * the phone can reach — on-device folders, every vault in the iCloud
 * container, and saved remote servers — plus "New Vault…", which asks for a
 * name and a location (iCloud / on-device). Switching routes through the store's
 * openLocalVault / connectRemoteWorkspaceProfile actions so the workspace
 * resets the same way the desktop switcher does.
 */
/** Name for a new vault (created in app storage, spec 03 default — iCloud is
 *  iOS-only so there are no location rows), plus the SAF escape hatch: open
 *  any shared-storage folder as the vault, which is what enables
 *  Syncthing/FolderSync cross-device workflows. */
function NewVaultSheet({
  onDone
}: {
  onDone: (created: boolean) => void
}): React.JSX.Element {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState<'create' | 'pick' | null>(null)
  const [error, setError] = useState('')

  const clean = sanitizeNoteTitle(name.trim())

  const cancel = (): void => {
    dismissKeyboard()
    onDone(false)
  }

  const create = (): void => {
    if (!clean || busy) return
    setBusy('create')
    setError('')
    dismissKeyboard()
    openLocalVault(`${VAULT_ROOT_PREFIX}${clean}`)
      .then(() => onDone(true))
      .catch((err) => {
        setError(String((err as Error)?.message ?? err))
        setBusy(null)
      })
  }

  // Escape hatch to shared storage: the system folder picker (SAF). The
  // picked folder itself becomes the vault, so the name field does not
  // apply; a cancelled picker returns to this sheet.
  const chooseFolder = (): void => {
    if (busy) return
    setBusy('pick')
    setError('')
    dismissKeyboard()
    const before = getShellSnapshot().vault?.root ?? null
    pickLocalVault()
      .then(() => {
        const after = getShellSnapshot().vault?.root ?? null
        if (after !== before) onDone(true)
        else setBusy(null)
      })
      .catch((err) => {
        setError(String((err as Error)?.message ?? err))
        setBusy(null)
      })
  }

  return (
    <>
      <div className="zn-mobile-sheet-backdrop" onClick={cancel} role="presentation" />
      <div className="zn-mobile-sheet" role="dialog" aria-label="New Vault">
        <SheetHandle onDismiss={cancel} />
        <div className="zn-mobile-sheet-title">New Vault</div>
        <div className="zn-mobile-sheet-scroll">
          <input
            className="zn-mobile-sheet-input"
            type="text"
            placeholder="Vault name"
            value={name}
            autoFocus
            enterKeyHint="done"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') create()
            }}
          />
          <p className="zn-mobile-sheet-note">
            Notes are plain Markdown files stored privately on this device.
          </p>
          <div className="zn-mobile-sheet-group">
            <button
              type="button"
              className="zn-mobile-sheet-row"
              disabled={busy !== null}
              onClick={chooseFolder}
            >
              <Icon d={D.folder} />
              <span className="zn-truncate">Choose Folder…</span>
              <span className="zn-mobile-sheet-row-detail">Any folder on this device</span>
            </button>
          </div>
          {busy === 'create' && <p className="zn-mobile-sheet-note">Creating…</p>}
          {busy === 'pick' && <p className="zn-mobile-sheet-note">Opening…</p>}
          {error && <p className="zn-mobile-sheet-note zn-danger">{error}</p>}
          <div className="zn-mobile-sheet-actions">
            <button type="button" onClick={cancel}>
              Cancel
            </button>
            <button
              type="button"
              className="zn-primary"
              disabled={!clean || busy !== null}
              onClick={create}
            >
              Create
            </button>
          </div>
        </div>
      </div>
    </>
  )
}

/** Ask for a name, then create+open the vault. Returns whether a vault was
 *  created (false on cancel). Shared by the Vaults sheet and the Settings
 *  quick-switch list. The `tier` argument is accepted for call-site parity
 *  with the iOS shell but Android v1 always creates in app storage. */
export function promptNewVault(_tier: 'local' | 'icloud'): Promise<boolean> {
  return new Promise((resolve) => {
    const host = document.createElement('div')
    // The sheet can be summoned over the Settings modal (z-modal: 70) — this
    // class lifts it to the app's nested-dialog layer.
    host.className = 'zn-mobile-sheet-nested'
    document.body.appendChild(host)
    const root = ReactDOM.createRoot(host)
    root.render(
      <NewVaultSheet
        onDone={(created) => {
          root.unmount()
          host.remove()
          resolve(created)
        }}
      />
    )
  })
}

/**
 * The Vaults manager — the one canonical surface for everything vault:
 * switch (tap), manage (⋯ → rename / move between tiers / delete), create
 * (New Vault…), and remote servers (connect / add / remove). Sections group
 * vaults by where they live; management flows stay inline in the sheet so
 * nothing ever stacks under a modal.
 */
type ManagerView =
  | { kind: 'list' }
  | { kind: 'vault'; entry: MobileVaultEntry }
  | { kind: 'rename'; entry: MobileVaultEntry }
  | { kind: 'delete'; entry: MobileVaultEntry }
  | { kind: 'remote'; id: string; name: string; host: string; current: boolean }

const TIER_SECTIONS = [
  { tier: 'local', label: 'On This Device' },
  { tier: 'external', label: 'Folders' }
] as const

export function VaultsSheet({ onClose }: { onClose: () => void }): React.JSX.Element {
  // The open vault is matched by its folder name, which is what an entry's
  // `name` is: rename and delete act on the folder, so the guards below must
  // hold for the folder that is open whatever the vault is called. The
  // bridge names the folder; the snapshot's vault name is the display name
  // (ZenNotes #692), which is what the rows show: the snapshot's for the
  // open vault (the shell resolves it) and each entry's for the others.
  const currentDisplayName = useShellSnapshot().vault?.name ?? null
  const currentFolder = currentVaultFolderName()
  const { mode: workspaceMode, remoteProfileId, remoteProfiles } = useWorkspaceSnapshot()
  const [entries, setEntries] = useState<MobileVaultEntry[] | null>(null)
  const [view, setView] = useState<ManagerView>({ kind: 'list' })
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [renameTo, setRenameTo] = useState('')

  const reload = (): void => {
    void listSwitchableVaults()
      .then(setEntries)
      .catch(() => setEntries([]))
  }

  useEffect(() => {
    reload()
    void refreshRemoteProfiles()
  }, [])

  // The storage pref tracks whichever tier is open (every switch path sets
  // it), so it names the current tier reliably — including external folders,
  // whose friendly root string varies by provider.
  const currentTier = workspaceMode === 'remote' ? 'remote' : getStoragePref()
  const isCurrent = (e: MobileVaultEntry): boolean =>
    currentTier === e.tier &&
    e.name === currentFolder &&
    // Picked folders may share a folder name: the root token decides.
    (e.tier !== 'external' || e.root === currentExternalVaultRoot())
  const shownName = (e: MobileVaultEntry): string =>
    (isCurrent(e) ? currentDisplayName : null) ?? e.displayName ?? e.name

  /** Switch flows close the sheet and drawer on success. */
  const act = (key: string, fn: () => Promise<unknown>): void => {
    setBusy(key)
    setError('')
    void fn()
      .then(() => {
        onClose()
        setDrawerOpen(false)
      })
      .catch((err) => {
        setError(String((err as Error)?.message ?? err))
        setBusy(null)
      })
  }

  /** Management flows stay in the sheet: back to the (re-listed) list. */
  const manage = (key: string, fn: () => Promise<unknown>): void => {
    setBusy(key)
    setError('')
    void fn()
      .then(() => {
        setBusy(null)
        setView({ kind: 'list' })
        reload()
      })
      .catch((err) => {
        setError(String((err as Error)?.message ?? err))
        setBusy(null)
      })
  }

  const submitRename = (entry: MobileVaultEntry): void => {
    if (entry.tier === 'external') return
    const clean = sanitizeNoteTitle(renameTo.trim())
    dismissKeyboard()
    if (!clean || clean === entry.name) {
      setView({ kind: 'vault', entry })
      return
    }
    manage('rename', async () => {
      await renameVault(entry, clean)
    })
  }

  const createVault = (): void => {
    const tier = currentTier === 'icloud' ? 'icloud' : 'local'
    // The New Vault sheet mounts in its own root, so it can come up in the
    // same frame this sheet closes — any delay here reads as lag.
    onClose()
    void promptNewVault(tier).then((created) => {
      if (created) setDrawerOpen(false)
    })
  }

  const addRemote = (): void => {
    onClose()
    // Let the sheet unmount so the guided URL/token prompts get focus.
    window.setTimeout(() => {
      void connectRemoteWorkspace()
    }, 30)
  }

  const hostOf = (baseUrl: string): string => baseUrl.replace(/^https?:\/\//, '')
  const remoteName = (name: string, baseUrl: string): string =>
    name.replace(` (${hostOf(baseUrl)})`, '').trim() || hostOf(baseUrl)

  const busyLabel =
    busy === null
      ? null
      : busy === 'delete'
        ? 'Deleting…'
        : busy === 'move'
          ? 'Moving notes…'
          : busy === 'rename'
            ? 'Renaming…'
            : busy === 'remove'
              ? 'Removing…'
              : 'Opening…'

  const backRow = (
    <div className="zn-mobile-sheet-group">
      <button type="button" className="zn-mobile-sheet-row" onClick={() => setView({ kind: 'list' })}>
        <Icon d={D.back} />
        All Vaults
      </button>
    </div>
  )

  return (
    <>
      <div className="zn-mobile-sheet-backdrop" onClick={onClose} role="presentation" />
      <div className="zn-mobile-sheet" role="dialog" aria-label="Vaults">
        <SheetHandle onDismiss={onClose} />
        <div className="zn-mobile-sheet-title">Vaults</div>
        <div className="zn-mobile-sheet-scroll">
          {busyLabel !== null && <p className="zn-mobile-sheet-note">{busyLabel}</p>}
          {error && <p className="zn-mobile-sheet-note zn-danger">{error}</p>}
          {busy === null && view.kind === 'list' && entries === null && (
            <p className="zn-mobile-sheet-note">Looking for vaults…</p>
          )}

          {busy === null && view.kind === 'list' && entries !== null && (
            <>
              {TIER_SECTIONS.map(({ tier, label }) => {
                const group = entries.filter((e) => e.tier === tier)
                if (group.length === 0) return null
                return (
                  <React.Fragment key={tier}>
                    <div className="zn-mobile-sheet-section">{label}</div>
                    <div className="zn-mobile-sheet-group">
                      {group.map((entry) => {
                        const current = isCurrent(entry)
                        return (
                          <div className="zn-mobile-sheet-rowline" key={entry.root}>
                            <button
                              type="button"
                              className="zn-mobile-sheet-row"
                              disabled={current}
                              onClick={() =>
                                act(`switch:${entry.root}`, () =>
                                  openLocalVault(entry.root)
                                )
                              }
                            >
                              <span className="zn-truncate">{shownName(entry)}</span>
                              {current && <span className="zn-mobile-sheet-row-check">✓</span>}
                            </button>
                            <button
                              type="button"
                              className="zn-mobile-sheet-row-more"
                              aria-label={`Manage ${shownName(entry)}`}
                              onClick={() => {
                                setError('')
                                setView({ kind: 'vault', entry })
                              }}
                            >
                              <Icon d={D.more} />
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  </React.Fragment>
                )
              })}

              {remoteProfiles.length > 0 && (
                <>
                  <div className="zn-mobile-sheet-section">Remote</div>
                  <div className="zn-mobile-sheet-group">
                    {remoteProfiles.map((profile) => {
                      const current =
                        workspaceMode === 'remote' && profile.id === remoteProfileId
                      return (
                        <div className="zn-mobile-sheet-rowline" key={profile.id}>
                          <button
                            type="button"
                            className="zn-mobile-sheet-row"
                            disabled={current}
                            onClick={() =>
                              act(`switch:${profile.id}`, () =>
                                connectRemoteProfile(profile.id)
                              )
                            }
                          >
                            <span className="zn-truncate">
                              {remoteName(profile.name, profile.baseUrl)}
                            </span>
                            <span className="zn-mobile-sheet-row-detail">
                              {current ? 'Connected' : hostOf(profile.baseUrl)}
                            </span>
                            {current && <span className="zn-mobile-sheet-row-check">✓</span>}
                          </button>
                          <button
                            type="button"
                            className="zn-mobile-sheet-row-more"
                            aria-label={`Manage ${profile.name}`}
                            onClick={() => {
                              setError('')
                              setView({
                                kind: 'remote',
                                id: profile.id,
                                name: remoteName(profile.name, profile.baseUrl),
                                host: hostOf(profile.baseUrl),
                                current
                              })
                            }}
                          >
                            <Icon d={D.more} />
                          </button>
                        </div>
                      )
                    })}
                  </div>
                </>
              )}

              <div className="zn-mobile-sheet-group zn-mobile-sheet-group-spaced">
                <button type="button" className="zn-mobile-sheet-row" onClick={createVault}>
                  <Icon d={D.plus} />
                  New Vault…
                </button>
                <button type="button" className="zn-mobile-sheet-row" onClick={addRemote}>
                  <Icon d={D.server} />
                  Add Remote Vault…
                </button>
              </div>
            </>
          )}

          {busy === null && view.kind === 'vault' && (
            <>
              {backRow}
              <p className="zn-mobile-sheet-note">
                “{shownName(view.entry)}”
                {shownName(view.entry) !== view.entry.name ? ` (folder ${view.entry.name})` : ''},{' '}
                {view.entry.tier === 'icloud'
                  ? 'iCloud Drive'
                  : view.entry.tier === 'external'
                    ? 'a folder on this device'
                    : 'on this device'}
                {isCurrent(view.entry) ? ' · currently open' : ''}
              </p>
              <div className="zn-mobile-sheet-group">
                {!isCurrent(view.entry) && (
                  <button
                    type="button"
                    className="zn-mobile-sheet-row"
                    onClick={() =>
                      act(`switch:${view.entry.root}`, () =>
                        openLocalVault(view.entry.root)
                      )
                    }
                  >
                    <Icon d={D.check} />
                    Open This Vault
                  </button>
                )}
                {view.entry.tier !== 'external' && (
                  <button
                    type="button"
                    className="zn-mobile-sheet-row"
                    onClick={() => {
                      setRenameTo(view.entry.name)
                      setError('')
                      setView({ kind: 'rename', entry: view.entry })
                    }}
                  >
                    <Icon d={D.pencil} />
                    Rename…
                  </button>
                )}
              </div>
              <div className="zn-mobile-sheet-group">
                {view.entry.tier === 'external' ? (
                  <button
                    type="button"
                    className="zn-mobile-sheet-row zn-danger"
                    disabled={isCurrent(view.entry)}
                    onClick={() => manage('remove', async () => forgetExternalVault(view.entry.root))}
                  >
                    <Icon d={D.trash} />
                    Remove from List
                    {isCurrent(view.entry) && (
                      <span className="zn-mobile-sheet-row-detail">Switch vaults first</span>
                    )}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="zn-mobile-sheet-row zn-danger"
                    disabled={isCurrent(view.entry)}
                    onClick={() => {
                      setError('')
                      setView({ kind: 'delete', entry: view.entry })
                    }}
                  >
                    <Icon d={D.trash} />
                    Delete Vault…
                    {isCurrent(view.entry) && (
                      <span className="zn-mobile-sheet-row-detail">Switch vaults first</span>
                    )}
                  </button>
                )}
              </div>
              {view.entry.tier === 'external' && (
                <p className="zn-mobile-sheet-note">
                  This folder belongs to you — removing it from the list never deletes its
                  files. Rename or move it in your file manager.
                </p>
              )}
            </>
          )}

          {busy === null && view.kind === 'rename' && (
            <>
              <p className="zn-mobile-sheet-note">Rename “{view.entry.name}”</p>
              <input
                className="zn-mobile-sheet-input"
                type="text"
                value={renameTo}
                autoFocus
                enterKeyHint="done"
                onChange={(e) => setRenameTo(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitRename(view.entry)
                }}
              />
              <div className="zn-mobile-sheet-actions">
                <button
                  type="button"
                  onClick={() => {
                    dismissKeyboard()
                    setView({ kind: 'vault', entry: view.entry })
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="zn-primary"
                  disabled={!sanitizeNoteTitle(renameTo.trim())}
                  onClick={() => submitRename(view.entry)}
                >
                  Rename
                </button>
              </div>
            </>
          )}

          {busy === null && view.kind === 'delete' && (
            <>
              <p className="zn-mobile-sheet-note">
                Delete “{view.entry.name}”?{' '}
                {view.entry.tier === 'icloud'
                  ? 'Its notes will be removed from iCloud Drive — on every device.'
                  : 'All of its notes will be deleted from this device.'}{' '}
                This cannot be undone.
              </p>
              <div className="zn-mobile-sheet-actions">
                <button
                  type="button"
                  onClick={() => setView({ kind: 'vault', entry: view.entry })}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="zn-destructive"
                  onClick={() => manage('delete', () => deleteVault(view.entry))}
                >
                  Delete Vault
                </button>
              </div>
            </>
          )}

          {busy === null && view.kind === 'remote' && (
            <>
              {backRow}
              <p className="zn-mobile-sheet-note">
                “{view.name}” — {view.host}
                {view.current ? ' · connected' : ''}
              </p>
              <div className="zn-mobile-sheet-group">
                {!view.current && (
                  <button
                    type="button"
                    className="zn-mobile-sheet-row"
                    onClick={() =>
                      act(`switch:${view.id}`, () =>
                        connectRemoteProfile(view.id)
                      )
                    }
                  >
                    <Icon d={D.check} />
                    Connect
                  </button>
                )}
                {view.current && (
                  <button
                    type="button"
                    className="zn-mobile-sheet-row"
                    onClick={() => {
                      onClose()
                      // Server-side folder browser renders as a modal — leave
                      // the sheet first so it gets focus.
                      window.setTimeout(() => {
                        void changeRemoteVaultPath()
                      }, 30)
                    }}
                  >
                    <Icon d={D.folder} />
                    Change Vault Folder…
                  </button>
                )}
                <button
                  type="button"
                  className="zn-mobile-sheet-row zn-danger"
                  onClick={() =>
                    manage('remove', () =>
                      deleteRemoteProfile(view.id)
                    )
                  }
                >
                  <Icon d={D.trash} />
                  Remove from List
                </button>
              </div>
              <p className="zn-mobile-sheet-note">
                Removing a remote vault only forgets the saved connection — nothing on the
                server is touched.
              </p>
            </>
          )}
        </div>
      </div>
    </>
  )
}

export function MobileDrawer(): React.JSX.Element | null {
  const open = useDrawerOpen()
  const browse = useBrowseSnapshot()
  const vaultName = browse.vault?.name ?? 'ZenNotes'
  const vaultRoot = browse.vault?.root ?? null
  const pins = usePins(vaultRoot)
  const { daily: dailyDir, weekly: weeklyDir, monthly: monthlyDir } = browse.dateDirectories
  const noteSortOrder = browse.noteSortOrder
  const dateDirs = useMemo(() => {
    const dirs = new Set<string>()
    if (dailyDir) dirs.add(dailyDir)
    if (weeklyDir) dirs.add(weeklyDir)
    if (monthlyDir) dirs.add(monthlyDir)
    return dirs
  }, [dailyDir, weeklyDir, monthlyDir])
  const [path, setPath] = useState('')

  // On each open, jump to the folder a breadcrumb tap requested ('' for a
  // plain FAB/edge-swipe open). Consumed so it doesn't leak into later opens.
  useEffect(() => {
    if (open) setPath(takeDrawerPath())
  }, [open])

  const { childFolders, childDatabases, childNotes } = useMemo(() => {
    const rows = getBrowseDirectory(browse, path, pins)
    return {
      childFolders: rows.folders.map(row => [row.directory, row.title] as [string, string]),
      childDatabases: rows.databases.map(row => [row.path, row.title, row.directory] as [string, string, string]),
      childNotes: [...rows.notes]
    }
  }, [browse, path, pins])

  if (!open) return null

  const close = (): void => {
    setDrawerOpen(false)
    setPath('')
  }

  const go = (action: () => unknown): void => {
    close()
    window.setTimeout(() => void action(), 30)
  }


  return (
    <>
    <MobileDrawerBody
      vaultName={vaultName}
      vaultRoot={vaultRoot}
      pinnedNotes={pins.notes}
      pinnedFolders={pins.folders}
      dailyDir={dailyDir}
      weeklyDir={weeklyDir}
      monthlyDir={monthlyDir}
      dateDirs={dateDirs}
      path={path}
      setPath={setPath}
      childFolders={childFolders}
      childDatabases={childDatabases}
      childNotes={childNotes}
      noteSortOrder={noteSortOrder}
      close={close}
      go={go}
      onOpenVaults={() => openMobileSheet('vaults')}
    />
    </>
  )
}

/** Long-press (500ms) handler props for destructive row actions. Pointer
 *  events cover both real touches and simulated mouse input; a 12px movement
 *  threshold keeps scrolling from triggering it. */
function useLongPress(): (fn: () => void) => {
  onPointerDown: (e: React.PointerEvent) => void
  onPointerMove: (e: React.PointerEvent) => void
  onPointerUp: () => void
  onPointerCancel: () => void
  onContextMenu: (e: React.MouseEvent) => void
  onClickCapture: (e: React.MouseEvent) => void
} {
  const timer = useRef<number | null>(null)
  const fired = useRef(false)
  const start = useRef({ x: 0, y: 0 })
  const clear = (): void => {
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = null
  }
  return (fn: () => void) => ({
    onPointerDown: (e: React.PointerEvent) => {
      fired.current = false
      start.current = { x: e.clientX, y: e.clientY }
      clear()
      timer.current = window.setTimeout(() => {
        fired.current = true
        fn()
      }, 500)
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (!timer.current) return
      const dx = e.clientX - start.current.x
      const dy = e.clientY - start.current.y
      if (dx * dx + dy * dy > 144) clear()
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault()
    },
    onClickCapture: (e: React.MouseEvent) => {
      // Swallow the tap that ends a long-press.
      if (fired.current) {
        e.preventDefault()
        e.stopPropagation()
        fired.current = false
      }
    }
  })
}

function MobileDrawerBody(props: {
  vaultName: string
  vaultRoot: string | null
  pinnedNotes: string[]
  pinnedFolders: string[]
  onOpenVaults: () => void
  dailyDir: string | null
  weeklyDir: string | null
  monthlyDir: string | null
  dateDirs: Set<string>
  path: string
  setPath: (p: string) => void
  childFolders: Array<[string, string]>
  childDatabases: Array<[string, string, string]>
  childNotes: Array<{ path: string; title: string }>
  noteSortOrder: NoteSortOrder
  close: () => void
  go: (action: () => unknown) => void
}): React.JSX.Element {
  const {
    vaultName,
    vaultRoot,
    pinnedNotes,
    pinnedFolders,
    dailyDir,
    weeklyDir,
    monthlyDir,
    dateDirs,
    path,
    setPath,
    childFolders,
    childDatabases,
    childNotes,
    noteSortOrder,
    close,
    go
  } = props
  const lp = useLongPress()
  const [sortOpen, setSortOpen] = useState(false)
  // Long-pressing a row opens its action sheet — the phone's right-click
  // (Discord folder feedback). Notes open the shell-wide note sheet
  // (note-actions.tsx, shared with app-core's lists); folders and databases
  // get Rename/Move/Delete here. Prompts overlay the open drawer (Modal layers above
  // z-49), so the drawer stays put and its list refreshes in place via the
  // vault change events.
  const [folderMenu, setFolderMenu] = useState<{ kind: 'folder' | 'database'; subpath: string; name: string; host: ReturnType<typeof captureMobileWorkspace> } | null>(null)

  const pinNote = (notePath: string): void => {
    if (!vaultRoot) return
    toggleNotePin(
      vaultRoot,
      notePath,
      getShellSnapshot().notes.map((n) => n.path)
    )
  }

  const pinFolder = (subpath: string): void => {
    if (!vaultRoot) return
    toggleFolderPin(
      vaultRoot,
      subpath,
      getBrowseSnapshot().folders.map(row => row.directory)
    )
  }

  // Pull-to-refresh on the scroll area: pull down from the top to rescan the
  // vault and kick cloud sync — the drawer is where a remote/cloud user goes
  // to ask "is this list current?".
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [pull, setPull] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const pullTouch = useRef<{ y: number; active: boolean } | null>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const PULL_TRIGGER = 64
    const onStart = (e: TouchEvent): void => {
      if (e.touches.length !== 1 || refreshing) return
      pullTouch.current = { y: e.touches[0]!.clientY, active: false }
    }
    const onMove = (e: TouchEvent): void => {
      const t = pullTouch.current
      if (!t || e.touches.length !== 1) return
      const dy = e.touches[0]!.clientY - t.y
      if (!t.active) {
        // Only claim the gesture when the list is already at the top and the
        // pull is clearly downward; otherwise it's a normal scroll.
        if (el.scrollTop > 0 || dy < 8) {
          if (el.scrollTop > 0) pullTouch.current = null
          return
        }
        t.active = true
      }
      e.preventDefault()
      setPull(Math.max(0, Math.min(dy / 2, 96)))
    }
    const onEnd = (): void => {
      const t = pullTouch.current
      pullTouch.current = null
      if (!t?.active) return
      setPull((current) => {
        if (current >= PULL_TRIGGER / 2 + 8) {
          setRefreshing(true)
          void refreshVault().finally(() => {
            setRefreshing(false)
          })
        }
        return 0
      })
    }
    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', onEnd)
    el.addEventListener('touchcancel', onEnd)
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onEnd)
    }
  }, [refreshing])

  const renameFolderFromDrawer = (subpath: string, _name: string): void => {
    const host = folderMenu?.host ?? captureMobileWorkspace()
    const rename = folderMenu?.kind === 'database' ? requestRenameBrowseDatabase : requestRenameBrowseFolder
    setFolderMenu(null)
    void rename(host, subpath).catch(reportActionError)
  }
  const newFolderHere = (): void => {
    void requestCreateBrowseFolder(captureMobileWorkspace(), path).catch(reportActionError)
  }
  // Core keeps the leaf name (a database keeps its .base suffix) and carries
  // tabs, folder icons, favorites and manual order to the new path. Folder
  // pins are keyed by subpath and are left alone, as Rename leaves them: an
  // orphaned pin never matches a row and is pruned on the next toggle.
  const moveFolderFromDrawer = (subpath: string): void => {
    const host = folderMenu?.host ?? captureMobileWorkspace()
    setFolderMenu(null)
    void requestMoveBrowseDirectory(host, subpath).catch(reportActionError)
  }
  const deleteFolder = (subpath: string, _name: string): void => {
    const host = folderMenu?.host ?? captureMobileWorkspace()
    void requestDeleteBrowseDirectory(host, subpath).catch(reportActionError)
  }

  return (
    <>
      <div className="zn-mobile-backdrop" onClick={close} role="presentation" />
      <nav className="zn-mobile-drawer" aria-label="Vault navigation">
        <button
          type="button"
          className="zn-mobile-drawer-header"
          aria-label="Switch vault"
          onClick={props.onOpenVaults}
        >
          <span className="zn-truncate">{vaultName}</span>
          <span className="zn-mobile-drawer-header-chev">
            <Icon d={D.chevDown} />
          </span>
        </button>

        <button type="button" className="zn-mobile-drawer-search" onClick={() => go(() => showSearch())}>
          <Icon d={D.search} />
          Search notes
        </button>

        <div className="zn-mobile-drawer-scroll" ref={scrollRef}>
          {(pull > 0 || refreshing) && (
            <div
              className={`zn-mobile-drawer-refresh${refreshing ? ' is-refreshing' : ''}`}
              style={refreshing ? undefined : { height: pull }}
              aria-live="polite"
            >
              <span className="zn-mobile-drawer-refresh-spinner" aria-hidden="true" />
              {refreshing ? 'Refreshing…' : pull >= 40 ? 'Release to refresh' : ''}
            </div>
          )}
          {path === '' ? (
            <div className="zn-mobile-drawer-group">
              {/* Views like Tasks/Tags have no back chevron (that's a note-header
                  affordance), so the drawer is the guaranteed way Home. */}
              <button type="button" onClick={() => go(() => goHome())}>
                <Icon d={D.home} />
                Home
              </button>
              <button type="button" onClick={() => go(() => openAppPage('tasks'))}>
                <Icon d={D.tasks} />
                Tasks
              </button>
              <button type="button" onClick={() => go(() => openAppPage('quick-notes'))}>
                <Icon d={D.quick} />
                Quick Notes
              </button>
              {dailyDir && (
                <button type="button" onClick={() => setPath(dailyDir)}>
                  <Icon d={D.calendar} />
                  <span className="zn-truncate">Daily Notes</span>
                  <span className="zn-mobile-drawer-chevron">›</span>
                </button>
              )}
              {weeklyDir && (
                <button type="button" onClick={() => setPath(weeklyDir)}>
                  <Icon d={D.calendar} />
                  <span className="zn-truncate">Weekly Notes</span>
                  <span className="zn-mobile-drawer-chevron">›</span>
                </button>
              )}
              {monthlyDir && (
                <button type="button" onClick={() => setPath(monthlyDir)}>
                  <Icon d={D.calendar} />
                  <span className="zn-truncate">Monthly Notes</span>
                  <span className="zn-mobile-drawer-chevron">›</span>
                </button>
              )}
              <button type="button" onClick={() => go(() => openAppPage('tags'))}>
                <Icon d={D.tag} />
                Tags
              </button>
              {/* The assets table only exists as a pane tab (zen://assets) —
                  the palette's "Go to Files" drives the desktop sidebar list,
                  which phones don't render, so this row is the phone's way in. */}
              <button type="button" onClick={() => go(() => openAppPage('assets'))}>
                <Icon d={D.files} />
                Files
              </button>
              <button type="button" onClick={() => go(() => openAppPage('archive'))}>
                <Icon d={D.archive} />
                Archive
              </button>
              <button type="button" onClick={() => go(() => openAppPage('trash'))}>
                <Icon d={D.trash} />
                Trash
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="zn-mobile-drawer-back"
              onClick={() => setPath(dirOf(path))}
            >
              <Icon d={D.back} />
              {dirOf(path) === '' ? 'All notes' : (dirOf(path).split('/').pop() ?? '')}
            </button>
          )}

          <div className="zn-mobile-drawer-section">
            <span className="zn-truncate">
              {path === '' ? 'Notes' : (path.split('/').pop() ?? path)}
            </span>
            <button
              type="button"
              className={`zn-mobile-drawer-sort${sortOpen ? ' is-open' : ''}`}
              aria-label="Sort notes"
              aria-expanded={sortOpen}
              onClick={() => setSortOpen((v) => !v)}
            >
              <Icon d={D.sort} />
            </button>
          </div>
          {sortOpen && (
            <div className="zn-mobile-drawer-sortmenu" role="menu" aria-label="Sort order">
              {SORT_OPTIONS.map(([order, label]) => (
                <button
                  key={order}
                  type="button"
                  role="menuitemradio"
                  aria-checked={noteSortOrder === order}
                  className={noteSortOrder === order ? 'is-active' : ''}
                  onClick={() => {
                    setNoteSortOrder(order)
                    setSortOpen(false)
                  }}
                >
                  <span className="zn-truncate">{label}</span>
                  {noteSortOrder === order && <Icon d={D.check} />}
                </button>
              ))}
            </div>
          )}
          <div className="zn-mobile-drawer-group">
            {childFolders.map(([subpath, name]) => {
              const isPinned = pinnedFolders.includes(subpath)
              return (
                <SwipeRow
                  key={subpath}
                  leftActions={[]}
                  pinned={isPinned}
                  onPinSwipe={() => pinFolder(subpath)}
                >
                  <button
                    type="button"
                    onClick={() => setPath(subpath)}
                    {...lp(() => setFolderMenu({ kind: 'folder', subpath, name, host: captureMobileWorkspace() }))}
                  >
                    <Icon d={dateDirs.has(subpath) ? D.calendar : D.folder} />
                    <span className="zn-truncate">{name}</span>
                    {isPinned && (
                      <span className="zn-mobile-drawer-pin" aria-label="Pinned">
                        <Icon d={D.pin} />
                      </span>
                    )}
                    <span className="zn-mobile-drawer-chevron">›</span>
                  </button>
                </SwipeRow>
              )
            })}
            {childDatabases.map(([tabPath, title, subpath]) => (
              <button
                key={tabPath}
                type="button"
                onClick={() => go(() => openNote(tabPath))}
                {...lp(() => setFolderMenu({ kind: 'database', subpath, name: title, host: captureMobileWorkspace() }))}
              >
                <Icon d={D.database} />
                <span className="zn-truncate">{title}</span>
              </button>
            ))}
            {childNotes.map((n) => {
              const isPinned = pinnedNotes.includes(n.path)
              return (
                <SwipeRow
                  key={n.path}
                  leftActions={[
                    {
                      label: 'Archive',
                      icon: <Icon d={D.archive} />,
                      onAction: () => archiveNote(n.path)
                    },
                    {
                      label: 'Delete',
                      icon: <Icon d={D.trash} />,
                      danger: true,
                      onAction: () => trashNote(n.path, n.title)
                    }
                  ]}
                  pinned={isPinned}
                  onPinSwipe={() => pinNote(n.path)}
                >
                  <button
                    type="button"
                    onClick={() => go(() => openNote(n.path))}
                    {...lp(() => openNoteMenu({ path: n.path, title: n.title, kind: 'note' }))}
                  >
                    <Icon d={D.note} />
                    <span className="zn-truncate">{n.title}</span>
                    {isPinned && (
                      <span className="zn-mobile-drawer-pin" aria-label="Pinned">
                        <Icon d={D.pin} />
                      </span>
                    )}
                  </button>
                </SwipeRow>
              )
            })}
            {childFolders.length === 0 && childDatabases.length === 0 && childNotes.length === 0 && (
              <div className="zn-mobile-drawer-empty">No notes here yet</div>
            )}
            <button
              type="button"
              className="zn-mobile-drawer-newfolder"
              onClick={newFolderHere}
            >
              <Icon d={D.folderPlus} />
              New folder
            </button>
          </div>
        </div>

        {folderMenu && (
          <>
            <div
              className="zn-mobile-sheet-backdrop"
              onClick={() => setFolderMenu(null)}
              role="presentation"
            />
            <div
              className="zn-mobile-sheet"
              role="menu"
              aria-label={folderMenu.kind === 'database' ? 'Database actions' : 'Folder actions'}
            >
              <SheetHandle onDismiss={() => setFolderMenu(null)} />
              <div className="zn-mobile-sheet-title zn-truncate">{folderMenu.name}</div>
              <div className="zn-mobile-sheet-scroll">
                <div className="zn-mobile-sheet-group">
                  {folderMenu.kind === 'folder' && (
                    <button
                      type="button"
                      className="zn-mobile-sheet-row"
                      onClick={() => {
                        const sp = folderMenu.subpath
                        setFolderMenu(null)
                        pinFolder(sp)
                      }}
                    >
                      <Icon d={D.pin} />
                      {pinnedFolders.includes(folderMenu.subpath) ? 'Unpin' : 'Pin'}
                    </button>
                  )}
                  <button
                    type="button"
                    className="zn-mobile-sheet-row"
                    onClick={() => renameFolderFromDrawer(folderMenu.subpath, folderMenu.name)}
                  >
                    <Icon d={D.rename} />
                    Rename
                  </button>
                  <button
                    type="button"
                    className="zn-mobile-sheet-row"
                    onClick={() => moveFolderFromDrawer(folderMenu.subpath)}
                  >
                    <Icon d={D.move} />
                    Move to…
                  </button>
                  <button
                    type="button"
                    className="zn-mobile-sheet-row zn-danger"
                    onClick={() => {
                      const { subpath, name } = folderMenu
                      setFolderMenu(null)
                      deleteFolder(subpath, name)
                    }}
                  >
                    <Icon d={D.trash} />
                    Delete
                  </button>
                </div>
              </div>
            </div>
          </>
        )}

        <div className="zn-mobile-drawer-footer">
          <button type="button" onClick={() => go(() => setSettingsVisible(true))}>
            <Icon d={D.settings} />
            Settings
          </button>
        </div>
      </nav>
    </>
  )
}
