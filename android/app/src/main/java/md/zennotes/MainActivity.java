package md.zennotes;

import android.content.Intent;
import android.os.Bundle;

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
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // Warm share (singleTask): stash before onResume so the foreground
        // appStateChange listener drains it in the same wake.
        ShareInboxPlugin.stashFromIntent(this, intent);
    }
}
