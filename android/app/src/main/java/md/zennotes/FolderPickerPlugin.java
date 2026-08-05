package md.zennotes;

import android.content.Intent;
import android.content.UriPermission;
import android.net.Uri;
import android.provider.DocumentsContract;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import android.database.Cursor;

/**
 * Android counterpart of the iOS FolderPicker plugin (same jsName and result
 * shape, so src/bridge/folder-picker.ts runs unchanged). iOS uses
 * UIDocumentPicker + a security-scoped bookmark; here the "bookmark" is the
 * SAF tree URI itself — a persistable URI permission taken at pick time
 * survives reboots, so the URI string is all we need to reopen the folder.
 */
@CapacitorPlugin(name = "FolderPicker")
public class FolderPickerPlugin extends Plugin {

    @PluginMethod
    public void pickFolder(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(
            Intent.FLAG_GRANT_READ_URI_PERMISSION |
            Intent.FLAG_GRANT_WRITE_URI_PERMISSION |
            Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
        );
        startActivityForResult(call, intent, "onFolderPicked");
    }

    @ActivityCallback
    private void onFolderPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        Uri uri = data == null ? null : data.getData();
        if (result.getResultCode() != android.app.Activity.RESULT_OK || uri == null) {
            JSObject ret = new JSObject();
            ret.put("cancelled", true);
            call.resolve(ret);
            return;
        }
        try {
            getContext().getContentResolver().takePersistableUriPermission(
                uri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            );
        } catch (SecurityException e) {
            call.reject("Could not keep access to the picked folder: " + e.getMessage());
            return;
        }
        JSObject ret = new JSObject();
        ret.put("cancelled", false);
        ret.put("url", uri.toString());
        ret.put("name", treeDisplayName(uri));
        ret.put("bookmark", uri.toString());
        call.resolve(ret);
    }

    @PluginMethod
    public void resolveBookmark(PluginCall call) {
        String bookmark = call.getString("bookmark");
        if (bookmark == null || bookmark.isEmpty()) {
            call.reject("No bookmark given");
            return;
        }
        Uri uri = Uri.parse(bookmark);
        boolean held = false;
        for (UriPermission p : getContext().getContentResolver().getPersistedUriPermissions()) {
            if (p.getUri().equals(uri) && p.isReadPermission() && p.isWritePermission()) {
                held = true;
                break;
            }
        }
        if (!held) {
            call.reject("Folder access is no longer granted. Pick the folder again.");
            return;
        }
        String name = treeDisplayName(uri);
        if (name == null) {
            call.reject("The picked folder no longer exists.");
            return;
        }
        JSObject ret = new JSObject();
        ret.put("url", uri.toString());
        ret.put("name", name);
        ret.put("bookmark", uri.toString());
        call.resolve(ret);
    }

    /** Display name of the tree's root document, or null if it's gone. */
    private String treeDisplayName(Uri treeUri) {
        try {
            Uri docUri = DocumentsContract.buildDocumentUriUsingTree(
                treeUri, DocumentsContract.getTreeDocumentId(treeUri)
            );
            try (Cursor c = getContext().getContentResolver().query(
                docUri,
                new String[] { DocumentsContract.Document.COLUMN_DISPLAY_NAME },
                null, null, null
            )) {
                if (c != null && c.moveToFirst()) return c.getString(0);
            }
        } catch (Exception ignored) {}
        return null;
    }
}
