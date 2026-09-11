package md.zennotes;

import org.junit.Test;
import static org.junit.Assert.*;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

public class ClipboardImageReadTest {
    @Test public void cancelledReadCannotDispatchAResponse() {
        AtomicInteger responses = new AtomicInteger();
        ClipboardImageRead read = new ClipboardImageRead(() -> {});
        read.respondIfOpen(responses::incrementAndGet);
        read.close();
        read.respondIfOpen(responses::incrementAndGet);
        assertEquals(1, responses.get());
    }

    @Test public void teardownCannotInterleaveWithResponseDispatch() throws Exception {
        AtomicInteger releases = new AtomicInteger();
        CountDownLatch responding = new CountDownLatch(1);
        CountDownLatch finishResponse = new CountDownLatch(1);
        CountDownLatch closing = new CountDownLatch(1);
        ClipboardImageRead read = new ClipboardImageRead(releases::incrementAndGet);
        var worker = Executors.newFixedThreadPool(2);
        try {
            var response = worker.submit(() -> read.respondIfOpen(() -> {
                responding.countDown();
                try { assertTrue(finishResponse.await(2, TimeUnit.SECONDS)); }
                catch (InterruptedException error) { throw new AssertionError(error); }
                assertFalse(read.isClosed());
            }));
            assertTrue(responding.await(2, TimeUnit.SECONDS));
            var teardown = worker.submit(() -> { closing.countDown(); read.close(); });
            assertTrue(closing.await(2, TimeUnit.SECONDS));
            assertEquals(0, releases.get());
            finishResponse.countDown();
            response.get(2, TimeUnit.SECONDS);
            teardown.get(2, TimeUnit.SECONDS);
            assertEquals(1, releases.get());
        } finally {
            finishResponse.countDown();
            worker.shutdownNow();
            read.close();
        }
    }

    @Test public void closesStreamAndReleasesPermissionExactlyOnce() throws Exception {
        AtomicInteger releases = new AtomicInteger();
        AtomicInteger closes = new AtomicInteger();
        ClipboardImageRead read = new ClipboardImageRead(releases::incrementAndGet);
        read.attach(new ByteArrayInputStream(new byte[]{1}) {
            @Override public void close() { closes.incrementAndGet(); }
        });
        read.close();
        read.close();
        assertTrue(read.isClosed());
        assertEquals(1, releases.get());
        assertEquals(1, closes.get());
    }

    @Test public void teardownWhileProviderIsOpeningReleasesGrantAndRejectsLateStream() {
        AtomicInteger releases = new AtomicInteger();
        AtomicInteger closes = new AtomicInteger();
        ClipboardImageRead read = new ClipboardImageRead(releases::incrementAndGet);
        read.close();
        assertEquals(1, releases.get());
        assertThrows(IOException.class, () -> read.attach(new ByteArrayInputStream(new byte[]{1}) {
            @Override public void close() { closes.incrementAndGet(); }
        }));
        assertEquals(1, closes.get());
        assertEquals(1, releases.get());
    }

    @Test public void teardownClosesAnInFlightReadWithoutWaitingForWorkerCompletion() throws Exception {
        AtomicInteger releases = new AtomicInteger();
        CountDownLatch started = new CountDownLatch(1);
        CountDownLatch closed = new CountDownLatch(1);
        ClipboardImageRead read = new ClipboardImageRead(releases::incrementAndGet);
        InputStream stream = read.attach(new InputStream() {
            @Override public int read() throws IOException {
                started.countDown();
                try { closed.await(); }
                catch (InterruptedException error) { throw new IOException(error); }
                return -1;
            }
            @Override public void close() { closed.countDown(); }
        });
        var worker = Executors.newSingleThreadExecutor();
        try {
            var result = worker.submit(() -> stream.read());
            assertTrue(started.await(2, TimeUnit.SECONDS));
            read.close();
            assertEquals(1, releases.get());
            assertEquals(Integer.valueOf(-1), result.get(2, TimeUnit.SECONDS));
        } finally {
            read.close();
            worker.shutdownNow();
        }
    }
}
