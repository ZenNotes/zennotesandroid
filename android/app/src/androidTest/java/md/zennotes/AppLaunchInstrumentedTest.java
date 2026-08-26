package md.zennotes;

import static androidx.test.espresso.Espresso.onView;
import static androidx.test.espresso.assertion.ViewAssertions.matches;
import static androidx.test.espresso.matcher.ViewMatchers.isAssignableFrom;
import static androidx.test.espresso.matcher.ViewMatchers.isDisplayed;
import static org.junit.Assert.assertEquals;

import android.content.Context;
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
    public void launchesMainActivityAndDisplaysTheWebApp() {
        try (ActivityScenario<MainActivity> ignored = ActivityScenario.launch(MainActivity.class)) {
            onView(isAssignableFrom(WebView.class)).check(matches(isDisplayed()));
        }
    }
}
