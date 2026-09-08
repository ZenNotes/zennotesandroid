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

/**
 * Keep Home across app-core's pane-tree rewrites (Adib, 2026-09-08: "the
 * drawer's Home row does not leave the Tasks view").
 *
 * Home is a state desktop never reaches, and app-core's `rewritePathsInTree`
 * — run by refreshNotes on every rescan, and by rename / move / delete —
 * falls back to the leaf's FIRST tab when the active tab is null. A rescan
 * lands within a second of reaching Home (the drawer's close and every
 * vault change event trigger one), so the first open tab came straight
 * back on screen: Tasks, whenever it had been opened in the session.
 *
 * The fallback has a signature no navigation shares: in one store update
 * the active leaf goes from a null active tab to its first tab AND `notes`
 * is replaced (a rescan or a vault mutation). Opening a note is a separate
 * update that leaves `notes` alone, and a new note appends its tab at the
 * end, so neither matches. When the signature does match, put Home back —
 * synchronously inside the subscriber, before React renders, so the tab
 * never shows. Returns the unsubscriber.
 */
export function installHomeGuard(): () => void {
  return useStore.subscribe((state, prev) => {
    if (state.notes === prev.notes || state.paneLayout === prev.paneLayout) return
    const leaf = findLeaf(state.paneLayout, state.activePaneId)
    const before = findLeaf(prev.paneLayout, state.activePaneId)
    if (!leaf || !before || before.activeTab !== null || before.tabs.length === 0) return
    if (leaf.activeTab === null || leaf.activeTab !== leaf.tabs[0]) return
    const next = updateLeaf(state.paneLayout, leaf.id, (l) => ({ ...l, activeTab: null }))
    if (!next) return
    useStore.setState({
      paneLayout: next,
      selectedPath: null,
      activeNote: null,
      activeDirty: false
    })
  })
}
