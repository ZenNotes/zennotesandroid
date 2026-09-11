package md.zennotes;

import android.content.Context;
import android.util.AttributeSet;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import android.view.inputmethod.InputMethodManager;
import androidx.core.view.inputmethod.EditorInfoCompat;
import androidx.core.view.inputmethod.InputConnectionCompat;
import androidx.core.view.inputmethod.InputContentInfoCompat;
import com.getcapacitor.CapacitorWebView;

/** Preserve Capacitor's keyboard handling and add Android's rich-content API. */
public class ImagePasteWebView extends CapacitorWebView {
    interface Receiver { boolean receive(InputContentInfoCompat content, int flags); }
    static final String[] IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"};
    private boolean imagePasteEnabled;
    Receiver imageReceiver;

    public ImagePasteWebView(Context context, AttributeSet attrs) { super(context, attrs); }

    void setImagePasteEnabled(boolean enabled) {
        if (imagePasteEnabled == enabled) return;
        imagePasteEnabled = enabled;
        InputMethodManager ime = (InputMethodManager) getContext().getSystemService(Context.INPUT_METHOD_SERVICE);
        if (ime != null) ime.restartInput(this);
    }

    @Override public InputConnection onCreateInputConnection(EditorInfo info) {
        InputConnection connection = super.onCreateInputConnection(info);
        if (connection == null || !imagePasteEnabled) return connection;
        EditorInfoCompat.setContentMimeTypes(info, IMAGE_TYPES);
        return InputConnectionCompat.createWrapper(connection, info,
                (content, flags, options) -> imagePasteEnabled && imageReceiver != null && imageReceiver.receive(content, flags));
    }
}
