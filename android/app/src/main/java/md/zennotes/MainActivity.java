package md.zennotes;

import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.view.View;

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
    }

    /**
     * Issue #12 (Android 10, Huawei SNE-LX2): with a modern WebView (>= 140)
     * and viewport-fit=cover, Capacitor's SystemBars pads the WebView's
     * parent by the full IME inset when the keyboard opens. On API 30+
     * that is the ONLY keyboard compensation (adjustResize is inert under
     * edge-to-edge) and everything is fine — but on API <= 29 the window
     * ALSO resizes for the keyboard, so it is subtracted twice: the page
     * ends mid-screen, the formatting toolbar docks there, and the vacated
     * strip shows the bare WebView background as a grey block above the
     * keyboard. Reproduced on an API 29 emulator by forcing SystemBars'
     * version gate, which is why no stock emulator shows it (their frozen
     * WebViews are < 140).
     *
     * The guard is self-gating rather than version-sniffing: on API <= 29,
     * whenever a layout pass leaves bottom padding on the WebView's parent,
     * remove it. On old WebViews (< 140) SystemBars never pads, so this is
     * a no-op; on new ones it cancels exactly the double-counted inset.
     * Ages out with minSdk 30.
     */
    private void neutralizeDoubleKeyboardInset() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            return;
        }
        View parent = (View) bridge.getWebView().getParent();
        parent
            .getViewTreeObserver()
            .addOnGlobalLayoutListener(() -> {
                if (parent.getPaddingBottom() != 0) {
                    parent.setPadding(
                        parent.getPaddingLeft(),
                        parent.getPaddingTop(),
                        parent.getPaddingRight(),
                        0
                    );
                }
            });
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // Warm share (singleTask): stash before onResume so the foreground
        // appStateChange listener drains it in the same wake.
        ShareInboxPlugin.stashFromIntent(this, intent);
    }
}
