import { getWorkspaceSnapshot } from '@zennotes/app-core/workspace'
import { activeVault } from '../bridge/mobile-bridge'

/** Capture before a gesture, native picker, or confirmation can outlive its vault. */
export function captureMobileWorkspace(): { isCurrent(): boolean } {
  try {
    const vault = activeVault()
    const workspace = getWorkspaceSnapshot()
    return { isCurrent: () => {
      try {
        const current = getWorkspaceSnapshot()
        return !workspace.transitioning && !current.transitioning && activeVault() === vault
          && current.generation === workspace.generation && current.mode === workspace.mode && current.remoteProfileId === workspace.remoteProfileId
      } catch { return false }
    } }
  } catch { return { isCurrent: () => false } }
}
export function reportActionError(error: unknown): void {
  window.alert(error instanceof Error ? error.message : String(error))
}
