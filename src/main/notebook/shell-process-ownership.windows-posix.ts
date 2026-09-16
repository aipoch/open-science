import { spawnSync, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync
} from 'node:fs'
import { readdir, readFile, rename, rm, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'

import { registerOwnedPosixProcessGroup, terminateProcessTree } from '../process-tree'
import { resolveWindowsPowerShellExecutable } from '../windows-powershell'
import { bootTokenProvesReboot, isValidBootToken, readBootToken } from './operation-journal'

type ShellProcessOwnershipRecord = Readonly<{
  version: 1
  runId: string
  projectId: string
  sessionId: string
  pid: number
  platform: NodeJS.Platform
  ownerInstanceId: string
  launchedAt: number
  processStartIdentity: string
  bootToken?: string
}>

type ShellProcessLaunchIntent = Readonly<{
  version: 1
  state: 'launching'
  bootToken?: string
  runId: string
  projectId: string
  sessionId: string
  ownerInstanceId: string
  launchedAt: number
}>

type HostedShellRecord = Omit<ShellProcessLaunchIntent, 'version' | 'state' | 'bootToken'> & {
  version: 2
  platform: 'win32'
  receiptId: string
  pid?: number
  commandIdentityMarker?: string
}

type ShellProcessLaunchOwnership = {
  host?: { path: string; pendingPath: string; receiptId: string }
  claim(child: ChildProcess, platform: NodeJS.Platform): () => void
  abort(): void
}

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
const RECEIPT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u

class ShellProcessRecoveryBlockedError extends Error {
  readonly code = 'SHELL_PROCESS_RECOVERY_BLOCKED'

  constructor(runId: string) {
    super(`SHELL_PROCESS_RECOVERY_BLOCKED: the old process tree for ${runId} was not reaped.`)
    this.name = 'ShellProcessRecoveryBlockedError'
  }
}

type ShellProcessOwnershipRegistryOptions = Readonly<{
  processHostPath?: string
  processExists?: (pid: number) => boolean
  ownedTreeExists?: (record: ShellProcessOwnershipRecord) => boolean
  processStartIdentity?: (pid: number, platform: NodeJS.Platform) => string | undefined
  readBootToken?: () => string | undefined
  terminateOwnedTree?: (record: ShellProcessOwnershipRecord) => Promise<{ reaped: boolean }>
}>

const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const ownedTreeExists = (record: ShellProcessOwnershipRecord): boolean => {
  if (record.platform === 'win32') return processExists(record.pid)
  try {
    process.kill(-record.pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const processStartIdentity = (pid: number, platform: NodeJS.Platform): string | undefined => {
  const result =
    platform === 'win32'
      ? spawnSync(
          resolveWindowsPowerShellExecutable(),
          [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks`
          ],
          { encoding: 'utf8', windowsHide: true }
        )
      : spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
          encoding: 'utf8',
          windowsHide: true
        })
  if (result.status !== 0) return undefined
  const identity = result.stdout.trim()
  return identity.length > 0 ? identity : undefined
}

const recoveryHandle = (
  record: Pick<ShellProcessOwnershipRecord, 'pid' | 'platform'>
): ChildProcess => {
  const handle = Object.assign(new EventEmitter(), {
    pid: record.pid,
    killed: false,
    exitCode: null,
    signalCode: null,
    kill: (signal?: NodeJS.Signals) => {
      try {
        process.kill(record.pid, signal)
        return true
      } catch {
        return false
      }
    }
  }) as unknown as ChildProcess
  if (record.platform !== 'win32') registerOwnedPosixProcessGroup(handle)
  return handle
}

class ShellProcessOwnershipRegistry {
  private readonly ownerInstanceId = randomUUID()
  private readonly directory: string

  // Only old, structurally complete launch intents qualify for explicit abandonment. A current
  // launch, a claimed process, a malformed file or an unknown format must retain its normal gate.
  private legacyLaunchSnapshot(): { token: string; entries: string[] } | undefined {
    try {
      const entries = readdirSync(this.directory)
        .filter((name) => name.endsWith('.json'))
        .sort()
      if (!entries.length) return undefined
      const hash = createHash('sha256').update(this.ownerInstanceId)
      for (const entry of entries) {
        const path = join(this.directory, entry)
        if (!lstatSync(path).isFile()) return undefined
        const contents = readFileSync(path)
        const record = JSON.parse(contents.toString('utf8'))
        if (
          record?.version !== 1 ||
          record.state !== 'launching' ||
          typeof record.runId !== 'string' ||
          !SAFE_RUN_ID.test(record.runId) ||
          entry !== `${record.runId}.json` ||
          typeof record.projectId !== 'string' ||
          typeof record.sessionId !== 'string' ||
          typeof record.ownerInstanceId !== 'string' ||
          record.ownerInstanceId === this.ownerInstanceId ||
          !Number.isFinite(record.launchedAt) ||
          record.pid !== undefined ||
          record.processStartIdentity !== undefined ||
          (record.bootToken !== undefined && !isValidBootToken(record.bootToken))
        )
          return undefined
        hash.update(JSON.stringify([entry, contents.toString('base64')]))
      }
      return { token: hash.digest('hex'), entries }
    } catch {
      return undefined
    }
  }

  getLegacyRecovery(): { token: string; count: number } | undefined {
    const snapshot = this.legacyLaunchSnapshot()
    return snapshot ? { token: snapshot.token, count: snapshot.entries.length } : undefined
  }

  archiveLegacyLaunches(token: string): void {
    // Synchronous validation + moves cannot interleave with this application's launch callbacks.
    // Tokens bind confirmation to exact bytes and to this registry instance, never just a count.
    const snapshot = this.legacyLaunchSnapshot()
    if (!snapshot || snapshot.token !== token) throw new Error('Shell recovery records changed.')
    const backup = join(this.directory, '..', 'shell-process-ownership-backups', randomUUID())
    mkdirSync(backup, { recursive: true })
    for (const entry of snapshot.entries) {
      // Rename retains the original bytes. On failure, both moved and remaining records survive;
      // ordinary recovery stays blocked and the user can review the remaining snapshot again.
      renameSync(join(this.directory, entry), join(backup, entry))
    }
  }

  constructor(
    storageRoot: string,
    private readonly options: ShellProcessOwnershipRegistryOptions = {}
  ) {
    this.directory = join(storageRoot, 'shell-process-ownership')
  }

  claim(
    child: ChildProcess,
    metadata: { runId: string; projectId: string; sessionId: string; platform: NodeJS.Platform }
  ): () => void {
    const launch = this.beginLaunch(metadata)
    // Once a child exists, only its caller can prove it was reaped before removing the receipt.
    return launch.claim(child, metadata.platform)
  }

  // Persist uncertain ownership before spawn, then atomically replace it with the child's identity.
  // A failed promotion must leave the original launch intent intact for fail-closed recovery.
  beginLaunch(metadata: {
    runId: string
    projectId: string
    sessionId: string
    platform?: NodeJS.Platform
    hosted?: boolean
  }): ShellProcessLaunchOwnership {
    if (!SAFE_RUN_ID.test(metadata.runId)) throw new Error('Invalid Shell Run identity.')
    if (metadata.hosted && metadata.platform === 'win32') return this.beginHostedLaunch(metadata)
    mkdirSync(this.directory, { recursive: true })
    const path = this.path(metadata.runId)
    const descriptor = openSync(path, 'wx', 0o600)
    const bootToken =
      (metadata.platform ?? process.platform) === 'linux'
        ? (this.options.readBootToken ?? readBootToken)()
        : undefined
    const intent: ShellProcessLaunchIntent = {
      version: 1,
      state: 'launching',
      ...(bootToken ? { bootToken } : {}),
      runId: metadata.runId,
      projectId: metadata.projectId,
      sessionId: metadata.sessionId,
      ownerInstanceId: this.ownerInstanceId,
      launchedAt: Date.now()
    }
    try {
      writeSync(descriptor, `${JSON.stringify(intent)}\n`, undefined, 'utf8')
      fsyncSync(descriptor)
    } catch (error) {
      closeSync(descriptor)
      try {
        unlinkSync(path)
      } catch {
        // Preserve the original durable-write failure.
      }
      throw error
    }
    closeSync(descriptor)
    const remove = (): void => {
      try {
        unlinkSync(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return {
      claim: (child, platform) => {
        const pid = child.pid
        if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) {
          throw new Error('Shell process did not expose a valid process identity.')
        }
        const bootToken =
          platform === 'linux' ? (this.options.readBootToken ?? readBootToken)() : undefined
        const record: ShellProcessOwnershipRecord = {
          version: 1,
          runId: metadata.runId,
          projectId: metadata.projectId,
          sessionId: metadata.sessionId,
          pid,
          platform,
          ownerInstanceId: this.ownerInstanceId,
          launchedAt: intent.launchedAt,
          ...(bootToken ? { bootToken } : {}),
          processStartIdentity:
            (this.options.processStartIdentity ?? processStartIdentity)(pid, platform) ??
            (() => {
              throw new Error('Shell process launch identity could not be confirmed.')
            })()
        }
        const temporary = `${path}.${randomUUID()}.tmp`
        const promotedDescriptor = openSync(temporary, 'wx', 0o600)
        try {
          try {
            writeSync(promotedDescriptor, `${JSON.stringify(record)}\n`, undefined, 'utf8')
            fsyncSync(promotedDescriptor)
          } finally {
            closeSync(promotedDescriptor)
          }
          renameSync(temporary, path)
        } catch (error) {
          try {
            unlinkSync(temporary)
          } catch {
            // Preserve the promotion failure; the original launch receipt remains authoritative.
          }
          throw error
        }
        let released = false
        return () => {
          if (released) return
          released = true
          remove()
        }
      },
      abort: remove
    }
  }

  private beginHostedLaunch(metadata: {
    runId: string
    projectId: string
    sessionId: string
  }): ShellProcessLaunchOwnership {
    mkdirSync(this.directory, { recursive: true })
    const receiptId = randomUUID()
    const prefix = join(this.directory, metadata.runId)
    const pendingPath = `${prefix}.pending.${receiptId}.json`
    const record: HostedShellRecord = {
      version: 2,
      platform: 'win32',
      receiptId,
      runId: metadata.runId,
      projectId: metadata.projectId,
      sessionId: metadata.sessionId,
      ownerInstanceId: this.ownerInstanceId,
      launchedAt: Date.now()
    }
    const descriptor = openSync(pendingPath, 'wx', 0o600)
    try {
      writeSync(descriptor, `${JSON.stringify(record)}\n`, undefined, 'utf8')
      fsyncSync(descriptor)
    } catch (error) {
      closeSync(descriptor)
      rmSync(pendingPath, { force: true })
      throw error
    }
    closeSync(descriptor)
    let activePath: string | undefined
    let pid: number | undefined
    const remove = (): void => {
      rmSync(pendingPath, { force: true })
      if (activePath) {
        rmSync(`${activePath}.${pid}.tmp`, { force: true })
        rmSync(activePath, { force: true })
      }
    }
    return {
      host: {
        path:
          this.options.processHostPath ??
          join(__dirname, '../../../resources/notebook/kernel_process_host.js'),
        pendingPath,
        receiptId
      },
      claim: (child) => {
        if (!Number.isSafeInteger(child.pid) || Number(child.pid) <= 0) {
          throw new Error('Shell process did not expose a valid process identity.')
        }
        pid = child.pid
        activePath = `${prefix}.active.${pid}.${receiptId}.json`
        // The host publishes its own PID before starting the workload. No racy parent-side query.
        return remove
      },
      abort: remove
    }
  }

  private async recoverHosted(entry: string, record: HostedShellRecord): Promise<boolean> {
    if (
      record.platform !== 'win32' ||
      !RECEIPT_ID.test(record.receiptId) ||
      typeof record.runId !== 'string' ||
      !SAFE_RUN_ID.test(record.runId) ||
      typeof record.projectId !== 'string' ||
      typeof record.sessionId !== 'string' ||
      typeof record.ownerInstanceId !== 'string' ||
      !Number.isFinite(record.launchedAt)
    ) {
      throw new Error(`Corrupt Shell process ownership record: ${entry}`)
    }
    const path = join(this.directory, entry)
    if (entry === `${record.runId}.pending.${record.receiptId}.json`) {
      const cancelled = `${path}.cancelled-${this.ownerInstanceId}`
      try {
        await rename(path, cancelled)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        return true // The host won admission: discover and verify its active receipt.
      }
      await unlink(cancelled)
      return false
    }
    const match = entry.match(/\.active\.(\d+)\.([a-f0-9-]+)\.json$/u)
    const pid = Number(match?.[1])
    if (
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      entry !== `${record.runId}.active.${pid}.${record.receiptId}.json` ||
      (record.pid !== undefined && record.pid !== pid) ||
      (record.commandIdentityMarker !== undefined &&
        record.commandIdentityMarker !== record.receiptId)
    ) {
      throw new Error(`Corrupt Shell process ownership record: ${entry}`)
    }
    const exists = this.options.processExists ?? processExists
    if (exists(pid)) {
      const result = spawnSync(
        resolveWindowsPowerShellExecutable(),
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 5000 }
      )
      if (result.status !== 0 || !result.stdout?.includes(record.receiptId)) {
        if (exists(pid)) throw new ShellProcessRecoveryBlockedError(record.runId)
      } else {
        const stopped = await terminateProcessTree(recoveryHandle({ pid, platform: 'win32' }))
        if (!stopped.reaped) throw new ShellProcessRecoveryBlockedError(record.runId)
      }
    }
    await rm(`${path}.${pid}.tmp`, { force: true })
    await unlink(path)
    return false
  }

  async recover(): Promise<void> {
    let legacyBlocked: ShellProcessRecoveryBlockedError | undefined
    let entries: string[]
    try {
      entries = await readdir(this.directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of entries.filter((name) => name.endsWith('.json')).sort()) {
      const path = join(this.directory, entry)
      let contents: string
      try {
        contents = await readFile(path, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this.recover()
        throw error
      }
      const document = JSON.parse(contents)
      if (document?.version === 2) {
        if (await this.recoverHosted(entry, document)) return this.recover()
        continue
      }
      const parsed = document as Partial<ShellProcessOwnershipRecord & ShellProcessLaunchIntent>
      if (
        parsed.version === 1 &&
        parsed.state === 'launching' &&
        typeof parsed.runId === 'string'
      ) {
        if (
          bootTokenProvesReboot(parsed.bootToken, (this.options.readBootToken ?? readBootToken)())
        ) {
          // No child from the recorded Linux boot can survive. Do not probe or signal any PID.
          await unlink(path)
          continue
        }
        // The app died between spawn and immutable identity capture. Without proof of a reboot,
        // retain the receipt and fence admission rather than infer ownership of an unknown process.
        legacyBlocked = new ShellProcessRecoveryBlockedError(parsed.runId)
        continue
      }
      if (
        parsed.version !== 1 ||
        typeof parsed.runId !== 'string' ||
        typeof parsed.projectId !== 'string' ||
        typeof parsed.sessionId !== 'string' ||
        !Number.isSafeInteger(parsed.pid) ||
        Number(parsed.pid) <= 0 ||
        typeof parsed.platform !== 'string' ||
        typeof parsed.ownerInstanceId !== 'string' ||
        typeof parsed.launchedAt !== 'number' ||
        typeof parsed.processStartIdentity !== 'string' ||
        (parsed.bootToken !== undefined && !isValidBootToken(parsed.bootToken))
      ) {
        throw new Error(`Corrupt Shell process ownership record: ${entry}`)
      }
      const record = parsed as ShellProcessOwnershipRecord
      if (record.platform !== 'win32') {
        const currentBootToken = (this.options.readBootToken ?? readBootToken)()
        if (bootTokenProvesReboot(record.bootToken, currentBootToken)) {
          // A detached process group cannot survive a reboot. Its numeric id may already name an
          // unrelated group, so discard this stale receipt before any group liveness/kill probe.
          await unlink(path)
          continue
        }
      }
      const leaderExists = (this.options.processExists ?? processExists)(record.pid)
      if (leaderExists) {
        const currentIdentity = (this.options.processStartIdentity ?? processStartIdentity)(
          record.pid,
          record.platform
        )
        if (currentIdentity === undefined) {
          // An unavailable identity lookup is not evidence of PID reuse. Keep the receipt so a later
          // startup can retry instead of signaling an unproven process or forgetting possible work.
          throw new ShellProcessRecoveryBlockedError(record.runId)
        }
        if (currentIdentity !== record.processStartIdentity) {
          // The recorded leader is gone and its PID has been reused. Never signal the unrelated tree.
          await unlink(path)
          continue
        }
      }
      const treeExists = (this.options.ownedTreeExists ?? ownedTreeExists)(record)
      if (treeExists && record.platform !== 'win32' && !leaderExists) {
        // A leaderless POSIX group cannot be tied back to the persisted start identity. Its numeric
        // id may have been reused during this boot, so never signal it from the receipt alone.
        throw new ShellProcessRecoveryBlockedError(record.runId)
      }
      if (treeExists) {
        const result = this.options.terminateOwnedTree
          ? await this.options.terminateOwnedTree(record)
          : await terminateProcessTree(recoveryHandle(record))
        if (!result.reaped) throw new ShellProcessRecoveryBlockedError(record.runId)
      }
      await unlink(path)
    }
    if (legacyBlocked) throw legacyBlocked
  }

  hasReceipts(): boolean {
    try {
      return readdirSync(this.directory).some((entry) => entry.endsWith('.json'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      // An unreadable ownership directory is possible retained evidence, never proof of absence.
      return true
    }
  }

  private path(runId: string): string {
    return join(this.directory, `${runId}.json`)
  }
}

export { ShellProcessOwnershipRegistry, ShellProcessRecoveryBlockedError }
export type {
  ShellProcessLaunchOwnership,
  ShellProcessLaunchIntent,
  ShellProcessOwnershipRecord,
  ShellProcessOwnershipRegistryOptions
}
