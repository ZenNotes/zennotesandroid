package md.zennotes;

import android.content.ContentResolver;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.provider.DocumentsContract.Document;
import android.util.Base64;
import android.webkit.MimeTypeMap;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.FileNotFoundException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * SAF-backed file operations for external-folder vaults (spec 03 advanced
 * tier). The JS vault layer (native-fs.ts) routes every op for content://
 * roots here, because @capacitor/filesystem cannot address document-tree URIs.
 *
 * Performance model: DocumentFile-style per-file resolution costs one
 * content-resolver query per path segment per op — the "SAF is slow" trap.
 * Instead, directories are listed with ONE child query returning
 * (documentId, name, mime, size, mtime) per row, and listings are cached in
 * memory keyed by parent documentId. Path resolution walks the cache;
 * readdir refreshes it; mutations update it in place. External writers
 * (Syncthing) are handled by the app's foreground rescan, which re-readdirs
 * the tree and thereby refreshes every cached listing.
 */
@CapacitorPlugin(name = "SafFs")
public class SafFsPlugin extends Plugin {

    private static final class Entry {
        final String docId;
        final boolean isDir;
        final long size;
        final long mtime;
        Entry(String docId, boolean isDir, long size, long mtime) {
            this.docId = docId;
            this.isDir = isDir;
            this.size = size;
            this.mtime = mtime;
        }
    }

    /** parentDocId (per root) → child name → entry. */
    private final Map<String, Map<String, Entry>> listings = new ConcurrentHashMap<>();

    private ContentResolver resolver() {
        return getContext().getContentResolver();
    }

    // ---- path plumbing ----------------------------------------------------

    private static String clean(String rel) {
        if (rel == null) return "";
        String r = rel.replaceAll("^/+", "").replaceAll("/+$", "");
        if (r.contains("..")) throw new IllegalArgumentException("Path escapes the vault: " + rel);
        return r;
    }

    private static String cacheKey(Uri tree, String docId) {
        return tree.toString() + "|" + docId;
    }

    private Uri docUri(Uri tree, String docId) {
        return DocumentsContract.buildDocumentUriUsingTree(tree, docId);
    }

    /** One IPC: list a directory's children into the cache, returning it. */
    private Map<String, Entry> listChildren(Uri tree, String dirDocId) {
        Map<String, Entry> out = new HashMap<>();
        Uri childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(tree, dirDocId);
        try (Cursor c = resolver().query(
            childrenUri,
            new String[] {
                Document.COLUMN_DOCUMENT_ID,
                Document.COLUMN_DISPLAY_NAME,
                Document.COLUMN_MIME_TYPE,
                Document.COLUMN_SIZE,
                Document.COLUMN_LAST_MODIFIED
            },
            null, null, null
        )) {
            if (c != null) {
                while (c.moveToNext()) {
                    String id = c.getString(0);
                    String name = c.getString(1);
                    String mime = c.getString(2);
                    long size = c.isNull(3) ? 0 : c.getLong(3);
                    long mtime = c.isNull(4) ? 0 : c.getLong(4);
                    if (name == null) continue;
                    out.put(name, new Entry(id, Document.MIME_TYPE_DIR.equals(mime), size, mtime));
                }
            }
        }
        listings.put(cacheKey(tree, dirDocId), out);
        return out;
    }

    /** Resolve a vault-relative path to its entry, walking cached listings.
     *  Returns null if any segment is missing. Refreshes a listing once per
     *  miss so external writes are found without a full rescan. */
    private Entry resolve(Uri tree, String rel) {
        String rootId = DocumentsContract.getTreeDocumentId(tree);
        if (rel.isEmpty()) return new Entry(rootId, true, 0, 0);
        String parentId = rootId;
        Entry cur = null;
        for (String seg : rel.split("/")) {
            Map<String, Entry> listing = listings.get(cacheKey(tree, parentId));
            Entry e = listing == null ? null : listing.get(seg);
            if (e == null) {
                listing = listChildren(tree, parentId);
                e = listing.get(seg);
                if (e == null) return null;
            }
            cur = e;
            parentId = e.docId;
        }
        return cur;
    }

    /** Resolve the parent directory of rel, creating missing dirs. */
    private String ensureParentDirs(Uri tree, String rel) throws Exception {
        int idx = rel.lastIndexOf('/');
        String dirRel = idx == -1 ? "" : rel.substring(0, idx);
        String rootId = DocumentsContract.getTreeDocumentId(tree);
        if (dirRel.isEmpty()) return rootId;
        String parentId = rootId;
        for (String seg : dirRel.split("/")) {
            Map<String, Entry> listing = listings.get(cacheKey(tree, parentId));
            Entry e = listing == null ? null : listing.get(seg);
            if (e == null) {
                listing = listChildren(tree, parentId);
                e = listing.get(seg);
            }
            if (e == null) {
                Uri created = DocumentsContract.createDocument(
                    resolver(), docUri(tree, parentId), Document.MIME_TYPE_DIR, seg
                );
                if (created == null) throw new Exception("Could not create folder: " + seg);
                e = new Entry(DocumentsContract.getDocumentId(created), true, 0, 0);
                listing.put(seg, e);
            } else if (!e.isDir) {
                throw new Exception("Not a folder: " + seg);
            }
            parentId = e.docId;
        }
        return parentId;
    }

    private static String baseName(String rel) {
        int idx = rel.lastIndexOf('/');
        return idx == -1 ? rel : rel.substring(idx + 1);
    }

    private static String mimeFor(String name) {
        if (name.endsWith(".md")) return "text/markdown";
        String ext = MimeTypeMap.getFileExtensionFromUrl(Uri.encode(name));
        String mime = ext == null ? null : MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext.toLowerCase());
        return mime == null ? "application/octet-stream" : mime;
    }

    private void invalidateParent(Uri tree, String rel) {
        int idx = rel.lastIndexOf('/');
        String dirRel = idx == -1 ? "" : rel.substring(0, idx);
        Entry dir = resolve(tree, dirRel);
        if (dir != null) listings.remove(cacheKey(tree, dir.docId));
    }

    private Uri requireTree(PluginCall call) {
        String root = call.getString("root");
        if (root == null || root.isEmpty()) {
            call.reject("Missing root");
            return null;
        }
        return Uri.parse(root);
    }

    // ---- plugin methods ---------------------------------------------------

    @PluginMethod
    public void readdir(PluginCall call) {
        Uri tree = requireTree(call);
        if (tree == null) return;
        try {
            String rel = clean(call.getString("path"));
            Entry dir = resolve(tree, rel);
            if (dir == null || !dir.isDir) throw new FileNotFoundException(rel);
            Map<String, Entry> listing = listChildren(tree, dir.docId);
            JSArray files = new JSArray();
            for (Map.Entry<String, Entry> e : listing.entrySet()) {
                JSObject f = new JSObject();
                f.put("name", e.getKey());
                f.put("type", e.getValue().isDir ? "directory" : "file");
                f.put("size", e.getValue().size);
                f.put("mtime", e.getValue().mtime);
                f.put("uri", docUri(tree, e.getValue().docId).toString());
                files.put(f);
            }
            JSObject ret = new JSObject();
            ret.put("files", files);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("readdir failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stat(PluginCall call) {
        Uri tree = requireTree(call);
        if (tree == null) return;
        try {
            String rel = clean(call.getString("path"));
            Entry e = resolve(tree, rel);
            if (e == null) throw new FileNotFoundException(rel);
            JSObject ret = new JSObject();
            ret.put("type", e.isDir ? "directory" : "file");
            ret.put("size", e.size);
            ret.put("mtime", e.mtime);
            ret.put("uri", docUri(tree, e.docId).toString());
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("stat failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void readText(PluginCall call) {
        Uri tree = requireTree(call);
        if (tree == null) return;
        try {
            String rel = clean(call.getString("path"));
            Entry e = resolve(tree, rel);
            if (e == null || e.isDir) throw new FileNotFoundException(rel);
            JSObject ret = new JSObject();
            ret.put("data", new String(readAll(docUri(tree, e.docId)), StandardCharsets.UTF_8));
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("readText failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void readBase64(PluginCall call) {
        Uri tree = requireTree(call);
        if (tree == null) return;
        try {
            String rel = clean(call.getString("path"));
            Entry e = resolve(tree, rel);
            if (e == null || e.isDir) throw new FileNotFoundException(rel);
            JSObject ret = new JSObject();
            ret.put("data", Base64.encodeToString(readAll(docUri(tree, e.docId)), Base64.NO_WRAP));
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("readBase64 failed: " + e.getMessage());
        }
    }

    private byte[] readAll(Uri doc) throws Exception {
        try (InputStream in = resolver().openInputStream(doc)) {
            if (in == null) throw new FileNotFoundException(doc.toString());
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] chunk = new byte[65536];
            int n;
            while ((n = in.read(chunk)) != -1) buf.write(chunk, 0, n);
            return buf.toByteArray();
        }
    }

    private void writeBytes(PluginCall call, byte[] bytes) {
        Uri tree = requireTree(call);
        if (tree == null) return;
        try {
            String rel = clean(call.getString("path"));
            Entry existing = resolve(tree, rel);
            Uri target;
            if (existing != null && !existing.isDir) {
                target = docUri(tree, existing.docId);
            } else if (existing == null) {
                String parentId = ensureParentDirs(tree, rel);
                String name = baseName(rel);
                Uri created = DocumentsContract.createDocument(
                    resolver(), docUri(tree, parentId), mimeFor(name), name
                );
                if (created == null) throw new Exception("Could not create: " + rel);
                target = created;
            } else {
                throw new Exception("Is a folder: " + rel);
            }
            // "rwt" truncates; plain "w" is documented to leave stale tail
            // bytes with some providers.
            try (OutputStream out = resolver().openOutputStream(target, "rwt")) {
                if (out == null) throw new Exception("Could not open for writing: " + rel);
                out.write(bytes);
            }
            invalidateParent(tree, rel);
            call.resolve();
        } catch (Exception e) {
            call.reject("write failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void writeText(PluginCall call) {
        String data = call.getString("data");
        writeBytes(call, data == null ? new byte[0] : data.getBytes(StandardCharsets.UTF_8));
    }

    @PluginMethod
    public void writeBase64(PluginCall call) {
        String data = call.getString("data");
        writeBytes(call, data == null ? new byte[0] : Base64.decode(data, Base64.DEFAULT));
    }

    @PluginMethod
    public void mkdir(PluginCall call) {
        Uri tree = requireTree(call);
        if (tree == null) return;
        try {
            String rel = clean(call.getString("path"));
            if (!rel.isEmpty() && resolve(tree, rel) == null) {
                String parentId = ensureParentDirs(tree, rel);
                String name = baseName(rel);
                Map<String, Entry> listing = listings.get(cacheKey(tree, parentId));
                if (listing == null || !listing.containsKey(name)) {
                    Uri created = DocumentsContract.createDocument(
                        resolver(), docUri(tree, parentId), Document.MIME_TYPE_DIR, name
                    );
                    if (created == null) throw new Exception("Could not create folder: " + rel);
                    invalidateParent(tree, rel);
                }
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("mkdir failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void rename(PluginCall call) {
        Uri tree = requireTree(call);
        if (tree == null) return;
        try {
            String from = clean(call.getString("from"));
            String to = clean(call.getString("to"));
            Entry src = resolve(tree, from);
            if (src == null) throw new FileNotFoundException(from);
            int fi = from.lastIndexOf('/');
            int ti = to.lastIndexOf('/');
            String fromDir = fi == -1 ? "" : from.substring(0, fi);
            String toDir = ti == -1 ? "" : to.substring(0, ti);
            if (fromDir.equals(toDir)) {
                Uri renamed = DocumentsContract.renameDocument(
                    resolver(), docUri(tree, src.docId), baseName(to)
                );
                if (renamed == null) throw new Exception("Rename refused");
            } else {
                Entry fromParent = resolve(tree, fromDir);
                String toParentId = ensureParentDirs(tree, to);
                Uri moved = DocumentsContract.moveDocument(
                    resolver(),
                    docUri(tree, src.docId),
                    docUri(tree, fromParent.docId),
                    docUri(tree, toParentId)
                );
                if (moved == null) throw new Exception("Move refused");
                String movedId = DocumentsContract.getDocumentId(moved);
                String targetName = baseName(to);
                if (!baseName(from).equals(targetName)) {
                    if (DocumentsContract.renameDocument(resolver(), docUri(tree, movedId), targetName) == null) {
                        throw new Exception("Rename after move refused");
                    }
                }
            }
            invalidateParent(tree, from);
            invalidateParent(tree, to);
            if (src.isDir) listings.remove(cacheKey(tree, src.docId));
            call.resolve();
        } catch (Exception e) {
            call.reject("rename failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void copy(PluginCall call) {
        Uri tree = requireTree(call);
        if (tree == null) return;
        try {
            String from = clean(call.getString("from"));
            String to = clean(call.getString("to"));
            copyRec(tree, from, to);
            invalidateParent(tree, to);
            call.resolve();
        } catch (Exception e) {
            call.reject("copy failed: " + e.getMessage());
        }
    }

    private void copyRec(Uri tree, String from, String to) throws Exception {
        Entry src = resolve(tree, from);
        if (src == null) throw new FileNotFoundException(from);
        if (src.isDir) {
            Map<String, Entry> children = listChildren(tree, src.docId);
            for (String name : children.keySet()) {
                copyRec(tree, from + "/" + name, to + "/" + name);
            }
            return;
        }
        byte[] bytes = readAll(docUri(tree, src.docId));
        Entry existing = resolve(tree, to);
        Uri target;
        if (existing != null && !existing.isDir) {
            target = docUri(tree, existing.docId);
        } else {
            String parentId = ensureParentDirs(tree, to);
            String name = baseName(to);
            Uri created = DocumentsContract.createDocument(
                resolver(), docUri(tree, parentId), mimeFor(name), name
            );
            if (created == null) throw new Exception("Could not create: " + to);
            target = created;
        }
        try (OutputStream out = resolver().openOutputStream(target, "rwt")) {
            if (out == null) throw new Exception("Could not open for writing: " + to);
            out.write(bytes);
        }
        invalidateParent(tree, to);
    }

    @PluginMethod
    public void delete(PluginCall call) {
        Uri tree = requireTree(call);
        if (tree == null) return;
        try {
            String rel = clean(call.getString("path"));
            Entry e = resolve(tree, rel);
            if (e == null) throw new FileNotFoundException(rel);
            if (!DocumentsContract.deleteDocument(resolver(), docUri(tree, e.docId))) {
                throw new Exception("Delete refused");
            }
            invalidateParent(tree, rel);
            if (e.isDir) listings.remove(cacheKey(tree, e.docId));
            call.resolve();
        } catch (Exception e) {
            call.reject("delete failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void getUri(PluginCall call) {
        Uri tree = requireTree(call);
        if (tree == null) return;
        try {
            String rel = clean(call.getString("path"));
            Entry e = resolve(tree, rel);
            if (e == null) throw new FileNotFoundException(rel);
            JSObject ret = new JSObject();
            ret.put("uri", docUri(tree, e.docId).toString());
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("getUri failed: " + e.getMessage());
        }
    }
}
