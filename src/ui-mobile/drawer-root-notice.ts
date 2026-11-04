/**
 * Whether the drawer warns that an inbox-mode vault is hiding notes beside its
 * inbox (#1023). The desktop sidebar has this banner; the drawer did not, so a
 * vault that filled up after a first note just looked empty, with no word why.
 */
const DISMISSED_PREFIX = 'zn:root-notes-notice-dismissed:'

type KeyValueStore = Pick<Storage, 'getItem' | 'setItem'>

export function rootNoticeDismissed(root: string, store: KeyValueStore = localStorage): boolean {
  try {
    return store.getItem(DISMISSED_PREFIX + root) === '1'
  } catch {
    return false
  }
}

export function dismissRootNotice(root: string, store: KeyValueStore = localStorage): void {
  try {
    store.setItem(DISMISSED_PREFIX + root, '1')
  } catch {
    // The notice comes back next time; nothing is lost.
  }
}

type LayoutBridge = {
  getVaultSettings: () => Promise<{ primaryNotesLocation?: string }>
  setVaultSettings: (settings: never) => Promise<unknown>
}

/** Vault.json keeps the rest of the settings as they are. */
export async function showRootNotes(bridge: LayoutBridge): Promise<void> {
  const settings = await bridge.getVaultSettings()
  await bridge.setVaultSettings({ ...settings, primaryNotesLocation: 'root' } as never)
}
