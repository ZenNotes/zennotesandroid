package md.zennotes.widgets;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.widget.RemoteViews;

import md.zennotes.R;

/**
 * One tap → a fresh note in the Inbox, title focused (the ⊕ sheet's "New
 * note"). Wears the app's theme from the snapshot.
 */
public class NewNoteWidgetProvider extends AppWidgetProvider {
    static final int REQUEST_NEW_NOTE = 11;

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] appWidgetIds) {
        WidgetSnapshot snapshot = WidgetSnapshot.load(context);
        for (int id : appWidgetIds) {
            manager.updateAppWidget(id, build(context, snapshot));
        }
    }

    static RemoteViews build(Context context, WidgetSnapshot snapshot) {
        WidgetSnapshot.Palette p = snapshot != null ? snapshot.palette : WidgetSnapshot.Palette.fallback();
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_new_note);
        views.setInt(R.id.zn_widget_bg, "setColorFilter", p.bg);
        views.setInt(R.id.zn_new_plus_bg, "setColorFilter", p.accent);
        views.setInt(R.id.zn_new_plus, "setColorFilter", p.bg);
        views.setTextColor(R.id.zn_new_title, p.fg);
        String vault = snapshot != null && snapshot.vaultName != null
                ? snapshot.vaultName
                : context.getString(R.string.widget_app_name);
        views.setTextViewText(R.id.zn_new_vault, vault);
        views.setTextColor(R.id.zn_new_vault, p.muted);
        views.setOnClickPendingIntent(R.id.zn_widget_root,
                WidgetLinks.activity(context, WidgetLinks.newNote(), REQUEST_NEW_NOTE));
        return views;
    }
}
