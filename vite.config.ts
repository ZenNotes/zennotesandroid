import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// The ZenNotes monorepo is consumed read-only, straight from source, the same
// way apps/web does it (aliases into packages/*). Nothing in that repo is
// modified by this project.
const ZENNOTES = resolve(__dirname, '../../opensource/zennotes')

// app-core's custom-code-language engine imports the oniguruma wasm as
// `?url`. Inline it as a data URL (same plugin as apps/web) so the lazily
// loaded engine chunk is self-contained — no wasm asset to serve under the
// capacitor:// scheme. The engine never loads on mobile today
// (supportsCustomCodeLanguages is false), but the import must still resolve
// at build time.
function onigurumaDataUrl(): Plugin {
  const virtualId = '\0zennotes:oniguruma-wasm-data-url'
  const wasmPath = createRequire(resolve(__dirname, 'package.json')).resolve(
    'vscode-oniguruma/release/onig.wasm'
  )
  return {
    name: 'zennotes-oniguruma-data-url',
    enforce: 'pre',
    resolveId(id) {
      if (id === 'vscode-oniguruma/release/onig.wasm?url') return virtualId
      return null
    },
    load(id) {
      if (id !== virtualId) return null
      const bytes = readFileSync(wasmPath)
      const url = `data:application/wasm;base64,${bytes.toString('base64')}`
      return `export default ${JSON.stringify(url)}`
    }
  }
}

function rendererManualChunk(id: string): string | undefined {
  const normalizedId = id.split('\\').join('/')
  if (normalizedId.endsWith('/packages/app-core/src/lib/wikilinks.ts')) {
    return 'app-wikilinks'
  }
  if (normalizedId.endsWith('/packages/app-core/src/lib/local-assets.ts')) {
    return 'app-local-assets'
  }
  if (normalizedId.endsWith('/packages/app-core/src/store.ts')) {
    return 'app-store'
  }

  if (!id.includes('node_modules')) return undefined

  // `@xyflow/react` (and the zustand nested under it) must NOT ride this
  // rule: `/react/` matches it as a substring, and vendor-react is on the
  // boot path, so React Flow would be fetched and evaluated on every launch
  // for the Workflows canvas — a feature mobile hides entirely. Left alone,
  // it lands in the lazily-imported WorkflowsView chunk, which never loads
  // here.
  if (
    (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/zustand/')) &&
    !id.includes('/@xyflow/')
  ) {
    return 'vendor-react'
  }
  if (id.includes('/@codemirror/language-data/')) {
    return 'vendor-editor-languages'
  }
  if (
    id.includes('/@codemirror/') ||
    id.includes('/codemirror/') ||
    id.includes('/@lezer/') ||
    id.includes('/@replit/codemirror-vim/')
  ) {
    return 'vendor-editor'
  }
  if (
    id.includes('/remark-') ||
    id.includes('/rehype-') ||
    id.includes('/unified/') ||
    id.includes('/unist-util-visit/') ||
    id.includes('/gray-matter/') ||
    id.includes('/katex/')
  ) {
    return 'vendor-markdown'
  }
  if (id.includes('/highlight.js/')) {
    return 'vendor-highlight'
  }
  if (id.includes('/vscode-textmate/') || id.includes('/vscode-oniguruma/')) {
    return 'vendor-textmate'
  }
  // No manualChunks rule for mermaid / cytoscape / dagre on purpose (upstream
  // PR #507 finding). Mermaid is only ever reached through a dynamic import,
  // but forcing its modules into a named chunk makes Rollup hoist that chunk
  // into the entry's STATIC graph — every launch then fetched and evaluated
  // 2.5MB of diagram code (plus vendor-markdown, which it imports) before the
  // user opened a note. Narrowing the rule does not help; the grouping itself
  // breaks the async boundary. Left to Rollup, mermaid lands in its own async
  // chunks fetched the first time a diagram actually renders. Total bundle
  // size is unchanged; only the boot path is — which is exactly what the
  // mobile cold-start budget cares about.
  if (id.includes('/jsxgraph/')) {
    return 'vendor-jsxgraph'
  }
  if (id.includes('/function-plot/')) {
    return 'vendor-function-plot'
  }
  if (id.includes('/d3')) {
    return 'vendor-d3'
  }
  return undefined
}

export default defineConfig({
  root: __dirname,
  base: './',
  resolve: {
    alias: [
      { find: '@renderer', replacement: resolve(ZENNOTES, 'packages/app-core/src') },
      { find: '@shared', replacement: resolve(ZENNOTES, 'packages/shared-domain/src') },
      { find: '@bridge-contract', replacement: resolve(ZENNOTES, 'packages/bridge-contract/src') },
      {
        find: /^@zennotes\/app-core\/(.*)$/,
        replacement: resolve(ZENNOTES, 'packages/app-core/src') + '/$1'
      },
      {
        find: /^@zennotes\/shared-domain\/(.*)$/,
        replacement: resolve(ZENNOTES, 'packages/shared-domain/src') + '/$1'
      },
      {
        find: /^@zennotes\/bridge-contract\/(.*)$/,
        replacement: resolve(ZENNOTES, 'packages/bridge-contract/src') + '/$1'
      },
      // Two dependency-free desktop-main data/logic modules reused verbatim
      // (demo tour content, wikilink rename rewriting). Read-only imports.
      { find: '@desktop-main', replacement: resolve(ZENNOTES, 'apps/desktop/src/main') }
    ],
    // The app-core sources live in another repo whose node_modules would
    // otherwise win nearest-wins resolution; dedupe pins every stateful
    // singleton (React, Zustand, CodeMirror) to this project's copy.
    dedupe: [
      'react',
      'react-dom',
      'zustand',
      '@codemirror/state',
      '@codemirror/view',
      '@codemirror/language',
      '@codemirror/autocomplete',
      '@codemirror/commands',
      '@codemirror/search',
      '@lezer/common',
      '@lezer/highlight',
      '@replit/codemirror-vim',
      'codemirror'
    ]
  },
  server: {
    port: 5183,
    fs: {
      allow: [__dirname, ZENNOTES]
    }
  },
  plugins: [onigurumaDataUrl(), react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 3500,
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: rendererManualChunk
      }
    }
  }
})
