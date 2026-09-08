/**
 * The phone's note-row gestures, layered onto app-core's lists (Adib,
 * 2026-09-08: "when I long press a note, we see options … all the common
 * gestures to work as expected").
 *
 * The drawer's own rows (SwipeRow + MobileDrawer's long-press) already answer
 * the full set; this module gives app-core's DOM rows the same four, with the
 * same feel and coexistence rules:
 *
 * - tap opens (app-core's own onClick, untouched);
 * - long-press (450ms, 10px slop, haptic) opens the note options sheet
 *   (note-actions.tsx) — the tap that ends it is swallowed so the note
 *   doesn't also open;
 * - swipe left reveals actions that stay open until one is tapped, the row
 *   is tapped, or another row swipes: Archive / Delete on notes, Restore /
 *   Delete on archived and trashed ones. The content nudges by a sixth, the
 *   buttons slide in over the right edge;
 * - swipe right past 64px pins / unpins on release, with the accent "Pin"
 *   chip under the row as its confirmation (notes only).
 *
 * Vertical scrolling wins: a gesture claims the touch only once |dx| beats
 * both |dy| and a 12px slop — which is ≥ the long-press slop, so the timer
 * is already cancelled by the time a drag claims. Touches in the drawer's
 * left-edge zone are left to the drawer. Cancelled or multi-touch gestures
 * revert and never commit anything.
 *
 * Rows are identified by the data attributes app-core's views put on them;
 * Home's recent list has none, so its rows are resolved by position against
 * the same recent ordering HomeView computes, and cross-checked by title.
 * The action / pin layers are appended into a "frame" (the row itself, or
 * the <li> around Home's button rows) and removed again when the row
 * settles closed, so React only ever sees an extra trailing child while a
 * row is engaged — React never reconciles children it didn't create, and a
 * row unmounting takes the layers with it.
 */
import { Haptics, ImpactStyle } from '@capacitor/haptics'
import { useStore } from '@zennotes/app-core/store'
import {
  archiveNote,
  deleteNoteForever,
  isNotePinned,
  openNoteMenu,
  pinNote,
  restoreNote,
  trashNote,
  type NoteRowKind
} from './note-actions'

const ACTION_WIDTH = 72 // px per revealed action button (SwipeRow's)
// SwipeRow nudges its content by a third; app-core's rows start their text
// only 12–16px in (no leading icon on the phone), so any nudge past that
// clips the first letter under the frame's overflow. Follow by a sixth,
// capped below the content's own left padding (see nudgeLimit).
const CONTENT_FOLLOW = 1 / 6
const CONTENT_NUDGE_MAX = 12
const CONTENT_NUDGE_INSET = 4
const PIN_TRIGGER = 64 // px of right-swipe that commits a pin toggle
// MUST stay >= LONG_PRESS_SLOP: a smaller value opens a band where the row
// is mid-swipe while the long-press timer is still armed.
const CLAIM = 12
const LONG_PRESS_MS = 450
const LONG_PRESS_SLOP = 10
// MobileShell's drawer-open edge swipe zone; a touch starting there is the
// drawer's, not the row's.
const EDGE = 28
const SETTLE_MS = 200 // > the 180ms CSS transition, so cleanup runs after it
const CLICK_SUPPRESS_MS = 700

const FRAME_CLASS = 'zn-row-swipe'
const SETTLING_CLASS = 'is-settling'
const ACTIONS_CLASS = 'zn-row-swipe-actions'
const PIN_CLASS = 'zn-row-swipe-pin'
const LAYER_SELECTOR = `.${ACTIONS_CLASS}, .${PIN_CLASS}`

const ICONS = {
  archive: 'M21 8v13H3V8M1 3h22v5H1zM10 12h4',
  trash: 'M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6M10 11v6M14 11v6',
  restore: 'M3 12a9 9 0 109-9 9 9 0 00-6.36 2.64L3 8M3 3v5h5'
}

interface RowAction {
  label: string
  icon: keyof typeof ICONS
  danger?: boolean
  run: (path: string, title: string) => void
}

interface RowKind {
  /** Matches the element the finger lands in (via closest). */
  selector: string
  kind: NoteRowKind
  path: (row: HTMLElement) => string | null
  /** Hosts the sliding layers: position relative + overflow hidden. */
  frame: (row: HTMLElement) => HTMLElement
  /** Elements translated with the finger. */
  content: (frame: HTMLElement) => HTMLElement[]
  actions: RowAction[]
  pinnable: boolean
}

const NOTE_ACTIONS: RowAction[] = [
  { label: 'Archive', icon: 'archive', run: (path) => archiveNote(path) },
  { label: 'Delete', icon: 'trash', danger: true, run: (path, title) => trashNote(path, title) }
]
const ARCHIVED_ACTIONS: RowAction[] = [
  { label: 'Restore', icon: 'restore', run: (path) => restoreNote(path, 'archived') },
  { label: 'Delete', icon: 'trash', danger: true, run: (path, title) => trashNote(path, title) }
]
const TRASHED_ACTIONS: RowAction[] = [
  { label: 'Restore', icon: 'restore', run: (path) => restoreNote(path, 'trashed') },
  {
    label: 'Delete',
    icon: 'trash',
    danger: true,
    run: (path, title) => deleteNoteForever(path, title)
  }
]

const self = (row: HTMLElement): HTMLElement => row
const ownChildren = (frame: HTMLElement): HTMLElement[] =>
  Array.from(frame.children).filter(
    (c): c is HTMLElement => c instanceof HTMLElement && !c.matches(LAYER_SELECTOR)
  )

/**
 * HomeView renders its Recent list as `ul > li > button[data-home-item]`
 * (one button per li; task rows put two buttons in their li) in the same
 * order as its `recent` memo: every non-trash, non-archive note by updatedAt
 * descending. Resolve the row by position and confirm by title.
 */
function homeRecentPath(row: HTMLElement): string | null {
  const li = row.parentElement
  // Count the li's own children only: while a row is engaged the action /
  // pin layers are appended into this very li, and counting them made an
  // open row unrecognisable — its closing tap then opened the note.
  if (!li || li.tagName !== 'LI' || ownChildren(li).length !== 1) return null
  const list = li.parentElement
  if (!list || list.tagName !== 'UL') return null
  const index = Array.prototype.indexOf.call(list.children, li)
  if (index < 0) return null
  const recent = useStore
    .getState()
    .notes.filter((n) => n.folder !== 'trash' && n.folder !== 'archive')
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
  const note = recent[index]
  if (!note) return null
  const shown = row.textContent?.trim() ?? ''
  return shown.startsWith(note.title || 'Untitled') ? note.path : null
}

const KINDS: RowKind[] = [
  {
    selector: '[data-quick-row]',
    kind: 'note',
    path: (row) => row.dataset.quickRow ?? null,
    frame: self,
    content: ownChildren,
    actions: NOTE_ACTIONS,
    pinnable: true
  },
  {
    selector: '[data-tag-row]',
    kind: 'note',
    path: (row) => row.dataset.tagRow ?? null,
    frame: self,
    content: ownChildren,
    actions: NOTE_ACTIONS,
    pinnable: true
  },
  {
    selector: 'li > button[data-home-item]',
    kind: 'note',
    path: homeRecentPath,
    frame: (row) => row.parentElement as HTMLElement,
    content: ownChildren,
    actions: NOTE_ACTIONS,
    pinnable: true
  },
  {
    selector: '[data-archive-row]',
    kind: 'archived',
    path: (row) => row.dataset.archiveRow ?? null,
    frame: self,
    content: ownChildren,
    actions: ARCHIVED_ACTIONS,
    pinnable: false
  },
  {
    selector: '[data-trash-row]',
    kind: 'trashed',
    path: (row) => row.dataset.trashRow ?? null,
    frame: self,
    content: ownChildren,
    actions: TRASHED_ACTIONS,
    pinnable: false
  }
]

/** Every row selector, for other shell gestures to carve out. */
export const NOTE_ROW_SELECTOR = KINDS.map((k) => k.selector).join(', ')

interface Hit {
  kind: RowKind
  row: HTMLElement
  frame: HTMLElement
  path: string
}

function hitTest(target: EventTarget | null): Hit | null {
  if (!(target instanceof Element)) return null
  for (const kind of KINDS) {
    const row = target.closest(kind.selector)
    if (!(row instanceof HTMLElement)) continue
    const path = kind.path(row)
    if (!path) return null
    return { kind, row, frame: kind.frame(row), path }
  }
  return null
}

function titleOf(path: string, row: HTMLElement): string {
  const note = useStore.getState().notes.find((n) => n.path === path)
  return note?.title || row.textContent?.trim() || path
}

function svg(icon: keyof typeof ICONS): string {
  return (
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICONS[icon]}"/></svg>`
  )
}

// ---------------------------------------------------------------------------
// Displacement + layers
// ---------------------------------------------------------------------------

interface Engaged {
  hit: Hit
  dx: number
}

/** Current displacement per frame (absent when at rest). */
const position = new WeakMap<HTMLElement, number>()
let openFrame: Engaged | null = null

function dxOf(frame: HTMLElement): number {
  return position.get(frame) ?? 0
}

function actionsLayer(hit: Hit): HTMLElement {
  const existing = hit.frame.querySelector<HTMLElement>(`:scope > .${ACTIONS_CLASS}`)
  if (existing) return existing
  const layer = document.createElement('div')
  layer.className = ACTIONS_CLASS
  layer.style.width = `${hit.kind.actions.length * ACTION_WIDTH}px`
  for (const action of hit.kind.actions) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = action.danger ? 'zn-danger' : ''
    button.innerHTML = `${svg(action.icon)}${action.label}`
    button.addEventListener('click', (e) => {
      // The row's own onClick would open the note.
      e.preventDefault()
      e.stopPropagation()
      settle(hit, 0)
      action.run(hit.path, titleOf(hit.path, hit.row))
    })
    layer.appendChild(button)
  }
  hit.frame.appendChild(layer)
  return layer
}

function pinLayer(hit: Hit): HTMLElement {
  const existing = hit.frame.querySelector<HTMLElement>(`:scope > .${PIN_CLASS}`)
  if (existing) return existing
  const layer = document.createElement('div')
  layer.className = PIN_CLASS
  layer.setAttribute('aria-hidden', 'true')
  const label = document.createElement('span')
  label.textContent = isNotePinned(hit.path) ? 'Unpin' : 'Pin'
  layer.appendChild(label)
  hit.frame.appendChild(layer)
  return layer
}

/** How far the content may slide left before its first letter would leave
 *  the frame: its own left padding less a small inset, at most 12px. */
function nudgeLimit(content: HTMLElement[]): number {
  const first = content[0]
  if (!first) return CONTENT_NUDGE_MAX
  const padding = parseFloat(getComputedStyle(first).paddingLeft) || 0
  return Math.max(0, Math.min(CONTENT_NUDGE_MAX, padding - CONTENT_NUDGE_INSET))
}

function paint(hit: Hit, dx: number, settling: boolean): void {
  const { frame, kind } = hit
  position.set(frame, dx)
  frame.classList.add(FRAME_CLASS)
  frame.classList.toggle(SETTLING_CLASS, settling)
  // Rightward (pin) swipes move the content 1:1 to uncover the chip;
  // leftward swipes move it by CONTENT_FOLLOW while the actions slide in.
  const content = kind.content(frame)
  const contentX = dx >= 0 ? dx : Math.max(dx * CONTENT_FOLLOW, -nudgeLimit(content))
  for (const el of content) el.style.transform = `translateX(${contentX}px)`
  if (kind.actions.length > 0) {
    const width = kind.actions.length * ACTION_WIDTH
    actionsLayer(hit).style.transform = `translateX(${Math.max(0, width + Math.min(0, dx))}px)`
  }
  if (kind.pinnable) {
    const chip = pinLayer(hit)
    chip.style.opacity = dx > 8 ? '1' : '0'
    chip.firstElementChild?.classList.toggle('is-armed', dx > PIN_TRIGGER)
  }
}

function rest(hit: Hit): void {
  const { frame, kind } = hit
  position.delete(frame)
  frame.classList.remove(FRAME_CLASS, SETTLING_CLASS)
  for (const el of kind.content(frame)) el.style.removeProperty('transform')
  frame.querySelectorAll(`:scope > .${ACTIONS_CLASS}, :scope > .${PIN_CLASS}`).forEach((l) => l.remove())
}

function settle(hit: Hit, target: number): void {
  if (!hit.frame.isConnected) {
    if (openFrame?.hit.frame === hit.frame) openFrame = null
    return
  }
  paint(hit, target, true)
  if (target === 0) {
    if (openFrame?.hit.frame === hit.frame) openFrame = null
    window.setTimeout(() => {
      // Only tidy up if nothing re-engaged the row meanwhile.
      if (dxOf(hit.frame) === 0 && !(track?.hit.frame === hit.frame && track.claimed)) rest(hit)
    }, SETTLE_MS)
  } else {
    if (openFrame && openFrame.hit.frame !== hit.frame) settle(openFrame.hit, 0)
    openFrame = { hit, dx: target }
  }
}

// ---------------------------------------------------------------------------
// Touch tracking
// ---------------------------------------------------------------------------

interface Track {
  hit: Hit
  x: number
  y: number
  claimed: boolean
  dead: boolean
  fromDx: number
  timer: number | null
}

let track: Track | null = null
let live = 0
let suppressClicksUntil = 0

function cancelLongPress(t: Track): void {
  if (t.timer !== null) {
    window.clearTimeout(t.timer)
    t.timer = null
  }
}

function fireLongPress(t: Track): void {
  t.timer = null
  t.dead = true
  if (!t.hit.row.isConnected) return
  void Haptics.impact({ style: ImpactStyle.Medium }).catch(() => {})
  // The finger lift emits a click; swallow it or the note opens under the sheet.
  suppressClicksUntil = Date.now() + CLICK_SUPPRESS_MS
  if (openFrame) settle(openFrame.hit, 0)
  openNoteMenu({ path: t.hit.path, title: titleOf(t.hit.path, t.hit.row), kind: t.hit.kind.kind })
}

function onTouchStart(e: TouchEvent): void {
  if (e.touches.length !== 1) {
    // A second finger mid-gesture: abandon and revert, never leave a row
    // half-open or fire a press.
    const t = track
    track = null
    if (t) {
      cancelLongPress(t)
      if (t.claimed) settle(t.hit, t.fromDx)
    }
    return
  }
  const touch = e.touches[0]!
  const hit = hitTest(e.target)
  const isOpenRow = !!hit && !!openFrame && openFrame.hit.frame === hit.frame
  // A touch anywhere but the open row closes it (the open row's own tap is
  // handled at click time so the note doesn't open underneath).
  if (openFrame && !isOpenRow) settle(openFrame.hit, 0)
  track = null
  if (!hit || touch.clientX <= EDGE) return
  if (e.target instanceof Element && e.target.closest(LAYER_SELECTOR)) return
  const t: Track = {
    hit,
    x: touch.clientX,
    y: touch.clientY,
    claimed: false,
    dead: false,
    fromDx: isOpenRow ? -(hit.kind.actions.length * ACTION_WIDTH) : 0,
    timer: null
  }
  // No long-press on a row that's showing its actions — tapping closes it.
  if (!isOpenRow) t.timer = window.setTimeout(() => fireLongPress(t), LONG_PRESS_MS)
  track = t
}

function onTouchMove(e: TouchEvent): void {
  const t = track
  if (!t || t.dead) return
  if (e.touches.length !== 1) {
    t.dead = true
    cancelLongPress(t)
    if (t.claimed) settle(t.hit, t.fromDx)
    return
  }
  const touch = e.touches[0]!
  const mx = touch.clientX - t.x
  const my = touch.clientY - t.y
  if (t.timer !== null && (Math.abs(mx) > LONG_PRESS_SLOP || Math.abs(my) > LONG_PRESS_SLOP)) {
    cancelLongPress(t)
  }
  if (!t.claimed) {
    if (Math.abs(my) > Math.abs(mx) && Math.abs(my) > CLAIM) {
      t.dead = true // vertical scroll wins
      return
    }
    // A rightward drag has nothing to reveal on rows that can't pin.
    if (mx > 0 && t.fromDx === 0 && !t.hit.kind.pinnable) {
      t.dead = true
      return
    }
    if (Math.abs(mx) <= CLAIM || Math.abs(mx) <= Math.abs(my)) return
    if (!t.hit.frame.isConnected) {
      t.dead = true
      return
    }
    t.claimed = true
    cancelLongPress(t)
  }
  e.preventDefault()
  let next = t.fromDx + mx
  const min = -(t.hit.kind.actions.length * ACTION_WIDTH)
  const max = t.hit.kind.pinnable ? PIN_TRIGGER + 24 : 0
  // Clamp with rubber-banding past the functional range.
  if (next < min) next = min + (next - min) / 3
  if (next > max) next = max + (next - max) / 3
  live = next
  paint(t.hit, next, false)
}

function onTouchEnd(): void {
  const t = track
  track = null
  if (!t) return
  cancelLongPress(t)
  if (t.dead || !t.claimed) return
  const width = t.hit.kind.actions.length * ACTION_WIDTH
  if (t.hit.kind.pinnable && live > PIN_TRIGGER) {
    pinNote(t.hit.path)
    settle(t.hit, 0)
  } else if (width > 0 && live < -width / 2) {
    settle(t.hit, -width)
  } else {
    settle(t.hit, 0)
  }
}

function onTouchCancel(): void {
  // The system stole the touch (edge swipe, call banner, app switch) —
  // revert to where the gesture started; a cancel must never commit.
  const t = track
  track = null
  if (!t) return
  cancelLongPress(t)
  if (t.claimed) settle(t.hit, t.fromDx)
}

function onClickCapture(e: MouseEvent): void {
  if (Date.now() < suppressClicksUntil) {
    // The tap that ended a long-press.
    e.preventDefault()
    e.stopPropagation()
    suppressClicksUntil = 0
    return
  }
  const open = openFrame
  if (!open) return
  const target = e.target
  if (!(target instanceof Element) || !open.hit.frame.contains(target)) return
  if (target.closest(LAYER_SELECTOR)) return
  // Tapping a swiped-open row closes it instead of opening the note.
  e.preventDefault()
  e.stopPropagation()
  settle(open.hit, 0)
}

function onContextMenuCapture(e: MouseEvent): void {
  // The sheet is the phone's context menu for these rows; keep app-core's
  // desktop menus (TagView, ArchiveView) from opening on top of it.
  if (hitTest(e.target)) {
    e.preventDefault()
    e.stopPropagation()
  }
}

/** Install the gestures document-wide; returns the uninstaller. */
export function installNoteRowGestures(): () => void {
  // Capture phase so the tracker sees the touch before app-core's React
  // handlers; touchmove is non-passive because a claimed swipe must stop
  // the list from scrolling under it.
  document.addEventListener('touchstart', onTouchStart, { passive: true, capture: true })
  document.addEventListener('touchmove', onTouchMove, { passive: false, capture: true })
  document.addEventListener('touchend', onTouchEnd, { passive: true, capture: true })
  document.addEventListener('touchcancel', onTouchCancel, { passive: true, capture: true })
  document.addEventListener('click', onClickCapture, { capture: true })
  document.addEventListener('contextmenu', onContextMenuCapture, { capture: true })
  return () => {
    document.removeEventListener('touchstart', onTouchStart, { capture: true } as never)
    document.removeEventListener('touchmove', onTouchMove, { capture: true } as never)
    document.removeEventListener('touchend', onTouchEnd, { capture: true } as never)
    document.removeEventListener('touchcancel', onTouchCancel, { capture: true } as never)
    document.removeEventListener('click', onClickCapture, { capture: true } as never)
    document.removeEventListener('contextmenu', onContextMenuCapture, { capture: true } as never)
    if (track) cancelLongPress(track)
    track = null
    if (openFrame) rest(openFrame.hit)
    openFrame = null
  }
}
