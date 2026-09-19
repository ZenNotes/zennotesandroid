import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(join(root, 'vendor/zennotes/manifest.json'), 'utf8'))
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
// Only archives built from a clean, committed upstream tree may ship: a dirty
// build has no reviewable source. Trying an unreleased core locally is fine,
// but has to be said out loud so it cannot slip into a release unnoticed.
const allowDirty = process.env.ZEN_ALLOW_DIRTY_CORE === '1'
for (const entry of [manifest, ...manifest.dependencies]) {
  assert.match(entry.file, /^[a-z0-9.-]+\.tgz$/)
  assert.match(entry.sourceCommit ?? '', /^[0-9a-f]{40}$/, `${entry.name} sourceCommit`)
  assert.ok(
    entry.workingTreeDirty === false || allowDirty,
    `${entry.name} was built from a dirty upstream tree (${entry.sourceCommit.slice(0, 8)}+); ` +
      'not shippable. Set ZEN_ALLOW_DIRTY_CORE=1 to try it locally.'
  )
  const archive = await readFile(join(root, 'vendor/zennotes', entry.file))
  assert.equal(createHash('sha256').update(archive).digest('hex'), entry.sha256, `${entry.name} checksum`)
  assert.equal(pkg.dependencies[entry.name], `file:vendor/zennotes/${entry.file}`)
  const installed = JSON.parse(await readFile(join(root, 'node_modules', entry.name, 'package.json'), 'utf8'))
  assert.equal(installed.version, entry.version, `${entry.name} installed version`)
}
const host = createRequire(join(root, 'package.json'))
const core = createRequire(join(root, 'node_modules/@zennotes/app-core/package.json'))
for (const peer of ['react', 'react-dom', '@codemirror/state', '@codemirror/view', '@codemirror/language', '@lezer/common', '@lezer/highlight']) {
  assert.equal(core.resolve(peer), host.resolve(peer), `Duplicate ${peer}`)
}
for (const privatePath of ['store', 'lib/pane-layout', 'src/store.ts', 'components/EditorPane']) {
  assert.throws(() => host.resolve(`@zennotes/app-core/${privatePath}`), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' })
}
async function inspect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) { await inspect(path); continue }
    if (!/\.(?:[cm]?[jt]sx?|css)$/.test(entry.name)) continue
    const body = await readFile(path, 'utf8')
    const imports = body.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\(\s*|@import\s*)['"]([^'"]+)['"]/g)
    for (const [, specifier] of imports) {
      assert.ok(!/^@(shared|bridge-contract|desktop-main)\//.test(specifier), `${path}: source alias ${specifier}`)
      assert.ok(!specifier.includes('.zennotes-source'), `${path}: source checkout import`)
      if (specifier.startsWith('@zennotes/app-core/')) import.meta.resolve(specifier)
    }
  }
}
await inspect(join(root, 'src'))
await inspect(join(root, 'tooling'))
console.log(`Public core boundary verified: ${manifest.version}`)
