import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { dirname } from 'node:path'
import type { NotebookExecutionRecovery } from '../../shared/execution-recovery'
import { assertShellSearchScope } from './shell-search-scope'

import { protectManagedRuntimeWrites } from './managed-runtime-guard'
import { wsl2BashPreviewStatus } from '../wsl/wsl2-preview-gate'
import type {
  NotebookProcessSandbox,
  NotebookSandboxCleanupReason,
  NotebookSandboxCleanupResult,
  NotebookSandboxProcessOutcome
} from './process-sandbox'
import {
  assertProcessTreeSupport,
  ProcessTreeUnavailableError,
  createPosixProcessTreeOwnership,
  trackOwnedPosixProcessTree,
  terminateProcessTree,
  type ProcessTreeKillResult
} from '../process-tree'
import { resolveWindowsPowerShellExecutable } from '../windows-powershell'
import { NOTEBOOK_SHELL_DEFAULT_TIMEOUT_MS } from '../../shared/notebook'
import type { ShellRuntimeBinding } from '../../shared/notebook'
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
import {
  defaultShellRuntimeBinding,
  shellRuntimePlatform,
  shellRuntimeSandboxTarget
} from './shell-runtime'

const SHELL_TIMEOUT_MESSAGE_RESERVE_BYTES = 256
const SHELL_CLEANUP_INCOMPLETE_MESSAGE =
  'SHELL_CLEANUP_INCOMPLETE: Shell execution cleanup did not complete; the result is not trusted.'
const SHELL_NETWORK_TRANSPORT_UNSUPPORTED_PREFIX = 'WSL2_NETWORK_TRANSPORT_UNSUPPORTED:'

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
  runtimeStatus?: 'unavailable'
  recovery?: NotebookExecutionRecovery
  errorCode?:
    'shell-runtime-unavailable' | 'shell-cleanup-incomplete' | 'shell-network-transport-unsupported'
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
  executionReference?: string
  sessionId: string
  projectId: string
  timeoutMs?: number
  signal?: AbortSignal
  runtimeBinding?: ShellRuntimeBinding
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
  runtime: NodeJS.Platform | ShellRuntimeBinding = process.platform
): ShellInvocation => {
  const binding = typeof runtime === 'string' ? defaultShellRuntimeBinding(runtime) : runtime
  return binding.kind === 'powershell'
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
    : {
        executable: binding.kind === 'wsl2-bash' ? '/bin/bash' : binding.shell,
        args: ['-c', command]
      }
}

const resolveShellProcessInvocation = (
  command: string,
  runtimeBinding: ShellRuntimeBinding,
  runtimeRoot: string,
  hostPlatform: NodeJS.Platform,
  hasProcessSandbox: boolean
): ShellInvocation => {
  const invocation = resolveShellInvocation(command, runtimeBinding)
  return hasProcessSandbox
    ? invocation
    : protectManagedRuntimeWrites(invocation, runtimeRoot, hostPlatform)
}

// Cancellation and timeout settle only after the bounded process-tree terminator finishes, so callers
// may safely tear down or remove the Session workspace after this promise resolves.
const terminateShellOnTimeout = async (
  child: ChildProcess,
  platform: NodeJS.Platform = process.platform,
  terminateTree: (process: ChildProcess) => Promise<ProcessTreeKillResult> = terminateProcessTree
): Promise<ProcessTreeKillResult> => {
  void platform
  try {
    return await terminateTree(child)
  } catch {
    // Preserve runShellCommand's never-reject contract even when the best-effort terminator fails.
    return { reaped: false }
  }
}

// Runs one fresh platform-native process with the Session cwd and handoff channel. Spawn failure,
// non-zero exit, and timeout all resolve as ordinary results instead of rejecting.
class ShellPreparationError extends Error {
  constructor(readonly result: NotebookShellResult) {
    super(result.stderr)
  }
}

const prepareShellLaunch = async (
  options: NotebookShellProcessRequest & { previewAvailable?: () => boolean },
  platform: NodeJS.Platform = process.platform,
  processSandbox?: NotebookProcessSandbox
): Promise<PreparedShellLaunch> => {
  return prepareShellLaunchOptions({ ...options, platform, processSandbox })
}

const prepareShellLaunchOptions = async (
  options: NotebookShellProcessRequest & {
    platform?: NodeJS.Platform
    processSandbox?: NotebookProcessSandbox
    previewAvailable?: () => boolean
  }
): Promise<PreparedShellLaunch> => {
  const hostPlatform = options.platform ?? process.platform
  try {
    assertProcessTreeSupport(hostPlatform)
  } catch (error) {
    throw new ShellPreparationError({
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      exitCode: null,
      runtimeStatus: 'unavailable',
      errorCode: 'shell-runtime-unavailable',
      recovery: { execution: 'not-started', retryAfter: 'runtime-ready' }
    })
  }
  const runtimeBinding = options.runtimeBinding ?? defaultShellRuntimeBinding(hostPlatform)
  if (
    runtimeBinding.kind === 'wsl2-bash' &&
    (!(options.previewAvailable ?? (() => wsl2BashPreviewStatus().available))() ||
      !options.processSandbox)
  ) {
    throw new ShellPreparationError({
      stdout: '',
      stderr: 'SHELL_RUNTIME_UNAVAILABLE: The selected WSL2 Bash runtime is unavailable.',
      exitCode: null,
      runtimeStatus: 'unavailable',
      errorCode: 'shell-runtime-unavailable',
      recovery: { execution: 'not-started', retryAfter: 'runtime-ready' }
    })
  }
  const runtimePlatform = shellRuntimePlatform(runtimeBinding, hostPlatform)
  await assertShellSearchScope(options.command, options.cwd, runtimePlatform, options.signal)

  let shellEnv: NodeJS.ProcessEnv
  let workloadCacheEnv: NodeJS.ProcessEnv
  try {
    workloadCacheEnv = prepareNotebookWorkloadCache(options.runtimeRoot)
    shellEnv = options.environment
      ? { ...options.environment }
      : buildShellEnv(
          options.handoffDir,
          runtimePlatform,
          process.env,
          options.runtimeRoot,
          workloadCacheEnv
        )
  } catch (error) {
    throw new ShellPreparationError({
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      exitCode: null
    })
  }

  const platform = hostPlatform
  const invocation = resolveShellProcessInvocation(
    options.command,
    runtimeBinding,
    options.runtimeRoot,
    hostPlatform,
    Boolean(options.processSandbox)
  )
  const baseEnv = shellEnv
  let sandboxed: Awaited<ReturnType<NotebookProcessSandbox['wrap']>> | undefined
  try {
    sandboxed = options.processSandbox
      ? await options.processSandbox.wrap({
          target: shellRuntimeSandboxTarget(runtimeBinding),
          executable: invocation.executable,
          args: invocation.args,
          env: baseEnv,
          pathEnvironment: {
            OPEN_SCIENCE_HANDOFF_DIR: options.handoffDir,
            ...workloadCacheEnv
          },
          cwd: options.cwd,
          commandText: options.command,
          ...(options.executionReference ? { executionReference: options.executionReference } : {}),
          sessionId: options.sessionId,
          projectId: options.projectId,
          runtime: 'bash',
          filesystem: {
            readOnlyRoots: [
              options.runtimeRoot,
              ...(options.inputRoot ? [options.inputRoot] : []),
              ...(runtimeBinding.kind === 'wsl2-bash'
                ? []
                : [
                    dirname(invocation.executable),
                    ...environmentPathRoots(baseEnv, runtimePlatform)
                  ])
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof ProcessTreeUnavailableError) {
      throw new ShellPreparationError({
        stdout: '',
        stderr: message,
        exitCode: null,
        runtimeStatus: 'unavailable',
        errorCode: 'shell-runtime-unavailable',
        recovery: { execution: 'not-started', retryAfter: 'runtime-ready' }
      })
    }
    if (message.startsWith('SHELL_CLEANUP_INCOMPLETE:')) {
      throw new ShellPreparationError({
        stdout: '',
        stderr: message,
        exitCode: null,
        errorCode: 'shell-cleanup-incomplete',
        recovery: { execution: 'not-started', retryAfter: 'cleanup-verified' }
      })
    }
    if (runtimeBinding.kind !== 'wsl2-bash') throw error
    if (options.signal?.aborted) {
      throw new ShellPreparationError({
        stdout: '',
        stderr: 'Shell command was cancelled.',
        exitCode: null,
        cancelled: true
      })
    }
    if (message.startsWith(SHELL_NETWORK_TRANSPORT_UNSUPPORTED_PREFIX)) {
      throw new ShellPreparationError({
        stdout: '',
        stderr: message,
        exitCode: null,
        errorCode: 'shell-network-transport-unsupported',
        recovery: { execution: 'not-started', retryAfter: 'runtime-ready' }
      })
    }
    throw new ShellPreparationError({
      stdout: '',
      stderr: 'SHELL_RUNTIME_UNAVAILABLE: The selected WSL2 Bash runtime is unavailable.',
      exitCode: null,
      runtimeStatus: 'unavailable',
      errorCode: 'shell-runtime-unavailable',
      recovery: { execution: 'not-started', retryAfter: 'runtime-ready' }
    })
  }
  return {
    platform,
    invocation,
    baseEnv,
    sandboxed,
    endSandboxExecution: sandboxed?.beginExecution?.()
  }
}

const disposePreparedShellLaunch = (prepared: PreparedShellLaunch): void => {
  prepared.endSandboxExecution?.()
  void prepared.sandboxed?.cleanup('cancel', { processesTerminated: true }).catch(() => undefined)
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
    terminateTree?: (process: ChildProcess) => Promise<ProcessTreeKillResult>
    previewAvailable?: () => boolean
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

    const runtimeBinding = options.runtimeBinding ?? defaultShellRuntimeBinding(options.platform)
    const runtimePlatform = shellRuntimePlatform(runtimeBinding, options.platform)
    const timeoutMs = options.timeoutMs ?? NOTEBOOK_SHELL_DEFAULT_TIMEOUT_MS
    const prepared =
      options.preparedLaunch ??
      (await prepareShellLaunch(options, options.platform, options.processSandbox))
    const { platform, invocation, baseEnv, sandboxed, endSandboxExecution } = prepared
    const cleanupCompleted = (result: NotebookSandboxCleanupResult): boolean =>
      result.processesTerminated && result.networkClosed && result.temporaryResourcesRemoved
    let sandboxCleanupPromise: Promise<NotebookSandboxCleanupResult> | undefined
    const cleanupSandbox = async (
      reason: NotebookSandboxCleanupReason,
      processOutcome: NotebookSandboxProcessOutcome
    ): Promise<NotebookSandboxCleanupResult> => {
      if (!sandboxCleanupPromise) {
        sandboxCleanupPromise =
          sandboxed?.cleanup(reason, processOutcome) ??
          Promise.resolve({
            processesTerminated: processOutcome.processesTerminated,
            networkClosed: true,
            temporaryResourcesRemoved: true
          })
      }
      try {
        const result = await sandboxCleanupPromise
        if (!cleanupCompleted(result)) sandboxCleanupPromise = undefined
        return result
      } catch (error) {
        sandboxCleanupPromise = undefined
        throw error
      }
    }
    const cleanupSandboxWithRetry = async (
      reason: NotebookSandboxCleanupReason,
      processOutcome: NotebookSandboxProcessOutcome
    ): Promise<NotebookSandboxCleanupResult> => {
      const firstResult = await cleanupSandbox(reason, processOutcome)
      if (runtimeBinding.kind !== 'wsl2-bash' || cleanupCompleted(firstResult)) return firstResult
      return cleanupSandbox(reason, processOutcome)
    }
    const withIncompleteCleanup = (
      result: NotebookShellResult,
      execution: NotebookExecutionRecovery['execution']
    ): NotebookShellResult => ({
      ...result,
      stderr:
        result.stderr +
        `${result.stderr && !result.stderr.endsWith('\n') ? '\n' : ''}${SHELL_CLEANUP_INCOMPLETE_MESSAGE}`,
      exitCode: null,
      errorCode: 'shell-cleanup-incomplete',
      recovery: { execution, retryAfter: 'cleanup-verified' }
    })

    if (options.signal?.aborted) {
      endSandboxExecution?.()
      let cleanupResult: NotebookSandboxCleanupResult | undefined
      try {
        cleanupResult = await cleanupSandboxWithRetry('cancel', { processesTerminated: true })
      } catch {
        cleanupResult = undefined
      }
      const cancelled: NotebookShellResult = {
        stdout: '',
        stderr: 'Shell command was cancelled.',
        exitCode: null,
        cancelled: true
      }
      return cleanupResult && cleanupCompleted(cleanupResult)
        ? cancelled
        : withIncompleteCleanup(cancelled, 'not-started')
    }

    const spawnAdmission = sandboxed?.beginSpawn?.()
    let processTreeOwnership: ReturnType<typeof createPosixProcessTreeOwnership>
    const launchOwnership = options.prepareProcessOwnership?.()
    let child: ChildProcessWithoutNullStreams
    try {
      processTreeOwnership = createPosixProcessTreeOwnership(sandboxed?.env ?? baseEnv, platform)
      child = spawn(
        sandboxed?.executable ?? invocation.executable,
        sandboxed?.args ?? invocation.args,
        {
          cwd: options.cwd,
          env: processTreeOwnership.env,
          // On POSIX this makes the shell the leader of a private process group/session. Keep its handle
          // and stdio referenced (no unref), preserving normal completion while enabling safe -PGID kills.
          detached: platform !== 'win32'
        }
      )
    } catch (error) {
      launchOwnership?.abort()
      spawnAdmission?.notStarted()
      endSandboxExecution?.()
      let complete = false
      try {
        complete = cleanupCompleted(
          await cleanupSandboxWithRetry('spawn-failed', { processesTerminated: true })
        )
      } catch {
        // The stable cleanup failure below preserves the executor's never-reject contract.
      }
      const result: NotebookShellResult = {
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: null
      }
      return complete ? result : withIncompleteCleanup(result, 'not-started')
    }
    spawnAdmission?.started()
    if (platform !== 'win32' && process.platform !== 'win32')
      trackOwnedPosixProcessTree(child, processTreeOwnership.token)

    return new Promise((resolve) => {
      let releaseProcessOwnership: (() => void) | undefined
      try {
        releaseProcessOwnership = launchOwnership
          ? launchOwnership.claim(child, platform)
          : options.claimProcess?.(child, platform)
      } catch (error) {
        // spawn can emit its error asynchronously after the missing PID made claim fail.
        child.once('error', () => undefined)
        let reaped = false
        // A failed spawn has no process to signal; a no-PID handle must never reach POSIX kill.
        const termination =
          child.pid === undefined ? Promise.resolve({ reaped: true }) : terminateProcessTree(child)
        void termination
          .then((result) => {
            reaped = result.reaped
            if (reaped) launchOwnership?.abort()
          })
          .catch(() => {
            // Retain the ownership receipt when cleanup cannot prove that the child tree is gone.
          })
          .finally(async () => {
            endSandboxExecution?.()
            try {
              if (reaped)
                reaped = cleanupCompleted(
                  await cleanupSandboxWithRetry('spawn-failed', { processesTerminated: reaped })
                )
            } catch {
              reaped = false
            }
            const result: NotebookShellResult = {
              stdout: '',
              stderr: error instanceof Error ? error.message : String(error),
              exitCode: null
            }
            if (!reaped) Object.defineProperty(result, 'ownedTreeReaped', { value: false })
            resolve(result)
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
      let exited = false
      let failed = false

      const finish = async (
        result: NotebookShellResult,
        cleanupReason: NotebookSandboxCleanupReason,
        processOutcome: NotebookSandboxProcessOutcome
      ): Promise<void> => {
        if (settled) return
        settled = true
        clearTimeout(timeoutTimer)
        options.signal?.removeEventListener('abort', abort)
        // A receipt is removal authority and recovery evidence. Keep it whenever full-tree teardown
        // cannot be proved so startup recovery can retry and new work remains fenced fail-closed.
        endSandboxExecution?.()
        const normalized =
          runtimeBinding.kind === 'powershell'
            ? normalizePowerShellStderr(result.stderr, runtimePlatform)
            : result.stderr
        const stderr = sandboxed ? sandboxed.annotateStderr(normalized) : normalized
        let complete = false
        try {
          complete = cleanupCompleted(
            await cleanupSandboxWithRetry(cleanupReason, {
              ...processOutcome,
              ...(!processOutcome.processesTerminated && runtimeBinding.kind === 'native-posix'
                ? {
                    confirmTermination: async () => {
                      const { reaped } = await terminateShellOnTimeout(
                        child,
                        platform,
                        options.terminateTree
                      )
                      if (reaped) releaseProcessOwnership?.()
                      return reaped
                    }
                  }
                : {})
            })
          )
        } catch {
          complete = false
        }
        if (complete) releaseProcessOwnership?.()
        const normalizedResult = { ...result, stderr }
        const completed = complete
          ? normalizedResult
          : withIncompleteCleanup(normalizedResult, 'may-have-run')
        if (!processOutcome.processesTerminated || !complete)
          Object.defineProperty(completed, 'ownedTreeReaped', { value: false })
        resolve(completed)
      }

      const terminateAndFinish = (
        result: NotebookShellResult,
        cleanupReason: 'cancel' | 'timeout'
      ): void => {
        void terminateShellOnTimeout(child, platform, options.terminateTree).then(({ reaped }) => {
          void finish(result, cleanupReason, { processesTerminated: reaped })
        })
      }

      const abort = (): void => {
        if (settled || timedOut || cancelled || exited || failed) return
        cancelled = true
        clearTimeout(timeoutTimer)
        terminateAndFinish(
          {
            stdout,
            stderr:
              stderr +
              `${stderr && !stderr.endsWith('\n') ? '\n' : ''}Shell command was cancelled.`,
            exitCode: null,
            cancelled: true
          },
          'cancel'
        )
      }

      const timeoutTimer = setTimeout(() => {
        if (settled || cancelled || exited || failed) return
        timedOut = true
        const timeoutResult: NotebookShellResult = {
          stdout,
          stderr:
            stderr +
            `${stderr && !stderr.endsWith('\n') ? '\n' : ''}Shell command timed out after ${timeoutMs}ms and was killed.`,
          exitCode: null,
          ...(truncated ? { truncated: true } : {})
        }
        terminateAndFinish(timeoutResult, 'timeout')
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
        if (timedOut || cancelled || exited || failed) return
        failed = true
        clearTimeout(timeoutTimer)
        void terminateShellOnTimeout(child, platform, options.terminateTree).then(({ reaped }) => {
          void finish(
            {
              stdout,
              stderr: stderr || error.message,
              exitCode: null,
              ...(truncated ? { truncated: true } : {})
            },
            'spawn-failed',
            { processesTerminated: reaped }
          )
        })
      })
      child.once('exit', (code) => {
        if (timedOut || cancelled || exited || failed) return
        exited = true
        clearTimeout(timeoutTimer)
        void terminateShellOnTimeout(child, platform, options.terminateTree).then(({ reaped }) => {
          // On Windows, taskkill runs after Node observes the PowerShell exit and can report that
          // the PID no longer exists. A numeric exit code is authoritative for this normal native
          // completion; timeout/cancel and WSL guest cleanup retain their stricter ownership checks.
          const processesTerminated =
            reaped ||
            (platform === 'win32' && runtimeBinding.kind === 'powershell' && code !== null)
          void finish(
            { stdout, stderr, exitCode: code, ...(truncated ? { truncated: true } : {}) },
            'exit',
            { processesTerminated }
          )
        })
      })
    })
  }

  return run().catch((error: unknown) =>
    error instanceof ShellPreparationError
      ? error.result
      : {
          stdout: '',
          stderr: error instanceof Error ? error.message : String(error),
          exitCode: null
        }
  )
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
    let preparedLaunch: PreparedShellLaunch
    try {
      preparedLaunch = await prepareShellLaunch(request, this.platform, this.processSandbox)
    } catch (error) {
      if (!(error instanceof ShellPreparationError)) throw error
      return { execute: async () => error.result, dispose: () => undefined }
    }
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
  resolveShellProcessInvocation,
  runShellCommand,
  terminateShellOnTimeout
}
export type { NotebookShellProcess, NotebookShellProcessRequest, NotebookShellResult }
