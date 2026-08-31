/**
 * Where an imported file goes and how it is linked.
 *
 * A leaf module on purpose: `vault-core` reaches `@shared/*` through a Vite
 * alias, which plain `node --test` cannot resolve, so nothing there is
 * unit-testable. These rules are where the attachment bugs hid, so they live
 * where a test can reach them. The vault core re-exports them so existing
 * importers remain unaffected.
 */
import type { ImportedAssetKind } from '@bridge-contract/ipc'

export const ASSETS_DIR = 'assets'

/** Keep imported names valid as both filenames and wikilink targets. Pasted
 * images already apply this rule: brackets, anchors, and pipes can terminate
 * or retarget a wikilink, while path/control characters are unsafe on one or
 * more supported filesystems. */
export function importedAssetFilename(filename: string): string {
  const segments = filename.split(/[\\/]/)
  const leaf = segments[segments.length - 1] ?? ''
  const safe = leaf
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:%\u0000-\u001f*?"<>|[\]#^]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
  return safe && safe !== '.' && safe !== '..' ? safe : 'file'
}

/** Every imported file lands in `assets/`, whichever way it arrived. Paste,
 *  attach and the cloud upload agree on this, so a link written by one is
 *  resolvable by the others. Attach used to write to the vault root, which
 *  scattered images among the notes (Discord, xenin); desktop had the same bug
 *  and fixed it in ZenNotes#377, and the port here was missed. */
export function importedAssetRelPath(filename: string): string {
  return `${ASSETS_DIR}/${filename}`
}

/** The link written into the note, by vault-relative path. Images take the
 *  wikilink form, matching pasted images and the cloud vault; anything else
 *  gets an angle-bracketed markdown link so a space in the name cannot break
 *  it. Never a note-relative `../` path: the old attach path hand-built one
 *  from the note's depth, which pointed outside the vault from a nested note. */
export function importedAssetMarkdown(
  relPath: string,
  filename: string,
  kind: ImportedAssetKind
): string {
  if (kind === 'image') return `![[${relPath}]]`
  return `[${filename}](<${relPath.replace(/>/g, '%3E')}>)`
}
