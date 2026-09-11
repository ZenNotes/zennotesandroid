# ZenNotes for Android 1.1.19: lighter sync, better touch

Cloud sync stops redoing work it has already done, the editor handles
touch more carefully, images paste straight from the keyboard, and the
launch splash is the same on every Android version. Eight tracker
reports (#48 to #55) plus the comment-sidecar fix; the app core moves to
2.47.0 (pin `431907df`).

## What changes on the phone

- **Cloud sync does less repeat work (#52).** Once Cloud has
  acknowledged a file, later scans reuse its fingerprint instead of
  rereading and hashing the whole file; changed and unacknowledged files
  are still read. A sync that changes nothing leaves the vault's views
  alone, and incoming changes refresh the views once as a batch rather
  than once per note. Large attachments are decoded in chunks with pauses
  for the UI, and binary uploads reuse their base64 data instead of
  encoding the same bytes twice. Conflict review still reads the real
  file, including when the conflicting file was moved or already
  acknowledged.
- **Paste images from the keyboard (#54).** Gboard and other keyboards
  that offer stickers, GIFs, or a copied screenshot can paste them
  straight into the note you are editing. The image is saved through the
  vault's normal asset path and embedded with a wikilink. PNG, JPEG, GIF,
  and WebP up to 10 MiB; larger files still go through Attach. The paste
  is accepted only inside an editable note, and if you switch note or
  vault before the image arrives, nothing is written into the wrong
  place.
- **Sheets drag (#53).** The pill at the top of every mobile sheet is a
  real 44 px handle: drag or swipe down to dismiss, short or cancelled
  drags snap back, and keyboard or TalkBack activation closes the sheet.
- **Wikilinks want a clean tap (#50).** A link opens only after a short
  completed tap. Scrolling across a link, dragging a selection handle
  over it, long-pressing it, or a second finger no longer navigates.
- **Selection toolbar keeps off the text (#51).** With the keyboard open,
  the docked selection toolbar takes real space in the editor layout, so
  the scroller shrinks and handles and text stay visible above it.
- **Cloud footer and floating buttons (#48).** The Cloud footer gets a
  44 px row of its own and the floating navigation button, menu, and
  hint sit above it, so Connect, Retry, and Review are tappable.
- **Opaque editor surfaces (#49).** Body, root, and editor paint their
  theme colour instead of exposing the WebView's backing colour during
  compositing. A mitigation for the reported flicker while extending a
  selection, not a reproduced root-cause fix.
- **One splash, same icon everywhere (#55).** The AndroidX splash is
  installed before Capacitor switches the theme, the icon sits on a
  square padded canvas on every Android version, and the duplicate
  plugin splash is off.
- **Comment threads survive a phone edit.** A reply, resolve, or delete
  on the phone no longer flattens every thread and drops the authors the
  desktop or an assistant wrote into the sidecar; the shell reads and
  writes comments through the shared normalizer, as desktop does. Landed
  on main after 1.1.18 shipped (#61), so this is its first Play release.

## Also in this update: app core 2.47

- A wikilink that points at a file in the vault opens the file instead
  of offering to create a missing note.
- Switching Excalidraw drawings no longer overwrites the one you opened.
- Cloud sync resumes when conflicted files already match, and local
  tasks stay visible while Cloud conflicts wait.
- Lockfile bumps for the smol-toml and hono advisories.

## Under the hood

- `src/bridge/cloud-sync-repository.ts` ports and hardens the iOS scan
  cache: unknown timestamps, missing cache entries, and unacknowledged
  content fall back to a full read, and a file changed during a read does
  not seed a reusable entry. `cloud-sync-work.ts` yields to the UI with a
  timer fallback for older WebViews; `cloud-sync-refresh.ts` tracks writes
  and scan changes, including partial failed pulls, and keeps a failed
  refresh for the next attempt. `MobileVault.rescan()` emits one resync
  event under the app core's existing unsaved-edit protection. The cache
  relies on the storage provider updating a file's modification time or
  size; a same-size write that preserves both is not detected.
- Image paste is Android's keyboard Commit Content API on a Capacitor
  WebView subclass (`ImagePasteWebView`, `ImagePastePlugin`), not
  clipboard polling: temporary `content://` grants, short-lived opaque
  tokens, bounded reads on a worker thread with a `CancellationSignal`,
  and PNG/JPEG/GIF/WebP signature checks. Grants are released exactly
  once on completion, failure, or teardown. WebP keeps its filename in
  the self-hosted `RemoteVault` path too.
- `SheetHandle.tsx`, `wikilink-touch.ts`, and
  `selection-toolbar-space.ts` carry the touch changes, each with
  regression tests; `tooling/android-ui-check.html` is a browser fixture
  for the layout contracts.
- Splash: `MainActivity` installs the compat splash before Capacitor's
  `onCreate`, `zn_splash_icon.xml` wraps the launcher bitmap in a square
  inset, and `capacitor.config.ts` turns the plugin's launch splash off.
- Pinned to upstream `431907df`: app core 2.47.0 plus the smol-toml and
  hono lockfile fix. No desktop or backend changes ride along.

No new permissions, services, or data collection. On-device and folder
vaults continue to work without an account; self-hosted and ZenNotes
Cloud vaults remain optional. The sync work pairs with ZenNotes for iOS
1.9.9.

## Validation (2026-09-11)

- Release build at the pin: `npm run typecheck` clean, `npm test`
  121/121, Gradle `testDebugUnitTest` (9 Java tests) and `bundleRelease`
  signed with the upload key; merged manifest versionCode 21 / 1.1.19;
  AAB sha256
  `cc93676c880a9e2b0e6f825b06a9e16299ed14b7d26283fdbed2b5a300423bfe`.
- Browser fixture at 390×650, 320×640, and a keyboard-reduced 390×380:
  Cloud footer 44 px with the floating button above it; selection toolbar
  starts below the scroller; handle keyboard activation dismisses the
  sheet; body, root, and editor share one opaque background (details in
  `docs/android-issue-validation-2026-09-11.md`).
- Pixel 7 API 35 emulator: the debug build of the same tree installs as
  versionCode 21, launches to the welcome note with the floating button
  sitting above the Cloud footer, opens the ⊕ menu and the More sheet, dismisses the sheet on a downward drag of its handle (#53), and logcat shows no crash.
- Not verified on hardware: typing while a real Cloud sync runs, Gboard
  image paste on a device, and the selection-handle flicker (#49).
