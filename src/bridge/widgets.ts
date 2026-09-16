/**
 * Widget publisher: keeps the snapshot the native widgets render
 * (widget-snapshot.ts is the contract) in step with the store. Same code as
 * the iPhone shell's; the only Android difference is the pins key, which
 * this shell derives from the vault root (note-actions.tsx does the same).
 *
 * Sources of change are the note index (every rescan and vault mutation
 * replaces `notes`), the shared task cache, the drawer's pins, the active
 * vault, and the theme. Each publish re-renders every placed widget, so the
 * first change after a quiet spell goes out almost at once and edits that
 * keep landing (every autosave bumps a note's updatedAt) are coalesced to
 * one publish per interval; backgrounding flushes whatever is pending so
 * the Home Screen is current the moment the user leaves.
 *
 * Task freshness is this module's job too: app-core rescans a note's tasks
 * on change only while a tasks surface is on screen (store.ts,
 * `tasksSurfaceVisible`), which on the phone is rarely the case while
 * editing. Notes whose updatedAt moved get a per-note rescan; a vault switch
 * (or a big batch, e.g. a folder vault landing many files) gets one full scan.
 */
import { App as CapApp } from '@capacitor/app'
import { Capacitor, registerPlugin } from '@capacitor/core'
import { getShellSnapshot, subscribeShell, type ShellSnapshot } from '@zennotes/app-core/shell'
import { getTasksSnapshot, subscribeTasks, refreshTasks, getTodayTasks, type TasksSnapshot } from '@zennotes/app-core/tasks'
import { subscribeSettings } from '@zennotes/app-core/settings'
import { toIsoDateLocal } from '@zennotes/shared-domain/tasks'
import { isMobileNoteIndexReady } from './mobile-bridge'
import { getPinnedNotes, subscribePins } from '../ui-mobile/pins'
import {
  WIDGET_SNAPSHOT_VERSION,
  selectWidgetNotes,
  selectWidgetTasks,
  themeFromTokens,
  type WidgetSnapshot,
  type WidgetTheme
} from './widget-snapshot'

interface ZenWidgetsPlugin {
  update(options: { snapshot: string }): Promise<void>
  clear(): Promise<void>
  /** The newest `zennotes://` link that launched or woke this process, once
   *  (deep-links.ts). Null when the app was opened normally. */
  consumeLaunchLink(): Promise<{ url: string | null }>
}

export const ZenWidgets = registerPlugin<ZenWidgetsPlugin>('ZenWidgets')

const PUBLISH_DEBOUNCE_MS = 400
const PUBLISH_MIN_INTERVAL_MS = 8000
/** Past this many changed notes one full scan beats per-note rescans. */
const RESCAN_BATCH_LIMIT = 8

type StoreState = ShellSnapshot

let timer = 0
let lastPublishedAt = 0
let lastPayload = ''
let taskVaultKey: string | null = null
let tasksSettled = false
let knownUpdatedAt = new Map<string, number>()

/** The pins key this shell uses everywhere (note-actions.tsx). */
function pinsKey(state: StoreState): string | null {
  return state.vault?.root ?? null
}

function themeMode(): WidgetTheme['mode'] {
  return document.documentElement.dataset.themeMode === 'light' ? 'light' : 'dark'
}

function buildSnapshot(state: StoreState, now: Date): Omit<WidgetSnapshot, 'generatedAt'> {
  const style = getComputedStyle(document.documentElement)
  const today = getTodayTasks(now)
  const { tasks, counts } = selectWidgetTasks(today.tasks, today.overdueCount, toIsoDateLocal(now))
  return {
    version: WIDGET_SNAPSHOT_VERSION,
    vaultName: state.vault?.name ?? null,
    theme: themeFromTokens((token) => style.getPropertyValue(token), themeMode()),
    notes: selectWidgetNotes(state.notes, getPinnedNotes(pinsKey(state))),
    tasks,
    taskCounts: counts,
    tasksReady: tasksSettled
  }
}

async function publish(): Promise<void> {
  const state = getShellSnapshot()
  // No vault (onboarding, a switch in flight): keep whatever the widgets
  // already show rather than blanking them.
  if (!state.vault || !state.workspaceRestored) return
  let body: Omit<WidgetSnapshot, 'generatedAt'>
  try {
    body = buildSnapshot(state, new Date())
  } catch (err) {
    console.error('widget snapshot failed', err)
    return
  }
  const payload = JSON.stringify(body)
  if (payload === lastPayload) return
  lastPayload = payload
  lastPublishedAt = Date.now()
  const snapshot: WidgetSnapshot = { ...body, generatedAt: Date.now() }
  await ZenWidgets.update({ snapshot: JSON.stringify(snapshot) }).catch(() => {})
}

function schedule(): void {
  if (timer) return
  const wait = Math.max(PUBLISH_DEBOUNCE_MS, lastPublishedAt + PUBLISH_MIN_INTERVAL_MS - Date.now())
  timer = window.setTimeout(() => {
    timer = 0
    void publish()
  }, wait)
}

function flush(): void {
  if (!timer) return
  window.clearTimeout(timer)
  timer = 0
  void publish()
}

function reconcileTasks(state: StoreState, prev: StoreState | null, tasks: TasksSnapshot, previousTasks: TasksSnapshot | null): void {
  if (!state.vault || !state.workspaceRestored || !isMobileNoteIndexReady()) return
  const key = pinsKey(state)
  if (key !== taskVaultKey) {
    taskVaultKey = key
    tasksSettled = false
    knownUpdatedAt = new Map(state.notes.map((n) => [n.path, n.updatedAt]))
    if (!tasks.loading) void refreshTasks()
    return
  }
  if (previousTasks?.loading && !tasks.loading) tasksSettled = true
  if (!prev || state.notes === prev.notes) return
  const changed: string[] = []
  const next = new Map<string, number>()
  for (const n of state.notes) {
    next.set(n.path, n.updatedAt)
    if (n.folder !== 'trash' && knownUpdatedAt.get(n.path) !== n.updatedAt) changed.push(n.path)
  }
  knownUpdatedAt = next
  if (changed.length === 0) return
  if (changed.length > RESCAN_BATCH_LIMIT) {
    if (!tasks.loading) void refreshTasks()
    return
  }
  for (const path of changed) void refreshTasks(path)
}

/** Start publishing; returns the teardown (tests / hot paths — the shell
 *  itself never stops). No-op off the native platform. */
export function installWidgetPublisher(): () => void {
  if (!Capacitor.isNativePlatform()) return () => {}
  let shell = getShellSnapshot()
  let tasks = getTasksSnapshot()
  const changed = (): void => {
    const nextShell = getShellSnapshot(), nextTasks = getTasksSnapshot()
    const previousShell = shell, previousTasks = tasks
    // Store subscriptions can fire synchronously when refreshTasks starts.
    shell = nextShell; tasks = nextTasks
    reconcileTasks(nextShell, previousShell, nextTasks, previousTasks)
    schedule()
  }
  const unsubShell = subscribeShell(changed)
  const unsubTasks = subscribeTasks(changed)
  const unsubSettings = subscribeSettings(schedule)
  const unsubPins = subscribePins(schedule)
  const appState = CapApp.addListener('appStateChange', ({ isActive }) => {
    if (!isActive) flush()
  })
  reconcileTasks(getShellSnapshot(), null, getTasksSnapshot(), null)
  schedule()
  return () => {
    unsubShell(); unsubTasks(); unsubSettings()
    unsubPins()
    void appState.then((handle) => handle.remove()).catch(() => {})
    window.clearTimeout(timer)
    timer = 0
  }
}
