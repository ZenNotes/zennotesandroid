package md.zennotes;

import org.junit.Test;
import static org.junit.Assert.*;
import java.io.ByteArrayInputStream;
import java.io.IOException;

public class ClipboardImageDataTest {
    @Test public void boundedReadPreservesBytes() throws Exception {
        byte[] data = {1, 2, 3, 4};
        assertArrayEquals(data, ClipboardImageData.read(new ByteArrayInputStream(data), 4));
    }
    @Test public void overLimitAndEmptyInputFail() {
        assertThrows(IOException.class, () -> ClipboardImageData.read(new ByteArrayInputStream(new byte[5]), 4));
        assertThrows(IOException.class, () -> ClipboardImageData.read(new ByteArrayInputStream(new byte[0]), 4));
    }
    @Test public void checksImageSignaturesNotUntrustedMimeOrFilename() throws Exception {
        assertEquals("image/png", ClipboardImageData.mimeType(new byte[]{(byte)137,80,78,71,13,10,26,10}));
        assertEquals("image/jpeg", ClipboardImageData.mimeType(new byte[]{(byte)255,(byte)216,(byte)255,0}));
        assertEquals("image/gif", ClipboardImageData.mimeType("GIF89a".getBytes()));
        assertEquals("image/webp", ClipboardImageData.mimeType("RIFF0000WEBP".getBytes()));
        assertThrows(IOException.class, () -> ClipboardImageData.mimeType("<svg onload='alert(1)'/>".getBytes()));
        assertThrows(IOException.class, () -> ClipboardImageData.mimeType(new byte[0]));
    }
}
