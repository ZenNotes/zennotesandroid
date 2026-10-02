package md.zennotes;

import static org.junit.Assert.*;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.provider.DocumentsContract;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class DirectUploadInstrumentedTest {
    private static class Result extends PluginCall {
        String message;
        JSObject value;
        Result(JSObject data) { super(null, "ZenDirectUpload", "fixture", "test", data); }
        @Override public void resolve(JSObject data) { value = data; }
        @Override public void resolve() { value = new JSObject(); }
        @Override public void reject(String message, String code, Exception error, JSObject data) { this.message = message + " " + error; }
    }

    private DirectUploadPlugin plugin(Context context) {
        return new DirectUploadPlugin() {
            @Override public Context getContext() { return context; }
            @Override public void execute(Runnable work) { work.run(); }
        };
    }

    @Test public void inspectsAndUploadsLocalAndDocumentProviderFilesWithoutBase64() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        File folder = new File(context.getFilesDir(), "ZenNotes/CapacityFixture");
        assertTrue(folder.isDirectory() || folder.mkdirs());
        File file = new File(folder, "large.bin");
        try {
            byte[] chunk = new byte[64 * 1024];
            Arrays.fill(chunk, (byte) 197);
            try (FileOutputStream output = new FileOutputStream(file)) {
                for (int left = 6_000_000; left > 0; left -= Math.min(left, chunk.length)) {
                    output.write(chunk, 0, Math.min(left, chunk.length));
                }
            }
            Uri tree = DocumentsContract.buildTreeDocumentUri("md.zennotes.test.cloud-files", "root");
            for (Uri uri : new Uri[] { Uri.fromFile(file), DocumentsContract.buildDocumentUriUsingTree(tree, "large") }) {
                DirectUploadPlugin plugin = plugin(context);
                if ("content".equals(uri.getScheme())) {
                    context.revokeUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    Result denied = new Result(new JSObject().put("uri", uri.toString()));
                    plugin.inspect(denied);
                    assertNotNull(denied.message);
                    context.getContentResolver().call(uri, "grant", context.getPackageName(), null);
                }
                Result inspected = new Result(new JSObject().put("uri", uri.toString()).put("textCandidate", false));
                plugin.inspect(inspected);
                assertNull(uri.toString(), inspected.message);
                assertEquals(6_000_000L, inspected.value.getLong("byteLength"));
                assertFalse(inspected.value.has("inlineBase64"));
                File copy = new File(folder, "copy.bin");
                Result copied = new Result(new JSObject().put("from", uri.toString()).put("to", Uri.fromFile(copy).toString())
                    .put("byteLength", 6_000_000).put("sha256", inspected.value.getString("sha256")));
                plugin.copy(copied);
                assertNull(copied.message);
                Result copyCheck = new Result(new JSObject().put("uri", Uri.fromFile(copy).toString()));
                plugin.inspect(copyCheck);
                assertEquals(inspected.value.getString("sha256"), copyCheck.value.getString("sha256"));
                assertTrue(copy.delete());
                try (ServerSocket server = new ServerSocket(0, 1, java.net.InetAddress.getByName("127.0.0.1"))) {
                    CompletableFuture<String> received = CompletableFuture.supplyAsync(() -> receive(server));
                    Result uploaded = new Result(new JSObject()
                        .put("url", "http://127.0.0.1:" + server.getLocalPort() + "/object")
                        .put("uri", uri.toString()).put("byteLength", 6_000_000)
                        .put("sha256", inspected.value.getString("sha256")));
                    plugin.put(uploaded);
                    assertNull(uploaded.message);
                    assertEquals(200, uploaded.value.getInteger("status").intValue());
                    assertEquals(inspected.value.getString("sha256"), received.get(10, TimeUnit.SECONDS));
                }
            }
        } finally {
            file.delete();
            new File(context.getCacheDir(), "saf-capacity-fixture.bin").delete();
        }
    }

    @Test public void refusesFilesOutsideVaultStorage() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        Result request = new Result(new JSObject().put("uri", Uri.fromFile(new File(context.getFilesDir(), "credential.json")).toString()));
        plugin(context).inspect(request);
        assertNotNull(request.message);
        assertNull(request.value);
    }

    private static String receive(ServerSocket server) {
        try (Socket socket = server.accept()) {
            socket.setSoTimeout(10_000);
            InputStream input = socket.getInputStream();
            ByteArrayOutputStream header = new ByteArrayOutputStream();
            int ending = 0;
            while (ending != 0x0d0a0d0a && header.size() < 16_384) {
                int value = input.read();
                if (value < 0) throw new IllegalStateException("Incomplete upload headers");
                header.write(value);
                ending = (ending << 8) | value;
            }
            String headers = header.toString("UTF-8").toLowerCase();
            assertTrue(headers.contains("content-length: 6000000"));
            assertFalse(headers.contains("transfer-encoding:"));
            assertFalse(headers.contains("authorization:"));
            MessageDigest hash = MessageDigest.getInstance("SHA-256");
            byte[] chunk = new byte[64 * 1024];
            int remaining = 6_000_000;
            while (remaining > 0) {
                int count = input.read(chunk, 0, Math.min(chunk.length, remaining));
                if (count < 0) throw new IllegalStateException("Truncated upload");
                hash.update(chunk, 0, count);
                remaining -= count;
            }
            socket.getOutputStream().write("HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.US_ASCII));
            StringBuilder digest = new StringBuilder();
            for (byte value : hash.digest()) digest.append(String.format("%02x", value));
            return digest.toString();
        } catch (Exception error) { throw new IllegalStateException(error); }
    }
}
