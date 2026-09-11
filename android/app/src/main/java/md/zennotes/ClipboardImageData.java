package md.zennotes;

import java.io.IOException;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;

final class ClipboardImageData {
    static final int MAX_BYTES = 10 * 1024 * 1024;
    static final class InvalidImage extends IOException {
        InvalidImage(String message) { super(message); }
    }
    static byte[] read(InputStream stream, int limit) throws IOException {
        if (stream == null) throw new InvalidImage("Could not read the pasted image.");
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[16384];
        int size;
        while ((size = stream.read(buffer)) != -1) {
            if (size > limit - output.size()) throw new InvalidImage("Pasted images must be 10 MB or smaller.");
            output.write(buffer, 0, size);
        }
        if (output.size() == 0) throw new InvalidImage("The pasted image is empty.");
        return output.toByteArray();
    }
    static String mimeType(byte[] b) throws IOException {
        if (b.length >= 8 && (b[0] & 255) == 137 && b[1] == 80 && b[2] == 78 && b[3] == 71 &&
                b[4] == 13 && b[5] == 10 && b[6] == 26 && b[7] == 10) return "image/png";
        if (b.length >= 3 && (b[0] & 255) == 255 && (b[1] & 255) == 216 && (b[2] & 255) == 255) return "image/jpeg";
        if (b.length >= 6) {
            String header = new String(b, 0, 6, StandardCharsets.US_ASCII);
            if (header.equals("GIF87a") || header.equals("GIF89a")) return "image/gif";
        }
        if (b.length >= 12 && new String(b, 0, 4, StandardCharsets.US_ASCII).equals("RIFF") &&
                new String(b, 8, 4, StandardCharsets.US_ASCII).equals("WEBP")) return "image/webp";
        throw new InvalidImage("Paste a PNG, JPEG, GIF, or WebP image.");
    }
}
