# Play Console metadata: ZenNotes 1.1.19

Prepared 2026-09-11 for the 21 (1.1.19) production release.

| Field | Value | Limit |
| --- | --- | --- |
| App name | ZenNotes: Markdown Notes | 30 |
| Short description | see `SHORT_DESCRIPTION.txt` (unchanged) | 80 |
| Full description | see `PLAY_STORE_DESCRIPTION.txt` (unchanged) | 4000 |
| Release notes | see `WHATS_NEW.md` | 500 |
| Promotional copy | see `PROMOTIONAL_TEXT.txt` | 170 |
| Category | Productivity | n/a |
| Application ID | md.zennotes | n/a |
| Target version | 1.1.19, versionCode 21 | n/a |
| Contact email | adib@lumarylabs.com | n/a |
| Website | https://zennotes.org | n/a |
| Privacy policy URL | https://zennotes.org/privacy | n/a |
| Ads | Contains no ads | n/a |
| Price | Existing listing unchanged | n/a |

## Data safety

No changes. The sync scan cache stores file paths, timestamps, sizes,
hashes, and media metadata in app-private storage, not additional copies
of note bodies. Keyboard image paste reads the image the keyboard hands
over through a temporary URI grant and saves it into the vault like any
other attachment. Existing optional Cloud data flows are unchanged. No
new permissions, analytics, or third-party SDKs.

## Release checks

- Branch `release/1.1.19`, based on main `6759cb2`. Source pin unchanged
  from main: `431907dfb63a59192ff414839673446564ee737e` (app core 2.47.0).
- versionName, bridge `appVersion`, package.json, and the lockfile root
  all read 1.1.19; versionCode 21 (Play Console showed 20 as the latest
  production release before this one).
- Release build at the pin: typecheck clean, 121/121 Node tests, 9 Java
  tests, `bundleRelease` signed with the upload key, merged manifest
  versionCode 21 / 1.1.19, AAB sha256
  `cc93676c880a9e2b0e6f825b06a9e16299ed14b7d26283fdbed2b5a300423bfe`.
- Pixel 7 API 35 emulator: debug build of the same tree installs and
  launches, opens the ⊕ menu and the More sheet, and dismisses the sheet on a handle drag, with no crash in logcat. Browser fixture checks are in
  `docs/android-issue-validation-2026-09-11.md`.
- Not verified on hardware: typing during a live Cloud sync, Gboard image
  paste, and the selection-handle flicker (#49).
- After Play publishes, the GitHub release uses Play's signed universal
  APK (app-key cert 9a8484df…), never a locally signed upload-key APK.
