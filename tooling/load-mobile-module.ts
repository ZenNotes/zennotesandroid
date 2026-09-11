import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(resolve(root, '.zennotes-source/package.json'))

/** Load real TypeScript modules with this mobile app's pinned source aliases. */
export async function loadMobileModule(
  entry: string | string[],
  mocks: Record<string, Record<string, unknown>> = {}
): Promise<Record<string, any>> {
  const { build } = require('esbuild')
  const result = await build({
    stdin: {
      contents: (Array.isArray(entry) ? entry : [entry]).map((path) => `export * from ${JSON.stringify(path)};`).join('\n'),
      resolveDir: root,
      loader: 'ts'
    },
    absWorkingDir: root,
    tsconfig: resolve(root, 'tsconfig.json'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    plugins: [{
      name: 'mobile-test-boundaries',
      setup(plugin: any) {
        plugin.onResolve({ filter: /.*/ }, (args: { path: string }) =>
          Object.hasOwn(mocks, args.path) ? { path: args.path, namespace: 'mobile-test-boundary' } : undefined
        )
        plugin.onLoad({ filter: /.*/, namespace: 'mobile-test-boundary' }, (args: { path: string }) => ({
          contents: `module.exports = __mobileTestMocks[${JSON.stringify(args.path)}];`,
          loader: 'js'
        }))
      }
    }]
  })
  const module = { exports: {} }
  const execute = new Function(
    'require', 'module', 'exports', '__mobileTestMocks',
    result.outputFiles[0].text + '\n//# sourceURL=' + entry
  )
  execute(require, module, module.exports, mocks)
  return module.exports
}
