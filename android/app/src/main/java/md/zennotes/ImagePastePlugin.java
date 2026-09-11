package md.zennotes;

import android.content.res.AssetFileDescriptor;
import android.os.CancellationSignal;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import androidx.core.view.inputmethod.InputConnectionCompat;
import androidx.core.view.inputmethod.InputContentInfoCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.InputStream;
import java.io.IOException;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;

@CapacitorPlugin(name = "ImagePaste")
public class ImagePastePlugin extends Plugin {
    private final Map<String, InputContentInfoCompat> pending = new HashMap<>();
    private final Handler expiry = new Handler(Looper.getMainLooper());
    private final ExecutorService reader = Executors.newSingleThreadExecutor();
    private ClipboardImageRead activeRead;
    private volatile boolean destroyed;

    @Override public void load() {
        ((ImagePasteWebView) getBridge().getWebView()).imageReceiver = this::receive;
    }

    @PluginMethod public void setEnabled(PluginCall call) {
        boolean enabled = call.getBoolean("enabled", false);
        getActivity().runOnUiThread(() -> {
            if (destroyed) { call.reject("Image pasting is unavailable."); return; }
            ((ImagePasteWebView) getBridge().getWebView()).setImagePasteEnabled(enabled);
            call.resolve();
        });
    }

    private synchronized boolean receive(InputContentInfoCompat content, int flags) {
        if (destroyed || !hasListeners("image") || activeRead != null || !pending.isEmpty() || !"content".equals(content.getContentUri().getScheme())) return false;
        boolean supported = false;
        for (String type : ImagePasteWebView.IMAGE_TYPES) supported |= content.getDescription().hasMimeType(type);
        if (!supported) return false;
        try {
            if ((flags & InputConnectionCompat.INPUT_CONTENT_GRANT_READ_URI_PERMISSION) != 0) content.requestPermission();
        } catch (RuntimeException error) { return false; }
        String id = UUID.randomUUID().toString();
        pending.put(id, content);
        JSObject event = new JSObject();
        event.put("id", id);
        notifyListeners("image", event);
        expiry.postDelayed(() -> release(id), 30000);
        return true;
    }

    private synchronized InputContentInfoCompat take(String id) { return pending.remove(id); }
    private void release(String id) {
        InputContentInfoCompat content = take(id);
        if (content != null) releasePermission(content);
    }
    private static void releasePermission(InputContentInfoCompat content) {
        try { content.releasePermission(); } catch (RuntimeException ignored) { /* provider already revoked it */ }
    }

    // Plugin methods run off the UI thread. Never send arbitrary URIs through
    // the JS bridge: read only the short-lived token from a user paste event.
    @PluginMethod public synchronized void read(PluginCall call) {
        if (destroyed) { call.reject("Image pasting is unavailable."); return; }
        InputContentInfoCompat content = take(call.getString("id", ""));
        if (content == null) { call.reject("The pasted image expired. Please paste it again."); return; }
        CancellationSignal cancellation = new CancellationSignal();
        ClipboardImageRead read = new ClipboardImageRead(() -> {
            releasePermission(content);
            try { cancellation.cancel(); } catch (RuntimeException ignored) { /* provider already gone */ }
        });
        activeRead = read;
        try { reader.execute(() -> readImage(call, content, read, cancellation)); }
        catch (RejectedExecutionException error) {
            activeRead = null;
            read.close();
            call.reject("Image pasting is unavailable. Please reopen the note.");
        }
    }
    private void readImage(PluginCall call, InputContentInfoCompat content, ClipboardImageRead read, CancellationSignal cancellation) {
        try {
            if (read.isClosed()) return;
            byte[] bytes;
            try (AssetFileDescriptor descriptor = getContext().getContentResolver()
                    .openAssetFileDescriptor(content.getContentUri(), "r", cancellation)) {
                InputStream stream = read.attach(descriptor == null ? null : descriptor.createInputStream());
                bytes = ClipboardImageData.read(stream, ClipboardImageData.MAX_BYTES);
            }
            JSObject result = new JSObject();
            result.put("mimeType", ClipboardImageData.mimeType(bytes));
            result.put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP));
            read.respondIfOpen(() -> call.resolve(result));
        } catch (ClipboardImageData.InvalidImage error) {
            read.respondIfOpen(() -> call.reject(error.getMessage()));
        } catch (IOException | RuntimeException error) {
            read.respondIfOpen(() -> call.reject("Could not read the pasted image. Please copy it again."));
        } finally {
            read.close();
            synchronized (this) { if (activeRead == read) activeRead = null; }
        }
    }

    @PluginMethod public void discard(PluginCall call) {
        release(call.getString("id", ""));
        call.resolve();
    }

    @Override protected synchronized void handleOnDestroy() {
        destroyed = true;
        expiry.removeCallbacksAndMessages(null);
        if (activeRead != null) { activeRead.close(); activeRead = null; }
        reader.shutdownNow();
        for (InputContentInfoCompat content : pending.values()) releasePermission(content);
        pending.clear();
    }
}
