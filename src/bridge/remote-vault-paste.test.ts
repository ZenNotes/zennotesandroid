import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadMobileModule } from '../../tooling/load-mobile-module.ts'

async function paste(mimeType: string, suggestedName?: string) {
  const uploads: Array<{ name: string; data: string; directory: string }> = []
  const changes: unknown[] = []
  const { RemoteVault } = await loadMobileModule('./src/bridge/remote-vault.ts', {
    './events': { emitVaultChange: (event: unknown) => changes.push(event) }
  })
  const vault = new RemoteVault({
    async uploadAsset(name: string, data: string, directory: string) {
      uploads.push({ name, data, directory })
      return { name, path: `${directory}/${name}` }
    }
  }, null, 'paste-test')
  const result = await vault.importPastedImage({
    mimeType, suggestedName, data: new Uint8Array([1, 2, 3])
  })
  return { result, uploads, changes }
}

test('remote keyboard WebP paste preserves its format and vault asset path', async () => {
  const { result, uploads, changes } = await paste('image/webp')
  assert.match(uploads[0].name, /^Pasted Image .*\.webp$/)
  assert.equal(uploads[0].data, 'AQID')
  assert.equal(uploads[0].directory, 'assets')
  assert.equal(result.markdown, `![[assets/${uploads[0].name}]]`)
  assert.equal(result.kind, 'image')
  assert.deepEqual(changes, [{
    kind: 'add', path: result.path, folder: 'inbox', scope: 'content'
  }])
})

test('remote pasted-image names cannot introduce paths or break the embed', async () => {
  const { result, uploads } = await paste('image/webp', '../picture [draft].webp')
  assert.equal(uploads[0].name, 'picture -draft-.webp')
  assert.equal(result.markdown, '![[assets/picture -draft-.webp]]')
})

test('remote paste retains PNG, JPEG and GIF extensions', async () => {
  for (const [mime, extension] of [
    ['image/png', '.png'], ['image/jpeg', '.jpg'], ['image/gif', '.gif']
  ]) {
    const { uploads } = await paste(mime, 'clipboard')
    assert.equal(uploads[0].name, `clipboard${extension}`)
  }
})
