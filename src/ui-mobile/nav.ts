/**
 * Shared shell navigation helpers (used by both MobileShell and MobileDrawer;
 * lives here so the drawer doesn't have to import from MobileShell).
 */
import { useStore } from '@zennotes/app-core/store'
import { findLeaf, updateLeaf } from '@zennotes/app-core/lib/pane-layout'

/**
 * Show the Home dashboard (Notion-style): deselect the active tab without
 * closing anything, so HomeView renders while open tabs stay reachable via
 * "Open notes". There's no store action for this — desktop only reaches Home
 * by closing every tab — so the shell drives the pane tree directly.
 */
export function goHome(): void {
  const s = useStore.getState()
  if (s.selectedPath && s.noteDirty[s.selectedPath]) {
    void s.persistNote(s.selectedPath)
  }
  const leaf = findLeaf(s.paneLayout, s.activePaneId)
  if (!leaf || leaf.activeTab === null) return
  const next = updateLeaf(s.paneLayout, leaf.id, (l) => ({ ...l, activeTab: null }))
  if (!next) return
  useStore.setState({
    paneLayout: next,
    selectedPath: null,
    activeNote: null,
    activeDirty: false
  })
}
