package md.zennotes.widgets;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;

import java.nio.charset.StandardCharsets;
import java.util.Locale;

import md.zennotes.MainActivity;

/**
 * The `zennotes://` links the shell runs (src/ui-mobile/widget-links.ts is
 * the parser and the source of truth for the vocabulary). Every tap is an
 * ACTION_VIEW intent aimed at MainActivity: cold, Capacitor's App plugin
 * reports it through getLaunchUrl; warm (singleTask), through onNewIntent
 * and the appUrlOpen event.
 */
public final class WidgetLinks {
    private WidgetLinks() {}

    /** Only unreserved characters stay bare: `#` in task ids and `&` in
     *  titles would otherwise split the URL. */
    private static final String UNRESERVED =
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

    public static Uri newNote() {
        return Uri.parse("zennotes://new");
    }

    public static Uri tasks() {
        return Uri.parse("zennotes://tasks");
    }

    public static Uri home() {
        return Uri.parse("zennotes://home");
    }

    public static Uri open(String path) {
        return Uri.parse("zennotes://open?path=" + encode(path));
    }

    public static Uri task(String id, String path) {
        return Uri.parse("zennotes://task?id=" + encode(id) + "&path=" + encode(path));
    }

    static String encode(String value) {
        byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
        StringBuilder out = new StringBuilder(bytes.length * 3);
        for (byte b : bytes) {
            int c = b & 0xff;
            if (c < 128 && UNRESERVED.indexOf((char) c) >= 0) {
                out.append((char) c);
            } else {
                out.append(String.format(Locale.US, "%%%02X", c));
            }
        }
        return out.toString();
    }

    /** A whole-widget or button tap: fixed link, immutable intent. */
    public static PendingIntent activity(Context context, Uri link, int requestCode) {
        Intent intent = new Intent(Intent.ACTION_VIEW, link, context, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(context, requestCode, intent, flags);
    }

    /** The list template: rows fill in their own link (setOnClickFillInIntent),
     *  which needs a mutable pending intent on Android 12+. */
    public static PendingIntent template(Context context, int requestCode) {
        Intent intent = new Intent(Intent.ACTION_VIEW, null, context, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) flags |= PendingIntent.FLAG_MUTABLE;
        return PendingIntent.getActivity(context, requestCode, intent, flags);
    }

    public static Intent fillIn(Uri link) {
        Intent intent = new Intent();
        intent.setData(link);
        return intent;
    }
}
