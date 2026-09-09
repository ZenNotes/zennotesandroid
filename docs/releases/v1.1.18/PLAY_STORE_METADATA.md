# Play Console metadata: ZenNotes 1.1.18

| Field | Value | Limit |
| --- | --- | --- |
| App name | ZenNotes: Markdown Notes | 30 |
| Short description | see `SHORT_DESCRIPTION.txt` (unchanged) | 80 |
| Full description | see `PLAY_STORE_DESCRIPTION.txt` (updated: widgets section) | 4000 |
| Release notes | see `WHATS_NEW.md` (under 500 chars) | 500 |
| Category | Productivity | n/a |
| Application ID | md.zennotes | n/a |
| Version | 1.1.18 (versionCode 20) | n/a |
| Contact email | adib@lumarylabs.com | n/a |
| Website | https://zennotes.org | n/a |
| Privacy policy URL | https://zennotes.org/privacy | n/a |
| Ads | Contains no ads | n/a |
| Price | Free app; optional external SaaS subscription | n/a |

## Data safety

Unchanged. No new permissions, no new collection. The widgets read a
summary file in the app's private storage (note titles, paths, dates,
task lines, theme colors); no note bodies and nothing off the device.

## Release checks

- Native version: 1.1.18; versionCode: 20 (bump committed on its own
  after the widget commit). Capacitor 8.5 / SDK 36 / minSdk 24 / AGP 8.13
  / Gradle 8.14.5. Native changes: `WidgetBridgePlugin.java`, the
  `md.zennotes.widgets` package, widget layouts, drawables and
  appwidget-provider metadata, three receivers and two services in the
  manifest. No permission changes.
- Source: branch `release/1.1.18` off main. Commits: the widgets, the
  version bump, this pack. main already carried the a3e638fc pin (app
  core 2.46.0 plus the js-yaml / svgo lockfile fix) and the shell's own
  js-yaml bump.
- Verified 2026-09-08 on the Pixel 7 API 35 AVD: the picker previews, all
  three widgets placed, New Note, note rows and task rows warm and after
  a real process kill (landing on the task's line), the widgets updating
  within seconds; `npm test` 50/50; `npm run typecheck` clean at the pin;
  `testDebugUnitTest`, `lintDebug` and `assembleDebug` pass. Not verified
  on a device or below API 31.
- Comment sidecar fix (2026-09-09, after the merge): between the 1.1.16
  pin and a3e638fc, desktop `vault.ts` dropped its private comment
  normalizer for the shared `@shared/note-comments`, which keeps the 2.46
  `author` and `parentId` fields. `MobileVault.writeNoteComments` still
  rebuilt each record from a fixed field list, and app-core hands over the
  whole list on every comment action, so one reply, resolve, or delete on
  the phone would have flattened every thread and dropped every name the
  desktop or an assistant wrote. `src/bridge/vault-fs.ts` now reads and
  writes the sidecar through the shared normalizer, as desktop does.
  Verified by `npm run typecheck`, `npm run build`, and `npm test`;
  `MobileVault` cannot run under `node --test` (path aliases), and the
  fix was not re-run on the AVD. Same fix as iPhone 1.9.8.
- Matching ports: iOS ZenNotes/zennotesios `release/1.9.8` (build 19);
  desktop ZenNotes/zennotes 2.46.0.
