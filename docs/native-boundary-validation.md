# Native package boundary validation

The host consumes the three archives pinned in `vendor/zennotes/manifest.json`.
There is no main-repository checkout or private editor/store import in the build.

## Package checks

```sh
npm ci
npm run boundaries:check
npm run typecheck
npm test
npm run build
```

Run the same checks in a fresh copy containing the package manifest/lock, vendor
archives, source, public assets, tooling, TypeScript/Vite/Tailwind/PostCSS config,
and native project. Omit `node_modules` and any historical source clone.

## Disposable native runtime

Use a newly created simulator/emulator with no real account or vault. The fixture
creates a uniquely named test vault and writes notes and attachments. Do not put
this fixture in a release or install it on a personal device.

1. Run `npm run build:boundary-fixture`. Only this explicit command adds
   `tooling/native-boundary-fixture.ts` to the app; ordinary `npm run build` does not.
2. In a disposable checkout, copy `dist-boundary-check/` into `dist/`, then run
   `npx cap sync android` and build the native debug/simulator app as below.
3. Install and launch on the disposable device. The fixture checks native typing,
   exact Unicode and trailing whitespace, search, task observation, attachments,
   note rename, comments, trash/restore, and whole-vault rename under the public
   workspace transition lock.
4. Read `boundary-validation.json` in the private Data directory in the app data container. It must
   report `passed-awaiting-restart` with 20 checks and no error.
5. Terminate and relaunch the app without clearing its data. The report must now
   be `restart-passed`, including vault identity, selected note and exact bytes.
6. Remove the disposable device when finished. Before a normal build, use
   `npm run build` and `npx cap sync android` to replace the fixture assets.

The fixture uses public core APIs and the native filesystem bridge. It needs no
account credentials. It does not prove live Cloud sync, iCloud account behavior,
or every third-party storage provider; those remain separate release checks.

## Android native checks

With a disposable AVD running, set `ANDROID_SERIAL` to its identifier. From
`android/`, using the project's supported JDK and Android SDK, run:

```sh
./gradlew --no-daemon :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
./gradlew --no-daemon :app:connectedDebugAndroidTest
```

Instrumentation includes a test-APK-only content provider. It exercises the real
Android resolver and `SafFsPlugin` for text/base64 reads, verified absence,
directories, revoked access, null listings, and unreadable documents. Provider
failures must never become missing-file results in optional sidecar reads.

For fixture reports, use the isolated WebView's debug connection to call
`Capacitor.Plugins.Filesystem.readFile` with directory `DATA`, path
`boundary-validation.json`, and encoding `utf8`. Reinstall the debug APK after
instrumentation if Gradle removed it, then launch the fixture separately.
