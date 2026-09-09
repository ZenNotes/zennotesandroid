# ZenNotes for Android 1.1.18: widgets

Home Screen widgets, in step with iPhone 1.9.9. Three of them, zero
configuration, wearing whatever theme the app wears.

## What changes on the phone

- **New Note.** A 2×2 widget: one tap creates a note in the Inbox and
  opens it with the title focused, the same path as the ⊕ sheet's New
  note.
- **Recent Notes.** 4×2 and up, resizable; the list scrolls. Your pinned
  notes first, in the order you pinned them (the drawer's own rule), then
  the ones you edited last, each with its "3h ago" stamp. A row opens the
  note; the + in the header starts a new one.
- **Today's Tasks.** 4×2 and up, resizable; the list scrolls. The Home
  dashboard's Today bucket: due today, overdue, or undated, with overdue
  tasks first and their count in the header. A row lands on the task's
  line in its note; the header opens the Tasks view. "All clear" when
  nothing is due.
- **Live.** The widgets update within seconds of a change: a saved note,
  a pinned one, a ticked task, a theme switch. Stamps refresh on the
  system's half-hour widget cadence in between.

## Under the hood

- Classic RemoteViews in Java (`md.zennotes.widgets`): three
  AppWidgetProviders and two RemoteViewsServices, no Glance and no
  Kotlin, so the build stays Java-only. The picker shows real previews on
  Android 12 and later.
- A widget cannot see the vault, so the shell publishes a snapshot into
  the app's private files (`files/widgets/snapshot.json`): pinned and
  recent note titles, paths and dates; today's tasks; the theme's colors.
  No note bodies. `src/bridge/widgets.ts` publishes on change, throttled
  to one refresh per 8 s while typing and flushed on backgrounding;
  `WidgetBridgePlugin.java` writes the file and re-renders every placed
  widget. The same publisher and contract as the iPhone shell.
- Taps are `zennotes://` view intents into the single-task MainActivity.
  At boot the shell asks the plugin for the newest link it saw rather
  than Capacitor's `getLaunchUrl`, which reports the task's original
  intent when the activity is recreated into its old task.
- Pinned to upstream `a3e638fc`: app core 2.46.0 plus the js-yaml and
  svgo lockfile fix for the advisories published on 2026-09-08.

No new permissions, services, or data collection. On-device and folder
vaults continue to work without an account; self-hosted and ZenNotes
Cloud vaults remain optional. The same widgets ship on iPhone and iPad as
ZenNotes 1.9.9.
