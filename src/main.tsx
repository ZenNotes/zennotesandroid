/**
 * ZenNotes Android shell: install the mobile ZenBridge, open (or create) the
 * on-device vault, then mount the shared app-core UI — the same contract
 * apps/web/src/main.tsx follows, plus the mobile-only affordances layered in
 * ui-mobile/.
 *
 * Prefs/theme pre-boot lives in an inline script in index.html — it MUST run
 * before the app-core store module evaluates, and Rollup chunk hoisting makes
 * module import order unreliable for that.
 */
import { App as CapApp } from '@capacitor/app'
import { Keyboard, KeyboardResize } from '@capacitor/keyboard'
import { renderZenNotesApp, requestCloudAutoSync } from '@zennotes/app-core/main'
import {
  installMobileBridge,
  loadNativeAppVersion,
  bootVault,
  activeVault,
  importPendingShares
} from './bridge/mobile-bridge'
import { ensureDownloaded } from './bridge/icloud'
import { configureMobileCloudAuth } from './bridge/mobile-cloud-auth'
import { maybeRunFirstRunOnboarding } from './ui-mobile/Onboarding'
import { mountMobileShell } from './ui-mobile/MobileShell'
import { isPhoneViewport, watchPhoneClass } from './viewport'
import './ui-mobile/mobile.css'

function wireKeyboard(): void {
  const html = document.documentElement
  // Tablets: hardware keyboards / the floating mini-keyboard still report a
  // "keyboard frame", and Native resize would shrink the WebView leaving a
  // black band where no keyboard is. Don't resize there — the toolbar lifts
  // by --zn-kb-height in CSS instead, gated on the zn-kb-noresize class set
  // below. Phones keep Native resize (the soft keyboard is the
  // norm and resizing keeps the caret visible); the toolbar docks with
  // bottom: 0 on the shrunk viewport — the keyboard's top edge. Unlike the
  // iPhone shell, nothing is computed from keyboardWillShow's geometry: on
  // Android the reported keyboardHeight includes the gesture-nav inset the
  // edge-to-edge WebView margin already excludes, and the plugin event races
  // the JS resize event, so any derived keyboard-top Y is unreliable
  // (issue #7's mid-screen toolbar).
  const applyResizeMode = (isPhone: boolean): void => {
    html.classList.toggle('zn-kb-noresize', !isPhone)
    void Keyboard.setResizeMode({
      mode: isPhone ? KeyboardResize.Native : KeyboardResize.None
    }).catch(() => {})
  }
  // Phone-ness is smallestWidth-based, so rotating never flips it (issue #12);
  // watchPhoneClass also publishes the same decision to CSS, so the resize mode
  // and the rules that assume it can't drift apart the way the old
  // innerWidth-at-boot check did.
  watchPhoneClass(applyResizeMode)
  applyResizeMode(isPhoneViewport())
  void Keyboard.addListener('keyboardWillShow', (info) => {
    html.classList.add('zn-kb-open')
    html.style.setProperty('--zn-kb-height', `${info.keyboardHeight}px`)
  }).catch(() => {})
  void Keyboard.addListener('keyboardWillHide', () => {
    html.classList.remove('zn-kb-open')
    html.style.setProperty('--zn-kb-height', '0px')
  }).catch(() => {})
}

function wireForegroundRescan(): void {
  void CapApp.addListener('appStateChange', ({ isActive }) => {
    if (!isActive) return
    // Order matters: pull down anything iCloud evicted/changed while
    // backgrounded, land shared captures, then rescan so the UI catches up.
    void (async () => {
      try {
        const v = activeVault()
        if (v.fs.isCloud && v.fs.rootUri) await ensureDownloaded(v.fs.rootUri, 15000)
      } catch {
        // no vault open yet
      }
      await importPendingShares().catch(() => 0)
      try {
        await activeVault().rescan()
      } catch {
        // no vault open yet
      }
      requestCloudAutoSync('foreground')
    })()
  }).catch(() => {})
}

async function boot(): Promise<void> {
  const appVersion = await loadNativeAppVersion()
  await configureMobileCloudAuth(appVersion)
  installMobileBridge()
  wireKeyboard()
  wireForegroundRescan()

  // True first run: welcome + storage choice BEFORE the vault is created, so
  // notes land in the tier the user actually picked (iCloud vs. on-device).
  await maybeRunFirstRunOnboarding()
  await bootVault()
  await importPendingShares().catch(() => 0)

  const root = document.getElementById('root')
  if (!root) throw new Error('Renderer root element #root was not found')
  renderZenNotesApp(root)
  mountMobileShell()
}

void boot().catch((err) => {
  console.error('ZenNotes failed to boot', err)
  const root = document.getElementById('root')
  if (root) {
    root.innerHTML = `<div style="padding:48px 24px;font-family:-apple-system,sans-serif;color:#ddd;background:#1d2021;height:100vh;box-sizing:border-box"><h1 style="font-size:18px">ZenNotes could not open the vault</h1><p style="font-size:14px;opacity:.8">${String(
      (err as Error)?.message ?? err
    )}</p></div>`
  }
})
