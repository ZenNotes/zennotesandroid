# ZenNotes for Android 1.1.17: app core 2.46

A pin release, in step with iPhone 1.9.8. The shell is unchanged; the app
core moves from 2.45.0 to 2.46.0, and five of its ten changes reach the
phone.

## What changes on the phone

- **Comment threads with names.** A reply files under the comment it
  answers and every entry shows who wrote it. An assistant connected over
  MCP on your desktop can answer in the same threads; its replies arrive on
  the phone through your synced vault, signed with its name.
- **Pick any date from the @ menu.** The list ends with Date…, which opens
  a calendar; Today, Yesterday, Tomorrow and Now stay one tap away.
- **Saved Tasks filters.** Name a filter once and recall it from the chips
  under the Tasks header.
- **The Kanban Folder board** gives every note folder its own column, or
  the children of one folder you name (kanban_folder_root).
- **Math.** A $$ block inside a callout renders in both views, and Typst
  formulas match KaTeX's size with square-root bars in the text color.

Not on the phone: the desktop-only keymap changes (Unbind, ignored keys),
the CLI fix and the remote-template routes, which need a desktop or a
ZenNotes server.

## Under the hood

Shell-only release: the web bundle changes, the native side does not.
Pinned to upstream `da59c372`, the 2.46.0 tag commit.

No new permissions, services, or data collection.
