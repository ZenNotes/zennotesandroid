package md.zennotes;

import java.io.IOException;
import java.io.InputStream;

/** Own the temporary grant even while a provider has not returned a stream. */
final class ClipboardImageRead implements AutoCloseable {
    private final Runnable releasePermission;
    private InputStream stream;
    private boolean closed;

    ClipboardImageRead(Runnable releasePermission) { this.releasePermission = releasePermission; }

    InputStream attach(InputStream opened) throws IOException {
        synchronized (this) {
            if (!closed) { stream = opened; return opened; }
        }
        closeStream(opened);
        throw new IOException("Image paste was cancelled.");
    }

    synchronized boolean isClosed() { return closed; }

    synchronized void respondIfOpen(Runnable response) {
        if (!closed) response.run();
    }

    @Override public void close() {
        InputStream opened;
        synchronized (this) {
            if (closed) return;
            closed = true;
            opened = stream;
            stream = null;
        }
        // Release the grant without waiting for provider I/O to finish.
        try { releasePermission.run(); }
        finally { closeStream(opened); }
    }

    private static void closeStream(InputStream stream) {
        if (stream == null) return;
        try { stream.close(); } catch (IOException | RuntimeException ignored) { /* already closed/revoked */ }
    }
}
