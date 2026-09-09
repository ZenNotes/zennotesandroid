package md.zennotes.widgets;

import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;
import android.widget.RemoteViewsService;

import java.util.Collections;
import java.util.List;

import md.zennotes.R;

/** Rows for the Today's Tasks widget's list, read from the snapshot. */
public class TasksWidgetService extends RemoteViewsService {
    @Override
    public RemoteViewsFactory onGetViewFactory(Intent intent) {
        return new Factory(getApplicationContext());
    }

    static final class Factory implements RemoteViewsFactory {
        private final Context context;
        private List<WidgetSnapshot.Task> tasks = Collections.emptyList();
        private WidgetSnapshot.Palette palette = WidgetSnapshot.Palette.fallback();
        private String todayIso = WidgetFormat.isoDate(System.currentTimeMillis());

        Factory(Context context) {
            this.context = context;
        }

        @Override
        public void onCreate() {
            load();
        }

        @Override
        public void onDataSetChanged() {
            load();
        }

        private void load() {
            WidgetSnapshot snapshot = WidgetSnapshot.load(context);
            tasks = snapshot != null ? snapshot.tasks : Collections.<WidgetSnapshot.Task>emptyList();
            palette = snapshot != null ? snapshot.palette : WidgetSnapshot.Palette.fallback();
            todayIso = WidgetFormat.isoDate(System.currentTimeMillis());
        }

        @Override
        public void onDestroy() {}

        @Override
        public int getCount() {
            return tasks.size();
        }

        @Override
        public RemoteViews getViewAt(int position) {
            RemoteViews row = new RemoteViews(context.getPackageName(), R.layout.widget_task_row);
            if (position < 0 || position >= tasks.size()) return row;
            WidgetSnapshot.Task task = tasks.get(position);
            boolean overdue = TasksWidgetProvider.isOverdue(task, todayIso);
            row.setImageViewResource(R.id.zn_row_icon,
                    task.inProgress ? R.drawable.ic_zn_progress : R.drawable.ic_zn_square);
            row.setInt(R.id.zn_row_icon, "setColorFilter", overdue ? palette.red : palette.muted);
            String content = task.content.trim();
            row.setTextViewText(R.id.zn_row_title, content.isEmpty() ? "Untitled task" : content);
            row.setTextColor(R.id.zn_row_title, palette.fg);
            String detail = task.noteTitle;
            if (overdue && task.due != null) {
                detail = WidgetFormat.shortDate(task.due) + " · " + task.noteTitle;
            }
            row.setTextViewText(R.id.zn_row_detail, detail);
            row.setTextColor(R.id.zn_row_detail, overdue ? palette.red : palette.muted);
            row.setOnClickFillInIntent(R.id.zn_row, WidgetLinks.fillIn(WidgetLinks.task(task.id, task.path)));
            return row;
        }

        @Override
        public RemoteViews getLoadingView() {
            return null;
        }

        @Override
        public int getViewTypeCount() {
            return 1;
        }

        @Override
        public long getItemId(int position) {
            return position;
        }

        @Override
        public boolean hasStableIds() {
            return false;
        }
    }
}
