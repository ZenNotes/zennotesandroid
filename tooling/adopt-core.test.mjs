import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { manifestFiles, packedPackage, readCandidate, rewritePackageJson, rewriteReadme, verifyCandidate } from './adopt-core.mjs'

const SOURCE = '3a622639a245c928f63f1f61d0adfa110e0ca637'
const OTHER_SOURCE = 'f90161fa3d4c4b54629a6cdf9c5cb9329abbefda'

/** Build a real npm-style archive (package/package.json) and its provenance. */
async function pack(directory, name, version, { sourceCommit = SOURCE, dirty = false, packedVersion = version } = {}) {
  const short = name.replace('@zennotes/', '')
  const file = `zennotes-${short}-${version}.tgz`
  const stage = join(directory, `stage-${short}`)
  await mkdir(join(stage, 'package'), { recursive: true })
  await writeFile(join(stage, 'package/package.json'), JSON.stringify({ name, version: packedVersion }) + '\n')
  execFileSync('tar', ['-czf', join(directory, file), '-C', stage, 'package'])
  await rm(stage, { recursive: true, force: true })
  const bytes = await readFile(join(directory, file))
  return {
    name,
    version,
    file,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    sourceCommit,
    workingTreeDirty: dirty
  }
}

/** A complete, consistent candidate directory; `mutate` may edit the provenance objects before they are written. */
async function candidate(options = {}, mutate = () => {}) {
  const directory = await mkdtemp(join(tmpdir(), 'adopt-core-test-'))
  const version = options.version ?? '2.53.1'
  const bridge = await pack(directory, '@zennotes/bridge-contract', `${version}-boundaries.h1111111111111111`, options.bridge)
  const domain = await pack(directory, '@zennotes/shared-domain', `${version}-boundaries.h1111111111111111`, options.domain)
  const core = {
    ...(await pack(directory, '@zennotes/app-core', `${version}-core.h2222222222222222`, options.core)),
    sourceLockSha256: 'd1900218a36064c5a2f613f1db9a6a4895086db6aa30e1cf1b8b35c18753e1c0',
    toolchain: { node: 'v22.23.2' },
    dependencies: [structuredClone(bridge), structuredClone(domain)]
  }
  const release = {
    target: 'core',
    tag: `core-${core.version}`,
    sourceCommit: options.releaseSource ?? SOURCE,
    localCandidate: options.localCandidate ?? false,
    files: [core.file, `${core.file}.json`, bridge.file, `${bridge.file}.json`, domain.file, `${domain.file}.json`]
  }
  mutate({ core, bridge, domain, release })
  for (const entry of [core, bridge, domain]) await writeFile(join(directory, `${entry.file}.json`), JSON.stringify(entry, null, 2) + '\n')
  await writeFile(join(directory, 'release.json'), JSON.stringify(release, null, 2) + '\n')
  return { directory, core, bridge, domain, release }
}

async function verify(directory, options) {
  return verifyCandidate(await readCandidate(directory), options)
}

test('a consistent candidate verifies and yields the app-core provenance as the manifest', async () => {
  const { directory, core } = await candidate()
  try {
    const manifest = await verify(directory, { expectedTag: `core-${core.version}`, expectedSource: SOURCE })
    assert.equal(manifest.name, '@zennotes/app-core')
    assert.equal(manifest.version, core.version)
    assert.deepEqual(manifestFiles(manifest), [core.file, ...core.dependencies.map((d) => d.file)])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('one flipped byte in an archive fails the SHA-256 check before anything else', async () => {
  const { directory, bridge } = await candidate()
  try {
    const bytes = await readFile(join(directory, bridge.file))
    bytes[bytes.length - 1] ^= 0xff // the gzip trailer, so tar itself would still list the entry
    await writeFile(join(directory, bridge.file), bytes)
    await assert.rejects(verify(directory), /bridge-contract: SHA-256 does not match/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a provenance whose sha256 was fixed up but whose integrity was not is still refused', async () => {
  const { directory } = await candidate({}, ({ domain, core }) => {
    domain.integrity = 'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=='
    core.dependencies[1].integrity = domain.integrity
  })
  try {
    await assert.rejects(verify(directory), /shared-domain: SHA-512 integrity does not match/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('archives built from different source commits are refused, even with matching checksums', async () => {
  const { directory } = await candidate({ domain: { sourceCommit: OTHER_SOURCE } }, ({ core, domain }) => {
    core.dependencies[1].sourceCommit = domain.sourceCommit
  })
  try {
    await assert.rejects(verify(directory), /shared-domain: sourceCommit differs from release.json/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('--source must equal the recorded commit; a short or different hash is refused', async () => {
  const { directory } = await candidate()
  try {
    await assert.rejects(verify(directory, { expectedSource: OTHER_SOURCE }), /differs from --source/)
    await verify(directory, { expectedSource: SOURCE.toUpperCase() })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a dirty build is refused unless allowDirty, for both the release flag and a per-archive flag', async () => {
  const local = await candidate({ localCandidate: true })
  const dirtyCore = await candidate({ core: { dirty: true } })
  try {
    await assert.rejects(verify(local.directory), /local candidate .* Set ZEN_ALLOW_DIRTY_CORE=1/)
    await assert.rejects(verify(dirtyCore.directory), /app-core was built from a dirty upstream tree/)
    const manifest = await verify(dirtyCore.directory, { allowDirty: true })
    assert.equal(manifest.workingTreeDirty, true)
    await verify(local.directory, { allowDirty: true })
  } finally {
    await rm(local.directory, { recursive: true, force: true })
    await rm(dirtyCore.directory, { recursive: true, force: true })
  }
})

test('the package inside the archive must be the one the provenance names', async () => {
  const wrongVersion = await candidate({ bridge: { packedVersion: '2.53.0-boundaries.h1111111111111111' } })
  try {
    await assert.rejects(verify(wrongVersion.directory), /bridge-contract: archive version 2\.53\.0-boundaries\.h1111111111111111 differs from provenance/)
    assert.deepEqual(packedPackage(join(wrongVersion.directory, wrongVersion.core.file)), { name: '@zennotes/app-core', version: wrongVersion.core.version })
  } finally {
    await rm(wrongVersion.directory, { recursive: true, force: true })
  }
})

test("app-core's dependency list must agree with each dependency's own provenance", async () => {
  const { directory } = await candidate({}, ({ core }) => {
    core.dependencies[0].version = '2.53.1-boundaries.h9999999999999999'
  })
  try {
    await assert.rejects(verify(directory), /bridge-contract: "version" differs between its own provenance and app-core's dependency list/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a missing package, an extra archive, or a wrong tag is refused', async () => {
  const missing = await candidate({}, ({ release, domain }) => {
    release.files = release.files.filter((file) => !file.startsWith(domain.file))
  })
  const wrongTag = await candidate()
  try {
    await rm(join(missing.directory, missing.domain.file))
    await rm(join(missing.directory, `${missing.domain.file}.json`))
    await assert.rejects(verify(missing.directory), /@zennotes\/shared-domain is missing/)
    await assert.rejects(verify(wrongTag.directory, { expectedTag: 'core-9.9.9-core.h0000000000000000' }), /tag differs from the requested tag/)
    await writeFile(join(wrongTag.directory, 'zennotes-extra-1.0.0.tgz'), 'not listed')
    await assert.rejects(readCandidate(wrongTag.directory), /differ from release.json "files"/)
  } finally {
    await rm(missing.directory, { recursive: true, force: true })
    await rm(wrongTag.directory, { recursive: true, force: true })
  }
})

const PACKAGE_JSON = `{
  "name": "zennotes-android",
  "version": "1.1.24",
  "dependencies": {
    "@capacitor/android": "^8.0.0",
    "@zennotes/app-core": "file:vendor/zennotes/zennotes-app-core-2.53.0-core.h598c8d004c9228a3.tgz",
    "@zennotes/bridge-contract": "file:vendor/zennotes/zennotes-bridge-contract-2.53.0-boundaries.h193dbe157c4e64d2.tgz",
    "@zennotes/shared-domain": "file:vendor/zennotes/zennotes-shared-domain-2.53.0-boundaries.h193dbe157c4e64d2.tgz",
    "react": "^19.2.0"
  }
}
`

test('rewritePackageJson swaps exactly the three file: dependencies and nothing else', () => {
  const manifest = {
    name: '@zennotes/app-core',
    file: 'zennotes-app-core-2.53.1-core.h2222222222222222.tgz',
    dependencies: [
      { name: '@zennotes/bridge-contract', file: 'zennotes-bridge-contract-2.53.1-boundaries.h1111111111111111.tgz' },
      { name: '@zennotes/shared-domain', file: 'zennotes-shared-domain-2.53.1-boundaries.h1111111111111111.tgz' }
    ]
  }
  const next = rewritePackageJson(PACKAGE_JSON, manifest)
  assert.equal(
    next,
    PACKAGE_JSON.replace(/2\.53\.0-core\.h598c8d004c9228a3/, '2.53.1-core.h2222222222222222').replaceAll('2.53.0-boundaries.h193dbe157c4e64d2', '2.53.1-boundaries.h1111111111111111')
  )
  assert.ok(next.includes('"react": "^19.2.0"'))
  assert.throws(() => rewritePackageJson(PACKAGE_JSON.replace(/.*shared-domain.*\n/, ''), manifest), /exactly one file: dependency for @zennotes\/shared-domain, found 0/)
})

test('rewriteReadme replaces the tag, link and commit of the vendored-set sentence and reports a missing sentence', () => {
  const readme = [
    'The vendored set is the core release',
    '[core-2.53.0-core.h598c8d004c9228a3](https://github.com/ZenNotes/zennotes/releases/tag/core-2.53.0-core.h598c8d004c9228a3)',
    '(desktop commit `3a622639`, clean tree). Run `npm run',
    'boundaries:check` to verify.'
  ].join('\n')
  const next = rewriteReadme(readme, { tag: 'core-2.53.1-core.h2222222222222222', repo: 'ZenNotes/zennotes', sourceCommit: OTHER_SOURCE })
  assert.equal(
    next,
    [
      'The vendored set is the core release',
      '[core-2.53.1-core.h2222222222222222](https://github.com/ZenNotes/zennotes/releases/tag/core-2.53.1-core.h2222222222222222)',
      '(desktop commit `f90161fa`, clean tree). Run `npm run',
      'boundaries:check` to verify.'
    ].join('\n')
  )
  assert.equal(rewriteReadme('No such sentence here.', { tag: 'core-1', repo: 'a/b', sourceCommit: SOURCE }), null)
})
