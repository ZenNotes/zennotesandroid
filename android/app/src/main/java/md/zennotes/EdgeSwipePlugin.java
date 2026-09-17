package md.zennotes;

import android.graphics.Rect;
import android.os.Build;
import android.view.View;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.Collections;

/**
 * Keeps the shell's left-edge swipe (open Browse) alive under gesture
 * navigation. Android claims every swipe that starts at a screen edge as
 * Back: the WebView saw touchstart then touchcancel, Browse never opened, and
 * the swipe navigated back instead, or left the app from Home (Play review,
 * 1.1.21). Excluding a band of the left edge from the Back gesture hands those
 * touches to the WebView, as androidx DrawerLayout does for its drawer edge.
 *
 * The system honours at most 200dp per edge, so the band sits mid-screen,
 * where a thumb swipes. Back keeps working above and below it and along the
 * whole right edge. The JS shell decides when the band is wanted (phone
 * layout, drawer closed), because only it knows the layout override and the
 * drawer state. Android-only; iOS has no edge Back gesture to contend with.
 */
@CapacitorPlugin(name = "EdgeSwipe")
public class EdgeSwipePlugin extends Plugin {

    private static final int BAND_WIDTH_DP = 32;
    private static final int BAND_HEIGHT_DP = 200;

    private boolean claimed = false;
    private View.OnLayoutChangeListener relayout;

    @PluginMethod
    public void setLeftEdgeClaimed(PluginCall call) {
        boolean claim = Boolean.TRUE.equals(call.getBoolean("claimed", false));
        getActivity().runOnUiThread(() -> {
            claimed = claim;
            apply();
            call.resolve();
        });
    }

    private void apply() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            return; // no gesture navigation, nothing to exclude
        }
        View webView = getBridge().getWebView();
        if (relayout == null) {
            // Rects are in view coordinates: follow rotation and the keyboard.
            relayout = (v, l, t, r, b, ol, ot, or, ob) -> exclude(v);
            webView.addOnLayoutChangeListener(relayout);
        }
        exclude(webView);
    }

    private void exclude(View view) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            return;
        }
        if (!claimed || view.getHeight() == 0) {
            view.setSystemGestureExclusionRects(Collections.emptyList());
            return;
        }
        float density = view.getResources().getDisplayMetrics().density;
        int width = Math.round(BAND_WIDTH_DP * density);
        int height = Math.min(Math.round(BAND_HEIGHT_DP * density), view.getHeight());
        int top = (view.getHeight() - height) / 2;
        view.setSystemGestureExclusionRects(
                Collections.singletonList(new Rect(0, top, width, top + height)));
    }
}
