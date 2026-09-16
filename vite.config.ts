import { zenNotesAssets } from '@zennotes/app-core/vite'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const ROOT = import.meta.dirname

function rendererManualChunk(id: string): string | undefined {
  const normalizedId = id.split('\\').join('/')

  // NO named chunks for app-core / react / codemirror / markdown here —
  // and none may return. src/bootstrap.ts is the entry since 1.1.3: it must
  // finish the async native-prefs restore BEFORE app-core's store evaluates
  // (loadPrefs caches on first call), and the only ordering Rollup
  // guarantees is the dynamic-import boundary bootstrap -> main. A named
  // manual chunk reachable through that boundary gets hoisted into the
  // entry's STATIC graph (same mechanism as the mermaid note below) and
  // evaluates before bootstrap runs — which is exactly how the 1.1.3
  // settings-restore silently raced and lost. Chunk naming bought nothing
  // on-device anyway: assets ship inside the APK, so there is no HTTP
  // cache for stable chunk hashes to help.
  if (!id.includes('node_modules')) return undefined
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
  root: ROOT,
  base: './',
  server: {
    port: 5183,
    fs: {
      allow: [ROOT]
    }
  },
  // harper: phones use the system keyboard for spelling; the core never loads it here.
  // excalidraw: the core helper would copy Excalidraw's whole font pack (234 files,
  // ~13 MB, 12 MB of it the Xiaolai CJK handwriting subsets) into the APK. 1.1.20
  // shipped without it and drawings resolved fonts as they always have, so keep
  // the download at ~31 MB instead of ~44 MB.
  plugins: [...zenNotesAssets({ harper: false, excalidraw: false }), react()],
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
