# Play review and Data safety notes: ZenNotes 1.1.16

Version 1.1.16 updates the shared ZenNotes app core from 2.44.0 to 2.45.0
and ports the iPhone shell's 1.9.7 editing and gesture fixes to Android. No
new permissions, no new data collection, no manifest permission changes,
no native code changes, and no change to the Data safety answers.

## What changed

- Editor input: the note editor no longer disables the keyboard's
  autocorrect, suggestions, and sentence capitalization for the note body
  (an HTML attribute change on the editor's content element). The system
  keyboard behaves as it does in any text field; the app itself performs
  no text processing and sends nothing.
- Editor toolbar: the Bullet, Checkbox, and Heading buttons insert their
  marker on an empty line; the caret is kept above the toolbar that docks
  over the keyboard.
- Note lists: every note row (Home, Quick Notes, Tags, Archive, Trash)
  answers long-press (an options sheet), swipe left (Archive / Delete, or
  Restore / Delete on archived and trashed notes), and swipe right (pin).
  These are the actions the app already offered elsewhere; Delete moves a
  note to the app's trash folder, and deleting from Trash asks for
  confirmation first.
- Navigation: a new Settings → Appearance → Start screen preference lets the
  user open the app on Home instead of the last note (stored on the device
  only, mirrored to app preferences like the existing layout and gesture
  settings). Home no longer reverts to the Tasks view after a vault
  rescan.
- App-core 2.45 fixes: arrow-key navigation in the editor's completion
  menus, and a self-hosted vault behind a proxy without WebSockets keeps
  refreshing over plain HTTP. Editor and sync behavior only.

## Data safety

Unchanged. The app collects no data by default; the optional ZenNotes Cloud
account and any user-configured self-hosted server work exactly as
previously declared. Local and folder vaults continue to work without an
account, and no storage permission is requested.
