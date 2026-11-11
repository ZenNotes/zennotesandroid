/**
 * Opening a vault attachment with another app: the bridge contract's
 * `openAssetExternally`, which this shell left unimplemented, so a tap on an
 * attachment chip ended in an error toast.
 *
 * Android hands a file over with a VIEW intent (OpenFilePlugin.java), to the
 * app the user keeps for its type. The WebView has no PDF viewer, so this is
 * also the only way a PDF shows at all: app-core sends a PDF here instead of
 * drawing an empty frame wherever `navigator.pdfViewerEnabled` is false (Dave,
 * Discord, 2026-10-27).
 *
 * A remote vault's asset exists only on the server, so it is copied into a
 * fresh cache directory first, as the iPhone shell does: fresh each time, so
 * opening it again never overwrites the copy a viewer still has on screen.
 */
import { registerPlugin } from '@capacitor/core'
import { Directory, Filesystem } from '@capacitor/filesystem'
import { RemoteVault } from '@zennotes/portable-vault/remote-vault'
import { randomUUID } from '@zennotes/portable-vault/uuid'
import type { PortableVault } from '@zennotes/portable-vault/vault'
import { resolveSafeRel } from '@zennotes/portable-vault/vault-core'
import type { NativeFs } from './native-fs'

interface OpenFilePlugin {
  open(options: { uri: string }): Promise<void>
}

const OpenFile = registerPlugin<OpenFilePlugin>('OpenFile')

/** Cache subtree holding copies staged out of a remote vault. */
const OPEN_CACHE_DIR = 'open-asset'

export async function openAssetExternally(
  vault: PortableVault | RemoteVault,
  relPath: string
): Promise<{ ok: boolean; error?: string }> {
  let rel: string
  try {
    rel = resolveSafeRel(relPath)
  } catch {
    return { ok: false, error: 'That attachment path is not inside this vault.' }
  }
  try {
    const uri =
      vault instanceof RemoteVault ? await stageRemoteAsset(vault, rel) : await localAssetUri(vault as PortableVault<NativeFs>, rel)
    if (!uri) return { ok: false, error: 'The attachment is missing from this vault.' }
    await OpenFile.open({ uri })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

async function localAssetUri(vault: PortableVault<NativeFs>, rel: string): Promise<string | null> {
  if (!(await vault.fs.statOrNull(rel))) return null
  return await vault.fs.fileUri(rel)
}

async function stageRemoteAsset(vault: RemoteVault, rel: string): Promise<string> {
  const { base64 } = await vault.client.fetchAssetBase64(rel)
  const name = rel.split('/').pop() || 'attachment'
  const dir = `${OPEN_CACHE_DIR}/${randomUUID()}`
  await Filesystem.mkdir({ path: dir, directory: Directory.Cache, recursive: true }).catch(() => {})
  const path = `${dir}/${name}`
  await Filesystem.writeFile({ path, directory: Directory.Cache, data: base64 })
  const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache })
  return uri
}
