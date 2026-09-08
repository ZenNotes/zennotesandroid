# Play Console metadata: ZenNotes 1.1.17

| Field | Value | Limit |
| --- | --- | --- |
| App name | ZenNotes: Markdown Notes | 30 |
| Short description | see `SHORT_DESCRIPTION.txt` (unchanged) | 80 |
| Full description | see `PLAY_STORE_DESCRIPTION.txt` (unchanged) | 4000 |
| Release notes | see `WHATS_NEW.md` (under 500 chars) | 500 |
| Category | Productivity | n/a |
| Application ID | md.zennotes | n/a |
| Version | 1.1.17 (versionCode 19) | n/a |
| Contact email | adib@lumarylabs.com | n/a |
| Website | https://zennotes.org | n/a |
| Privacy policy URL | https://zennotes.org/privacy | n/a |
| Ads | Contains no ads | n/a |
| Price | Free app; optional external SaaS subscription | n/a |

## Data safety

Unchanged. No new permissions, no new collection. Comment authorship is a
name stored in the note's own comment file inside the vault; saved filters
are a device preference.

## Release checks

- Native version: 1.1.17; versionCode: 19 (bump committed with the 2.46.0
  pin). Capacitor 8.5 / SDK 36 / minSdk 24 / AGP 8.13 / Gradle 8.14.5.
  Native changes: none on this branch.
- Source: branch `release/1.1.17`. Commits: the pin move and bump, and this
  pack. No shell changes.
- Build is pinned to upstream `da59c372` (the 2.46.0 tag commit), up from
  `3301a29` (2.45.0) in 1.1.16. Between the pins app-core gains comment
  threads with authors and replies, the @ menu calendar, saved Tasks
  filters, the folder-based Kanban board, and two math fixes; the bridge
  contract gains optional comment fields (`author`, `parentId`) and the
  `kanbanFolderRoot` view setting.
- Verified 2026-09-08 at the pin: `npm run typecheck` clean against
  app-core 2.46.0; `npm test`; `npm run build` production bundle. Not
  exercised on an emulator for this pin release.
- Matching ports: iOS ZenNotes/zennotesios `release/1.9.8` (build 19);
  desktop ZenNotes/zennotes 2.46.0.
