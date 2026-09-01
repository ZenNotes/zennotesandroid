/** Settings → Appearance → System bars: how much Android chrome stays on
 *  screen. 'status-hidden' is the original fullscreen-writing option (#22);
 *  'immersive' (#42) hides the navigation bar too. */
export type SystemBarsMode = 'shown' | 'status-hidden' | 'immersive'

/**
 * Stored-flag mapping. '1' is the 1.1.12 hidden-status-bar value (#22) and
 * must keep meaning exactly that; 'immersive' rides the same localStorage
 * key so the native mirror in bootstrap.ts needs no changes and a downgrade
 * degrades to the closest older behavior (unknown value = shown). Absent
 * means the default visible chrome.
 */
export function systemBarsModeFromStored(raw: string | null): SystemBarsMode {
  if (raw === 'immersive') return 'immersive'
  if (raw === '1') return 'status-hidden'
  return 'shown'
}

/** Inverse of the above; null means "remove the key" (the shown default). */
export function storedFromSystemBarsMode(mode: SystemBarsMode): string | null {
  if (mode === 'immersive') return 'immersive'
  if (mode === 'status-hidden') return '1'
  return null
}
