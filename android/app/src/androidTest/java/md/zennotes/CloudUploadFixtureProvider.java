package md.zennotes;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

/** Protected like a document provider; the test must explicitly receive a URI grant. */
public class CloudUploadFixtureProvider extends SafFixtureProvider {
    @Override public Bundle call(String method, String arg, Bundle extras) {
        if (!"grant".equals(method) || !"md.zennotes".equals(arg)) throw new SecurityException("Unsupported fixture call");
        Uri uri = Uri.parse("content://md.zennotes.test.cloud-files/tree/root/document/large");
        getContext().grantUriPermission(arg, uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        return Bundle.EMPTY;
    }
}
