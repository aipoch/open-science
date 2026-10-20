import { createHash, randomUUID } from 'node:crypto'
import { open, readFile, rename, realpath, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  hasSystemRestarted,
  isStableBootIdentity,
  systemBootIdentity
} from '../system-boot-identity'
import { RuntimeDirectoryOwnership } from '../runtime-ownership'
import type { RuntimeStartupOptions } from '../runtime-startup-options'
import {
  finishInstallationRecoveryAsync,
  inspectInstallationAvailability,
  inspectInstallationUpdate,
  installationStateDirectory,
  verifyInstallationManifestAsync,
  type InstallationLocation,
  type InstallationManifest
} from './installation-protection'

export function installationManifestIdentity(
  manifest: InstallationManifest | undefined
): string | undefined {
  return manifest ? createHash('sha256').update(JSON.stringify(manifest)).digest('hex') : undefined
}
/** Reboot proves the recorded writers are gone; it does not prove a successful installation.
 * This explicit recovery action verifies files and all original directory leases before issuing
 * a startup ticket. It never runs an installer, changes stoppedClean, or starts a Runtime. */
export async function recoverInstallationAfterSystemRestart(
  location: InstallationLocation,
  operationId: string,
  options: {
    version: string
    allowedProcessIds?: () => number[]
    readBootIdentity?: () => string
    inspectProcesses?: Parameters<typeof inspectInstallationAvailability>[0]['inspectProcesses']
    signal?: AbortSignal
  }
): Promise<{ intent: 'cancel' | 'complete'; startupOptions: RuntimeStartupOptions } | undefined> {
  const record = inspectInstallationUpdate(location)
  if (!record || record.operationId !== operationId)
    throw new Error('The installation operation changed.')
  if (!isStableBootIdentity(record.bootIdentity)) return undefined
  const currentBoot = (options.readBootIdentity ?? systemBootIdentity)()
  if (!hasSystemRestarted(record.bootIdentity, currentBoot)) return undefined
  const ownership = new RuntimeDirectoryOwnership()
  let executor: DatabaseSync | undefined
  try {
    // Do not create missing configuration directories as a side effect of proof collection.
    for (const directory of new Set([
      record.startupOptions.configRoot,
      record.startupOptions.dataRoot,
      record.startupOptions.profilePath
    ])) {
      if (!(await stat(directory)).isDirectory())
        throw new Error('An original Runtime directory is unavailable.')
      ownership.acquireSync(await realpath(directory))
    }
    let request: Record<string, unknown> | undefined
    if (record.phase === 'handoff') {
      if (!record.executor) throw new Error('The bound installation executor is unavailable.')
      executor = new DatabaseSync(join(record.executor.directory, 'executor.sqlite'))
      executor.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE')
      const bytes = await readFile(join(record.executor.directory, 'request.json'))
      if (createHash('sha256').update(bytes).digest('hex') !== record.executor.requestSha256)
        throw new Error('The installation request changed.')
      request = JSON.parse(bytes.toString())
      if (
        !request ||
        request.operationId !== operationId ||
        request.bootIdentity !== record.bootIdentity ||
        request.installationRoot !== record.installationRoot ||
        request.channel !== record.executor.channel ||
        request.recordPath !==
          join(installationStateDirectory(location), 'update-in-progress.json') ||
        request.oldManifestSha256 !== installationManifestIdentity(record.oldManifest) ||
        request.targetManifestSha256 !== installationManifestIdentity(record.targetManifest)
      )
        throw new Error('The original operation, boot and manifests are not bound to this request.')
    }
    await inspectInstallationAvailability(
      {
        ...location,
        allowedProcessIds: options.allowedProcessIds,
        inspectProcesses: options.inspectProcesses
      },
      options.signal
    )
    // An unfinished stop may only recover the unchanged original installation, never complete an update.
    const targetMatches =
      record.phase === 'handoff' &&
      !!record.targetManifest &&
      record.targetManifest.version === record.targetVersion &&
      (await verifyInstallationManifestAsync(
        location.installationRoot,
        record.targetManifest,
        options.signal
      ))
    const intent = targetMatches ? 'complete' : 'cancel'
    const expected = targetMatches ? record.targetManifest! : record.oldManifest
    if (
      !targetMatches &&
      !(await verifyInstallationManifestAsync(location.installationRoot, expected, options.signal))
    )
      throw new Error(
        'Restore the original or exact target installation with its original installer, restart the operating system, and check again. Startup remains protected.'
      )
    if (expected.version !== options.version)
      throw new Error(
        'Close this Desktop and reopen the verified installed version before recovering.'
      )
    options.signal?.throwIfAborted()
    if (JSON.stringify(inspectInstallationUpdate(location)) !== JSON.stringify(record))
      throw new Error('The installation operation changed during verification.')
    // Repeat occupancy immediately before publication; supported entrants remain blocked by the marker.
    await inspectInstallationAvailability(
      {
        ...location,
        allowedProcessIds: options.allowedProcessIds,
        inspectProcesses: options.inspectProcesses
      },
      options.signal
    )
    if (record.executor && request) {
      await writeReceipt(join(record.executor.directory, 'result.json'), {
        operationId,
        requestSha256: record.executor.requestSha256,
        outcome: targetMatches ? 'installed' : 'rolled-back',
        pid: process.pid,
        settlement: 'system-restart',
        recordedBootIdentity: record.bootIdentity,
        bootIdentity: currentBoot
      })
      executor!.close()
      executor = undefined
    }
    const startupOptions = await finishInstallationRecoveryAsync(
      location,
      operationId,
      intent,
      options.signal
    )
    return { intent, startupOptions }
  } finally {
    executor?.close()
    ownership.closeSync()
  }
}
async function writeReceipt(path: string, value: unknown): Promise<void> {
  const temporary = path + '.' + randomUUID() + '.tmp',
    file = await open(temporary, 'wx', 0o600)
  try {
    await file.writeFile(JSON.stringify(value))
    await file.sync()
  } finally {
    await file.close()
  }
  await rename(temporary, path)
  if (process.platform !== 'win32') {
    const directory = await open(dirname(path), 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  }
}
