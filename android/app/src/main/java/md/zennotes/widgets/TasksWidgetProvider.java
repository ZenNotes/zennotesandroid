package md.zennotes.widgets;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.view.View;
import android.widget.RemoteViews;

import md.zennotes.R;

/**
 * The Home dashboard's Today bucket: due today, overdue, and undated open
 * tasks, overdue first. Rows (TasksWidgetService) jump to the task's line;
 * the header, and any empty space, open the Tasks view.
 */
public class TasksWidgetProvider extends AppWidgetProvider {
    static final int REQUEST_TASKS = 31;
    static final int REQUEST_ROW_TEMPLATE = 32;

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] appWidgetIds) {
        WidgetSnapshot snapshot = WidgetSnapshot.load(context);
        for (int id : appWidgetIds) {
            manager.updateAppWidget(id, build(context, snapshot, id));
        }
        manager.notifyAppWidgetViewDataChanged(appWidgetIds, R.id.zn_widget_list);
    }

    static boolean isOverdue(WidgetSnapshot.Task task, String todayIso) {
        if (task.due != null) return task.due.compareTo(todayIso) < 0;
        return task.overdue;
    }

    static RemoteViews build(Context context, WidgetSnapshot snapshot, int appWidgetId) {
        WidgetSnapshot.Palette p = snapshot != null ? snapshot.palette : WidgetSnapshot.Palette.fallback();
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_tasks);
        views.setInt(R.id.zn_widget_bg, "setColorFilter", p.bg);
        views.setInt(R.id.zn_header_icon, "setColorFilter", p.accent);
        views.setTextColor(R.id.zn_header_title, p.fg);

        String todayIso = WidgetFormat.isoDate(System.currentTimeMillis());
        int overdue = 0;
        int today = 0;
        if (snapshot != null) {
            for (WidgetSnapshot.Task task : snapshot.tasks) {
                if (isOverdue(task, todayIso)) overdue++;
            }
            overdue = Math.max(overdue, snapshot.overdueCount);
            today = snapshot.todayCount;
        }
        if (overdue > 0) {
            views.setTextViewText(R.id.zn_header_count, context.getString(R.string.widget_overdue_count, overdue));
            views.setTextColor(R.id.zn_header_count, p.red);
        } else if (today > 0) {
            views.setTextViewText(R.id.zn_header_count, context.getString(R.string.widget_open_count, today));
            views.setTextColor(R.id.zn_header_count, p.muted);
        } else {
            views.setTextViewText(R.id.zn_header_count, "");
        }

        Intent adapter = new Intent(context, TasksWidgetService.class);
        adapter.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId);
        adapter.setData(Uri.parse(adapter.toUri(Intent.URI_INTENT_SCHEME)));
        views.setRemoteAdapter(R.id.zn_widget_list, adapter);
        views.setEmptyView(R.id.zn_widget_list, R.id.zn_widget_empty);
        views.setPendingIntentTemplate(R.id.zn_widget_list,
                WidgetLinks.template(context, REQUEST_ROW_TEMPLATE));

        boolean ready = snapshot != null && snapshot.tasksReady;
        if (ready) {
            views.setViewVisibility(R.id.zn_empty_icon, View.VISIBLE);
            views.setInt(R.id.zn_empty_icon, "setColorFilter", p.accent);
            views.setTextViewText(R.id.zn_empty_title, context.getString(R.string.widget_all_clear));
            views.setTextViewText(R.id.zn_empty_detail, context.getString(R.string.widget_all_clear_detail));
        } else {
            views.setViewVisibility(R.id.zn_empty_icon, View.GONE);
            views.setTextViewText(R.id.zn_empty_title, context.getString(R.string.widget_empty_open_app));
            views.setTextViewText(R.id.zn_empty_detail, context.getString(R.string.widget_empty_tasks_detail));
        }
        views.setTextColor(R.id.zn_empty_title, p.fg);
        views.setTextColor(R.id.zn_empty_detail, p.muted);

        views.setOnClickPendingIntent(R.id.zn_widget_root,
                WidgetLinks.activity(context, WidgetLinks.tasks(), REQUEST_TASKS));
        return views;
    }
}
