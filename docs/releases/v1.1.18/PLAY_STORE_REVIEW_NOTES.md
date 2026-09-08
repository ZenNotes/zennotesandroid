# Play review and Data safety notes: ZenNotes 1.1.18

Version 1.1.18 adds Home Screen widgets. No new permissions, no new data
collection, no manifest permission changes, and no change to the Data
safety answers. The shared app core stays at 2.46.

## What changed

- Three app widgets (manifest receivers with the standard
  `APPWIDGET_UPDATE` filter, plus two `RemoteViewsService`s guarded by
  `BIND_REMOTEVIEWS`): New Note, Recent Notes, and Today's Tasks.
- The widgets render a small summary the app writes into its own private
  files directory: note titles, paths, and modification dates; task
  lines; the theme's colors. Note bodies never leave the vault, and
  nothing is sent anywhere.
- Tapping a widget opens the app through its existing `zennotes` URL
  scheme: New Note creates a note in the Inbox and opens it; a Recent
  Notes row opens that note; a task row opens the note at that task's
  line; the tasks header opens the Tasks view.

## Data safety

Unchanged. The app collects no data by default; the optional ZenNotes
Cloud account and any user-configured self-hosted server work exactly as
previously declared. On-device and folder vaults continue to work without
an account, and no storage permission is requested.
