import { build } from 'vite'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
await build({
  root, configFile: resolve(root, 'vite.config.ts'),
  plugins: [{
    name: 'isolated-native-boundary-fixture',
    transformIndexHtml: { order: 'pre', handler(html) {
      return html.replace('</body>', '<script type="module" src="/tooling/native-boundary-fixture.ts"></script></body>')
    } }
  }],
  build: { outDir: 'dist-boundary-check' }
})
console.log('Fixture build ready. Install only on a disposable native simulator or emulator; see docs/native-boundary-validation.md.')
