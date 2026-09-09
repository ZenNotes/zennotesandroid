package md.zennotes.widgets;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.widget.RemoteViews;

import md.zennotes.R;

/**
 * Pinned notes first, then the ones edited last: the Home dashboard's
 * Recent list with the drawer's pins on top. Rows come from
 * RecentNotesWidgetService and open their note; the header's + starts a
 * new one; empty space opens Home.
 */
public class RecentNotesWidgetProvider extends AppWidgetProvider {
    static final int REQUEST_NEW_NOTE = 21;
    static final int REQUEST_HOME = 22;
    static final int REQUEST_ROW_TEMPLATE = 23;

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] appWidgetIds) {
        WidgetSnapshot snapshot = WidgetSnapshot.load(context);
        for (int id : appWidgetIds) {
            manager.updateAppWidget(id, build(context, snapshot, id));
        }
        manager.notifyAppWidgetViewDataChanged(appWidgetIds, R.id.zn_widget_list);
    }

    static RemoteViews build(Context context, WidgetSnapshot snapshot, int appWidgetId) {
        WidgetSnapshot.Palette p = snapshot != null ? snapshot.palette : WidgetSnapshot.Palette.fallback();
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_recent_notes);
        views.setInt(R.id.zn_widget_bg, "setColorFilter", p.bg);

        String vault = snapshot != null && snapshot.vaultName != null
                ? snapshot.vaultName
                : context.getString(R.string.widget_app_name);
        views.setTextViewText(R.id.zn_header_title, vault);
        views.setTextColor(R.id.zn_header_title, p.muted);
        views.setInt(R.id.zn_header_action_bg, "setColorFilter", WidgetSnapshot.Palette.withAlpha(p.accent, 0.18f));
        views.setInt(R.id.zn_header_action_icon, "setColorFilter", p.accent);
        views.setOnClickPendingIntent(R.id.zn_header_action,
                WidgetLinks.activity(context, WidgetLinks.newNote(), REQUEST_NEW_NOTE));

        // One adapter intent per widget id: the data URI keeps the launcher
        // from coalescing two placed widgets onto one factory.
        Intent adapter = new Intent(context, RecentNotesWidgetService.class);
        adapter.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId);
        adapter.setData(Uri.parse(adapter.toUri(Intent.URI_INTENT_SCHEME)));
        views.setRemoteAdapter(R.id.zn_widget_list, adapter);
        views.setEmptyView(R.id.zn_widget_list, R.id.zn_widget_empty);
        views.setPendingIntentTemplate(R.id.zn_widget_list,
                WidgetLinks.template(context, REQUEST_ROW_TEMPLATE));

        boolean noSnapshot = snapshot == null;
        views.setTextViewText(R.id.zn_empty_title, context.getString(
                noSnapshot ? R.string.widget_empty_open_app : R.string.widget_empty_no_notes));
        views.setTextViewText(R.id.zn_empty_detail, context.getString(
                noSnapshot ? R.string.widget_empty_open_app_detail : R.string.widget_empty_no_notes_detail));
        views.setTextColor(R.id.zn_empty_title, p.fg);
        views.setTextColor(R.id.zn_empty_detail, p.muted);

        views.setOnClickPendingIntent(R.id.zn_widget_root,
                WidgetLinks.activity(context, WidgetLinks.home(), REQUEST_HOME));
        return views;
    }
}
