import { spawn, type ChildProcess } from 'node:child_process'
import { dirname } from 'node:path'

import { protectManagedRuntimeWrites } from './managed-runtime-guard'
import type { NotebookProcessSandbox } from './process-sandbox'
import { registerOwnedPosixProcessGroup, terminateProcessTree } from '../process-tree'
import { resolveWindowsPowerShellExecutable } from '../windows-powershell'
import { NOTEBOOK_SHELL_DEFAULT_TIMEOUT_MS } from '../../shared/notebook'
import {
  notebookWorkloadCacheEnv,
  notebookWorkloadCacheRoot,
  prepareNotebookWorkloadCache
} from './notebook-workload-cache-paths'
import {
  NOTEBOOK_DIAGNOSTIC_RESERVE_BYTES,
  NOTEBOOK_TEXT_LIMIT_BYTES,
  limitUtf8
} from './content-limits'
import { buildNotebookShellEnvironment, environmentPathRoots } from './process-environment'

// Grace between the POSIX process group's polite termination and an uncatchable group kill.
const SHELL_KILL_GRACE_MS = 2_000
const SHELL_TIMEOUT_MESSAGE_RESERVE_BYTES = 256

// Result of one stateless bash_execute run. No status/traceback classification: the shell is
// expected to fail non-zero sometimes, so the caller inspects exitCode directly instead of a
// completed/failed status flag.
type NotebookShellResult = {
  stdout: string
  stderr: string
  exitCode: number | null
  truncated?: boolean
  cancelled?: boolean
  // Runtime-private cleanup evidence. Public adapters project only the legacy result fields.
  ownedTreeReaped?: boolean
}

type NotebookShellProcessRequest = {
  runId?: string
  command: string
  cwd: string
  handoffDir: string
  runtimeRoot: string
  notebookSessionRoot?: string
  inputRoot?: string
  protectedDirs?: readonly string[]
  environment?: NodeJS.ProcessEnv
  sessionId: string
  projectId: string
  timeoutMs?: number
  signal?: AbortSignal
}

// Runtime-private port: platform invocation, encoding, env projection, and teardown stay in its adapter.
type NotebookShellProcess = {
  execute(request: NotebookShellProcessRequest): Promise<NotebookShellResult>
  prepare?(request: NotebookShellProcessRequest): Promise<{
    execute(signal?: AbortSignal): Promise<NotebookShellResult>
    dispose(): void
  }>
}

type PreparedShellLaunch = {
  platform: NodeJS.Platform
  invocation: ShellInvocation
  baseEnv: NodeJS.ProcessEnv
  sandboxed?: Awaited<ReturnType<NotebookProcessSandbox['wrap']>>
  endSandboxExecution?: () => void
}

const buildShellEnv = (
  handoffDir: string,
  platform: NodeJS.Platform = process.platform,
  sourceEnv: NodeJS.ProcessEnv = process.env,
  runtimeRoot?: string,
  workloadCacheEnv?: NodeJS.ProcessEnv
): NodeJS.ProcessEnv => {
  const env = buildNotebookShellEnvironment(handoffDir, platform, sourceEnv)
  if (runtimeRoot) {
    Object.assign(env, workloadCacheEnv ?? notebookWorkloadCacheEnv(runtimeRoot))
  }
  return env
}

const POWERSHELL_CLIXML_BLOCK = /#< CLIXML\r?\n<Objs\b[\s\S]*?<\/Objs>(?:\r?\n)?/gu

const isPowerShellProgressClixml = (block: string): boolean => {
  const xmlStart = block.indexOf('<Objs')
  if (xmlStart === -1) return false

  const xml = block.slice(xmlStart)
  const objectStreamPattern = /<Obj\b[^>]*\bS=(["'])(.*?)\1/giu
  let sawObject = false
  let match: RegExpExecArray | null

  while ((match = objectStreamPattern.exec(xml)) !== null) {
    sawObject = true
    if (match[2].toLowerCase() !== 'progress') return false
  }

  return sawObject
}

const skipOneLineBreak = (text: string, index: number): number => {
  if (text.startsWith('\r\n', index)) return index + 2
  if (text[index] === '\n' || text[index] === '\r') return index + 1
  return index
}

const normalizePowerShellStderr = (
  stderr: string,
  platform: NodeJS.Platform = process.platform
): string => {
  if (platform !== 'win32' || !stderr.includes('#< CLIXML')) return stderr

  let normalized = ''
  let cursor = 0
  let match: RegExpExecArray | null
  POWERSHELL_CLIXML_BLOCK.lastIndex = 0

  while ((match = POWERSHELL_CLIXML_BLOCK.exec(stderr)) !== null) {
    if (!isPowerShellProgressClixml(match[0])) continue

    normalized += stderr.slice(cursor, match.index)
    cursor = match.index + match[0].length
    if (normalized.endsWith('\n')) cursor = skipOneLineBreak(stderr, cursor)
  }

  if (cursor === 0) return stderr
  return normalized + stderr.slice(cursor)
}

type ShellInvocation = {
  executable: string
  args: string[]
}

// PowerShell receives a UTF-16LE wrapper around a separately encoded UTF-8 script block, isolating
// trailing syntax from UTF-8 setup and the $?/$LASTEXITCODE normalization.
const encodePowerShellCommand = (command: string): string => {
  const encodedCommand = Buffer.from(command, 'utf8').toString('base64')
  const script = [
    'if ($env:OPEN_SCIENCE_PSMODULEPATH) {',
    '  $env:PSModulePath = $env:OPEN_SCIENCE_PSMODULEPATH',
    // Import the common in-box command modules by absolute path so their first use does not scan
    // the larger AllUsers tree. Keep AllUsers first in PSModulePath so updated or additional
    // machine modules retain Windows PowerShell's standard precedence for every other command.
    '  Import-Module "$PSHOME\\Modules\\Microsoft.PowerShell.Management\\Microsoft.PowerShell.Management.psd1" -ErrorAction Stop',
    '  Import-Module "$PSHOME\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1" -ErrorAction Stop',
    "  [System.Environment]::SetEnvironmentVariable('OPEN_SCIENCE_PSMODULEPATH', $null, [System.EnvironmentVariableTarget]::Process)",
    '}',
    '$openScienceUtf8 = [System.Text.UTF8Encoding]::new($false)',
    '[Console]::OutputEncoding = $openScienceUtf8',
    '$OutputEncoding = $openScienceUtf8',
    `$openScienceCommandBase64 = '${encodedCommand}'`,
    '$global:LASTEXITCODE = 0',
    "$ProgressPreference = 'SilentlyContinue'",
    "$ErrorActionPreference = 'Stop'",
    'try {',
    '$openScienceCommandText = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($openScienceCommandBase64))',
    '$openScienceCommand = [ScriptBlock]::Create($openScienceCommandText)',
    '& $openScienceCommand',
    '$openScienceSucceeded = $?',
    '$openScienceNativeExitCode = $LASTEXITCODE',
    'if ($openScienceNativeExitCode -is [int] -and $openScienceNativeExitCode -ne 0) { exit $openScienceNativeExitCode }',
    'if ($openScienceSucceeded) { exit 0 }',
    '} catch {',
    '[Console]::Error.WriteLine($_.ToString())',
    '}',
    'exit 1'
  ].join('\n')

  return Buffer.from(script, 'utf16le').toString('base64')
}

// Resolve the command interpreter explicitly instead of using shell:true. Node's Windows default is
// cmd.exe, whose command language cannot run the POSIX-style commands agents commonly emit.
const resolveShellInvocation = (
  command: string,
  platform: NodeJS.Platform = process.platform
): ShellInvocation =>
  platform === 'win32'
    ? {
        executable: resolveWindowsPowerShellExecutable(),
        args: [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          encodePowerShellCommand(command)
        ]
      }
    : { executable: '/bin/sh', args: ['-c', command] }

// POSIX shells are spawned as independent groups below. Signal that group first so descendants do
// not survive a timeout; if group signaling is unavailable, fall back to the direct child handle.
const signalPosixShellGroup = (child: ChildProcess, signal: NodeJS.Signals): void => {
  const groupId = child.pid
  if (groupId !== undefined && Number.isSafeInteger(groupId) && groupId > 0) {
    try {
      process.kill(-groupId, signal)
      return
    } catch {
      // The group may already be gone or the platform may reject group signaling.
    }
  }

  try {
    child.kill(signal)
  } catch {
    // It exited between timeout detection and this best-effort signal.
  }
}

// Cancellation and timeout settle only after the bounded process-tree terminator finishes, so callers
// may safely tear down or remove the Session workspace after this promise resolves.
const terminateShellOnTimeout = async (
  child: ChildProcess,
  platformOrTerminateTree:
    NodeJS.Platform | ((process: ChildProcess) => Promise<unknown>) = process.platform,
  terminateTree: (process: ChildProcess) => Promise<unknown> = terminateProcessTree
): Promise<boolean | undefined> => {
  const legacyCall = typeof platformOrTerminateTree === 'function'
  const platform = legacyCall ? process.platform : platformOrTerminateTree
  const effectiveTerminateTree = legacyCall ? platformOrTerminateTree : terminateTree
  if (platform !== 'win32') {
    if (legacyCall) {
      try {
        await effectiveTerminateTree(child)
      } catch {
        // Preserve the historical never-reject teardown contract.
      }
      return undefined
    }
    signalPosixShellGroup(child, 'SIGTERM')
    setTimeout(() => signalPosixShellGroup(child, 'SIGKILL'), SHELL_KILL_GRACE_MS)
    return false
  }

  try {
    const result = (await effectiveTerminateTree(child)) as { reaped?: boolean }
    return legacyCall ? undefined : result.reaped === true
  } catch {
    // Preserve runShellCommand's never-reject contract even when the best-effort terminator fails.
    return false
  }
}

// Runs one fresh platform-native process with the Session cwd and handoff channel. Spawn failure,
// non-zero exit, and timeout all resolve as ordinary results instead of rejecting.
const prepareShellLaunch = async (
  options: NotebookShellProcessRequest,
  platform: NodeJS.Platform = process.platform,
  processSandbox?: NotebookProcessSandbox
): Promise<PreparedShellLaunch> => {
  const baseEnv = options.environment
    ? { ...options.environment }
    : buildShellEnv(
        options.handoffDir,
        platform,
        process.env,
        options.runtimeRoot,
        prepareNotebookWorkloadCache(options.runtimeRoot)
      )
  const nativeInvocation = resolveShellInvocation(options.command, platform)
  const invocation = processSandbox
    ? nativeInvocation
    : protectManagedRuntimeWrites(nativeInvocation, options.runtimeRoot, platform)
  const sandboxed = processSandbox
    ? await processSandbox.wrap({
        executable: invocation.executable,
        args: invocation.args,
        env: baseEnv,
        cwd: options.cwd,
        commandText: options.command,
        sessionId: options.sessionId,
        projectId: options.projectId,
        runtime: 'bash',
        filesystem: {
          readOnlyRoots: [
            options.runtimeRoot,
            ...(options.inputRoot ? [options.inputRoot] : []),
            dirname(invocation.executable),
            ...environmentPathRoots(baseEnv, platform)
          ],
          readWriteRoots: [
            options.notebookSessionRoot ?? options.cwd,
            options.cwd,
            options.handoffDir,
            notebookWorkloadCacheRoot(options.runtimeRoot)
          ],
          deniedReadRoots: options.protectedDirs ?? [],
          deniedWriteRoots: options.protectedDirs ?? []
        },
        ...(options.signal ? { signal: options.signal } : {})
      })
    : undefined
  return {
    platform,
    invocation,
    baseEnv,
    sandboxed,
    // Consuming one-shot grants here freezes them at admission, before a queued Run waits.
    endSandboxExecution: sandboxed?.beginExecution?.()
  }
}

const disposePreparedShellLaunch = (prepared: PreparedShellLaunch): void => {
  prepared.endSandboxExecution?.()
  prepared.sandboxed?.cleanup()
}

const runShellCommand = (
  options: NotebookShellProcessRequest & {
    platform?: NodeJS.Platform
    processSandbox?: NotebookProcessSandbox
    claimProcess?: (child: ChildProcess, platform: NodeJS.Platform) => () => void
    prepareProcessOwnership?: () => {
      claim(child: ChildProcess, platform: NodeJS.Platform): () => void
      abort(): void
    }
    preparedLaunch?: PreparedShellLaunch
  }
): Promise<NotebookShellResult> => {
  const run = async (): Promise<NotebookShellResult> => {
    if (options.signal?.aborted) {
      if (options.preparedLaunch) disposePreparedShellLaunch(options.preparedLaunch)
      return {
        stdout: '',
        stderr: 'Shell command was cancelled.',
        exitCode: null,
        cancelled: true
      }
    }
    const timeoutMs = options.timeoutMs ?? NOTEBOOK_SHELL_DEFAULT_TIMEOUT_MS
    const prepared =
      options.preparedLaunch ??
      (await prepareShellLaunch(options, options.platform, options.processSandbox))
    const { platform, invocation, baseEnv, sandboxed, endSandboxExecution } = prepared

    return new Promise((resolve) => {
      const launchOwnership = options.prepareProcessOwnership?.()
      let child: ChildProcess
      try {
        child = spawn(
          sandboxed?.executable ?? invocation.executable,
          sandboxed?.args ?? invocation.args,
          {
            cwd: options.cwd,
            env: sandboxed?.env ?? baseEnv,
            // POSIX spawn makes this shell the leader of a private process group/session.
            detached: platform !== 'win32'
          }
        )
      } catch (error) {
        launchOwnership?.abort()
        disposePreparedShellLaunch(prepared)
        resolve({
          stdout: '',
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: null
        })
        return
      }
      if (platform !== 'win32') registerOwnedPosixProcessGroup(child)
      let releaseProcessOwnership: (() => void) | undefined
      try {
        releaseProcessOwnership = launchOwnership
          ? launchOwnership.claim(child, platform)
          : options.claimProcess?.(child, platform)
      } catch (error) {
        launchOwnership?.abort()
        void terminateProcessTree(child).finally(() => {
          endSandboxExecution?.()
          sandboxed?.cleanup()
          resolve({
            stdout: '',
            stderr: error instanceof Error ? error.message : String(error),
            exitCode: null
          })
        })
        return
      }

      let stdout = ''
      let stderr = ''
      let stdoutBytes = 0
      let stderrBytes = 0
      let truncated = false
      let settled = false
      // Timeout owns settlement even if Windows taskkill emits exit before its promise resolves.
      let timedOut = false
      let cancelled = false

      const finish = (result: NotebookShellResult, ownedTreeReaped = true): void => {
        if (settled) return
        settled = true
        clearTimeout(timeoutTimer)
        options.signal?.removeEventListener('abort', abort)
        // A receipt is removal authority and recovery evidence. Keep it whenever full-tree teardown
        // cannot be proved so startup recovery can retry and new work remains fenced fail-closed.
        if (ownedTreeReaped) releaseProcessOwnership?.()
        endSandboxExecution?.()
        const normalized = normalizePowerShellStderr(result.stderr)
        const stderr = sandboxed ? sandboxed.annotateStderr(normalized) : normalized
        sandboxed?.cleanup()
        const completed = { ...result, stderr }
        if (!ownedTreeReaped) {
          // Keep cleanup evidence runtime-private and out of the exact legacy foreground payload.
          Object.defineProperty(completed, 'ownedTreeReaped', { value: false })
        }
        resolve(completed)
      }

      const terminateAndFinish = (result: NotebookShellResult): void => {
        // Do not expose a terminal result until the complete owned tree is gone. This keeps the
        // Session workspace and ownership receipt valid throughout timeout cleanup on every OS.
        void terminateProcessTree(child).then((tree) => finish(result, tree.reaped))
      }

      const abort = (): void => {
        if (settled || timedOut || cancelled) return
        cancelled = true
        clearTimeout(timeoutTimer)
        const result = {
          stdout,
          stderr:
            stderr + `${stderr && !stderr.endsWith('\n') ? '\n' : ''}Shell command was cancelled.`,
          exitCode: null,
          cancelled: true as const
        }
        // Stop and lifecycle teardown do not settle until the entire owned tree is confirmed gone.
        // This is deliberately stronger than timeout's prompt-return compatibility path.
        void terminateProcessTree(child).then((tree) => finish(result, tree.reaped))
      }

      const timeoutTimer = setTimeout(() => {
        if (settled || cancelled) return
        timedOut = true
        const timeoutResult: NotebookShellResult = {
          stdout,
          stderr:
            stderr +
            `${stderr && !stderr.endsWith('\n') ? '\n' : ''}Shell command timed out after ${timeoutMs}ms and was killed.`,
          exitCode: null,
          ...(truncated ? { truncated: true } : {})
        }
        terminateAndFinish(timeoutResult)
      }, timeoutMs)

      options.signal?.addEventListener('abort', abort, { once: true })
      if (options.signal?.aborted) abort()

      child.stdout!.setEncoding('utf8')
      child.stderr!.setEncoding('utf8')
      const appendOutput = (
        current: string,
        chunk: string,
        remainingBytes: number,
        updateBytes: (captured: number) => void
      ): string => {
        const limited = limitUtf8(chunk, remainingBytes)
        updateBytes(Buffer.byteLength(limited.text, 'utf8'))
        truncated ||= limited.truncated
        return current + limited.text
      }
      child.stdout!.on('data', (chunk: string) => {
        stdout = appendOutput(
          stdout,
          chunk,
          NOTEBOOK_TEXT_LIMIT_BYTES - NOTEBOOK_DIAGNOSTIC_RESERVE_BYTES - stdoutBytes,
          (captured) => {
            stdoutBytes += captured
          }
        )
      })
      child.stderr!.on('data', (chunk: string) => {
        stderr = appendOutput(
          stderr,
          chunk,
          NOTEBOOK_DIAGNOSTIC_RESERVE_BYTES - SHELL_TIMEOUT_MESSAGE_RESERVE_BYTES - stderrBytes,
          (captured) => {
            stderrBytes += captured
          }
        )
      })
      child.once('error', (error) => {
        if (!timedOut && !cancelled) {
          const result = {
            stdout,
            stderr: stderr || error.message,
            exitCode: null,
            ...(truncated ? { truncated: true } : {})
          }
          void terminateProcessTree(child).then((tree) => finish(result, tree.reaped))
        }
      })
      child.once('exit', (code) => {
        if (!timedOut && !cancelled) {
          const result = {
            stdout,
            stderr,
            exitCode: code,
            ...(truncated ? { truncated: true } : {})
          }
          void terminateProcessTree(child).then((tree) => finish(result, tree.reaped))
        }
      })
    })
  }

  return run().catch((error: unknown) => ({
    stdout: '',
    stderr: error instanceof Error ? error.message : String(error),
    exitCode: null
  }))
}

// Stateless production adapter: a shared instance adds no queue or process registry.
class NotebookShellProcessAdapter implements NotebookShellProcess {
  constructor(
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly processSandbox?: NotebookProcessSandbox,
    private readonly processOwnership?: {
      claim(
        child: ChildProcess,
        metadata: {
          runId: string
          projectId: string
          sessionId: string
          platform: NodeJS.Platform
        }
      ): () => void
      beginLaunch?(metadata: {
        runId: string
        projectId: string
        sessionId: string
        platform?: NodeJS.Platform
      }): {
        claim(child: ChildProcess, platform: NodeJS.Platform): () => void
        abort(): void
      }
    }
  ) {}

  async prepare(request: NotebookShellProcessRequest): Promise<{
    execute(signal?: AbortSignal): Promise<NotebookShellResult>
    dispose(): void
  }> {
    const preparedLaunch = await prepareShellLaunch(request, this.platform, this.processSandbox)
    let consumed = false
    return {
      execute: (signal?: AbortSignal) => {
        if (consumed)
          return Promise.reject(new Error('Prepared Shell launch was already consumed.'))
        consumed = true
        return runShellCommand({
          ...request,
          ...(signal ? { signal } : {}),
          platform: this.platform,
          preparedLaunch,
          ...this.ownershipClaim(request)
        })
      },
      dispose: () => {
        if (consumed) return
        consumed = true
        disposePreparedShellLaunch(preparedLaunch)
      }
    }
  }

  execute(request: NotebookShellProcessRequest): Promise<NotebookShellResult> {
    return runShellCommand({
      ...request,
      platform: this.platform,
      ...(this.processSandbox ? { processSandbox: this.processSandbox } : {}),
      ...this.ownershipClaim(request)
    })
  }

  private ownershipClaim(request: NotebookShellProcessRequest): {
    claimProcess?: (child: ChildProcess, platform: NodeJS.Platform) => () => void
    prepareProcessOwnership?: () => {
      claim(child: ChildProcess, platform: NodeJS.Platform): () => void
      abort(): void
    }
  } {
    if (!this.processOwnership || !request.runId) return {}
    if (this.processOwnership.beginLaunch) {
      return {
        prepareProcessOwnership: () =>
          this.processOwnership!.beginLaunch!({
            runId: request.runId!,
            projectId: request.projectId,
            sessionId: request.sessionId,
            platform: this.platform
          })
      }
    }
    return {
      claimProcess: (child: ChildProcess, platform: NodeJS.Platform) =>
        this.processOwnership!.claim(child, {
          runId: request.runId!,
          projectId: request.projectId,
          sessionId: request.sessionId,
          platform
        })
    }
  }
}

export {
  NotebookShellProcessAdapter,
  buildShellEnv,
  normalizePowerShellStderr,
  resolveShellInvocation,
  runShellCommand,
  terminateShellOnTimeout
}
export type { NotebookShellProcess, NotebookShellProcessRequest, NotebookShellResult }
