import { lstat, realpath } from 'node:fs/promises'
import { basename, extname, isAbsolute } from 'node:path'
import type { UpdateInstaller, UpdateStatus } from '../../shared/update'

export type InstallerFileIdentity = {
  realPath: string
  device: number
  inode: number
  size: number
  modified: number
}

export type InspectInstallerFile = (path: string) => Promise<InstallerFileIdentity | null>

export const inspectInstallerFile: InspectInstallerFile = async (path) => {
  if (!isAbsolute(path)) return null
  try {
    const [file, realPath] = await Promise.all([lstat(path), realpath(path)])
    // A directory, symlink, or partial transfer is never a completed installer.
    if (!file.isFile()) return null
    return {
      realPath,
      device: file.dev,
      inode: file.ino,
      size: file.size,
      modified: file.mtimeMs
    }
  } catch {
    return null
  }
}

export const installerFormat = (
  fileName: string,
  platform: NodeJS.Platform
): UpdateInstaller['format'] => {
  const extension = extname(fileName).slice(1).toLowerCase()
  const formats = { darwin: ['zip', 'dmg'], win32: ['exe'], linux: ['deb', 'appimage'] }
  return formats[platform as keyof typeof formats]?.includes(extension)
    ? (extension as UpdateInstaller['format'])
    : 'unknown'
}

// This in-memory receipt is created only by the existing successful download path. It does not
// scan or persist paths, and cannot discover files downloaded by a browser or a prior application.
export type ConfirmedInstaller = {
  path: string
  latest: string
  source: string
  description: UpdateInstaller
  file: Promise<InstallerFileIdentity | null>
}

const artifactSource = (status: UpdateStatus): string =>
  status.download ? JSON.stringify(status.download) : (status.artifactSha512 ?? '')

export const installerMatchesStatus = (
  artifact: ConfirmedInstaller,
  status: UpdateStatus
): boolean =>
  artifact.path === status.localPath &&
  artifact.latest === status.latest &&
  artifact.source === artifactSource(status)

export const confirmInstaller = (
  status: UpdateStatus,
  platform: NodeJS.Platform,
  inspectFile: InspectInstallerFile,
  formatFileName = status.localPath ?? ''
): ConfirmedInstaller | undefined => {
  if (!status.localPath || !status.latest || !isAbsolute(status.localPath)) return undefined
  return {
    path: status.localPath,
    latest: status.latest,
    source: artifactSource(status),
    description: {
      fileName: basename(status.localPath),
      format: installerFormat(formatFileName, platform),
      platform
    },
    file: inspectFile(status.localPath).catch(() => null)
  }
}

type InstallerInspection =
  | { kind: 'ready'; path: string; installer: UpdateInstaller; artifact: ConfirmedInstaller }
  | { kind: 'missing' | 'unavailable' }

export const inspectConfirmedInstaller = async (
  artifact: ConfirmedInstaller | undefined,
  inspectFile: InspectInstallerFile,
  isCurrent: (artifact: ConfirmedInstaller) => boolean
): Promise<InstallerInspection> => {
  if (!artifact || !isCurrent(artifact)) return { kind: 'unavailable' }
  const confirmed = await artifact.file
  const file = confirmed ? await inspectFile(artifact.path).catch(() => null) : null
  // No late result may clear, describe, or reveal a superseding release or artifact.
  if (!isCurrent(artifact)) return { kind: 'unavailable' }
  if (
    !confirmed ||
    !file ||
    file.realPath !== confirmed.realPath ||
    file.device !== confirmed.device ||
    file.inode !== confirmed.inode ||
    file.size !== confirmed.size ||
    file.modified !== confirmed.modified
  )
    return { kind: 'missing' }
  return { kind: 'ready', path: artifact.path, installer: artifact.description, artifact }
}

// Keep recovery and handoff facts authoritative if a file disappears while installation is pending.
// The caller decides when its existing operation has finished; inspection never cancels or recovers it.
export const withoutMissingInstaller = (
  status: UpdateStatus,
  installationActive = false
): UpdateStatus => {
  const remaining = { ...status }
  delete remaining.localPath
  delete remaining.artifactSha512
  delete remaining.progress
  delete remaining.downloadedBytes
  delete remaining.downloadProgress
  const recovery = status.recovery
  const safePreflight =
    recovery?.phase === 'preparing' &&
    recovery.runtime === 'running' &&
    recovery.installation === 'unchanged' &&
    !recovery.canRecover &&
    !recovery.operationId &&
    recovery.detail !== 'operation-pending'
  if (!installationActive && (!recovery || safePreflight)) {
    delete remaining.recovery
    delete remaining.reason
    delete remaining.outcome
    delete remaining.cliConfirmation
    delete remaining.canForce
    delete remaining.blockedBy
    delete remaining.blockedTasks
    delete remaining.legacyShellRecovery
    return {
      ...remaining,
      state: 'available',
      installerMissing: true,
      error: status.error ?? 'The installer is missing or has changed. Download the update again.'
    }
  }
  return {
    ...remaining,
    installerMissing: true,
    ...(status.recovery ? { recovery: { ...status.recovery, canRetryInstall: false } } : {}),
    error: status.error
  }
}
