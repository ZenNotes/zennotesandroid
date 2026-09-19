// Adopt a ZenNotes core release into this shell.
//
//   npm run core:adopt -- core-2.53.1-core.h0123456789abcdef            # a GitHub release (draft or published)
//   npm run core:adopt -- --from ../../opensource/zennotes/dist/boundary-release/core-2.53.1-core.h...   # a local rehearsal build
//
// The release (or rehearsal directory) holds three archives, one `.tgz.json`
// provenance file per archive, and `release.json`. Nothing is written until
// every archive's SHA-256 and SHA-512 match its provenance, the package inside
// each archive is the one the provenance names, every recorded source commit is
// the same 40-hex commit, and the build came from a clean upstream tree. Then
// the archives replace the ones in `vendor/zennotes/`, `manifest.json` becomes
// the app-core provenance file (as it always has been), the three `file:`
// dependencies in `package.json` point at the new filenames, the README
// sentence that names the vendored release is rewritten, `npm install` pins
// the set in `package-lock.json`, and `check-core-boundary.mjs` runs.
//
// A dirty upstream build is refused unless ZEN_ALLOW_DIRTY_CORE=1, the same
// override `check-core-boundary.mjs` honours for a local try-out. The script
// never runs git: review the diff, then stage `package.json`,
// `package-lock.json`, `vendor/zennotes` and `README.md` by path.

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { copyFile, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

export const CORE_PACKAGES = ['@zennotes/app-core', '@zennotes/bridge-contract', '@zennotes/shared-domain']
export const DEFAULT_REPO = 'ZenNotes/zennotes'
const VENDOR_DIR = 'vendor/zennotes'

/** Read a candidate directory: release.json plus one provenance file per archive. */
export async function readCandidate(directory) {
  const release = JSON.parse(await readFile(join(directory, 'release.json'), 'utf8'))
  assert.equal(release.target, 'core', `release.json target is "${release.target}", expected "core"`)
  const listed = (release.files ?? []).filter((file) => file.endsWith('.tgz'))
  const present = (await readdir(directory)).filter((file) => file.endsWith('.tgz')).sort()
  assert.deepEqual(present, [...listed].sort(), 'archives in the directory differ from release.json "files"')
  const entries = []
  for (const file of listed) {
    const provenance = JSON.parse(await readFile(join(directory, `${file}.json`), 'utf8'))
    entries.push({ file, path: join(directory, file), provenance })
  }
  return { directory, release, entries }
}

/** The version and name of the package inside an npm archive (`package/package.json`). */
export function packedPackage(archivePath) {
  const text = execFileSync('tar', ['-xOf', archivePath, 'package/package.json'], { encoding: 'utf8' })
  const { name, version } = JSON.parse(text)
  return { name, version }
}

/**
 * Check a candidate against its own provenance. Returns the app-core
 * provenance (the future manifest) when everything agrees; throws otherwise.
 */
export async function verifyCandidate(candidate, { allowDirty = false, expectedSource, expectedTag, readPacked = packedPackage } = {}) {
  const { release, entries } = candidate
  if (expectedTag) assert.equal(release.tag, expectedTag, 'release.json tag differs from the requested tag')
  assert.match(release.sourceCommit ?? '', /^[0-9a-f]{40}$/, 'release.json sourceCommit is not a full commit hash')
  if (expectedSource) {
    assert.equal(release.sourceCommit, expectedSource.toLowerCase(), 'release.json sourceCommit differs from --source')
  }
  assert.ok(
    release.localCandidate === false || allowDirty,
    'release.json marks this a local candidate (built with --allow-dirty); not shippable. Set ZEN_ALLOW_DIRTY_CORE=1 to try it locally.'
  )
  const byName = new Map()
  for (const entry of entries) {
    const { file, path, provenance } = entry
    assert.match(file, /^[a-z0-9.-]+\.tgz$/, `${file}: archive name has characters the boundary check refuses`)
    assert.equal(provenance.file, file, `${file}: provenance names a different file (${provenance.file})`)
    assert.ok(CORE_PACKAGES.includes(provenance.name), `${file}: unexpected package ${provenance.name}`)
    assert.ok(!byName.has(provenance.name), `${provenance.name} appears twice`)
    assert.match(provenance.sourceCommit ?? '', /^[0-9a-f]{40}$/, `${provenance.name}: sourceCommit is not a full commit hash`)
    assert.equal(provenance.sourceCommit, release.sourceCommit, `${provenance.name}: sourceCommit differs from release.json`)
    assert.ok(
      provenance.workingTreeDirty === false || allowDirty,
      `${provenance.name} was built from a dirty upstream tree (${provenance.sourceCommit.slice(0, 8)}+); not shippable. Set ZEN_ALLOW_DIRTY_CORE=1 to try it locally.`
    )
    const bytes = await readFile(path)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), provenance.sha256, `${provenance.name}: SHA-256 does not match its provenance`)
    assert.equal(`sha512-${createHash('sha512').update(bytes).digest('base64')}`, provenance.integrity, `${provenance.name}: SHA-512 integrity does not match its provenance`)
    const packed = readPacked(path)
    assert.equal(packed.name, provenance.name, `${file}: archive contains ${packed.name}, provenance says ${provenance.name}`)
    assert.equal(packed.version, provenance.version, `${provenance.name}: archive version ${packed.version} differs from provenance ${provenance.version}`)
    byName.set(provenance.name, entry)
  }
  for (const name of CORE_PACKAGES) assert.ok(byName.has(name), `${name} is missing from the candidate`)
  const core = byName.get('@zennotes/app-core').provenance
  const dependencies = core.dependencies ?? []
  for (const name of CORE_PACKAGES.slice(1)) {
    const own = byName.get(name).provenance
    const recorded = dependencies.find((dependency) => dependency.name === name)
    assert.ok(recorded, `app-core provenance does not list ${name}`)
    for (const key of ['version', 'file', 'sha256', 'integrity', 'sourceCommit', 'workingTreeDirty']) {
      assert.deepEqual(recorded[key], own[key], `${name}: "${key}" differs between its own provenance and app-core's dependency list`)
    }
  }
  return core
}

/** Files named by a manifest: the app-core archive and its two dependencies. */
export function manifestFiles(manifest) {
  return [manifest, ...(manifest.dependencies ?? [])].map((entry) => entry.file)
}

/** Rewrite the three `file:` dependencies in package.json text, keeping everything else byte for byte. */
export function rewritePackageJson(text, manifest) {
  let next = text
  for (const entry of [manifest, ...manifest.dependencies]) {
    const pattern = new RegExp(`("${entry.name.replace(/[/@.]/g, '\\$&')}":\\s*")file:${VENDOR_DIR}/[^"]+(")`, 'g')
    const matches = [...next.matchAll(pattern)]
    assert.equal(matches.length, 1, `package.json: expected exactly one file: dependency for ${entry.name}, found ${matches.length}`)
    next = next.replace(pattern, `$1file:${VENDOR_DIR}/${entry.file}$2`)
  }
  return next
}

const README_PATTERN = /\[core-[^\]]+\]\(https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/tag\/core-[^)]+\)\s*\(desktop commit `[0-9a-f]{7,40}`, clean tree\)/

/** Rewrite the README sentence that names the vendored release; returns null when the sentence is not found. */
export function rewriteReadme(text, { tag, repo, sourceCommit }) {
  if (!README_PATTERN.test(text)) return null
  const replacement = `[${tag}](https://github.com/${repo}/releases/tag/${tag})\n(desktop commit \`${sourceCommit.slice(0, 8)}\`, clean tree)`
  return text.replace(README_PATTERN, replacement)
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
  if (result.error) throw result.error
  assert.equal(result.status, 0, `${command} ${args.join(' ')} exited with ${result.status}`)
}

function usage() {
  return [
    'Usage:',
    '  node tooling/adopt-core.mjs <core-tag> [--repo owner/name] [--source <commit>] [--dry-run] [--no-install] [--keep-download]',
    '  node tooling/adopt-core.mjs --from <directory> [--source <commit>] [--dry-run] [--no-install]',
    '',
    '  <core-tag>       GitHub release tag on the desktop repo, e.g. core-2.53.1-core.h0123456789abcdef (drafts work with an authenticated gh)',
    '  --from           A directory with the same files (a local `prepare-boundary-release.mjs core` build) instead of a download',
    '  --source         Refuse the candidate unless every recorded source commit equals this one',
    '  --dry-run        Download and verify, print the plan, change nothing',
    '  --no-install     Skip npm install and the boundary check after writing files',
    '  --keep-download  Leave the downloaded files in place and print the directory',
    '',
    '  ZEN_ALLOW_DIRTY_CORE=1 accepts a build from a dirty upstream tree for a local try-out (never for a release).'
  ].join('\n')
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      repo: { type: 'string', default: DEFAULT_REPO },
      from: { type: 'string' },
      source: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'no-install': { type: 'boolean', default: false },
      'keep-download': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false }
    }
  })
  if (values.help || (positionals.length === 0 && !values.from)) {
    console.log(usage())
    return values.help ? 0 : 2
  }
  assert.ok(positionals.length <= 1, 'Expected at most one core tag')
  const tag = positionals[0]
  assert.ok(!(tag && values.from), 'Give either a core tag or --from, not both')
  if (tag) assert.match(tag, /^core-[a-z0-9.-]+$/, `Not a core tag: ${tag}`)
  if (values.source) assert.match(values.source, /^[0-9a-f]{40}$/i, '--source must be a full 40-hex commit hash')
  const allowDirty = env.ZEN_ALLOW_DIRTY_CORE === '1'
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

  let directory = values.from ? resolve(values.from) : null
  let downloaded = null
  if (!directory) {
    downloaded = await mkdtemp(join(tmpdir(), 'zennotes-core-'))
    console.log(`Downloading ${tag} from ${values.repo} ...`)
    run('gh', ['release', 'download', tag, '--repo', values.repo, '-D', downloaded], root)
    directory = downloaded
  }

  try {
    const candidate = await readCandidate(directory)
    const manifest = await verifyCandidate(candidate, { allowDirty, expectedSource: values.source, expectedTag: tag })
    const releaseTag = candidate.release.tag
    console.log(`Verified ${releaseTag}: source ${manifest.sourceCommit}, ${candidate.entries.length} archives, checksums and packed versions match.`)
    if (candidate.release.localCandidate || manifest.workingTreeDirty) {
      console.log('WARNING: this is a dirty local candidate, accepted because ZEN_ALLOW_DIRTY_CORE=1. Do not release it.')
    }

    const current = JSON.parse(await readFile(join(root, VENDOR_DIR, 'manifest.json'), 'utf8'))
    const currentFiles = manifestFiles(current)
    const nextFiles = manifestFiles(manifest)
    const unchanged = current.version === manifest.version && JSON.stringify(currentFiles) === JSON.stringify(nextFiles)
    const removals = currentFiles.filter((file) => !nextFiles.includes(file))
    console.log(unchanged ? `Already on ${manifest.version}; files will be rewritten in place.` : `Replacing ${current.version} with ${manifest.version}.`)
    for (const file of nextFiles) console.log(`  + ${VENDOR_DIR}/${file}`)
    for (const file of removals) console.log(`  - ${VENDOR_DIR}/${file}`)

    const packageText = await readFile(join(root, 'package.json'), 'utf8')
    const nextPackageText = rewritePackageJson(packageText, manifest)
    const readmeText = await readFile(join(root, 'README.md'), 'utf8')
    const cleanRelease = !candidate.release.localCandidate && !manifest.workingTreeDirty
    const nextReadme = cleanRelease ? rewriteReadme(readmeText, { tag: releaseTag, repo: values.repo, sourceCommit: manifest.sourceCommit }) : readmeText
    if (cleanRelease && nextReadme === null) console.log('WARNING: README.md: the "vendored set" sentence was not found; update it by hand.')

    if (values['dry-run']) {
      console.log('Dry run: nothing written.')
      return 0
    }

    for (const entry of candidate.entries) await copyFile(entry.path, join(root, VENDOR_DIR, entry.file))
    await writeFile(join(root, VENDOR_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
    for (const file of removals) await unlink(join(root, VENDOR_DIR, file)).catch(() => {})
    await writeFile(join(root, 'package.json'), nextPackageText)
    if (nextReadme && nextReadme !== readmeText) await writeFile(join(root, 'README.md'), nextReadme)
    console.log(`Wrote ${VENDOR_DIR}/manifest.json, package.json${nextReadme && nextReadme !== readmeText ? ', README.md' : ''}.`)

    if (values['no-install']) {
      console.log('Skipped npm install and the boundary check (--no-install).')
    } else {
      run('npm', ['install', '--no-audit', '--no-fund'], root)
      run(process.execPath, [join(root, 'tooling/check-core-boundary.mjs')], root)
    }
    console.log(
      [
        '',
        `Adopted ${releaseTag}. Next:`,
        '  npm run typecheck && npm test && npm run build && npm run sync',
        '  (cd android && ./gradlew assembleDebug) and an emulator pass',
        `  git add package.json package-lock.json ${VENDOR_DIR} README.md   (stage by path; the script ran no git command)`
      ].join('\n')
    )
    return 0
  } catch (error) {
    // Keep a failed download so the mismatch can be inspected.
    if (downloaded) console.error(`Downloaded files kept for inspection at ${downloaded}`)
    downloaded = null
    throw error
  } finally {
    if (downloaded) {
      if (values['keep-download']) console.log(`Downloaded files kept at ${downloaded}`)
      else await rm(downloaded, { recursive: true, force: true })
    }
  }
}

function invokedDirectly() {
  // Compare real paths: Node resolves symlinks for the ESM entry (e.g. /tmp -> /private/tmp on macOS),
  // and a mismatch here would turn the whole script into a silent no-op.
  try {
    return Boolean(process.argv[1]) && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (invokedDirectly()) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`\nadopt-core: ${error.message}`)
      process.exit(1)
    }
  )
}
