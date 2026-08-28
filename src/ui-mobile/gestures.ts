/**
 * Configurable swipe gestures (issue #24, modelled on Obsidian mobile).
 *
 * The phone shell already had three touch gestures over an open note: a
 * left-edge swipe opens Browse, a horizontal flick moves to the previous /
 * next note, and a pinch resizes the font. The request was for the Obsidian
 * set — swipe to the file browser, swipe to the outline, pull down for a
 * quick action — and, since those collide with the flick, a setting to
 * choose. This module owns that setting: three slots (swipe left, swipe
 * right, pull down), each mapping to one action. Defaults keep the shipped
 * swipe behavior and turn the new pull-down on, where nothing else lived.
 *
 * Reads are cached: the gesture hooks consult the prefs on every touch and
 * the Settings card writes through `setGesturePrefs`, so a change applies to
 * the very next swipe without remounting anything. The key is mirrored to
 * native storage by bootstrap.ts like the other shell preferences.
 */
import { GESTURES_KEY } from '../viewport.ts'

/** 'note' is direction-aware: next note on a left swipe, previous on a right. */
export type SwipeAction = 'note' | 'browse' | 'outline' | 'off'
export type PullAction = 'palette' | 'search' | 'new' | 'off'

export interface GesturePrefs {
  swipeLeft: SwipeAction
  swipeRight: SwipeAction
  pullDown: PullAction
}

export const DEFAULT_GESTURES: GesturePrefs = {
  swipeLeft: 'note',
  swipeRight: 'note',
  pullDown: 'palette'
}

const SWIPE_ACTIONS: readonly SwipeAction[] = ['note', 'browse', 'outline', 'off']
const PULL_ACTIONS: readonly PullAction[] = ['palette', 'search', 'new', 'off']

let cached: GesturePrefs | null = null

function normalize(raw: unknown): GesturePrefs {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const swipe = (value: unknown, fallback: SwipeAction): SwipeAction =>
    SWIPE_ACTIONS.includes(value as SwipeAction) ? (value as SwipeAction) : fallback
  const pull = (value: unknown): PullAction =>
    PULL_ACTIONS.includes(value as PullAction) ? (value as PullAction) : DEFAULT_GESTURES.pullDown
  return {
    swipeLeft: swipe(obj.swipeLeft, DEFAULT_GESTURES.swipeLeft),
    swipeRight: swipe(obj.swipeRight, DEFAULT_GESTURES.swipeRight),
    pullDown: pull(obj.pullDown)
  }
}

export function getGesturePrefs(): GesturePrefs {
  if (cached) return cached
  try {
    const raw = localStorage.getItem(GESTURES_KEY)
    cached = normalize(raw ? JSON.parse(raw) : null)
  } catch {
    cached = { ...DEFAULT_GESTURES }
  }
  return cached
}

export function setGesturePrefs(next: GesturePrefs): void {
  const normalized = normalize(next)
  cached = normalized
  try {
    const isDefault = (Object.keys(DEFAULT_GESTURES) as (keyof GesturePrefs)[]).every(
      (key) => normalized[key] === DEFAULT_GESTURES[key]
    )
    // Defaults remove the key, so a fresh install and a reset look identical.
    if (isDefault) localStorage.removeItem(GESTURES_KEY)
    else localStorage.setItem(GESTURES_KEY, JSON.stringify(normalized))
  } catch {
    // Storage unavailable: the choice applies to this session only.
  }
}
