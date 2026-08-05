# Vendored TikZJax (on-device TikZ rendering)

- `tikzjax.js` — single-file browser TikZJax: WebAssembly TeX engine +
  precompiled core dump (TikZ, pgfplots, circuitikz, …) inlined.
- `fonts.css` — the plugin's `styles.css`: inlined fonts used by SVG text.

Source: https://github.com/artisticat1/obsidian-tikzjax (MIT), the build the
Obsidian TikZJax plugin ships, fetched 2026-07-17 from the `main` branch.
Loaded lazily by `src/bridge/tikz.ts` on the first TikZ render; nothing here
is on the boot path.
