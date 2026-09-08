/**
 * The `zennotes://` links the widgets fire (md.zennotes.widgets.WidgetLinks
 * builds them; deep-links.ts runs them):
 *
 *   zennotes://new                     create a note in the Inbox and open it
 *   zennotes://open?path=<enc>         open a note by vault-relative path
 *   zennotes://task?id=<enc>&path=<enc> jump to a task line (VaultTask id)
 *   zennotes://tasks                   the Tasks view
 *   zennotes://home                    the Home dashboard
 *
 * Values are percent-encoded with only unreserved characters left bare, so
 * `#` (task ids are `path#index`) and `&` in titles survive the trip. The
 * Cloud auth callback (`zennotes://auth?…`) shares the scheme and is not
 * ours — it parses to null here. Pure, so node --test covers it.
 */
export type WidgetLink =
  | { kind: 'new' }
  | { kind: 'open'; path: string }
  | { kind: 'task'; id: string; path: string }
  | { kind: 'tasks' }
  | { kind: 'home' }

/** Vault-relative, forward-slash, no traversal — the same shape the bridge's
 *  path guards accept, checked here so a bad link never throws. */
export function isSafeVaultPath(path: string): boolean {
  if (!path || path.length > 2048) return false
  if (path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

export function parseWidgetLink(raw: string): WidgetLink | null {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'zennotes:') return null
  const action = (url.hostname || url.pathname.replace(/^\/+/, '')).toLowerCase()
  switch (action) {
    case 'new':
      return { kind: 'new' }
    case 'tasks':
      return { kind: 'tasks' }
    case 'home':
      return { kind: 'home' }
    case 'open': {
      const path = url.searchParams.get('path') ?? ''
      return isSafeVaultPath(path) ? { kind: 'open', path } : null
    }
    case 'task': {
      const id = url.searchParams.get('id') ?? ''
      const hash = id.lastIndexOf('#')
      const path = url.searchParams.get('path') ?? (hash > 0 ? id.slice(0, hash) : '')
      if (!id || !isSafeVaultPath(path)) return null
      return { kind: 'task', id, path }
    }
    default:
      return null
  }
}
