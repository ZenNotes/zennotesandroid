package md.zennotes;

import android.database.Cursor;
import android.database.MatrixCursor;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract.Document;
import android.content.ContentProvider;
import android.content.ContentValues;
import android.net.Uri;
import android.provider.DocumentsContract;
import java.io.File;
import java.io.FileNotFoundException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/** A real Android resolver boundary with deliberate provider failure modes. */
public class SafFixtureProvider extends ContentProvider {
    private static final String[] COLUMNS = { Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME,
        Document.COLUMN_MIME_TYPE, Document.COLUMN_SIZE, Document.COLUMN_LAST_MODIFIED };

    @Override public String getType(Uri uri) { return "text/markdown"; }
    @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException(); }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] args) { throw new UnsupportedOperationException(); }
    @Override public int delete(Uri uri, String selection, String[] args) { throw new UnsupportedOperationException(); }
    @Override public boolean onCreate() { return true; }
    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] args, String sortOrder) {
        String parent = DocumentsContract.getTreeDocumentId(uri);
        if (parent.equals("null-list")) return null;
        if (parent.equals("denied")) throw new SecurityException("Provider access revoked");
        MatrixCursor cursor = new MatrixCursor(COLUMNS);
        cursor.addRow(new Object[] {"present", "present.md", "text/markdown", 0, 0});
        cursor.addRow(new Object[] {"directory", "directory", Document.MIME_TYPE_DIR, 0, 0});
        cursor.addRow(new Object[] {"unreadable", "unreadable.md", "text/markdown", 0, 0});
        return cursor;
    }
    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        String id = DocumentsContract.getDocumentId(uri);
        if (!id.equals("present")) throw new FileNotFoundException("Provider cannot open this document");
        try {
            File file = new File(getContext().getCacheDir(), "saf-fixture.md");
            Files.write(file.toPath(), "Exact café 日本語.  \n".getBytes(StandardCharsets.UTF_8));
            return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY);
        } catch (Exception error) { throw new FileNotFoundException(error.getMessage()); }
    }
}
