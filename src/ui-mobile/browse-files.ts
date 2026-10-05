/**
 * The drawer's file rows: the attachments and other non-note files a folder
 * holds, which core's Browse listing gives the way the desktop sidebar lists
 * them. The pinned core (2.60.4) predates file rows and has no `files` field,
 * so it is read defensively here: the drawer builds and runs against either
 * core, and shows files once the shell adopts one that lists them.
 */
export interface DrawerFileRow {
  /** Opaque core path: open it with navigation's openNote, like a database row. */
  readonly path: string
  /** The file name with its extension. */
  readonly name: string
}

/** Takes `object`, not `{ files?: unknown }`: TypeScript refuses the pinned
 *  core's directory type for a shape it shares no field with. */
export function drawerFileRows(directory: object): readonly DrawerFileRow[] {
  const files = (directory as { readonly files?: unknown }).files
  return Array.isArray(files) ? files.filter(isDrawerFileRow) : []
}

function isDrawerFileRow(row: unknown): row is DrawerFileRow {
  if (!row || typeof row !== 'object') return false
  const { path, name } = row as { path?: unknown; name?: unknown }
  return typeof path === 'string' && path !== '' && typeof name === 'string' && name !== ''
}

/** The extension the desktop sidebar prints beside a file, upper-cased. */
export function fileExtensionLabel(name: string): string {
  return name.includes('.') ? (name.split('.').pop() ?? '').toUpperCase() : ''
}
