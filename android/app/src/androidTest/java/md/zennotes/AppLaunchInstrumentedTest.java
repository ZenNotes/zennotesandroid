package md.zennotes;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.view.View;
import android.webkit.WebView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class AppLaunchInstrumentedTest {

    @Test
    public void packageIdentityMatchesReleaseApplication() {
        Context appContext = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertEquals("md.zennotes", appContext.getPackageName());
    }

    @Test
    public void launchesMainActivityAndCreatesVisibleWebView() {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity -> {
                assertNotNull(activity.getBridge());

                WebView webView = activity.getBridge().getWebView();
                assertNotNull(webView);
                assertEquals(View.VISIBLE, webView.getVisibility());
                assertTrue(webView.isAttachedToWindow());
            });
        }
    }
}
