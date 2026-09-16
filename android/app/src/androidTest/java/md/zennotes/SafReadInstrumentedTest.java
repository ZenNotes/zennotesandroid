package md.zennotes;

import static org.junit.Assert.*;
import android.content.Context;
import android.provider.DocumentsContract;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class SafReadInstrumentedTest {
    private static class Result extends PluginCall {
        String code, message;
        JSObject value;
        Result(String root, String path) {
            super(null, "SafFs", "fixture", "read", new JSObject().put("root", root).put("path", path));
        }
        @Override public void resolve(JSObject data) { value = data; }
        @Override public void reject(String message, String code, Exception error, JSObject data) {
            this.message = message; this.code = code;
        }
    }
    private Result read(String rootId, String path, boolean base64) {
        SafFsPlugin plugin = new SafFsPlugin() {
            @Override public Context getContext() { return InstrumentationRegistry.getInstrumentation().getContext(); }
        };
        String root = DocumentsContract.buildTreeDocumentUri("md.zennotes.test.saf-fixture", rootId).toString();
        Result result = new Result(root, path);
        if (base64) plugin.readBase64(result); else plugin.readText(result);
        return result;
    }
    @Test public void onlyVerifiedAbsenceReturnsNotFound() {
        for (boolean base64 : new boolean[] {false, true}) {
            assertEquals("ZN-SAF-NOT-FOUND", read("root", "missing.md", base64).code);
            assertEquals("ZN-SAF-IS-DIRECTORY", read("root", "directory", base64).code);
            for (String root : new String[] {"null-list", "denied"}) {
                Result failed = read(root, "missing.md", base64);
                assertNotNull(failed.message);
                assertNotEquals("ZN-SAF-NOT-FOUND", failed.code);
            }
            Result unavailable = read("root", "unreadable.md", base64);
            assertNotNull(unavailable.message);
            assertNotEquals("ZN-SAF-NOT-FOUND", unavailable.code);
        }
    }
    @Test public void nativeProviderReadsPreserveExactBytes() {
        Result text = read("root", "present.md", false);
        assertNull(text.message);
        assertEquals("Exact café 日本語.  \n", text.value.getString("data"));
        Result binary = read("root", "present.md", true);
        assertNull(binary.message);
        assertArrayEquals("Exact café 日本語.  \n".getBytes(java.nio.charset.StandardCharsets.UTF_8),
            android.util.Base64.decode(binary.value.getString("data"), android.util.Base64.DEFAULT));
    }
}
