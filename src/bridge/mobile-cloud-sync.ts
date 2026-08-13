import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'
import type {
  CloudBackupNoteRestoreResult,
  CloudBackupRestoreResult,
  CloudBackupSchedule,
  CloudBackupSnapshot,
  CloudBackupSnapshotItem,
  CloudSyncRunSummary,
  CloudVaultLink
} from '@zennotes/bridge-contract/cloud-sync'
import {
  CloudSyncHostService,
  type CloudSyncHostPersistence,
  type CloudSyncHostVault
} from '@zennotes/shared-domain/cloud-sync-host-service'
import {
  PortableCloudSyncRepository,
  type PortableCloudSyncFileSystem
} from '@zennotes/shared-domain/cloud-sync-portable-filesystem'
import type { CloudSyncState } from '@zennotes/shared-domain/cloud-sync-engine'
import { MobileVault } from './vault-fs'
import {
  authenticatedCredential,
  authenticatedClient,
  getMobileCloudAccountStatus
} from './mobile-cloud-auth'
import { emitVaultChange } from './events'

const STORAGE_ROOT = 'zennotes-cloud-sync'

const persistence: CloudSyncHostPersistence = {
  async loadLink(vaultKey: string): Promise<unknown> {
    return readJson(await linkPath(vaultKey))
  },
  async saveLink(vaultKey: string, link: CloudVaultLink): Promise<void> {
    await writeJson(await linkPath(vaultKey), link)
  },
  async deleteLink(vaultKey: string): Promise<void> {
    await deleteDataFile(await linkPath(vaultKey))
  },
  async loadState(vaultKey: string, baseUrl: string, vaultId: string): Promise<unknown> {
    return readJson(await statePath(vaultKey, baseUrl, vaultId))
  },
  async saveState(vaultKey: string, baseUrl: string, state: CloudSyncState): Promise<void> {
    await writeJson(await statePath(vaultKey, baseUrl, state.vault_id), state)
  }
}

const service = new CloudSyncHostService({
  persistence,
  accountStatus: getMobileCloudAccountStatus,
  createClient: authenticatedClient
})

export async function getMobileCloudVaultLink(vault: MobileVault): Promise<CloudVaultLink | null> {
  return service.linkedVault(hostVault(vault))
}

export async function linkMobileCloudVault(
  vault: MobileVault,
  vaultId: string
): Promise<CloudVaultLink> {
  return service.link(hostVault(vault), vaultId)
}

export async function createAndLinkMobileCloudVault(
  vault: MobileVault,
  name: string
): Promise<CloudVaultLink> {
  return service.createAndLink(hostVault(vault), name)
}

export async function unlinkMobileCloudVault(vault: MobileVault): Promise<void> {
  await service.unlink(hostVault(vault))
}

export async function syncMobileCloudVault(vault: MobileVault): Promise<CloudSyncRunSummary> {
  const summary = await service.sync(hostVault(vault))

  if (summary.pulled > 0) {
    emitVaultChange({ kind: 'change', path: '', folder: 'inbox', scope: 'resync' })
  }

  return summary
}

export async function listMobileCloudBackups(vault: MobileVault): Promise<CloudBackupSnapshot[]> {
  return service.listBackups(hostVault(vault))
}

export async function getMobileCloudBackupSchedule(
  vault: MobileVault
): Promise<CloudBackupSchedule> {
  return service.backupSchedule(hostVault(vault))
}

export async function updateMobileCloudBackupSchedule(
  vault: MobileVault,
  enabled: boolean
): Promise<CloudBackupSchedule> {
  return service.updateBackupSchedule(hostVault(vault), enabled)
}

export async function listMobileCloudBackupItems(
  vault: MobileVault,
  backupId: string
): Promise<CloudBackupSnapshotItem[]> {
  return service.listBackupItems(hostVault(vault), backupId)
}

export async function createMobileCloudBackup(
  vault: MobileVault,
  label?: string
): Promise<CloudBackupSnapshot> {
  return service.createBackup(hostVault(vault), label)
}

export async function deleteMobileCloudBackup(
  vault: MobileVault,
  backupId: string
): Promise<void> {
  await service.deleteBackup(hostVault(vault), backupId)
}

export async function downloadMobileCloudBackup(
  vault: MobileVault,
  backupId: string
): Promise<void> {
  const link = await service.linkedVault(hostVault(vault))
  if (!link) throw new Error('Link this local vault to a ZenNotes Cloud vault first.')
  const credential = await authenticatedCredential()
  if (link.base_url !== credential.base_url) {
    throw new Error('This vault is linked to a different ZenNotes Cloud account.')
  }

  const safeBackupId = backupId.replace(/[^a-zA-Z0-9-]/g, '')
  if (!safeBackupId) throw new Error('That backup identifier is invalid.')
  const path = `zennotes-cloud-backups/${crypto.randomUUID()}/zennotes-backup-${safeBackupId}.json.gz`
  const url = `${credential.base_url}/api/v1/vaults/${encodeURIComponent(link.vault_id)}/backups/${encodeURIComponent(backupId)}/download`
  await Filesystem.downloadFile({
    url,
    path,
    directory: Directory.Cache,
    recursive: true,
    headers: {
      Accept: 'application/gzip',
      Authorization: `Bearer ${credential.token}`
    },
    connectTimeout: 30_000,
    readTimeout: 120_000
  })
  const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache })
  try {
    await Share.share({ title: 'ZenNotes backup', files: [uri] })
  } catch (error) {
    if (!/cancel/i.test(error instanceof Error ? error.message : String(error))) throw error
  }
}

export async function restoreMobileCloudBackup(
  vault: MobileVault,
  backupId: string
): Promise<CloudBackupRestoreResult> {
  return service.restoreBackup(hostVault(vault), backupId)
}

export async function restoreMobileCloudBackupNote(
  vault: MobileVault,
  backupId: string,
  snapshotItemId: number
): Promise<CloudBackupNoteRestoreResult> {
  return service.restoreBackupNote(hostVault(vault), backupId, snapshotItemId)
}

function hostVault(vault: MobileVault): CloudSyncHostVault {
  const fs: PortableCloudSyncFileSystem = {
    readdir: async (directory) =>
      (await vault.fs.readdir(directory)).map((entry) => ({
        name: entry.name,
        type: entry.type === 'directory' ? 'directory' : 'file'
      })),
    stat: async (path) => (await vault.fs.statOrNull(path))?.type ?? null,
    readBase64: (path) => vault.fs.readBase64(path),
    writeText: (path, value) => vault.fs.writeText(path, value),
    writeBase64: (path, value) => vault.fs.writeBase64(path, value),
    deleteFile: (path) => vault.fs.deleteFile(path),
    rename: (from, to) => vault.fs.rename(from, to)
  }

  return {
    key: vault.rootLabel,
    repository: new PortableCloudSyncRepository(fs),
    refresh: () => vault.rescan()
  }
}

async function linkPath(vaultKey: string): Promise<string> {
  return `${STORAGE_ROOT}/links/${await fingerprint(vaultKey)}.json`
}

async function statePath(vaultKey: string, baseUrl: string, vaultId: string): Promise<string> {
  return `${STORAGE_ROOT}/states/${await fingerprint(vaultKey)}/${await fingerprint(baseUrl)}/${await fingerprint(vaultId)}.json`
}

async function readJson(path: string): Promise<unknown> {
  try {
    const result = await Filesystem.readFile({ path, directory: Directory.Data, encoding: Encoding.UTF8 })
    const value = typeof result.data === 'string' ? result.data : await result.data.text()
    return JSON.parse(value) as unknown
  } catch {
    return null
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await Filesystem.writeFile({
    path,
    directory: Directory.Data,
    encoding: Encoding.UTF8,
    data: JSON.stringify(value),
    recursive: true
  })
}

async function deleteDataFile(path: string): Promise<void> {
  await Filesystem.deleteFile({ path, directory: Directory.Data }).catch(() => {})
}

async function fingerprint(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}
