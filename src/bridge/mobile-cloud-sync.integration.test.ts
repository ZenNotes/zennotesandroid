import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import type {
  CloudSyncChange, CloudSyncContent, CloudSyncManifestItem, CloudSyncMutation
} from '@zennotes/bridge-contract/cloud-sync'
import type { CloudSyncState } from '@zennotes/shared-domain/cloud-sync-engine'
import { loadMobileModule } from '../../tooling/load-mobile-module.ts'
import { withoutRandomUUID } from '../../tooling/without-random-uuid.ts'

const { WELCOME_NOTE_BODY, WELCOME_NOTE_PATH, isUntouchedWelcomeSeed } = await loadMobileModule('./src/bridge/welcome-note')

const SEED_OF_2026_10_08 = `# Welcome to ZenNotes

This is your first note. It is yours: edit it, add to it, or delete it once you have found your feet.

## The circle

The small circle in the bottom corner is how you get around. Tap it:

- **New**: write a note
- **Search**: find anything, instantly
- **Browse**: your folders, tasks, and tags
- **More**: everything else, including Settings

## Try it now

- [ ] Tap this checkbox to tick it off
- [ ] Tap the circle, then **New**, and write down a thought
- [ ] Tap the circle, then **Browse**, to see your folders

## Just plain text

Every note is a plain Markdown file: **bold**, *italic*, lists, and checkboxes are all simple text. No database, no lock-in. Your notes stay readable anywhere, forever.

## Organize with tags and folders

Type \`#\` in any note to tag it, like #ideas on this one. Tags appear under **Browse → Tags** the moment you write them.

Folders work the way you expect: create one in **Browse → New folder**, and move any note with the circle → **More** → **Move to…**.

## Capture from anywhere

Reading something worth keeping? Share it from any app and choose **ZenNotes**. It lands in your notes, ready when you are.

## Where your notes live

You picked a home for your notes when you first opened the app. To move between **iCloud** and this device, or to keep several vaults and switch between them, tap the circle → **More** → **Settings** → **Vault**.

## When you want more

ZenNotes also does math, diagrams, tables, tasks with due dates, and daily notes. For a folder of example notes showing everything, tap the circle → **More** → **All commands…** and run **Generate demo tour**.

Happy writing.
`

function textContent(text: string): CloudSyncContent {
  return {
    encoding: 'utf8', data: text, byte_length: Buffer.byteLength(text),
    sha256: createHash('sha256').update(text).digest('hex'), media_type: 'text/markdown'
  }
}

/** Real mobile adapter -> host service -> coordinator -> cached repository.
 * Only Capacitor storage/auth/layout and the server boundary are fakes. */
async function fixture(
  initial: Record<string, string> = { 'note.md': 'Original' },
  mocks: Record<string, Record<string, unknown>> = {}
) {
  const persisted = new Map<string, string>()
  const files = new Map(Object.entries(initial).map(([path, data]) => [
    path, { bytes: Buffer.from(data), mtime: 1000 }
  ]))
  const remoteItems = new Map<string, CloudSyncManifestItem>()
  const revisions = new Map<string, CloudSyncManifestItem>()
  const feed: CloudSyncChange[] = []
  const reads: string[] = []
  const createdDirectories: string[] = []
  const refreshes: Record<string, string>[] = []
  const uploaded: CloudSyncMutation[] = []
  const manifestRequests: unknown[] = []
  let accountStatus = { state: 'connected', account: { base_url: 'https://sync.example.test' } }
  let cursor = 0
  let clock = 1000
  let failWritePath: string | null = null
  let beforeChanges: (() => void) | undefined

  const put = (path: string, bytes: string | Buffer) => {
    files.set(path, { bytes: Buffer.from(bytes), mtime: ++clock })
  }
  function remoteText(path: string, text: string) {
    const previous = [...remoteItems.values()].find((item) => item.path === path)
    const itemId = previous?.item_id ?? 'remote-' + path
    const content = textContent(text)
    const revision = (previous?.revision ?? 0) + 1
    const item: CloudSyncManifestItem = {
      item_id: itemId, path, kind: 'text', revision, content,
      sha256: content.sha256, byte_length: content.byte_length, media_type: content.media_type
    }
    remoteItems.set(itemId, item)
    revisions.set(itemId + ':' + revision, structuredClone(item))
    feed.push({
      sequence: ++cursor, item_id: itemId, type: 'upsert', path,
      previous_path: previous?.path ?? null, revision, content
    })
    return item
  }
  const remote = {
    listVaults: async () => ({ data: [{ id: 'vault-1', name: 'Test vault' }, { id: 'vault-2', name: 'Other vault' }] }),
    manifest: async (_vaultId: string, options?: unknown) => {
      manifestRequests.push(options)
      return { data: [...remoteItems.values()], cursor, next_page: null }
    },
    changes: async (_vaultId: string, after: number) => {
      beforeChanges?.()
      return { data: feed.filter((change) => change.sequence > after), cursor, has_more: false }
    },
    revision: async (_vaultId: string, itemId: string, revision: number) => {
      const item = revisions.get(itemId + ':' + revision)
      assert.ok(item)
      return { data: { ...item, deleted: false } }
    },
    mutate: async (_vaultId: string, request: { mutations: CloudSyncMutation[] }) => {
      uploaded.push(...JSON.parse(JSON.stringify(request.mutations)))
      const acknowledged = request.mutations.map((mutation) => {
        const previous = remoteItems.get(mutation.item_id)
        const revision = (previous?.revision ?? 0) + 1
        if (mutation.type === 'upsert') {
          const item: CloudSyncManifestItem = {
            item_id: mutation.item_id, path: mutation.path, kind: mutation.kind,
            revision, content: structuredClone(mutation.content),
            sha256: mutation.content.sha256, byte_length: mutation.content.byte_length,
            media_type: mutation.content.media_type
          }
          remoteItems.set(item.item_id, item)
          revisions.set(item.item_id + ':' + revision, structuredClone(item))
          feed.push({
            sequence: ++cursor, item_id: item.item_id, type: 'upsert', path: item.path,
            previous_path: previous?.path ?? null, revision, content: item.content
          })
        } else {
          assert.ok(previous)
          if (mutation.type === 'delete') remoteItems.delete(mutation.item_id)
          else remoteItems.set(mutation.item_id, { ...previous, path: mutation.path, revision })
          feed.push({
            sequence: ++cursor, item_id: mutation.item_id, type: mutation.type,
            path: mutation.type === 'move' ? mutation.path : previous.path,
            previous_path: previous.path, revision
          })
        }
        return { operation_id: mutation.operation_id, item_id: mutation.item_id, revision, sequence: cursor }
      })
      return { acknowledged, conflicts: [], cursor }
    }
  }
  const native = {
    rootPath: 'ZenNotes/Test',
    async readdirStrict(directory: string) {
      const entries = new Map<string, { name: string; type: 'file' | 'directory'; size: number; mtime: number }>()
      const prefix = directory ? directory + '/' : ''
      for (const [path, file] of files) {
        if (!path.startsWith(prefix)) continue
        const [name, nested] = path.slice(prefix.length).split('/')
        entries.set(name, {
          name, type: nested ? 'directory' : 'file',
          size: nested ? 0 : file.bytes.length, mtime: nested ? 1000 : file.mtime
        })
      }
      return [...entries.values()]
    },
    async statOrNull(path: string) {
      const file = files.get(path)
      return file ? { type: 'file' as const, mtime: file.mtime, size: file.bytes.length } : null
    },
    async statVerified(path: string) { return files.has(path) ? 'file' : null },
    async readBase64(path: string) {
      reads.push(path)
      const file = files.get(path)
      assert.ok(file)
      return file.bytes.toString('base64')
    },
    async readForSync(path: string, textCandidate: boolean) {
      reads.push(path)
      const file = files.get(path)
      assert.ok(file)
      return {
        uri: `file:///vault/${path}`, byteLength: file.bytes.length,
        sha256: createHash('sha256').update(file.bytes).digest('hex'), utf8: textCandidate,
        inlineBase64: file.bytes.toString('base64')
      }
    },
    async writeText(path: string, data: string) {
      put(path, data)
      if (path === failWritePath) throw new Error('Native write failed after writing')
    },
    async writeBase64(path: string, data: string) {
      put(path, Buffer.from(data, 'base64'))
      if (path === failWritePath) throw new Error('Native write failed after writing')
    },
    async deleteFile(path: string) { files.delete(path) },
    async mkdir(path: string) { createdDirectories.push(path) },
    async rename(from: string, to: string) {
      const file = files.get(from)
      assert.ok(file)
      files.set(to, file)
      files.delete(from)
      if (to === failWritePath) throw new Error('Native write failed after publishing')
    }
  }
  const vault = {
    rootLabel: 'ZenNotes/Test', fs: native,
    async rescan() {
      refreshes.push(Object.fromEntries([...files].map(([path, file]) => [path, file.bytes.toString()])))
    }
  }
  const api = await loadMobileModule('./src/bridge/mobile-cloud-sync', {
    '@capacitor/filesystem': {
      Directory: { Data: 'DATA', Cache: 'CACHE' }, Encoding: { UTF8: 'utf8' },
      Filesystem: {
        async readFile({ path }: { path: string }) {
          if (!persisted.has(path)) throw Object.assign(new Error('Missing'), { code: 'OS-PLUG-FILE-0008' })
          return { data: persisted.get(path)! }
        },
        async writeFile({ path, data }: { path: string; data: string }) { persisted.set(path, data) },
        async deleteFile({ path }: { path: string }) { persisted.delete(path) }
      }
    },
    '@capacitor/share': { Share: {} },
    './vault-fs': { MobileVault: class {} },
    './cloud-layout': { reconcileLayoutForCloudJoin: async () => {} },
    './mobile-cloud-auth': {
      authenticatedCredential: async () => ({ base_url: 'https://sync.example.test', token: 'test-only' }),
      authenticatedClient: async () => remote,
      getMobileCloudAccountStatus: async () => accountStatus
    },
    ...mocks
  })
  await api.linkMobileCloudVault(vault, 'vault-1')
  const stateKey = () => [...persisted.keys()].find((path) => path.includes('/states/'))
  return {
    api, vault, files, reads, uploaded, refreshes, remoteText, put, manifestRequests, remote, persisted, createdDirectories,
    setAccountStatus: (value: typeof accountStatus) => { accountStatus = value },
    sync: () => api.syncMobileCloudVault(vault),
    setFailWrite: (path: string | null) => { failWritePath = path },
    setBeforeChanges: (callback: typeof beforeChanges) => { beforeChanges = callback },
    clearState: () => { const key = stateKey(); if (key) persisted.delete(key) },
    get state(): CloudSyncState {
      const key = stateKey()
      assert.ok(key)
      return JSON.parse(persisted.get(key)!)
    },
    set state(value: CloudSyncState) {
      const key = stateKey()
      assert.ok(key)
      persisted.set(key, JSON.stringify(value))
    }
  }
}

describe('mobile Cloud adapter wiring', () => {
  for (const [path, directories] of [
    ['Welcome.md', []],
    ['notes/Welcome.md', ['notes']]
  ] as const) {
    it(`creates only actual parent directories when pulling ${path}`, async () => {
      const h = await fixture({})
      h.remoteText(path, 'Content from desktop')
      await h.sync()
      assert.equal(h.files.get(path)?.bytes.toString(), 'Content from desktop')
      assert.deepEqual(h.createdDirectories, directories)
    })
  }

  it('makes each folder once per sync however many pulled files land in it', async () => {
    const h = await fixture({})
    for (const path of ['notes/a.md', 'notes/b.md', 'notes/deeper/c.md', 'notes/d.md', 'top.md']) {
      h.remoteText(path, `Content of ${path}`)
    }
    await h.sync()
    assert.deepEqual([...h.files.keys()].sort(), ['notes/a.md', 'notes/b.md', 'notes/d.md', 'notes/deeper/c.md', 'top.md'])
    assert.deepEqual(h.createdDirectories, ['notes', 'notes/deeper'])
    // A folder removed between syncs comes back: each sync asks again. The
    // edit's original moves aside into .zennotes/sync before the new bytes land.
    h.createdDirectories.length = 0
    h.remoteText('notes/e.md', 'Fifth note')
    h.remoteText('notes/b.md', 'Edited on desktop')
    await h.sync()
    assert.deepEqual(h.createdDirectories, ['notes', '.zennotes/sync'])
    assert.equal(h.files.get('notes/b.md')?.bytes.toString(), 'Edited on desktop')
  })

  it('detects remote changes from a one-item metadata manifest without scanning local files', async () => {
    const h = await fixture()
    assert.equal(await h.api.hasMobileCloudVaultChanges(h.vault), true)
    assert.deepEqual(h.manifestRequests, [])
    await h.sync()
    h.manifestRequests.length = 0
    h.reads.length = 0
    h.refreshes.length = 0
    assert.equal(await h.api.hasMobileCloudVaultChanges(h.vault), false)
    h.remoteText('note.md', 'Incoming edit')
    assert.equal(await h.api.hasMobileCloudVaultChanges(h.vault), true)
    assert.deepEqual(h.manifestRequests, [
      { includeContent: false, perPage: 1 }, { includeContent: false, perPage: 1 }
    ])
    assert.deepEqual(h.reads, [])
    assert.deepEqual(h.refreshes, [])
    await h.sync()
    assert.equal(await h.api.hasMobileCloudVaultChanges(h.vault), false)
  })

  it('does not probe an unlinked, disconnected, or different-origin account', async () => {
    const h = await fixture()
    await h.sync()
    h.manifestRequests.length = 0
    h.setAccountStatus({ state: 'disconnected', account: { base_url: 'https://sync.example.test' } })
    assert.equal(await h.api.hasMobileCloudVaultChanges(h.vault), false)
    h.setAccountStatus({ state: 'connected', account: { base_url: 'https://another.example.test' } })
    assert.equal(await h.api.hasMobileCloudVaultChanges(h.vault), false)
    await h.api.unlinkMobileCloudVault(h.vault)
    assert.equal(await h.api.hasMobileCloudVaultChanges(h.vault), false)
    assert.deepEqual(h.manifestRequests, [])
  })

  it('does not rescan the vault or reread acknowledged bytes during a no-op sync', async () => {
    const h = await fixture()
    await h.sync()
    h.refreshes.length = 0
    h.reads.length = 0
    const summary = await h.sync()
    assert.equal(summary.pushed, 0)
    assert.equal(summary.pulled, 0)
    assert.deepEqual(h.refreshes, [])
    assert.deepEqual(h.reads, [])
  })

  it('resynchronizes UI state once after a whole batch of pulled files', async () => {
    const h = await fixture()
    await h.sync()
    h.refreshes.length = 0
    h.remoteText('note.md', 'Remote update')
    h.remoteText('second.md', 'Second note')
    h.remoteText('folder/third.md', 'Third note')
    const summary = await h.sync()
    assert.equal(summary.pulled, 3)
    assert.equal(h.refreshes.length, 1)
    assert.deepEqual(h.refreshes[0], {
      'note.md': 'Remote update', 'second.md': 'Second note', 'folder/third.md': 'Third note'
    })
    h.refreshes.length = 0
    await h.sync()
    assert.deepEqual(h.refreshes, [])
  })

  it('refreshes a newly discovered local edit even when nothing is downloaded', async () => {
    const h = await fixture()
    await h.sync()
    h.refreshes.length = 0
    h.put('note.md', 'Local changes')
    const summary = await h.sync()
    assert.equal(summary.pulled, 0)
    assert.equal(summary.pushed, 1)
    assert.deepEqual(h.refreshes, [{ 'note.md': 'Local changes' }])
    const uploaded = h.uploaded.at(-1)
    assert.equal(uploaded?.type, 'upsert')
    if (uploaded?.type === 'upsert') assert.equal(uploaded.content.data, 'Local changes')
  })

  it('rolls back a partial native publish while preserving earlier completed pulls', async () => {
    const h = await fixture()
    await h.sync()
    h.refreshes.length = 0
    h.remoteText('note.md', 'Remote update')
    h.remoteText('second.md', 'Partially written')
    h.setFailWrite('second.md')
    await assert.rejects(h.sync(), /Native write failed/)
    assert.deepEqual(h.refreshes, [{ 'note.md': 'Remote update' }])
    assert.equal(h.files.has('second.md'), false)
    h.setFailWrite(null)
    await h.sync()
    assert.equal(h.files.get('note.md')?.bytes.toString(), 'Remote update')
    assert.equal(h.files.get('second.md')?.bytes.toString(), 'Partially written')
  })

  it('keeps a conflicting local edit visible when a remote version arrives', async () => {
    const h = await fixture()
    await h.sync()
    h.refreshes.length = 0
    h.remoteText('note.md', 'Cloud replacement')
    h.setBeforeChanges(() => {
      h.setBeforeChanges(undefined)
      h.put('note.md', 'Local replacement')
    })
    const summary = await h.sync()
    assert.equal(summary.pending_conflicts.length, 1)
    assert.equal(h.files.get('note.md')?.bytes.toString(), 'Local replacement')
    assert.equal(h.refreshes.at(-1)?.['note.md'], 'Local replacement')
    const details = await h.api.getMobileCloudConflict(h.vault, summary.pending_conflicts[0].id)
    assert.equal(details.local.text, 'Local replacement')
    assert.equal(details.cloud.text, 'Cloud replacement')
  })

  it('loads full pending-conflict review bytes despite an acknowledged warm scan cache', async () => {
    const h = await fixture()
    await h.sync()
    const state = h.state
    const [item] = Object.values(state.items)
    state.pending_conflicts = {
      [item.item_id]: {
        id: item.item_id, item_id: item.item_id, kind: 'content', sequence: 2,
        base: { path: item.path, revision: 1, kind: 'text', content: textContent('Base') },
        local: { path: item.path, revision: null, kind: 'text', content: textContent('Original') },
        cloud: { path: item.path, revision: 2, kind: 'text', content: textContent('Cloud replacement') }
      }
    }
    h.state = state
    h.reads.length = 0
    const details = await h.api.getMobileCloudConflict(h.vault, item.item_id)
    assert.equal(details.local.text, 'Original')
    assert.equal(details.cloud.text, 'Cloud replacement')
    assert.deepEqual(h.reads, ['note.md'])
  })

  it('loads full bootstrap review bytes when old scan cache survives a lost sync state', async () => {
    const h = await fixture()
    await h.sync()
    const cloud = h.remoteText('note.md', 'Cloud replacement')
    h.clearState()
    h.reads.length = 0
    const details = await h.api.getMobileCloudBootstrapConflict(h.vault, {
      code: 'BOOTSTRAP_CONTENT_CONFLICT', item_id: cloud.item_id, path: cloud.path,
      local_sha256: textContent('Original').sha256, remote_sha256: cloud.sha256
    })
    assert.equal(details.local.text, 'Original')
    assert.equal(details.cloud.text, 'Cloud replacement')
    assert.deepEqual(h.reads, ['note.md'])
  })
})


describe('a Welcome note on the first Cloud link', () => {
  const edited = () => WELCOME_NOTE_BODY.replace('- [ ]', '- [x]')
  const paths = (mutations: CloudSyncMutation[]) => mutations.map((mutation) => 'path' in mutation ? mutation.path : mutation.type)

  it('gives an untouched seed up to the Cloud copy, and leaves that copy alone', async () => {
    const h = await fixture({ [WELCOME_NOTE_PATH]: WELCOME_NOTE_BODY, 'note.md': 'Mine' })
    const cloud = h.remoteText(WELCOME_NOTE_PATH, 'An older seed from another phone')
    const summary = await h.sync()
    assert.deepEqual(summary.pending_conflicts, [])
    assert.equal(h.files.get(WELCOME_NOTE_PATH)?.bytes.toString(), 'An older seed from another phone')
    assert.deepEqual(paths(h.uploaded), ['note.md'])
    assert.equal((await h.remote.manifest('vault-1')).data.find((item) => item.path === WELCOME_NOTE_PATH)?.revision, cloud.revision)

    h.uploaded.length = 0
    const again = await h.sync()
    assert.deepEqual(again.pending_conflicts, [])
    assert.deepEqual(h.uploaded, [])
  })

  it('gives up a seed an older version of the app wrote', async () => {
    const h = await fixture({ [WELCOME_NOTE_PATH]: SEED_OF_2026_10_08 })
    h.remoteText(WELCOME_NOTE_PATH, 'Written on another device')
    assert.deepEqual((await h.sync()).pending_conflicts, [])
    assert.equal(h.files.get(WELCOME_NOTE_PATH)?.bytes.toString(), 'Written on another device')
    assert.deepEqual(h.uploaded, [])
  })

  it('gives up a seed that a Cloud join moved to the vault root', async () => {
    const h = await fixture({ 'Welcome to ZenNotes.md': WELCOME_NOTE_BODY })
    h.remoteText('Welcome to ZenNotes.md', 'Written on another device')
    assert.deepEqual((await h.sync()).pending_conflicts, [])
    assert.equal(h.files.get('Welcome to ZenNotes.md')?.bytes.toString(), 'Written on another device')
    assert.deepEqual(h.uploaded, [])
  })

  it('still raises a conflict for a note the person edited, keeping both versions', async () => {
    const h = await fixture({ [WELCOME_NOTE_PATH]: edited() })
    h.remoteText(WELCOME_NOTE_PATH, 'An older seed from another phone')
    const summary = await h.sync()
    assert.deepEqual(summary.pending_conflicts.map((conflict: { path: string }) => conflict.path), [WELCOME_NOTE_PATH])
    assert.equal(h.files.get(WELCOME_NOTE_PATH)?.bytes.toString(), edited())
    assert.deepEqual(h.uploaded, [])
    const details = await h.api.getMobileCloudConflict(h.vault, summary.pending_conflicts[0].id)
    assert.equal(details.local.text, edited())
    assert.equal(details.cloud.text, 'An older seed from another phone')
  })

  it('still raises a conflict when the person edits the seed during the first sync', async () => {
    const h = await fixture({ [WELCOME_NOTE_PATH]: WELCOME_NOTE_BODY })
    h.remoteText(WELCOME_NOTE_PATH, 'An older seed from another phone')
    const read = h.vault.fs.readForSync
    h.vault.fs.readForSync = async (path: string, textCandidate: boolean) => {
      const file = await read(path, textCandidate)
      // The scan has its bytes; the edit lands before the Cloud copy arrives.
      if (path === WELCOME_NOTE_PATH) {
        h.vault.fs.readForSync = read
        h.put(path, edited())
      }
      return file
    }
    const summary = await h.sync()
    assert.deepEqual(summary.pending_conflicts.map((conflict: { path: string }) => conflict.path), [WELCOME_NOTE_PATH])
    assert.equal(h.files.get(WELCOME_NOTE_PATH)?.bytes.toString(), edited())
  })

  it('leaves a seed Cloud has no copy of to go up as a new note, and never as a deletion', async () => {
    const h = await fixture({ [WELCOME_NOTE_PATH]: WELCOME_NOTE_BODY })
    const summary = await h.sync()
    assert.deepEqual(summary.pending_conflicts, [])
    assert.deepEqual(h.uploaded.map((mutation) => mutation.type), ['upsert'])
    assert.deepEqual(paths(h.uploaded), [WELCOME_NOTE_PATH])
    assert.equal(h.files.get(WELCOME_NOTE_PATH)?.bytes.toString(), WELCOME_NOTE_BODY)

    h.uploaded.length = 0
    await h.sync()
    assert.deepEqual(h.uploaded, [])
  })

  it('treats an untouched seed like any other note once the vault has synced', async () => {
    const h = await fixture({ [WELCOME_NOTE_PATH]: WELCOME_NOTE_BODY })
    await h.sync()
    h.uploaded.length = 0
    h.remoteText(WELCOME_NOTE_PATH, 'Updated on another device')
    assert.deepEqual((await h.sync()).pending_conflicts, [])
    assert.equal(h.files.get(WELCOME_NOTE_PATH)?.bytes.toString(), 'Updated on another device')
    assert.deepEqual(h.uploaded, [])
  })

  it('lists the text this version seeds, so a rewrite cannot forget its hash', () => {
    const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
    assert.equal(isUntouchedWelcomeSeed(WELCOME_NOTE_PATH, sha256(WELCOME_NOTE_BODY)), true)
    assert.equal(isUntouchedWelcomeSeed(WELCOME_NOTE_PATH, sha256(edited())), false)
    assert.equal(isUntouchedWelcomeSeed('inbox/Copy.md', sha256(WELCOME_NOTE_BODY)), false)
  })
})

describe('deleted Cloud vault recovery (#791)', () => {
  const serviceError = (status: number, code: string | null) => Object.assign(
    new Error('ZenNotes Cloud request failed'), { name: 'CloudServiceRequestError', status, code }
  )
  const missing = () => serviceError(404, 'NOT_FOUND')

  it('clears only the missing Cloud association and state while preserving local bytes and another link', async () => {
    const h = await fixture({})
    await h.sync()
    const ownStateKey = [...h.persisted.keys()].find((path) => path.includes('/states/'))!
    const otherVault = { ...h.vault, rootLabel: 'ZenNotes/Other', fs: { ...h.vault.fs, rootPath: 'ZenNotes/Other' } }
    const otherLink = await h.api.linkMobileCloudVault(otherVault, 'vault-2')
    await h.api.syncMobileCloudVault(otherVault)
    const otherStateKey = [...h.persisted.keys()].find((path) => path.includes('/states/') && path !== ownStateKey)!
    const otherState = h.persisted.get(otherStateKey)
    const note = '---\ntitle: Keep me\n---\r\nUnsent local edit 📝\r\n'
    h.put('note.md', note)
    h.remote.changes = async () => { throw missing() }
    h.remote.manifest = async () => { throw missing() }

    await assert.rejects(h.sync())

    assert.equal(await h.api.getMobileCloudVaultLink(h.vault), null)
    assert.equal(h.persisted.has(ownStateKey), false)
    assert.equal(h.files.get('note.md')?.bytes.toString(), note)
    assert.deepEqual(await h.api.getMobileCloudVaultLink(otherVault), otherLink)
    assert.equal(h.persisted.get(otherStateKey), otherState)
  })

  it('archives a missing vault\'s state on a WebView without crypto.randomUUID', async () => {
    const h = await fixture({})
    await h.sync()
    h.remote.changes = async () => { throw missing() }
    h.remote.manifest = async () => { throw missing() }

    await withoutRandomUUID(() => assert.rejects(h.sync()))

    assert.equal(await h.api.getMobileCloudVaultLink(h.vault), null)
    assert.ok([...h.persisted.keys()].some((path) => /\/retired-states\/.+\.[0-9a-f-]{36}\.json$/.test(path)))
  })

  it('preserves complete conflict drafts in unique inactive state archives when a Cloud vault disappears', async () => {
    const h = await fixture({ 'note.md': 'local version' })
    h.remoteText('note.md', 'cloud version')
    const savedChanges = h.remote.changes
    const savedManifest = h.remote.manifest
    const snapshots: string[] = []
    const draft = 'Unsent merge draft\r\nKeep every byte 📝\r\n'
    for (let attempt = 1; attempt <= 2; attempt++) {
      h.remote.changes = savedChanges
      h.remote.manifest = savedManifest
      if (attempt > 1) await h.api.linkMobileCloudVault(h.vault, 'vault-1')
      const conflict = (await h.sync()).pending_conflicts[0]
      assert.ok(conflict)
      await h.api.saveMobileCloudConflictDraft(h.vault, conflict.id, `${draft}${attempt}`)
      const stateKey = [...h.persisted.keys()].find((path) => path.includes('/states/'))!
      snapshots.push(h.persisted.get(stateKey)!)
      h.remote.changes = async () => { throw missing() }
      h.remote.manifest = async () => { throw missing() }

      await assert.rejects(h.sync())

      assert.equal(h.persisted.has(stateKey), false)
      assert.equal(await h.api.getMobileCloudVaultLink(h.vault), null)
    }
    const archived = [...h.persisted.entries()].filter(([path]) => !path.includes('/states/'))
    for (const snapshot of snapshots) {
      assert.equal(archived.filter(([, value]) => value === snapshot).length, 1)
    }
    assert.equal(h.files.get('note.md')?.bytes.toString(), 'local version')
  })

  it('retires the deleted link when a background metadata probe discovers it', async () => {
    const h = await fixture({})
    await h.sync()
    h.remote.manifest = async () => { throw missing() }

    await h.api.hasMobileCloudVaultChanges(h.vault).catch(() => undefined)

    assert.equal(await h.api.getMobileCloudVaultLink(h.vault), null)
    assert.equal(await h.api.hasMobileCloudVaultChanges(h.vault), false)
  })

  for (const [label, failure] of [
    ['offline', new Error('Network unavailable')],
    ['unauthenticated', serviceError(401, 'UNAUTHENTICATED')],
    ['forbidden', serviceError(403, 'FORBIDDEN')],
    ['server failure', serviceError(503, null)],
    ['unstructured proxy 404', serviceError(404, null)]
  ] as const) {
    it(`preserves the link and cursor after ${label}`, async () => {
      const h = await fixture({})
      await h.sync()
      const link = await h.api.getMobileCloudVaultLink(h.vault)
      const state = structuredClone(h.state)
      h.remote.changes = async () => { throw failure }
      h.remote.manifest = async () => { throw failure }

      await assert.rejects(h.sync())
      await h.api.hasMobileCloudVaultChanges(h.vault).catch(() => undefined)

      assert.deepEqual(await h.api.getMobileCloudVaultLink(h.vault), link)
      assert.deepEqual(h.state, state)
    })
  }

  it('retains the link when a missing mutation resource belongs to an existing vault', async () => {
    const h = await fixture({})
    await h.sync()
    const link = await h.api.getMobileCloudVaultLink(h.vault)
    h.put('note.md', 'Local note still exists')
    h.remote.mutate = async () => { throw missing() }

    await assert.rejects(h.sync())

    assert.deepEqual(await h.api.getMobileCloudVaultLink(h.vault), link)
    assert.equal(h.files.get('note.md')?.bytes.toString(), 'Local note still exists')
  })

  it('keeps the association when confirmation cannot reach an authenticated vault endpoint', async () => {
    const h = await fixture({})
    await h.sync()
    const link = await h.api.getMobileCloudVaultLink(h.vault)
    h.remote.changes = async () => { throw missing() }
    h.remote.manifest = async () => { throw serviceError(401, 'UNAUTHENTICATED') }

    await assert.rejects(h.sync())

    assert.deepEqual(await h.api.getMobileCloudVaultLink(h.vault), link)
  })

  it('preserves a newer association when an older sync reports a deleted vault', async () => {
    const h = await fixture({})
    await h.sync()
    let begin!: () => void
    let fail!: (error: Error) => void
    const started = new Promise<void>((resolve) => { begin = resolve })
    h.remote.changes = async () => {
      begin()
      return await new Promise<never>((_resolve, reject) => { fail = reject })
    }
    h.remote.manifest = async () => { throw missing() }
    const rejected = assert.rejects(h.sync())
    await started
    const replacement = await h.api.linkMobileCloudVault(h.vault, 'vault-2')
    fail(missing())
    await rejected

    assert.deepEqual(await h.api.getMobileCloudVaultLink(h.vault), replacement)
  })
})

describe('end-to-end encrypted vaults', () => {
  const encryptedVaults = (encrypted: Set<string>, created: string[] = []) => ({
    './mobile-cloud-encryption': {
      ENCRYPTED_VAULT_BACKUP_DOWNLOAD_MESSAGE: 'Download backups of encrypted vaults from the ZenNotes desktop app.',
      assertMobileCloudVaultCanLink: async () => {},
      createMobileEncryptedCloudVault: async (name: string) => { created.push(name); return 'vault-2' },
      isMobileCloudVaultEncrypted: async (vaultId: string) => encrypted.has(vaultId)
    }
  })

  it('never saves an encrypted vault\'s backup archive and keeps its backups unlabeled', async () => {
    const encrypted = new Set(['vault-1'])
    const h = await fixture({}, encryptedVaults(encrypted))
    const labels: (string | undefined)[] = []
    Object.assign(h.remote, {
      createBackup: async (_vaultId: string, label?: string) => { labels.push(label); return { data: { id: 'backup-2' } } }
    })
    await assert.rejects(h.api.downloadMobileCloudBackup(h.vault, 'backup-1'),
      /^Error: Download backups of encrypted vaults from the ZenNotes desktop app\.$/)
    await h.api.createMobileCloudBackup(h.vault, 'Before the trip')
    encrypted.clear()
    await h.api.createMobileCloudBackup(h.vault, 'Before the trip')
    assert.deepEqual(labels, [undefined, 'Before the trip'])
  })

  it('creates an encrypted vault through the encryption layer and links this vault to it', async () => {
    const created: string[] = []
    const h = await fixture({}, encryptedVaults(new Set(), created))
    const link = await h.api.createAndLinkMobileCloudVault(h.vault, 'Journal', { encrypted: true })
    assert.deepEqual(created, ['Journal'])
    assert.equal(link.vault_id, 'vault-2')
    assert.deepEqual(await h.api.getMobileCloudVaultLink(h.vault), link)
  })
})
