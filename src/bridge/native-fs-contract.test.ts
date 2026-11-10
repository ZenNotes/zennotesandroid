import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadMobileModule } from '../../tooling/load-mobile-module.ts'

// @zennotes/portable-vault's VaultFileSystem contract over this app's
// NativeFs, on both of its tiers:
// - app storage, an in-memory Capacitor Filesystem in Directory.External
//   that answers a missing path with the plugin's OS-PLUG-FILE-0008;
// - a picked folder, an in-memory SafFs (SafFsPlugin.java) that answers a
//   missing path with ZN-SAF-NOT-FOUND and every other failure (a revoked
//   grant, a provider gone) with a message and no code.
// An outage is a failing store, and NativeFs must report it as a failure,
// never as an empty folder or a missing file: sync turns those into deletes.

type Entry = { kind: 'file'; bytes: Uint8Array; mtime: number } | { kind: 'dir'; mtime: number }

/** One in-memory tree, shared by both fakes: keys are slash paths, '' the root. */
class Tree {
  entries = new Map<string, Entry>([['', { kind: 'dir', mtime: 1 }]])
  clock = 1_000

  parent(key: string): string {
    return key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : ''
  }
  makeParents(key: string): void {
    let dir = this.parent(key)
    const missing: string[] = []
    while (dir && !this.entries.has(dir)) { missing.push(dir); dir = this.parent(dir) }
    for (const name of missing) this.entries.set(name, { kind: 'dir', mtime: (this.clock += 1) })
  }
  write(key: string, bytes: Uint8Array): void {
    this.entries.set(key, { kind: 'file', bytes, mtime: (this.clock += 1) })
  }
  children(key: string): Array<[string, Entry]> {
    const prefix = key ? `${key}/` : ''
    return [...this.entries].filter(([path]) => path !== key && path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
  }
  inside(key: string): string[] {
    return [...this.entries.keys()].filter((path) => path.startsWith(`${key}/`))
  }
  move(from: string, to: string, keep: boolean): void {
    this.makeParents(to)
    for (const [path, entry] of [...this.entries]) {
      if (path !== from && !path.startsWith(`${from}/`)) continue
      this.entries.set(to + path.slice(from.length), entry.kind === 'file' ? { ...entry, bytes: entry.bytes.slice(), mtime: (this.clock += 1) } : entry)
      if (!keep) this.entries.delete(path)
    }
  }
}

const bytesOf = (data: string, utf8: boolean) => utf8 ? new TextEncoder().encode(data) : Uint8Array.from(Buffer.from(data, 'base64'))
const textOf = (bytes: Uint8Array, utf8: boolean) => utf8 ? new TextDecoder().decode(bytes) : Buffer.from(bytes).toString('base64')

const APP_FILES = 'file:///storage/emulated/0/Android/data/md.zennotes/files'

/** @capacitor/filesystem in Directory.External (app storage). */
class CapacitorFilesystem {
  tree = new Tree()
  outage = false

  private fail(path: string, notFound: boolean): never {
    if (notFound) throw Object.assign(new Error(`File does not exist: ${path}`), { code: 'OS-PLUG-FILE-0008' })
    throw Object.assign(new Error('The operation failed.'), { code: 'OS-PLUG-FILE-0013' })
  }
  private key(o: { path: string; directory?: string }): string {
    assert.equal(o.directory, 'EXTERNAL', 'the app-storage tier lives in Directory.External')
    if (this.outage) this.fail(o.path, false)
    return o.path.replace(/^\/+|\/+$/g, '')
  }
  private uri(key: string): string {
    return `${APP_FILES}/${key.split('/').map(encodeURIComponent).join('/')}`
  }
  async mkdir(o: { path: string; directory?: string }) {
    const key = this.key(o)
    if (this.tree.entries.has(key)) throw new Error('Directory exists')
    this.tree.makeParents(`${key}/x`)
  }
  async getUri(o: { path: string; directory?: string }) {
    return { uri: this.uri(this.key(o)) }
  }
  async readFile(o: { path: string; directory?: string; encoding?: string }) {
    const entry = this.tree.entries.get(this.key(o))
    if (!entry) this.fail(o.path, true)
    if (entry.kind !== 'file') this.fail(o.path, false)
    return { data: textOf(entry.bytes, Boolean(o.encoding)) }
  }
  async writeFile(o: { path: string; directory?: string; data: string; encoding?: string; recursive?: boolean }) {
    const key = this.key(o)
    if (o.recursive) this.tree.makeParents(key)
    else if (!this.tree.entries.has(this.tree.parent(key))) this.fail(o.path, false)
    this.tree.write(key, bytesOf(o.data, Boolean(o.encoding)))
    return { uri: this.uri(key) }
  }
  async stat(o: { path: string; directory?: string }) {
    const key = this.key(o)
    const entry = this.tree.entries.get(key)
    if (!entry) this.fail(o.path, true)
    return { type: entry.kind === 'dir' ? 'directory' : 'file', size: entry.kind === 'file' ? entry.bytes.length : 0, mtime: entry.mtime, ctime: entry.mtime, uri: this.uri(key) }
  }
  async readdir(o: { path: string; directory?: string }) {
    const key = this.key(o)
    const entry = this.tree.entries.get(key)
    if (!entry) this.fail(o.path, true)
    if (entry.kind !== 'dir') this.fail(o.path, false)
    const prefix = key ? `${key}/` : ''
    return {
      files: this.tree.children(key).map(([path, child]) => ({
        name: path.slice(prefix.length), type: child.kind === 'dir' ? 'directory' : 'file',
        size: child.kind === 'file' ? child.bytes.length : 0, mtime: child.mtime, uri: this.uri(path)
      }))
    }
  }
  async rename(o: { from: string; to: string; directory?: string; toDirectory?: string }) {
    const from = this.key({ path: o.from, directory: o.directory })
    const to = this.key({ path: o.to, directory: o.toDirectory })
    if (!this.tree.entries.has(from)) this.fail(o.from, true)
    this.tree.move(from, to, false)
  }
  async copy(o: { from: string; to: string; directory?: string; toDirectory?: string }) {
    const from = this.key({ path: o.from, directory: o.directory })
    const to = this.key({ path: o.to, directory: o.toDirectory })
    if (!this.tree.entries.has(from)) this.fail(o.from, true)
    this.tree.move(from, to, true)
  }
  async deleteFile(o: { path: string; directory?: string }) {
    const key = this.key(o)
    if (this.tree.entries.get(key)?.kind !== 'file') this.fail(o.path, true)
    this.tree.entries.delete(key)
  }
  async rmdir(o: { path: string; directory?: string; recursive?: boolean }) {
    const key = this.key(o)
    if (this.tree.entries.get(key)?.kind !== 'dir') this.fail(o.path, true)
    const inside = this.tree.inside(key)
    if (inside.length > 0 && !o.recursive) throw Object.assign(new Error('Folder is not empty.'), { code: 'OS-PLUG-FILE-0012' })
    for (const path of [key, ...inside]) this.tree.entries.delete(path)
  }
}

/** SafFsPlugin.java over picked folders, one tree per root URI. */
class SafFs {
  trees = new Map<string, Tree>()
  outage = false

  private tree(o: { root: string }): Tree {
    // A revoked grant or a provider that went away: SecurityException and
    // friends, which the plugin rejects with a message and no code.
    if (this.outage) throw new Error('readdir failed: Permission Denial: reading com.android.externalstorage requires that you obtain access')
    let tree = this.trees.get(o.root)
    if (!tree) this.trees.set(o.root, (tree = new Tree()))
    return tree
  }
  private notFound(rel: string): never {
    throw Object.assign(new Error(`File does not exist: ${rel}`), { code: 'ZN-SAF-NOT-FOUND' })
  }
  private uri(root: string, rel: string): string {
    const rootDocId = decodeURIComponent(root.split('/tree/')[1] ?? '')
    return `${root}/document/${encodeURIComponent(rel ? `${rootDocId}/${rel}` : rootDocId)}`
  }
  async readdir(o: { root: string; path: string }) {
    const tree = this.tree(o)
    const entry = tree.entries.get(o.path)
    if (entry?.kind !== 'dir') this.notFound(o.path)
    const prefix = o.path ? `${o.path}/` : ''
    return {
      files: tree.children(o.path).map(([path, child]) => ({
        name: path.slice(prefix.length), type: child.kind === 'dir' ? 'directory' : 'file',
        size: child.kind === 'file' ? child.bytes.length : 0, mtime: child.mtime, uri: this.uri(o.root, path)
      }))
    }
  }
  async stat(o: { root: string; path: string }) {
    const entry = this.tree(o).entries.get(o.path)
    if (!entry) this.notFound(o.path)
    return { type: entry.kind === 'dir' ? 'directory' : 'file', size: entry.kind === 'file' ? entry.bytes.length : 0, mtime: entry.mtime, uri: this.uri(o.root, o.path) }
  }
  private read(o: { root: string; path: string }, utf8: boolean) {
    const entry = this.tree(o).entries.get(o.path)
    if (!entry) this.notFound(o.path)
    if (entry.kind !== 'file') throw Object.assign(new Error(`Cannot read a directory: ${o.path}`), { code: 'ZN-SAF-IS-DIRECTORY' })
    return { data: textOf(entry.bytes, utf8) }
  }
  async readText(o: { root: string; path: string }) { return this.read(o, true) }
  async readBase64(o: { root: string; path: string }) { return this.read(o, false) }
  private write(o: { root: string; path: string; data: string }, utf8: boolean) {
    const tree = this.tree(o)
    if (tree.entries.get(o.path)?.kind === 'dir') throw new Error(`write failed: Is a folder: ${o.path}`)
    tree.makeParents(o.path)
    tree.write(o.path, bytesOf(o.data, utf8))
  }
  async writeText(o: { root: string; path: string; data: string }) { this.write(o, true) }
  async writeBase64(o: { root: string; path: string; data: string }) { this.write(o, false) }
  async mkdir(o: { root: string; path: string }) {
    const tree = this.tree(o)
    if (o.path && !tree.entries.has(o.path)) tree.makeParents(`${o.path}/x`)
  }
  async rename(o: { root: string; from: string; to: string }) {
    const tree = this.tree(o)
    if (!tree.entries.has(o.from)) throw new Error(`rename failed: ${o.from}`)
    tree.move(o.from, o.to, false)
  }
  async copy(o: { root: string; from: string; to: string }) {
    const tree = this.tree(o)
    if (!tree.entries.has(o.from)) throw new Error(`copy failed: ${o.from}`)
    tree.move(o.from, o.to, true)
  }
  // deleteDocument takes a folder with everything in it; a missing path is a
  // FileNotFoundException the plugin rejects without a code.
  async delete(o: { root: string; path: string }) {
    const tree = this.tree(o)
    if (!tree.entries.has(o.path)) throw new Error(`delete failed: ${o.path}`)
    for (const path of [o.path, ...tree.inside(o.path)]) tree.entries.delete(path)
  }
  async rmdirIfEmpty(o: { root: string; path: string }) {
    const tree = this.tree(o)
    const entry = tree.entries.get(o.path)
    if (!entry) throw new Error(`rmdirIfEmpty failed: ${o.path}`)
    if (entry.kind !== 'dir') throw new Error('rmdirIfEmpty failed: Not a folder')
    if (tree.inside(o.path).length > 0) throw new Error('rmdirIfEmpty failed: Folder is not empty')
    tree.entries.delete(o.path)
  }
}

const disk = new CapacitorFilesystem()
const saf = new SafFs()
const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
// vaultsRoot() reads the probed root from localStorage at module load.
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => 'external', setItem: () => {} } })
let api: Record<string, any>
try {
  api = await loadMobileModule(['./src/bridge/native-fs.ts', '@zennotes/portable-vault/vault-fs-contract', '@zennotes/portable-vault/vault'], {
    '@capacitor/filesystem': { Directory: { External: 'EXTERNAL', Data: 'DATA' }, Encoding: { UTF8: 'utf8' }, Filesystem: disk },
    '@capacitor/core': {
      Capacitor: { convertFileSrc: (uri: string) => uri },
      registerPlugin: (name: string) => (name === 'SafFs' ? saf : {})
    },
    './icloud': { ensureDownloaded: async () => 0 }
  })
} finally {
  if (storage) Object.defineProperty(globalThis, 'localStorage', storage)
  else Reflect.deleteProperty(globalThis, 'localStorage')
}
const { NativeFs, PortableVault, vaultFileSystemContract } = api

const pickedFolder = (name: string) => `content://com.android.externalstorage.documents/tree/${encodeURIComponent(`primary:Notes/${name}`)}`

const tiers = {
  'app storage': {
    create: (name: string) => new NativeFs(name),
    breakStorage: () => { disk.outage = true },
    restoreStorage: () => { disk.outage = false }
  },
  'a picked folder (SAF)': {
    create: (name: string) => new NativeFs(name, pickedFolder(name)),
    breakStorage: () => { saf.outage = true },
    restoreStorage: () => { saf.outage = false }
  }
}

let vaults = 0
for (const [tier, setup] of Object.entries(tiers)) {
  const harness = {
    async create() {
      const fs = setup.create(`Contract ${(vaults += 1)}`)
      await fs.init()
      return fs
    },
    async reopen(fs: { rootPath: string; cloudRootUri: string | null }) {
      const name = fs.rootPath.slice('ZenNotes/'.length)
      const again = fs.cloudRootUri ? new NativeFs(name, fs.cloudRootUri) : new NativeFs(name)
      await again.init()
      return again
    },
    breakStorage: setup.breakStorage,
    restoreStorage: setup.restoreStorage
  }
  for (const contract of vaultFileSystemContract as Array<{ name: string; run(h: typeof harness): Promise<void> }>) {
    test(`NativeFs on ${tier} keeps the VaultFileSystem contract: ${contract.name}`, () => contract.run(harness))
  }
}

test('NativeFs keys the Cloud link on the root URI it opened, as the vault did before the package', async () => {
  // The key an older build linked under (MobileVault.rootLabel): changing it
  // orphans every link, sync state and scan cache on the device.
  const local = new NativeFs('My Vault')
  assert.equal(local.syncKey, 'ZenNotes/My Vault', 'before init, the path')
  await local.init()
  assert.equal(local.syncKey, `${APP_FILES}/ZenNotes/My%20Vault`)
  assert.equal(local.rootLabel, local.syncKey)

  const picked = new NativeFs('Notes', pickedFolder('Notes'))
  await picked.init()
  assert.equal(picked.syncKey, pickedFolder('Notes'))
})

test('only a native not-found code reads as absence, never a message', () => {
  const fs = new NativeFs('Codes')
  assert.equal(fs.isNotFound(Object.assign(new Error('x'), { code: 'OS-PLUG-FILE-0008' })), true)
  assert.equal(fs.isNotFound(Object.assign(new Error('x'), { code: 'ZN-SAF-NOT-FOUND' })), true)
  assert.equal(fs.isNotFound(new Error('File does not exist')), false)
  assert.equal(fs.isNotFound(Object.assign(new Error('Folder is not empty.'), { code: 'OS-PLUG-FILE-0012' })), false)
})

test('deleting an attachment from a picked folder never strands it where Trash cannot see it', async () => {
  // The old vault-fs.ts moved the file into its Trash folder first and wrote
  // the record Trash lists it by second, so a failed write left it in a
  // folder the app ignores. The package writes the record first.
  const vault = new PortableVault('Trash order', new NativeFs('Trash order', pickedFolder('Trash order')))
  await vault.open()
  await vault.fs.writeBase64('assets/pic.png', 'iVBORw0KGgo=')
  const write = saf.writeText
  saf.writeText = async (o: { root: string; path: string; data: string }) => {
    if (o.path.endsWith('/.zn-deleted.json')) throw new Error('write failed: The provider refused the write')
    return write.call(saf, o)
  }
  try {
    await assert.rejects(vault.deleteAsset('assets/pic.png'), /refused/)
  } finally {
    saf.writeText = write
  }
  assert.equal(await vault.fs.readBase64('assets/pic.png'), 'iVBORw0KGgo=', 'the attachment stays where it was')
  assert.deepEqual(await vault.fs.readdir('.zennotes/deleted-assets'), [], 'no Trash folder is left without its record')

  const deleted = await vault.deleteAsset('assets/pic.png')
  assert.deepEqual((await vault.listDeletedAssets()).map((asset: { path: string }) => asset.path), ['assets/pic.png'])
  await vault.restoreDeletedAsset(deleted)
  assert.equal(await vault.fs.readBase64('assets/pic.png'), 'iVBORw0KGgo=')
})
