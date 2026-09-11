# Android issue pass — 11 September 2026

Validation snapshot for work prepared on `release/1.1.19`. No release has
been published and no GitHub issues were closed in this pass. Existing Cloud
responsiveness work for #52 was preserved. Desktop, website, and iOS code
were not changed. Commit/push was approved on 11 September; native verification
remains pending. Status comments were posted on all eight open issues.

## Issue-by-issue status

| Issue | Change / finding | Verification still needed |
| --- | --- | --- |
| [#45](https://github.com/ZenNotes/zennotesandroid/issues/45) | Investigated the Google Play installer prompt. No source licensing check, `CHECK_LICENSE` permission, or Pairip/licensing strings found in the downloaded 1.1.15 and 1.1.18 universal APKs (all DEX files searched). This does **not** identify the cause or prove absence of protection. | Reproduce using the exact affected APK/install path; compare fresh and upgraded sideload installs; inspect Play Console automatic-protection settings. No settings were changed. |
| [#48](https://github.com/ZenNotes/zennotesandroid/issues/48) | Give the Cloud footer a 44px row and lift the floating navigation, menu, and hint above it. The old footer selector stopped matching after upstream responsive-padding changes. | Native portrait/landscape check with Connect, Retry, and Review actions. |
| [#49](https://github.com/ZenNotes/zennotesandroid/issues/49) | Make body/root/editor surfaces opaque and theme-colored instead of exposing the WebView backing color during compositing. **Mitigation, not a reproduced root-cause fix.** | Reproduce native selection-handle flicker on affected Android/WebView versions and verify this change actually stops it. |
| [#50](https://github.com/ZenNotes/zennotesandroid/issues/50) | Navigate a wikilink only after a short completed tap. Reject drags, scrolling, long presses, existing/extended selection, cancellation, and multitouch; block delayed compatibility mouse events. | Native tap, scroll, long-press, and selection-handle tests, including a link whose rendered DOM disappears on touch. |
| [#51](https://github.com/ZenNotes/zennotesandroid/issues/51) | Measure the docked selection toolbar and reserve real space in the flex editor, shrinking its scroller. Scroll-content padding alone allowed handles/text under the overlay. | Actual IME open/close, native selection extension near the bottom, landscape, rotation, and in-note search. |
| [#53](https://github.com/ZenNotes/zennotesandroid/issues/53) | Replace the decorative pill with a 44px drag handle on all mobile sheets. Downward drag/swipe dismisses; short/cancelled gestures snap back. Keyboard/assistive activation closes the sheet. Content scrolling remains native. | Native drag, cancellation, list scrolling, nested Vaults/New Vault sheets, and TalkBack. |
| [#54](https://github.com/ZenNotes/zennotesandroid/issues/54) | Add Android IME rich-content support to a Capacitor WebView subclass. Accept explicit keyboard image pastes only in an editable note, save through the existing vault asset path, and insert a wikilink. | Real Gboard clipboard PNG/JPEG/GIF/WebP, failed/revoked URI permissions, repeated paste, switching notes/vaults during paste, and Cloud delivery to another client. |
| [#55](https://github.com/ZenNotes/zennotesandroid/issues/55) | Install AndroidX splash handling before Capacitor changes the launch theme; use the same square bitmap inside a square padded canvas on all versions. Disable the duplicate plugin launch splash. | Cold/warm launches on pre-12 and 12+ Android, portrait and landscape; verify icon proportions, no clipping, no double splash. |

## Automated checks

- `npm test`: 121 tests passed, including the existing Cloud suite.
- `tsc --noEmit`: passed.
- `npm run build`: passed; existing upstream JSXGraph direct-eval warning remains.
- `npx cap sync android`: passed.
- Gradle `:app:testDebugUnitTest :app:assembleDebug`: passed (9 Java tests).
- `npm audit --omit=dev`: zero reported vulnerabilities.
- `git diff --check`: passed.

New regression tests were run failing before their corresponding changes,
then passing. CSS/XML tests check contracts, not visual or device behavior.
Java tests check bounded reads and signatures, not an actual IME session.
They also check cancellation cleanup with late-opening and in-flight fake
streams; native provider behavior still requires device verification.
Sheet tests invoke the real component handlers with fake pointer events;
they are not physical touch-device tests.

A second-pass review caught WebP images receiving a JPEG filename in the
self-hosted `RemoteVault` paste path. It now uses the shared filename helper;
regressions through the real vault implementation cover WebP, safe suggested
names, asset events/embeds, and existing PNG/JPEG/GIF behavior. This is distinct
from the regular ZenNotes Cloud path, which uses `MobileVault`.

Review also caught an in-flight URI grant missing from activity teardown.
`ClipboardImageRead` now retains that grant until completion or cancellation,
releases it exactly once, closes the tracked stream on teardown, and rejects
and closes a stream returned by the provider after cancellation. Provider
opening uses `openAssetFileDescriptor` with a `CancellationSignal`; teardown
signals cancellation as well as releasing the grant. A misbehaving provider
may still take time to return. Response dispatch and cancellation share one
lock, so a closed read cannot subsequently dispatch a result into the bridge.
Tests cover cancelled responses and teardown racing with dispatch.

Play Console was checked read-only in the current browser account, but it
only offered developer-account signup, not access to the app's settings.
No account or protection settings were changed. This leaves #45 unresolved.

## Browser fixture

Run `npm run dev`, then open `/tooling/android-ui-check.html`. The fixture
uses real CodeMirror, the shared selection toolbar, and the new sheet handle,
but no native filesystem or account. It is not a replacement for an installed
Android app test.

Verified in Chromium:

- 390×650 and 320×640: Cloud footer is 44px; floating button is above it.
- Selection toolbar at 390×650: scroller ends at 474px, toolbar starts at 482px.
- Simulated keyboard-reduced 390×380 viewport: scroller ends at 204px,
  toolbar starts at 212px.
- Close-handle keyboard activation dismisses the sheet.
- Theme toggle gives body, root, and editor the same opaque background.
- No app-origin errors observed; unrelated extension warnings were present.

No Android emulator or iOS simulator was started in this pass, following the
earlier CPU-load concern. Permission to run one Android emulator was requested
but not yet received. The newly built APK has not been installed or launched.

## Native image-paste constraints

This is keyboard **Commit Content**, not background clipboard polling. It uses
temporary `content://` permission grants, short-lived opaque tokens, bounded
reads on a dedicated worker, and signature checks for PNG/JPEG/GIF/WebP. No
new storage permission, service, dependency, or Cloud quota change is needed.
Pasted image input is limited to 10 MiB to bound bridge/memory cost; larger
files can still use the existing Attach flow, subject to normal Cloud limits.

The note, vault, editor, document and selection must still match after loading
the image. If they change, insertion is cancelled rather than writing into a
different note. If an asset was already saved when the note changed, the user
is told to insert it from the vault assets. URI permissions expire if JavaScript
does not consume the paste, and are released on completion/failure/destruction.

## Sources for platform decisions

- [Android image keyboard / Commit Content API](https://developer.android.com/develop/ui/views/touch-and-input/image-keyboard)
- [Android cancellable content-provider file access](https://developer.android.com/reference/android/content/ContentResolver#openAssetFileDescriptor(android.net.Uri,%20java.lang.String,%20android.os.CancellationSignal))
- [Android splash-screen migration](https://developer.android.com/develop/ui/views/launch/splash-screen/migrate)
- [Google Play installer-check guidance](https://support.google.com/googleplay/android-developer/answer/15621622?hl=en)

## Release gate

Do not mark these as shipped or close the issues solely from passing unit
tests. Complete native checks and normal release review/CI. Commit/push has
been approved, but release publication has not. Keep #45 open until the installer problem is reproduced and
resolved, and #49 open until the reported flicker is actually verified fixed.
The branch name is `release/1.1.19`, but version metadata is still 1.1.18 / code
20; perform the normal version bump before building the release artifact.

## Workflow skills used

Issue resolution, systematic debugging, test-driven development, incremental
implementation, Git workflow, modern web guidance, frontend UI engineering,
browser testing, security hardening, code review, and documentation/ADRs guided
the work. In particular, they kept native verification distinct from browser
and unit checks, required regression coverage, and prompted the second-pass
review. Commit/push was approved; native-device execution still needs approval.
