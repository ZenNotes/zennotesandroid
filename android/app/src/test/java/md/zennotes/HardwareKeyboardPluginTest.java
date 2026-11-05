package md.zennotes;

import static org.junit.Assert.*;

import android.content.res.Configuration;

import org.junit.Test;

public class HardwareKeyboardPluginTest {
    @Test
    public void onlyATypingKeyboardThatIsOutCounts() {
        assertTrue(HardwareKeyboardPlugin.connected(Configuration.KEYBOARD_QWERTY, Configuration.HARDKEYBOARDHIDDEN_NO));
    }

    @Test
    public void aDeviceWithNoKeyboardDoesNot() {
        assertFalse(HardwareKeyboardPlugin.connected(Configuration.KEYBOARD_NOKEYS, Configuration.HARDKEYBOARDHIDDEN_YES));
        assertFalse(HardwareKeyboardPlugin.connected(Configuration.KEYBOARD_NOKEYS, Configuration.HARDKEYBOARDHIDDEN_NO));
        assertFalse(HardwareKeyboardPlugin.connected(Configuration.KEYBOARD_UNDEFINED, Configuration.HARDKEYBOARDHIDDEN_UNDEFINED));
    }

    @Test
    public void aFoldedKeyboardOrANumericPadDoesNot() {
        assertFalse(HardwareKeyboardPlugin.connected(Configuration.KEYBOARD_QWERTY, Configuration.HARDKEYBOARDHIDDEN_YES));
        assertFalse(HardwareKeyboardPlugin.connected(Configuration.KEYBOARD_12KEY, Configuration.HARDKEYBOARDHIDDEN_NO));
    }
}
