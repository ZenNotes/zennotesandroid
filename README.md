# ZenNotes for Android

A Capacitor shell that runs the ZenNotes product core (`packages/app-core` from
the [zennotes monorepo](../../opensource/zennotes)) inside the Android System
WebView, backed by a local-first vault on the device filesystem. Implements the
architecture in `docs/specs/mobile/` (the Phase 2 "Android fast-follow"),
derived from the iPhone shell at `../zennotesiphone` — the two shells share the
same structure and bridge modules; platform-specific divergences are noted
below.

The zennotes repo is consumed **read-only, straight from source**, via Vite/TS
path aliases (see `vite.config.ts`) — nothing in that repo is modified. The
repo is expected at `../../opensource/zennotes` relative to this directory.

## Architecture

```
src/
  main.tsx                install bridge → open vault → renderZenNotesApp()
  bridge/
    mobile-bridge.ts      the mobile ZenBridge (window.zen) implementation
    vault-fs.ts           desktop vault.ts semantics over Capacitor Filesystem
    vault-core.ts         pure helpers ported 1:1 (folder map, meta extraction,
                          naming, search scoring) — keep in sync with desktop
    native-fs.ts          Capacitor Filesystem wrapper (vault root = app-scoped
                          external storage via Directory.External)
    events.ts             VaultChangeEvent emitter (in-app writes + rescan)
  ui-mobile/
    MobileShell.tsx       bottom nav (capture ⊕ / search / sidebar / palette),
                          phone drawer behavior via the shared Zustand store
    mobile.css            safe areas, overlay drawers, keyboard handling
android/                  Capacitor-generated Gradle project (appId md.zennotes)
  app/src/main/java/md/zennotes/
    MainActivity.java     registers ShareInboxPlugin, stashes ACTION_SEND shares
    ShareInboxPlugin.java Android ShareInbox (same jsName/contract as iOS)
```

Key decisions (all forced by "don't modify the zennotes repo"):

- **`runtime: 'web'`** — the bridge contract has no `'mobile'` runtime yet.
  Every desktop-only affordance in app-core gates on `runtime === 'desktop'`,
  so `'web'` + the capability flags produces correct mobile behavior. When the
  contract gains `'mobile'` + the new capability flags (spec 02), flip it here.
- **`platform: 'linux'`** (iOS shell reports `'darwin'`) — gives app-core
  Ctrl-based keymaps and hides Mac-only chrome; right for Android hardware
  keyboards.
- **Vault location** — app-scoped external storage:
  `/Android/data/md.zennotes/files/ZenNotes/<vault>` (`Directory.External`),
  the spec-03 Android default tier: no permission prompt, works under scoped
  storage. **Do not switch to `Directory.Documents`** — on Android that is the
  public Documents collection, which the Filesystem plugin permission-gates
  and Android 11+ scoped storage effectively breaks.
- **Two storage tiers.** Default: app-scoped storage (above) — with a
  one-time boot probe (`initVaultsRoot`) that falls back to internal app
  storage (`Directory.Data`) on devices where `getExternalFilesDir` is
  unusable (custom ROMs / restricted profiles crashed at first launch with
  "Missing parent directory", issue #2); the chosen root is persisted so it
  never flips between launches. Advanced: the
  **SAF external-folder tier** (spec 03) — "Choose Folder…" in the New Vault
  sheet opens `ACTION_OPEN_DOCUMENT_TREE` (`FolderPickerPlugin.java`; the
  persisted tree-URI permission is the "bookmark", surviving reboots), and
  every file op on a `content://` root routes through `SafFsPlugin.java`
  (`DocumentsContract` child queries with a documentId cache — one IPC per
  directory listing, NOT per-file DocumentFile resolution) because Capacitor
  Filesystem cannot address tree URIs. This is the tier that enables
  Syncthing/FolderSync cross-device workflows. iCloud stays iOS-only;
  `icloud.ts` is kept (inert) to minimize drift against the iPhone shell.
  Unlike the iPhone shell's single-bookmark slot, `folder-picker.ts` keeps a
  **registry of every picked folder** (`zn-mobile:external-vaults`, with the
  legacy single-ref key as the "current" pointer and migration seed) so any
  number of SAF folder vaults stay switchable (zennotes#584) — external-tier
  root tokens carry the bookmark URI (`zn://external-vaults/<encoded-uri>`).
  Porting this back to iOS is a known follow-up; multiple security-scoped
  bookmarks are equally legal there.
- **SAF performance (measured, Pixel 7 AVD, 500-note vault):** ~2 ms/op on
  app storage vs ~35 ms/op over SAF (~17×). Cold open+index: ~3.3 s local vs
  ~20 s SAF; warm relaunch: ~2.6 s vs ~23 s — dominated by a per-launch
  full-body read pass (workspace/tasks restore) that every tier performs but
  only SAF makes expensive. The note-meta cache itself hits correctly on both
  tiers. Verdict: fine for small/medium vaults; for large vaults the next
  lever is batching (`readTextMany`-style plugin call or a native scan op),
  not `MANAGE_EXTERNAL_STORAGE` — revisit per spec 09 if users hit it.
- **On-disk contract is byte-compatible with desktop**: same folder layout
  (`inbox|quick|archive|trash`, `assets/`, legacy `attachements/` recognized —
  the misspelling is intentional and load-bearing), same `.zennotes/`
  metadata (vault.json, workspace.json, comments/), same naming/collision
  rules, same NoteMeta extraction regexes, `systemFolderPaths` remaps honored
  via `@shared/system-folder-paths`.
- **Share sheet → quick capture**: Android needs no app extension — a
  `text/plain` `ACTION_SEND` intent-filter on MainActivity stashes captures in
  SharedPreferences; the app-local `ShareInbox` plugin (same `jsName` and
  `drain()` contract as the Swift one) hands them to the unchanged JS side on
  launch/foreground.
- **Long-press context menus**: unlike WKWebView, the Android WebView fires a
  real `contextmenu` event on long-press, so the iOS 450ms synthesizer is
  replaced by a passive listener that only adds the haptic and swallows the
  post-lift synthetic mouse burst (without which menus close instantly).
- **TikZ** capability-gated off; workflows not offered; custom TextMate
  languages gated off; vim mode defaults off on first run — all as on iOS.
- **Desktop 2.21/2.22 features** arrive via shared source, same as the iOS
  1.4 build (both stamp upstream 2.22.0): in-progress task state (`- [/]`,
  set via long-press → Mark in progress — the long-press allowlist covers
  task rows, kanban cards, and calendar day cells), subtask rollups, archived
  notes retiring their tasks, inline mermaid while writing, text
  replacements, configurable tab size, manual kanban card order, and
  absence-aware remote reads (`@shared/remote-absence`).

## Build & run

```sh
npm install
npm run sync              # vite build + cap sync android
npx cap open android      # open in Android Studio, or:
cd android && JAVA_HOME=/opt/homebrew/opt/openjdk@21 \
  ANDROID_HOME=/opt/homebrew/share/android-commandlinetools \
  ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Toolchain: JDK 21 + Android SDK 35 (Capacitor 7). `android/local.properties`
points at the SDK. Dev loop against a browser (no emulator): `npm run dev` —
Capacitor plugins are absent in a plain browser, so vault I/O won't work; use
the emulator for real testing.

`npm run upstream` reports what changed in the zennotes repo since the
`.zennotes-commit` stamp and typechecks the bridge against current source.

## Boot-order gotcha (load-bearing)

Prefs seeding + theme attributes live in an **inline classic `<script>` in
index.html**, not a module: the app-core store reads
`localStorage['zen:prefs:v2']` at module-evaluation time, and Rollup chunk
hoisting (manualChunks) runs the store chunk before any entry-chunk module —
an imported "bootstrap.ts" silently ran too late on fresh installs.

## Boot-path chunking (load-bearing)

There is deliberately **no manualChunks rule for mermaid/cytoscape/dagre**
(upstream 2.20 finding): naming that chunk hoisted it into the entry's static
graph, so every cold start fetched and evaluated ~2.5MB of diagram code (plus
vendor-markdown, which it imports) before a note was even open. Left to
Rollup, mermaid splits into async per-diagram chunks fetched the first time a
diagram renders. Same idea: `/@xyflow/` is excluded from the `vendor-react`
substring match so React Flow stays inside the never-loaded WorkflowsView
chunk. Check `dist/index.html`'s modulepreloads after touching the config —
the entry must not statically import mermaid, markdown, or highlight chunks.

## ZenNotes Cloud

On-device and SAF vaults can connect to the optional ZenNotes Cloud service
from Settings → Cloud. The mobile bridge stores the account token in Android
secure storage, links or creates a cloud vault, runs the shared offline-first
sync engine, and exposes backups, note-level restore, publishing, and
automatic sync on app foreground and local changes. Local vaults, SAF folders,
and self-hosted workspaces continue to work without an account or subscription.

## Not yet built

- **SAF read batching** — a `readTextMany`/native-scan plugin op to make
  large external vaults fast (see the performance note above)
- Quick-capture home-screen widget / app shortcuts
- Store distribution work (signing config, Play listing — spec 08)
