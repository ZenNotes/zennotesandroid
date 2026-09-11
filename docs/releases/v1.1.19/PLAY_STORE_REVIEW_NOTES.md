# Play review and Data safety notes: ZenNotes 1.1.19

## What changed

- Cloud sync skips repeat reads for unchanged, acknowledged files, skips
  a view refresh when nothing changed, batches incoming changes into one
  refresh, and decodes large attachments in chunks.
- Images offered by the keyboard (Gboard stickers, GIFs, a copied
  screenshot) can be pasted into the note being edited; they are saved as
  vault attachments. Android's keyboard Commit Content API with temporary
  URI grants; no clipboard polling and no new permission.
- Touch fixes in the editor: sheets dismiss by dragging their handle,
  wikilinks open only on a completed tap, the selection toolbar and the
  Cloud footer no longer cover content, and a single launch splash shows
  a square icon on every Android version.
- Comment replies made on the phone keep thread structure and authors.
- App core 2.47.0.

No native permission, manifest-permission, billing, or account-access
changes.

## Reviewer steps

1. Open the app. A welcome note opens in reading mode; tap the pencil to
   edit. No account is needed.
2. With a keyboard that offers images (Gboard), pick a sticker or GIF
   while editing: it is saved into the vault and embedded in the note.
3. Tap the ⊕ button, then drag the handle at the top of the sheet down to
   dismiss it.
4. Select text and extend the selection with the handles: the toolbar
   stays below the text.
5. To exercise Cloud-specific behaviour, use the Cloud-enabled review
   account provided through the approved review channel, link a
   disposable test vault, and keep typing while syncs run.

## Data safety

Existing disclosures are unchanged. Cache metadata stays in app-private
storage. Cloud remains optional; on-device and folder vaults keep their
account-free behaviour and storage permissions.
