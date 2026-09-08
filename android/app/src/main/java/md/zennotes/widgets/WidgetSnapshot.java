package md.zennotes.widgets;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Mirror of src/bridge/widget-snapshot.ts (the WebView is the writer;
 * WidgetBridgePlugin hands the JSON here) and of the iPhone shell's
 * WidgetSnapshot.swift. The widgets never see the vault: they render this
 * one file from the app's private storage. Every field a later shell might
 * add or drop is read with a default, so an older APK never fails on a
 * newer snapshot.
 */
public final class WidgetSnapshot {
    private static final String DIR = "widgets";
    private static final String FILE = "snapshot.json";

    public final long generatedAt;
    /** Nullable: no vault open when the snapshot was written. */
    public final String vaultName;
    public final Palette palette;
    public final List<Note> notes;
    public final List<Task> tasks;
    public final int todayCount;
    public final int overdueCount;
    public final boolean tasksReady;

    private WidgetSnapshot(long generatedAt, String vaultName, Palette palette, List<Note> notes,
                           List<Task> tasks, int todayCount, int overdueCount, boolean tasksReady) {
        this.generatedAt = generatedAt;
        this.vaultName = vaultName;
        this.palette = palette;
        this.notes = Collections.unmodifiableList(notes);
        this.tasks = Collections.unmodifiableList(tasks);
        this.todayCount = todayCount;
        this.overdueCount = overdueCount;
        this.tasksReady = tasksReady;
    }

    public static final class Note {
        public final String path;
        public final String title;
        public final String folder;
        /** ms since epoch. */
        public final long updatedAt;
        public final boolean pinned;

        Note(String path, String title, String folder, long updatedAt, boolean pinned) {
            this.path = path;
            this.title = title;
            this.folder = folder;
            this.updatedAt = updatedAt;
            this.pinned = pinned;
        }
    }

    public static final class Task {
        public final String id;
        public final String path;
        public final String noteTitle;
        public final String content;
        /** ISO YYYY-MM-DD, or null for an undated task. */
        public final String due;
        public final boolean overdue;
        public final boolean inProgress;
        /** Nullable. */
        public final String priority;

        Task(String id, String path, String noteTitle, String content, String due,
             boolean overdue, boolean inProgress, String priority) {
            this.id = id;
            this.path = path;
            this.noteTitle = noteTitle;
            this.content = content;
            this.due = due;
            this.overdue = overdue;
            this.inProgress = inProgress;
            this.priority = priority;
        }
    }

    /**
     * The app's active theme, sampled from the `--z-*` tokens by the shell.
     * Falls back to ZenNotes' default dark-hard palette (the same colors as
     * res/values/colors.xml) before the first publish.
     */
    public static final class Palette {
        public final boolean isDark;
        public final int bg;
        public final int bg1;
        public final int bg2;
        public final int fg;
        public final int fg2;
        public final int muted;
        public final int accent;
        public final int red;

        Palette(boolean isDark, int bg, int bg1, int bg2, int fg, int fg2, int muted, int accent, int red) {
            this.isDark = isDark;
            this.bg = bg;
            this.bg1 = bg1;
            this.bg2 = bg2;
            this.fg = fg;
            this.fg2 = fg2;
            this.muted = muted;
            this.accent = accent;
            this.red = red;
        }

        public static Palette fallback() {
            return new Palette(true, 0xFF1D2021, 0xFF32302F, 0xFF3C3836, 0xFFD4BE98, 0xFFDDC7A1,
                    0xFFA89984, 0xFFE78A4E, 0xFFEA6962);
        }

        static Palette from(JSONObject theme) {
            Palette f = fallback();
            if (theme == null) return f;
            return new Palette(
                    !"light".equals(theme.optString("mode", "dark")),
                    hex(theme, "bg", f.bg),
                    hex(theme, "bg1", f.bg1),
                    hex(theme, "bg2", f.bg2),
                    hex(theme, "fg", f.fg),
                    hex(theme, "fg2", f.fg2),
                    hex(theme, "muted", f.muted),
                    hex(theme, "accent", f.accent),
                    hex(theme, "red", f.red));
        }

        /** `#rrggbb` (the hash optional) → opaque ARGB; anything else keeps the fallback. */
        static int hex(JSONObject theme, String key, int fallback) {
            if (theme.isNull(key)) return fallback;
            String value = theme.optString(key, "").trim();
            if (value.startsWith("#")) value = value.substring(1);
            if (value.length() != 6) return fallback;
            try {
                return 0xFF000000 | Integer.parseInt(value, 16);
            } catch (NumberFormatException e) {
                return fallback;
            }
        }

        /** The color with its alpha replaced (0..1), for tinted circles behind glyphs. */
        public static int withAlpha(int color, float alpha) {
            int a = Math.max(0, Math.min(255, Math.round(alpha * 255)));
            return (color & 0x00FFFFFF) | (a << 24);
        }
    }

    // ---- storage ------------------------------------------------------------

    public static File file(Context context) {
        return new File(new File(context.getFilesDir(), DIR), FILE);
    }

    /** Atomic replace: a widget waking mid-write sees the old file or the new one. */
    public static void write(Context context, String json) throws IOException {
        File target = file(context);
        File dir = target.getParentFile();
        if (dir == null) throw new IOException("No parent directory for " + target);
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("Could not create " + dir);
        File tmp = new File(dir, FILE + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(json.getBytes(StandardCharsets.UTF_8));
            out.getFD().sync();
        }
        if (!tmp.renameTo(target)) {
            //noinspection ResultOfMethodCallIgnored
            tmp.delete();
            throw new IOException("Could not replace " + target);
        }
    }

    public static void delete(Context context) {
        //noinspection ResultOfMethodCallIgnored
        file(context).delete();
    }

    /** The current snapshot, or null when none was written or it does not parse. */
    public static WidgetSnapshot load(Context context) {
        File f = file(context);
        if (!f.isFile()) return null;
        try (InputStream in = new FileInputStream(f)) {
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int read;
            while ((read = in.read(chunk)) != -1) buffer.write(chunk, 0, read);
            return parse(new String(buffer.toByteArray(), StandardCharsets.UTF_8));
        } catch (IOException | JSONException e) {
            return null;
        }
    }

    static WidgetSnapshot parse(String json) throws JSONException {
        JSONObject root = new JSONObject(json);
        long generatedAt = (long) root.optDouble("generatedAt", 0);
        String vaultName = root.isNull("vaultName") ? null : root.optString("vaultName", null);
        Palette palette = Palette.from(root.optJSONObject("theme"));

        List<Note> notes = new ArrayList<>();
        JSONArray noteArray = root.optJSONArray("notes");
        if (noteArray != null) {
            for (int i = 0; i < noteArray.length(); i++) {
                JSONObject n = noteArray.optJSONObject(i);
                if (n == null) continue;
                String path = n.optString("path", "");
                if (path.isEmpty()) continue;
                String title = n.optString("title", "").trim();
                notes.add(new Note(path, title.isEmpty() ? "Untitled" : title, n.optString("folder", ""),
                        (long) n.optDouble("updatedAt", 0), n.optBoolean("pinned", false)));
            }
        }

        List<Task> tasks = new ArrayList<>();
        JSONArray taskArray = root.optJSONArray("tasks");
        if (taskArray != null) {
            for (int i = 0; i < taskArray.length(); i++) {
                JSONObject t = taskArray.optJSONObject(i);
                if (t == null) continue;
                String id = t.optString("id", "");
                String path = t.optString("path", "");
                if (id.isEmpty() || path.isEmpty()) continue;
                tasks.add(new Task(id, path, t.optString("noteTitle", ""), t.optString("content", ""),
                        t.isNull("due") ? null : t.optString("due", null), t.optBoolean("overdue", false),
                        t.optBoolean("inProgress", false), t.isNull("priority") ? null : t.optString("priority", null)));
            }
        }

        JSONObject counts = root.optJSONObject("taskCounts");
        int todayCount = counts != null ? counts.optInt("today", tasks.size()) : tasks.size();
        int overdueCount = counts != null ? counts.optInt("overdue", 0) : 0;
        return new WidgetSnapshot(generatedAt, vaultName, palette, notes, tasks, todayCount, overdueCount,
                root.optBoolean("tasksReady", false));
    }
}
