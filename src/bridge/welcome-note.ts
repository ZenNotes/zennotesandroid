/**
 * The note a brand-new vault is seeded with on mobile. The desktop demo tour
 * (16 numbered notes about reference panes and keymaps) overwhelmed and
 * confused first-time phone users — its recency-sorted tail even hid
 * "00 — Start Here" from the Home screen. One warm, phone-focused note that
 * the shell opens automatically replaces it; the full tour stays one command
 * away for the curious.
 */

export const WELCOME_NOTE_PATH = 'inbox/Welcome to ZenNotes.md'

export const WELCOME_NOTE_BODY = `# Welcome to ZenNotes

This is your first note. It is yours — edit it, add to it, or delete it once you have found your feet.

## The circle

The small circle in the bottom corner is how you get around. Tap it:

- **New** — write a note
- **Search** — find anything, instantly
- **Browse** — your folders, tasks, and tags
- **More** — everything else, including Settings

## Try it now

- [ ] Tap this checkbox to tick it off
- [ ] Tap the circle, then **New**, and write down a thought
- [ ] Tap the circle, then **Browse**, to see your folders

## Just plain text

Every note is a plain Markdown file — **bold**, *italic*, lists, and checkboxes are all simple text. No database, no lock-in. Your notes stay readable anywhere, forever.

## Capture from anywhere

Reading something worth keeping? Share it from any app and choose **ZenNotes** — it lands in your notes, ready when you are.

## Where your notes live

Your notes are plain files stored privately on this device. To keep several vaults and switch between them — or to connect a self-hosted ZenNotes server — tap the circle → **More** → **Settings** → **Vault**.

## When you want more

ZenNotes also does math, diagrams, tables, tasks with due dates, and daily notes. For a folder of example notes showing everything, tap the circle → **More** → **All commands…** and run **Generate demo tour**.

Happy writing.
`
