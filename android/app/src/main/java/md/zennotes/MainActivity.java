package md.zennotes;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.WebView;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // App-local plugins must be registered before the bridge loads.
        registerPlugin(ShareInboxPlugin.class);
        registerPlugin(FolderPickerPlugin.class);
        registerPlugin(SafFsPlugin.class);
        super.onCreate(savedInstanceState);
        // Cold-start share: the launch intent IS the share. Stash it now; the
        // WebView drains the inbox after the vault opens (importPendingShares).
        ShareInboxPlugin.stashFromIntent(this, getIntent());
        neutralizeDoubleKeyboardInset();
        // Fullscreen writing (#22): while the JS shell hides the status bar
        // via the StatusBar plugin, a swipe from the top edge should peek it
        // transiently instead of bringing it back for good. The behavior is
        // inert while the bar is visible, so it is safe to set once here.
        new WindowInsetsControllerCompat(getWindow(), getWindow().getDecorView())
                .setSystemBarsBehavior(
                        WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
    }

    // Mirrors SystemBars' private WEBVIEW_VERSION_WITH_SAFE_AREA_FIX: the
    // WebView major version from which Capacitor pads the WebView's parent
    // by the IME inset (given viewport-fit=cover, which this app always has).
    private static final int WEBVIEW_VERSION_WITH_SAFE_AREA_FIX = 140;

    /**
     * Issues #12 and #15 (Android 10, Huawei SNE-LX2): with a modern WebView
     * (>= 140) and viewport-fit=cover, Capacitor's SystemBars pads the
     * WebView's parent by the full IME inset when the keyboard opens. On
     * API 30+ the window is edge-to-edge, so that padding is the ONLY
     * keyboard compensation and all is well — but on API <= 29 the decor
     * still fits system windows and ALSO makes room for the keyboard, so
     * the inset is subtracted twice: the page ends mid-screen and the
     * vacated strip shows the bare WebView background as a grey block
     * (issue #12).
     *
     * 1.1.7 countered by clearing SystemBars' padding after every layout
     * pass. That looked stable on the forced-gate API 29 emulator, whose
     * frozen WebView (< 140) never re-requests insets — but real WebView
     * 140 re-requests them whenever its size changes, so every clear
     * triggered a re-pad and every re-pad a clear: the layout oscillated
     * at frame rate and the toolbar/grey block flickered (issue #15).
     *
     * So don't fight the padding — remove the OTHER compensation instead.
     * Under exactly the conditions that make SystemBars pad (API < 30,
     * WebView >= 140), put the window in the API 30+ shape: edge-to-edge,
     * with adjustResize pinned so the IME keeps reporting through the
     * window insets SystemBars reads. Its padding then becomes the single
     * compensation, applied once and never cleared — nothing left to
     * oscillate, and no grey block either. On old WebViews (< 140)
     * SystemBars never pads and the classic decor-fitted resize keeps
     * working untouched. Ages out with minSdk 30.
     */
    @SuppressWarnings("deprecation")
    private void neutralizeDoubleKeyboardInset() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            return;
        }
        if (webViewMajorVersion() < WEBVIEW_VERSION_WITH_SAFE_AREA_FIX) {
            return;
        }
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
    }

    private int webViewMajorVersion() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return 0;
        }
        PackageInfo info = WebView.getCurrentWebViewPackage();
        if (info == null || info.versionName == null) {
            return 0;
        }
        try {
            return Integer.parseInt(info.versionName.split("\\.")[0]);
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // Warm share (singleTask): stash before onResume so the foreground
        // appStateChange listener drains it in the same wake.
        ShareInboxPlugin.stashFromIntent(this, intent);
    }
}
