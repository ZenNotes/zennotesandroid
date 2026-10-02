package md.zennotes;

import static org.junit.Assert.*;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import org.junit.Test;

public class CloudFileStreamTest {
    @Test
    public void fingerprintsLargeInputWithBoundedReadsAndNoInlineBody() throws Exception {
        byte[] bytes = new byte[8_000_000];
        Arrays.fill(bytes, (byte) 129);
        InputStream input = new ByteArrayInputStream(bytes) {
            @Override public synchronized int read(byte[] target, int offset, int length) {
                assertTrue("Native reads must stay bounded", length <= 65_536);
                return super.read(target, offset, length);
            }
        };
        CloudFileStream.Fingerprint result = CloudFileStream.inspect(input, false);
        assertEquals(bytes.length, result.byteLength);
        assertEquals(hash(bytes), result.sha256);
        assertNull(result.inlineBytes);
    }

    @Test
    public void validatesUtf8AcrossChunkBoundariesWithoutChangingRawBytes() throws Exception {
        byte[] bytes = ("a".repeat(65_535) + "日本語 café").getBytes(StandardCharsets.UTF_8);
        CloudFileStream.Fingerprint result = CloudFileStream.inspect(new ByteArrayInputStream(bytes), true);
        assertTrue(result.utf8);
        assertArrayEquals(bytes, result.inlineBytes);
        assertEquals(hash(bytes), result.sha256);
        bytes[bytes.length - 1] = (byte) 255;
        assertFalse(CloudFileStream.inspect(new ByteArrayInputStream(bytes), true).utf8);
    }

    @Test
    public void detectsTruncatedUtf8AndStillHashesTheEntireFile() throws Exception {
        byte[] bytes = new byte[] { 97, (byte) 0xe6, (byte) 0x97 };
        CloudFileStream.Fingerprint result = CloudFileStream.inspect(new ByteArrayInputStream(bytes), true);
        assertFalse(result.utf8);
        assertEquals(hash(bytes), result.sha256);
    }

    @Test
    public void streamsAnExactUploadAndRejectsChangedContentOrLength() throws Exception {
        byte[] bytes = "exact café bytes".getBytes(StandardCharsets.UTF_8);
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        CloudFileStream.copyVerified(new ByteArrayInputStream(bytes), output, bytes.length, hash(bytes));
        assertArrayEquals(bytes, output.toByteArray());
        for (int expected : new int[] { bytes.length - 1, bytes.length + 1 }) {
            assertThrows(IOException.class, () -> CloudFileStream.copyVerified(
                new ByteArrayInputStream(bytes), OutputStream.nullOutputStream(), expected, hash(bytes)));
        }
        assertThrows(IOException.class, () -> CloudFileStream.copyVerified(
            new ByteArrayInputStream(bytes), OutputStream.nullOutputStream(), bytes.length, hash(new byte[] { 1 })));
    }

    private static String hash(byte[] bytes) throws Exception {
        StringBuilder hex = new StringBuilder();
        for (byte value : MessageDigest.getInstance("SHA-256").digest(bytes)) hex.append(String.format("%02x", value));
        return hex.toString();
    }
}
