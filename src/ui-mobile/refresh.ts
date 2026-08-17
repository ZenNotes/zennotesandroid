/**
 * The vault refresh sequence, shared between the app-foreground listener
 * (main.tsx) and the drawer's pull-to-refresh. Order matters: pull down
 * anything iCloud evicted/changed, land shared captures, then rescan so the
 * UI catches up, then let cloud sync run.
 */
import { requestCloudAutoSync } from '@zennotes/app-core/main'
import { activeVault, importPendingShares } from '../bridge/mobile-bridge'
import { ensureDownloaded } from '../bridge/icloud'

export async function refreshVault(): Promise<void> {
  try {
    const v = activeVault()
    if (v.fs.isCloud && v.fs.rootUri) await ensureDownloaded(v.fs.rootUri, 15000)
  } catch {
    // no vault open yet
  }
  await importPendingShares().catch(() => 0)
  try {
    await activeVault().rescan()
  } catch {
    // no vault open yet
  }
  // 'foreground' is an immediate-reason for the auto-sync engine — right for
  // both the app-foreground path and an explicit pull-to-refresh.
  requestCloudAutoSync('foreground')
}
