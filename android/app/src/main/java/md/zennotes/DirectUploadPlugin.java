package md.zennotes;

import android.util.Base64;
import android.util.Base64InputStream;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Process;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;

/**
 * Streams a vault file to its short-lived signed object-storage URL.
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
    public void inspect(PluginCall call) {
        execute(() -> {
            try (InputStream input = openVaultFile(call.getString("uri"))) {
                CloudFileStream.Fingerprint fingerprint = CloudFileStream.inspect(input, call.getBoolean("textCandidate", false));
                JSObject result = new JSObject();
                result.put("uri", call.getString("uri"));
                result.put("byteLength", fingerprint.byteLength);
                result.put("sha256", fingerprint.sha256);
                result.put("utf8", fingerprint.utf8);
                if (fingerprint.inlineBytes != null) {
                    result.put("inlineBase64", Base64.encodeToString(fingerprint.inlineBytes, Base64.NO_WRAP));
                }
                call.resolve(result);
            } catch (Exception error) {
                call.reject("Cloud file inspection failed.", "CLOUD_FILE_READ_FAILED", error);
            }
        });
    }

    @PluginMethod
    public void copy(PluginCall call) {
        execute(() -> {
            Long bytes = call.getLong("byteLength");
            if (bytes == null && call.getInt("byteLength") != null) bytes = call.getInt("byteLength").longValue();
            String hash = call.getString("sha256");
            if (bytes == null || bytes < 0 || hash == null || !hash.matches("[0-9a-f]{64}")) {
                call.reject("Invalid Cloud copy request.", "INVALID_COPY_REQUEST");
                return;
            }
            try {
                Uri target = vaultFileUri(call.getString("to"), Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                Uri source = vaultFileUri(call.getString("from"), Intent.FLAG_GRANT_READ_URI_PERMISSION);
                if (source.equals(target)) throw new IOException("Cloud copy source and destination must differ.");
                try (InputStream input = openVaultFile(source.toString());
                     OutputStream output = "content".equals(target.getScheme())
                         ? getContext().getContentResolver().openOutputStream(target, "wt")
                         : new FileOutputStream(target.getPath())) {
                    if (output == null) throw new IOException("Cloud copy destination is unavailable.");
                    CloudFileStream.copyVerified(input, output, bytes, hash);
                }
                call.resolve();
            } catch (Exception error) {
                call.reject("Cloud file copy failed.", "CLOUD_FILE_COPY_FAILED", error);
            }
        });
    }

    /**
     * Stream a signed Cloud revision GET into a vault staging file. The body
     * never enters the WebView; a length or SHA-256 mismatch deletes the
     * partial file and rejects, so a truncated download can never be published.
     */
    @PluginMethod
    public void download(PluginCall call) {
        execute(() -> {
            Long bytes = call.getLong("byteLength");
            if (bytes == null && call.getInt("byteLength") != null) bytes = call.getInt("byteLength").longValue();
            String hash = call.getString("sha256");
            String value = call.getString("url");
            JSObject headers = call.getObject("headers", new JSObject());
            if (bytes == null || bytes < 0 || hash == null || !hash.matches("[0-9a-f]{64}") || value == null) {
                call.reject("Invalid Cloud download request.", "INVALID_DOWNLOAD_REQUEST");
                return;
            }
            HttpURLConnection connection = null;
            Uri target = null;
            try {
                target = vaultFileUri(call.getString("to"), Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                URL url = new URL(value);
                validateUrl(url);
                connection = (HttpURLConnection) url.openConnection();
                connection.setRequestMethod("GET");
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
                connection.setReadTimeout(READ_TIMEOUT_MS);
                connection.setRequestProperty("Accept-Encoding", "identity");
                applyHeaders(connection, headers);
                int status = connection.getResponseCode();
                if (status < 200 || status >= 300) {
                    drain(connection.getErrorStream());
                    JSObject data = new JSObject();
                    data.put("status", status);
                    call.reject("Cloud object download failed (" + status + ").", "DIRECT_DOWNLOAD_FAILED", null, data);
                    return;
                }
                long declared = connection.getContentLengthLong();
                if (declared >= 0 && declared != bytes) throw new IOException("Cloud download length did not match its reference.");
                try (InputStream input = connection.getInputStream();
                     OutputStream output = "content".equals(target.getScheme())
                         ? getContext().getContentResolver().openOutputStream(target, "wt")
                         : new FileOutputStream(target.getPath())) {
                    if (output == null) throw new IOException("Cloud download destination is unavailable.");
                    CloudFileStream.copyVerified(input, output, bytes, hash);
                }
                call.resolve();
            } catch (Exception error) {
                if (target != null && "file".equals(target.getScheme())) new File(target.getPath()).delete();
                call.reject("Cloud object download failed.", "DIRECT_DOWNLOAD_FAILED", error);
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    @PluginMethod
    public void put(PluginCall call) {
        execute(() -> upload(call));
    }

    private void upload(PluginCall call) {
        HttpURLConnection connection = null;
        try {
            String value = call.getString("url");
            String base64 = call.getString("base64");
            String sourceUri = call.getString("uri");
            String expectedHash = call.getString("sha256");
            Integer expectedBytes = call.getInt("byteLength");
            JSObject headers = call.getObject("headers", new JSObject());
            if (value == null || (base64 == null && sourceUri == null) || expectedBytes == null || expectedBytes < 0
                || (sourceUri != null && (expectedHash == null || !expectedHash.matches("[0-9a-f]{64}")))) {
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

            try (
                InputStream decoded = sourceUri != null ? openVaultFile(sourceUri) : new Base64InputStream(
                    new ByteArrayInputStream(base64.getBytes(StandardCharsets.US_ASCII)), Base64.DEFAULT);
                OutputStream output = connection.getOutputStream()
            ) {
                if (expectedHash != null) {
                    CloudFileStream.copyVerified(decoded, output, expectedBytes, expectedHash);
                } else {
                    long written = 0;
                    byte[] buffer = new byte[BUFFER_SIZE];
                    int count;
                    while ((count = decoded.read(buffer)) != -1) {
                        output.write(buffer, 0, count);
                        written += count;
                    }
                    if (written != expectedBytes) throw new IOException("Decoded upload size changed before transmission.");
                    output.flush();
                }
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

    private InputStream openVaultFile(String value) throws IOException {
        Uri uri = vaultFileUri(value, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        if ("content".equals(uri.getScheme())) {
            InputStream input = getContext().getContentResolver().openInputStream(uri);
            if (input == null) throw new IOException("Vault file is unavailable.");
            return input;
        }
        return new FileInputStream(uri.getPath());
    }

    private Uri vaultFileUri(String value, int access) throws IOException {
        if (value == null) throw new IOException("Missing vault file.");
        Uri uri = Uri.parse(value);
        if ("content".equals(uri.getScheme())) {
            if (getContext().checkUriPermission(uri, Process.myPid(), Process.myUid(), access)
                != PackageManager.PERMISSION_GRANTED) throw new IOException("Vault file access is not granted.");
            return uri;
        }
        if (!"file".equals(uri.getScheme()) || uri.getPath() == null ||
            (uri.getAuthority() != null && !uri.getAuthority().isEmpty())) throw new IOException("Invalid vault file URI.");
        File file = new File(uri.getPath()).getCanonicalFile();
        if (!insideVaults(file, getContext().getFilesDir()) && !insideVaults(file, getContext().getExternalFilesDir(null))) {
            throw new IOException("File is outside the local vault storage.");
        }
        return Uri.fromFile(file);
    }

    private static boolean insideVaults(File file, File storage) throws IOException {
        return storage != null && file.getPath().startsWith(new File(storage, "ZenNotes").getCanonicalPath() + File.separator);
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
