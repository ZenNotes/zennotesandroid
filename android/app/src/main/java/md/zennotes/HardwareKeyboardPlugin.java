package md.zennotes;

import android.content.res.Configuration;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Whether a typing keyboard is attached, for the formatting toolbar: with one, the
 * row is only in the way (src/ui-mobile/toolbar-mode.ts). A Bluetooth keyboard can
 * come and go with the app open, so the JS shell hears each change. MainActivity
 * declares keyboard and keyboardHidden in configChanges, which is why a connect
 * reaches onConfigurationChanged instead of recreating the activity.
 */
@CapacitorPlugin(name = "HardwareKeyboard")
public class HardwareKeyboardPlugin extends Plugin {

    private boolean lastSent;

    /** A folded-away keyboard (a lid, a keyboard case turned back) does not count,
     *  and neither does a device's numeric pad or its few buttons. */
    static boolean connected(int keyboard, int hardKeyboardHidden) {
        return keyboard == Configuration.KEYBOARD_QWERTY
            && hardKeyboardHidden == Configuration.HARDKEYBOARDHIDDEN_NO;
    }

    private static boolean connected(Configuration config) {
        return connected(config.keyboard, config.hardKeyboardHidden);
    }

    @Override
    public void load() {
        lastSent = connected(getContext().getResources().getConfiguration());
    }

    @PluginMethod
    public void isConnected(PluginCall call) {
        JSObject result = new JSObject();
        result.put("connected", connected(getContext().getResources().getConfiguration()));
        call.resolve(result);
    }

    @Override
    protected void handleOnConfigurationChanged(Configuration newConfig) {
        boolean now = connected(newConfig);
        if (now == lastSent) return;
        lastSent = now;
        JSObject data = new JSObject();
        data.put("connected", now);
        notifyListeners("change", data);
    }
}
