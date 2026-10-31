import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { resolveWindowsPowerShellExecutable } from '../windows-powershell'
import { runtimeMetadataIfConfigured } from '../runtime-metadata'

/** Verify and stop the exact host object before reaping its original, from-birth Job.
 * A legacy receipt without that containment proof cannot prove its whole tree was reaped. */
export function recoverLegacyWindowsProcess(options: {
  pid: number
  receiptId?: string
  pendingPath?: string
  jobName?: string
}): { reaped: boolean } {
  if (!Number.isSafeInteger(options.pid) || options.pid <= 0) return { reaped: false }
  if (
    !options.receiptId ||
    !options.pendingPath ||
    options.jobName !== `Local\\OpenScience.Delegation.${options.receiptId}`
  )
    return { reaped: false }
  const resources = runtimeMetadataIfConfigured()?.resourcesPath
  const helper = [
    resources &&
      join(resources, 'app.asar.unpacked/resources/notebook/windows_process_recovery.ps1'),
    resources && join(resources, 'notebook/windows_process_recovery.ps1'),
    resources && join(resources, 'resources/notebook/windows_process_recovery.ps1'),
    join(__dirname, '../../resources/notebook/windows_process_recovery.ps1'),
    join(__dirname, '../../../resources/notebook/windows_process_recovery.ps1')
  ].find((path): path is string => Boolean(path && existsSync(path)))
  if (!helper) return { reaped: false }
  const result = spawnSync(
    resolveWindowsPowerShellExecutable(),
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      helper,
      '-HostProcessId',
      String(options.pid),
      ...(options.receiptId && options.pendingPath
        ? ['-ReceiptId', options.receiptId, '-PendingPath', options.pendingPath]
        : []),
      '-JobName',
      options.jobName
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 4096 }
  )
  return { reaped: result.status === 0 && result.stdout.trim() === '{"reaped":true}' }
}
