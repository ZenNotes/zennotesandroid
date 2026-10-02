package md.zennotes;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.Buffer;
import java.nio.CharBuffer;
import java.nio.charset.CharsetDecoder;
import java.nio.charset.CoderResult;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/** Bounded file inspection and copying, including UTF-8 sequences split across reads. */
final class CloudFileStream {
    static final int BUFFER_SIZE = 64 * 1024;
    static final int INLINE_LIMIT = 5 * 1024 * 1024;

    static final class Fingerprint {
        final long byteLength;
        final String sha256;
        final boolean utf8;
        final byte[] inlineBytes;

        Fingerprint(long byteLength, String sha256, boolean utf8, byte[] inlineBytes) {
            this.byteLength = byteLength;
            this.sha256 = sha256;
            this.utf8 = utf8;
            this.inlineBytes = inlineBytes;
        }
    }

    static Fingerprint inspect(InputStream input, boolean textCandidate) throws IOException {
        MessageDigest digest = digest();
        byte[] chunk = new byte[BUFFER_SIZE];
        ByteArrayOutputStream inline = new ByteArrayOutputStream();
        Utf8Check text = textCandidate ? new Utf8Check() : null;
        long length = 0;
        int count;
        while ((count = input.read(chunk)) != -1) {
            if (Thread.currentThread().isInterrupted()) throw new IOException("File inspection cancelled.");
            digest.update(chunk, 0, count);
            length += count;
            if (inline != null) {
                if (length <= INLINE_LIMIT) inline.write(chunk, 0, count);
                else inline = null;
            }
            if (text != null) text.accept(chunk, count, false);
        }
        if (text != null) text.accept(chunk, 0, true);
        return new Fingerprint(length, hex(digest.digest()), text != null && text.valid,
            inline == null ? null : inline.toByteArray());
    }

    static void copyVerified(InputStream input, OutputStream output, long expectedBytes, String expectedHash) throws IOException {
        MessageDigest digest = digest();
        byte[] chunk = new byte[BUFFER_SIZE];
        long written = 0;
        int count;
        while ((count = input.read(chunk)) != -1) {
            if (Thread.currentThread().isInterrupted()) throw new IOException("File upload cancelled.");
            written += count;
            if (written > expectedBytes) throw new IOException("The upload file changed size.");
            digest.update(chunk, 0, count);
            output.write(chunk, 0, count);
        }
        if (written != expectedBytes || !hex(digest.digest()).equals(expectedHash)) {
            throw new IOException("The upload file changed after its scan.");
        }
        output.flush();
    }

    private static MessageDigest digest() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private static String hex(byte[] bytes) {
        char[] alphabet = "0123456789abcdef".toCharArray();
        char[] out = new char[bytes.length * 2];
        for (int i = 0; i < bytes.length; i++) {
            out[i * 2] = alphabet[(bytes[i] & 255) >>> 4];
            out[i * 2 + 1] = alphabet[bytes[i] & 15];
        }
        return new String(out);
    }

    private static final class Utf8Check {
        final CharsetDecoder decoder = StandardCharsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT);
        final ByteBuffer pending = ByteBuffer.allocate(BUFFER_SIZE + 4);
        final CharBuffer characters = CharBuffer.allocate(8192);
        boolean valid = true;

        void accept(byte[] chunk, int count, boolean last) {
            if (!valid) return;
            pending.put(chunk, 0, count);
            ((Buffer) pending).flip();
            CoderResult result;
            do {
                ((Buffer) characters).clear();
                result = decoder.decode(pending, characters, last);
            } while (result.isOverflow());
            valid = !result.isError();
            pending.compact();
        }
    }
}
