import { spawnSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync
} from 'node:fs'
import { readdir, readFile, unlink } from 'node:fs/promises'
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

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u

class ShellProcessRecoveryBlockedError extends Error {
  readonly code = 'SHELL_PROCESS_RECOVERY_BLOCKED'

  constructor(runId: string) {
    super(`SHELL_PROCESS_RECOVERY_BLOCKED: the old process tree for ${runId} was not reaped.`)
    this.name = 'ShellProcessRecoveryBlockedError'
  }
}

type ShellProcessOwnershipRegistryOptions = Readonly<{
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

const recoveryHandle = (record: ShellProcessOwnershipRecord): ChildProcess => {
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
  }): {
    claim(child: ChildProcess, platform: NodeJS.Platform): () => void
    abort(): void
  } {
    if (!SAFE_RUN_ID.test(metadata.runId)) throw new Error('Invalid Shell Run identity.')
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
        } finally {
          try {
            unlinkSync(temporary)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
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

  async recover(): Promise<void> {
    let entries: string[]
    try {
      entries = await readdir(this.directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of entries.filter((name) => name.endsWith('.json')).sort()) {
      const path = join(this.directory, entry)
      const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<
        ShellProcessOwnershipRecord & ShellProcessLaunchIntent
      >
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
        throw new ShellProcessRecoveryBlockedError(parsed.runId)
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
  ShellProcessLaunchIntent,
  ShellProcessOwnershipRecord,
  ShellProcessOwnershipRegistryOptions
}
