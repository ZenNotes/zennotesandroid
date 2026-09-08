package md.zennotes;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.IOException;

import md.zennotes.widgets.WidgetSnapshot;
import md.zennotes.widgets.WidgetUpdater;

/**
 * Android counterpart of the iOS WidgetBridgePlugin (same jsName, same
 * update()/clear()/consumeLaunchLink() contract, so src/bridge/widgets.ts
 * and ui-mobile/deep-links.ts run unchanged). The WebView publishes the
 * widget snapshot; this writes it into the app's private files and
 * re-renders every placed widget (md.zennotes.widgets). The widgets never
 * see the vault itself.
 */
@CapacitorPlugin(name = "ZenWidgets")
public class WidgetBridgePlugin extends Plugin {

    /**
     * The latest zennotes:// view intent this process has seen, for the
     * WebView to consume at boot. Capacitor's getLaunchUrl captures the
     * activity's intent once, at bridge creation — and a singleTask activity
     * recreated into its old task reports the task's ORIGINAL intent there,
     * while the widget tap that actually woke it arrives through onNewIntent
     * (as a retained appUrlOpen the Cloud auth listener, registered first,
     * consumes). MainActivity stashes both, so the newest wins.
     */
    private static volatile String pendingLaunchLink;

    static void stashLaunchLink(Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) return;
        Uri data = intent.getData();
        if (data == null || !"zennotes".equals(data.getScheme())) return;
        pendingLaunchLink = data.toString();
    }

    @PluginMethod
    public void consumeLaunchLink(PluginCall call) {
        String link = pendingLaunchLink;
        pendingLaunchLink = null;
        JSObject ret = new JSObject();
        ret.put("url", link);
        call.resolve(ret);
    }

    @PluginMethod
    public void update(PluginCall call) {
        String json = call.getString("snapshot");
        if (json == null || json.isEmpty()) {
            call.reject("snapshot is required");
            return;
        }
        final Context context = getContext().getApplicationContext();
        new Thread(() -> {
            try {
                WidgetSnapshot.write(context, json);
            } catch (IOException e) {
                call.reject("Could not write the widget snapshot: " + e.getMessage());
                return;
            }
            WidgetUpdater.refreshAll(context);
            call.resolve();
        }, "zn-widgets").start();
    }

    @PluginMethod
    public void clear(PluginCall call) {
        final Context context = getContext().getApplicationContext();
        new Thread(() -> {
            WidgetSnapshot.delete(context);
            WidgetUpdater.refreshAll(context);
            call.resolve();
        }, "zn-widgets").start();
    }
}
