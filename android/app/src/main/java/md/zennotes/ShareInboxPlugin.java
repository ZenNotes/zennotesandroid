package md.zennotes;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Android counterpart of the iOS ShareInbox plugin (same jsName, same drain()
 * contract, so src/bridge/mobile-bridge.ts runs unchanged). iOS fills the
 * inbox from a Share Extension via an App Group; here MainActivity receives
 * ACTION_SEND text shares directly and stashes them in SharedPreferences
 * until the WebView drains them into quick notes.
 */
@CapacitorPlugin(name = "ShareInbox")
public class ShareInboxPlugin extends Plugin {

    private static final String PREFS = "zn_share_inbox";
    private static final String KEY = "captures";

    /** Append a {body, createdAt} capture from an ACTION_SEND text intent. */
    static void stashFromIntent(Context context, Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return;
        String type = intent.getType();
        if (type == null || !type.startsWith("text/")) return;
        String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        if (text == null || text.trim().isEmpty()) return;
        String body = text.trim();
        String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        if (subject != null && !subject.trim().isEmpty() && !body.contains(subject.trim())) {
            body = subject.trim() + "\n\n" + body;
        }
        // Consume the extra so an activity re-create can't duplicate the capture.
        intent.removeExtra(Intent.EXTRA_TEXT);

        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        try {
            JSONArray captures = new JSONArray(prefs.getString(KEY, "[]"));
            JSONObject capture = new JSONObject();
            capture.put("body", body);
            capture.put("createdAt", System.currentTimeMillis());
            captures.put(capture);
            prefs.edit().putString(KEY, captures.toString()).apply();
        } catch (JSONException ignored) {
            // A corrupt inbox is dropped rather than blocking future captures.
            prefs.edit().remove(KEY).apply();
        }
    }

    /** Read and clear the pending captures. */
    @PluginMethod
    public void drain(PluginCall call) {
        SharedPreferences prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String raw = prefs.getString(KEY, "[]");
        prefs.edit().remove(KEY).apply();
        JSObject ret = new JSObject();
        try {
            // JSArray(String) parses the stored JSON; JSArray.from(Object) would
            // reject a JSONArray argument and return null (captures silently lost).
            ret.put("captures", new JSArray(raw));
        } catch (JSONException e) {
            ret.put("captures", new JSArray());
        }
        call.resolve(ret);
    }
}
