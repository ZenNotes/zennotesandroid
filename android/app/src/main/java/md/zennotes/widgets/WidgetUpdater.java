package md.zennotes.widgets;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;

import md.zennotes.R;

/**
 * Re-renders every placed ZenNotes widget from the current snapshot. Called
 * by WidgetBridgePlugin after each publish (WidgetKit's reloadAllTimelines
 * counterpart) and safe from any thread: AppWidgetManager marshals to the
 * launcher itself.
 */
public final class WidgetUpdater {
    private WidgetUpdater() {}

    public static void refreshAll(Context context) {
        Context app = context.getApplicationContext();
        AppWidgetManager manager = AppWidgetManager.getInstance(app);
        if (manager == null) return;
        WidgetSnapshot snapshot = WidgetSnapshot.load(app);

        for (int id : ids(app, manager, NewNoteWidgetProvider.class)) {
            manager.updateAppWidget(id, NewNoteWidgetProvider.build(app, snapshot));
        }

        int[] recent = ids(app, manager, RecentNotesWidgetProvider.class);
        for (int id : recent) {
            manager.updateAppWidget(id, RecentNotesWidgetProvider.build(app, snapshot, id));
        }
        if (recent.length > 0) manager.notifyAppWidgetViewDataChanged(recent, R.id.zn_widget_list);

        int[] tasks = ids(app, manager, TasksWidgetProvider.class);
        for (int id : tasks) {
            manager.updateAppWidget(id, TasksWidgetProvider.build(app, snapshot, id));
        }
        if (tasks.length > 0) manager.notifyAppWidgetViewDataChanged(tasks, R.id.zn_widget_list);
    }

    private static int[] ids(Context context, AppWidgetManager manager,
                             Class<? extends AppWidgetProvider> provider) {
        int[] ids = manager.getAppWidgetIds(new ComponentName(context, provider));
        return ids == null ? new int[0] : ids;
    }
}
