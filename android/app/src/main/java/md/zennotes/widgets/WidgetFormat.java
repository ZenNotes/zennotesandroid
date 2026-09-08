package md.zennotes.widgets;

import android.text.format.DateFormat;

import java.text.ParseException;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/** The Home dashboard's stamps, as the iPhone widgets format them. */
public final class WidgetFormat {
    private WidgetFormat() {}

    /** just now, 5m ago, 3h ago, yesterday, 4d ago, then a short date. */
    public static String timeAgo(long then, long now) {
        long minutes = Math.round((now - then) / 60000.0);
        if (minutes < 1) return "just now";
        if (minutes < 60) return minutes + "m ago";
        long hours = Math.round(minutes / 60.0);
        if (hours < 24) return hours + "h ago";
        long days = Math.round(hours / 24.0);
        if (days == 1) return "yesterday";
        if (days < 7) return days + "d ago";
        return shortDate(new Date(then));
    }

    /** Local calendar day as ISO YYYY-MM-DD, the form task `due` uses, so
     *  overdue is a plain string comparison. */
    public static String isoDate(long now) {
        return new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date(now));
    }

    /** "Sep 5" in the device locale's order. */
    public static String shortDate(Date date) {
        String pattern = DateFormat.getBestDateTimePattern(Locale.getDefault(), "MMMd");
        return new SimpleDateFormat(pattern, Locale.getDefault()).format(date);
    }

    /** "Sep 5" for an ISO due date; the raw string if it doesn't parse. */
    public static String shortDate(String iso) {
        SimpleDateFormat parser = new SimpleDateFormat("yyyy-MM-dd", Locale.US);
        parser.setLenient(false);
        try {
            Date date = parser.parse(iso);
            return date == null ? iso : shortDate(date);
        } catch (ParseException e) {
            return iso;
        }
    }
}
