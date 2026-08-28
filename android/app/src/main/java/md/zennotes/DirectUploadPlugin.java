package md.zennotes;

import android.util.Base64;
import android.util.Base64InputStream;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;

/**
 * Streams a base64 Cloud item to its short-lived signed object-storage URL.
 *
 * Capacitor's Android `dataType: file` implementation only decodes the body
 * on API 26+, while ZenNotes supports API 24. Keeping this tiny uploader in
 * the app makes the same direct-upload contract work on every supported OS.
 * The account bearer token never enters this plugin; it receives only the
 * signed URL and storage headers returned for this one upload.
 */
@CapacitorPlugin(name = "ZenDirectUpload")
public class DirectUploadPlugin extends Plugin {
    private static final int CONNECT_TIMEOUT_MS = 30_000;
    private static final int READ_TIMEOUT_MS = 300_000;
    private static final int BUFFER_SIZE = 64 * 1024;

    @PluginMethod
    public void put(PluginCall call) {
        execute(() -> upload(call));
    }

    private void upload(PluginCall call) {
        HttpURLConnection connection = null;
        try {
            String value = call.getString("url");
            String base64 = call.getString("base64");
            Integer expectedBytes = call.getInt("byteLength");
            JSObject headers = call.getObject("headers", new JSObject());
            if (value == null || base64 == null || expectedBytes == null || expectedBytes < 0) {
                call.reject("Invalid direct-upload request.", "INVALID_DIRECT_UPLOAD_REQUEST");
                return;
            }

            URL url = new URL(value);
            validateUrl(url);
            connection = (HttpURLConnection) url.openConnection();
            connection.setRequestMethod("PUT");
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setDoOutput(true);
            connection.setFixedLengthStreamingMode(expectedBytes);
            applyHeaders(connection, headers);

            long written = 0;
            byte[] buffer = new byte[BUFFER_SIZE];
            try (
                InputStream encoded = new ByteArrayInputStream(base64.getBytes(StandardCharsets.US_ASCII));
                InputStream decoded = new Base64InputStream(encoded, Base64.DEFAULT);
                OutputStream output = connection.getOutputStream()
            ) {
                int count;
                while ((count = decoded.read(buffer)) != -1) {
                    output.write(buffer, 0, count);
                    written += count;
                }
                output.flush();
            }
            if (written != expectedBytes) {
                throw new IllegalArgumentException("Decoded upload size changed before transmission.");
            }

            int status = connection.getResponseCode();
            drain(status >= 400 ? connection.getErrorStream() : connection.getInputStream());
            JSObject result = new JSObject();
            result.put("status", status);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Cloud object upload failed.", "DIRECT_UPLOAD_FAILED", error);
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static void validateUrl(URL url) {
        String protocol = url.getProtocol();
        String host = url.getHost() == null ? "" : url.getHost().toLowerCase();
        boolean loopback = host.equals("localhost") || host.equals("::1") || host.startsWith("127.");
        if ((!protocol.equals("https") && !(protocol.equals("http") && loopback)) || url.getUserInfo() != null) {
            throw new IllegalArgumentException("Unsafe direct-upload URL.");
        }
    }

    private static void applyHeaders(HttpURLConnection connection, JSObject headers) throws Exception {
        Iterator<String> names = headers.keys();
        while (names.hasNext()) {
            String name = names.next();
            String value = headers.getString(name);
            if (value == null || containsNewline(name) || containsNewline(value)) {
                throw new IllegalArgumentException("Invalid direct-upload header.");
            }
            if (name.equalsIgnoreCase("Authorization")) {
                throw new IllegalArgumentException("Authorization is not allowed on signed object uploads.");
            }
            connection.setRequestProperty(name, value);
        }
    }

    private static boolean containsNewline(String value) {
        return value.indexOf('\r') >= 0 || value.indexOf('\n') >= 0;
    }

    private static void drain(InputStream input) {
        if (input == null) return;
        byte[] buffer = new byte[4 * 1024];
        try (InputStream stream = input) {
            while (stream.read(buffer) != -1) {
                // Object-storage responses are intentionally discarded.
            }
        } catch (Exception ignored) {
            // The HTTP status is authoritative; a response-body read failure
            // must not turn a successfully persisted object into a retry.
        }
    }
}
