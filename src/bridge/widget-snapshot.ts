/**
 * The Home Screen widget snapshot — the contract between the shell and the
 * native widgets (android/app/src/main/java/md/zennotes/widgets; the same
 * file, byte for byte, feeds the iPhone's WidgetKit extension).
 *
 * The widgets cannot see the vault, so the app publishes what they show —
 * the active vault's pinned + recent notes, today's tasks, and the active
 * theme's colors — as one JSON document: WidgetBridgePlugin.java writes it
 * into the app's private files, WidgetSnapshot.java decodes it. Keep the
 * two sides in step; the Java reader treats every field as optional.
 *
 * Only pure selectors live here (node --test covers them). The store/pins
 * wiring and the native call are in widgets.ts.
 */
import type { NoteMeta } from '@bridge-contract/ipc'
import type { VaultTask } from '@shared/tasks'

export const WIDGET_SNAPSHOT_VERSION = 1
/** The list scrolls; a dozen keeps the widget useful at any height. */
export const WIDGET_MAX_NOTES = 12
export const WIDGET_MAX_TASKS = 12

export interface WidgetTheme {
  mode: 'light' | 'dark'
  /** Hex colors (#rrggbb) sampled from the app-core `--z-*` tokens. */
  bg: string
  bg1: string
  bg2: string
  fg: string
  fg2: string
  muted: string
  accent: string
  red: string
}

export interface WidgetNote {
  path: string
  title: string
  folder: string
  /** ms since epoch, as NoteMeta reports it. */
  updatedAt: number
  pinned: boolean
}

export interface WidgetTask {
  /** VaultTask id (`${sourcePath}#${taskIndex}`) — the tap link carries it
   *  back so the shell can jump to the exact line. */
  id: string
  path: string
  noteTitle: string
  content: string
  /** ISO YYYY-MM-DD or null for an undated task (those sit in Today too). */
  due: string | null
  overdue: boolean
  inProgress: boolean
  priority: string | null
}

export interface WidgetTaskCounts {
  /** Everything in the Today bucket, not just the rows that fit. */
  today: number
  overdue: number
}

export interface WidgetSnapshot {
  version: typeof WIDGET_SNAPSHOT_VERSION
  /** ms since epoch. */
  generatedAt: number
  vaultName: string | null
  theme: WidgetTheme
  /** Pinned notes first (in pin order), then the most recently edited. */
  notes: WidgetNote[]
  /** The Today bucket, overdue first, then the Tasks view's order. */
  tasks: WidgetTask[]
  taskCounts: WidgetTaskCounts
  /** False until the first task scan for this vault has landed, so the
   *  widget shows "loading" rather than a misleading "All clear". */
  tasksReady: boolean
}

/** ZenNotes' default theme (dark-hard), used before the first publish and
 *  for any token the active theme leaves undefined. */
export const FALLBACK_WIDGET_THEME: WidgetTheme = {
  mode: 'dark',
  bg: '#1d2021',
  bg1: '#32302f',
  bg2: '#3c3836',
  fg: '#d4be98',
  fg2: '#ddc7a1',
  muted: '#a89984',
  accent: '#e78a4e',
  red: '#ea6962'
}

const THEME_TOKENS: Record<Exclude<keyof WidgetTheme, 'mode'>, string> = {
  bg: '--z-bg',
  bg1: '--z-bg-1',
  bg2: '--z-bg-2',
  fg: '--z-fg',
  fg2: '--z-fg-2',
  muted: '--z-grey-2',
  accent: '--z-accent',
  red: '--z-red'
}

/** `"29 32 33"` (the `--z-*` channel triplet form) → `"#1d2021"`. */
export function channelsToHex(value: string): string | null {
  const channels = value.trim().split(/\s+/).map(Number)
  if (
    channels.length !== 3 ||
    channels.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255)
  ) {
    return null
  }
  return '#' + channels.map((n) => n.toString(16).padStart(2, '0')).join('')
}

/** Resolve the widget palette from a token reader (getComputedStyle in the
 *  app); tokens that don't parse keep the fallback value. */
export function themeFromTokens(
  read: (token: string) => string,
  mode: WidgetTheme['mode']
): WidgetTheme {
  const theme: WidgetTheme = { ...FALLBACK_WIDGET_THEME, mode }
  for (const [key, token] of Object.entries(THEME_TOKENS) as Array<
    [Exclude<keyof WidgetTheme, 'mode'>, string]
  >) {
    const hex = channelsToHex(read(token))
    if (hex) theme[key] = hex
  }
  return theme
}

export type WidgetNoteSource = Pick<NoteMeta, 'path' | 'title' | 'folder' | 'updatedAt'>

/**
 * Pinned notes first, in the order they were pinned (the drawer's own
 * convention — pins sort to the top of their group), then the most recently
 * edited notes, mirroring the Home dashboard's Recent list. Trash and
 * Archive never show; a pin whose note is gone is skipped, not surfaced.
 */
export function selectWidgetNotes(
  notes: readonly WidgetNoteSource[],
  pinnedPaths: readonly string[],
  max = WIDGET_MAX_NOTES
): WidgetNote[] {
  const live = notes.filter((n) => n.folder !== 'trash' && n.folder !== 'archive')
  const byPath = new Map(live.map((n) => [n.path, n] as const))
  const out: WidgetNote[] = []
  const seen = new Set<string>()
  const push = (note: WidgetNoteSource, pinned: boolean): void => {
    if (seen.has(note.path) || out.length >= max) return
    seen.add(note.path)
    out.push({
      path: note.path,
      title: note.title.trim() || 'Untitled',
      folder: note.folder,
      updatedAt: note.updatedAt,
      pinned
    })
  }
  for (const path of pinnedPaths) {
    const note = byPath.get(path)
    if (note) push(note, true)
  }
  for (const note of live.slice().sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (out.length >= max) break
    push(note, false)
  }
  return out
}

export type WidgetTaskSource = Pick<
  VaultTask,
  'id' | 'sourcePath' | 'noteTitle' | 'content' | 'due' | 'inProgress' | 'priority'
>

/**
 * Drop tasks whose note no longer exists (or sits in Trash). App-core keeps
 * `vaultTasks` fresh only while a tasks surface is on screen, so on the
 * phone a note deleted from the drawer can leave its tasks in the cache
 * until the next full scan — the widget must not show them.
 */
export function filterLiveTasks<T extends { sourcePath: string }>(
  tasks: readonly T[],
  notes: readonly Pick<NoteMeta, 'path' | 'folder'>[]
): T[] {
  const live = new Set(notes.filter((n) => n.folder !== 'trash').map((n) => n.path))
  return tasks.filter((t) => live.has(t.sourcePath))
}

/**
 * The rows for the Tasks widget from the Today bucket app-core's
 * `computeTasksRender` produces (due today, overdue, or undated — the same
 * list the Home dashboard shows), plus the counts the header needs even
 * when rows are cut off. `todayIso` is the local calendar day.
 *
 * One departure from the bucket's file order: overdue tasks lead. The
 * widget shows a few rows under a header that counts the overdue ones,
 * and in a vault with many undated tasks the bucket order would keep
 * every overdue row out of sight. The sort is stable, so everything else
 * keeps the app's order.
 */
export function selectWidgetTasks(
  today: readonly WidgetTaskSource[],
  overdueCount: number,
  todayIso: string,
  max = WIDGET_MAX_TASKS
): { tasks: WidgetTask[]; counts: WidgetTaskCounts } {
  const isOverdue = (t: WidgetTaskSource): boolean => typeof t.due === 'string' && t.due < todayIso
  const ordered = today.slice().sort((a, b) => Number(isOverdue(b)) - Number(isOverdue(a)))
  const tasks = ordered.slice(0, max).map(
    (t): WidgetTask => ({
      id: t.id,
      path: t.sourcePath,
      noteTitle: t.noteTitle,
      content: t.content.trim() || 'Untitled task',
      due: t.due ?? null,
      overdue: typeof t.due === 'string' && t.due < todayIso,
      inProgress: t.inProgress,
      priority: t.priority ?? null
    })
  )
  return { tasks, counts: { today: today.length, overdue: overdueCount } }
}
