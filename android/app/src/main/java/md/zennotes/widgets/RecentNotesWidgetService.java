package md.zennotes.widgets;

import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.widget.RemoteViews;
import android.widget.RemoteViewsService;

import java.util.Collections;
import java.util.List;

import md.zennotes.R;

/** Rows for the Recent Notes widget's list, read from the snapshot. */
public class RecentNotesWidgetService extends RemoteViewsService {
    @Override
    public RemoteViewsFactory onGetViewFactory(Intent intent) {
        return new Factory(getApplicationContext());
    }

    static final class Factory implements RemoteViewsFactory {
        private final Context context;
        private List<WidgetSnapshot.Note> notes = Collections.emptyList();
        private WidgetSnapshot.Palette palette = WidgetSnapshot.Palette.fallback();
        private long now = System.currentTimeMillis();

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
            notes = snapshot != null ? snapshot.notes : Collections.<WidgetSnapshot.Note>emptyList();
            palette = snapshot != null ? snapshot.palette : WidgetSnapshot.Palette.fallback();
            now = System.currentTimeMillis();
        }

        @Override
        public void onDestroy() {}

        @Override
        public int getCount() {
            return notes.size();
        }

        @Override
        public RemoteViews getViewAt(int position) {
            RemoteViews row = new RemoteViews(context.getPackageName(), R.layout.widget_note_row);
            if (position < 0 || position >= notes.size()) return row;
            WidgetSnapshot.Note note = notes.get(position);
            row.setImageViewResource(R.id.zn_row_icon, note.pinned ? R.drawable.ic_zn_pin : R.drawable.ic_zn_doc);
            row.setInt(R.id.zn_row_icon, "setColorFilter", note.pinned ? palette.accent : palette.muted);
            row.setTextViewText(R.id.zn_row_title, note.title);
            row.setTextColor(R.id.zn_row_title, palette.fg);
            row.setTextViewText(R.id.zn_row_stamp, WidgetFormat.timeAgo(note.updatedAt, now));
            row.setTextColor(R.id.zn_row_stamp, palette.muted);
            boolean last = position == notes.size() - 1;
            row.setInt(R.id.zn_row_divider, "setBackgroundColor", last ? Color.TRANSPARENT : palette.bg2);
            row.setOnClickFillInIntent(R.id.zn_row, WidgetLinks.fillIn(WidgetLinks.open(note.path)));
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
