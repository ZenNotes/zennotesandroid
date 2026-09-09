/**
 * Runs the widgets' `zennotes://` links (widget-links.ts parses them).
 *
 * Delivery: `appUrlOpen` while the app runs (a widget tap reaches the
 * single-task activity as a new intent; on iOS, an open-URL), and at boot the newest link the
 * native side saw — `ZenWidgets.consumeLaunchLink()`, kept by the platform
 * plugin from every URL open. Capacitor's own `getLaunchUrl` stays the
 * fallback: on Android it captures the activity's intent once, and an
 * activity recreated into its old task reports the task's ORIGINAL intent
 * there while the tap that actually woke it arrives as a retained
 * `appUrlOpen` the Cloud auth listener (registered first) consumes. The
 * Cloud auth callback shares the scheme; its listener ignores these links
 * and this one ignores `zennotes://auth`.
 *
 * A link waits for the workspace: the vault open, the store restored, and
 * the note index in, since a stale row (the note was deleted after the last
 * publish) must fall back to Home, not throw. Links that land while booting
 * coalesce to the newest one — a wake can deliver the old task intent and
 * the real tap back to back, and only the last is the user's. The runner
 * then yields a beat so the shell's own cold-launch landing
 * (usePhoneLayoutBoot: Home, or where the user left) has run first and the
 * link wins, exactly as tapping the note in the app would.
 */
import { App as CapApp } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'
import { useStore } from '@zennotes/app-core/store'
import { isMobileNoteIndexReady } from '../bridge/mobile-bridge'
import { ZenWidgets } from '../bridge/widgets'
import { setDrawerOpen } from './drawer-state'
import { goHome } from './nav'
import { closeNoteMenu } from './note-actions'
import { closeMobileSheet } from './sheet-state'
import { parseWidgetLink, type WidgetLink } from './widget-links'

const DUPLICATE_WINDOW_MS = 5000
const LANDING_SETTLE_MS = 80
/** A vault that never becomes ready (remote workspace offline, onboarding
 *  abandoned) must not pin a link forever; past this the link runs anyway
 *  and its own guards decide. */
const READY_TIMEOUT_MS = 20000

type StoreState = ReturnType<typeof useStore.getState>

let lastUrl = ''
let lastAt = 0
let pending: WidgetLink | null = null
let waiting = false

export function installDeepLinks(): void {
  if (!Capacitor.isNativePlatform()) return
  void CapApp.addListener('appUrlOpen', ({ url }) => handleDeepLink(url)).catch(() => {})
  void ZenWidgets.consumeLaunchLink()
    .then((result) => {
      if (result?.url) handleDeepLink(result.url)
    })
    .catch(() =>
      CapApp.getLaunchUrl()
        .then((launch) => {
          if (launch?.url) handleDeepLink(launch.url)
        })
        .catch(() => {})
    )
}

export function handleDeepLink(raw: string): void {
  const link = parseWidgetLink(raw)
  if (!link) return
  const now = Date.now()
  if (raw === lastUrl && now - lastAt < DUPLICATE_WINDOW_MS) return
  lastUrl = raw
  lastAt = now
  if (isReady()) {
    window.setTimeout(() => void run(link), LANDING_SETTLE_MS)
    return
  }
  pending = link
  if (waiting) return
  waiting = true
  whenReady(() => {
    waiting = false
    const next = pending
    pending = null
    if (next) void run(next)
  })
}

function isReady(): boolean {
  const s = useStore.getState()
  return Boolean(s.vault) && s.workspaceRestored && isMobileNoteIndexReady()
}

function whenReady(cb: () => void): void {
  let done = false
  const finish = (): void => {
    if (done) return
    done = true
    unsub()
    window.clearTimeout(deadline)
    window.setTimeout(cb, LANDING_SETTLE_MS)
  }
  const unsub = useStore.subscribe(() => {
    if (isReady()) finish()
  })
  const deadline = window.setTimeout(finish, READY_TIMEOUT_MS)
}

function hasNote(s: StoreState, path: string): boolean {
  return s.notes.some((n) => n.path === path && n.folder !== 'trash')
}

async function run(link: WidgetLink): Promise<void> {
  // Whatever chrome was up when the user left is in the way now.
  closeMobileSheet()
  closeNoteMenu()
  setDrawerOpen(false)
  const s = useStore.getState()
  switch (link.kind) {
    case 'new':
      // The ⊕ sheet's "New note" (commands.ts `note.new.inbox`).
      await s.createAndOpen('inbox', '', { focusTitle: true })
      return
    case 'open':
      if (hasNote(s, link.path)) await s.selectNote(link.path)
      else goHome()
      return
    case 'task':
      await openTask(s, link)
      return
    case 'tasks':
      await s.openTasksView()
      return
    case 'home':
      goHome()
      return
  }
}

async function openTask(s: StoreState, link: Extract<WidgetLink, { kind: 'task' }>): Promise<void> {
  if (!hasNote(s, link.path)) {
    goHome()
    return
  }
  let task = s.vaultTasks.find((t) => t.id === link.id)
  if (!task) {
    // The cache is lazy on the phone; one per-note scan is enough to find it.
    await s.rescanTasksForPath(link.path)
    task = useStore.getState().vaultTasks.find((t) => t.id === link.id)
  }
  if (task) await useStore.getState().openTaskAt(task)
  else await useStore.getState().selectNote(link.path)
}
