import { nodeRuntimeEnvironment } from '../node-process-host'
import { createManagedOutputRedactor, redactManagedOutput } from './managed-output-redaction'
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { ShellCellSession } from './shell-cell-session'
import { dirname } from 'node:path'
import {
  resolveManagedShellExecutionCapability,
  type ManagedShellExecutionCapability
} from './managed-shell-execution'
import type { NotebookExecutionRecovery } from '../../shared/execution-recovery'
import { assertShellSearchScope } from './shell-search-scope'
import type { ShellProcessLaunchOwnership } from './shell-process-ownership.windows-posix'
import type { GrantedLocalRoot } from '../../shared/local-fs'

import { protectManagedRuntimeWrites, detectManagedRuntimeMutation } from './managed-runtime-guard'
import { wsl2BashPreviewStatus } from '../wsl/wsl2-preview-gate'
import {
  type NotebookProcessSandbox,
  type NotebookSandboxCleanupReason,
  type NotebookSandboxCleanupResult,
  type NotebookSandboxProcessOutcome,
  withNotebookSandboxProcessState
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
import {
  resolveWindowsNotebookRuntime,
  windowsNotebookRuntimeEnvironment
} from './windows-notebook-runtime'
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
  prepareShellNpmEnvironment,
  shellNpmPaths,
  shellNpmReadRoots
} from './shell-npm-environment'
import {
  defaultShellRuntimeBinding,
  shellRuntimePlatform,
  shellRuntimeSandboxTarget
} from './shell-runtime'

const SHELL_TIMEOUT_MESSAGE_RESERVE_BYTES = 256
const SHELL_CLEANUP_INCOMPLETE_MESSAGE =
  'SHELL_CLEANUP_INCOMPLETE: Shell execution cleanup did not complete; the result is not trusted.'
const SHELL_NETWORK_TRANSPORT_UNSUPPORTED_PREFIX = 'WSL2_NETWORK_TRANSPORT_UNSUPPORTED:'

// Result of one bash_execute run. No status/traceback classification: the shell is
// expected to fail non-zero sometimes, so the caller inspects exitCode directly instead of a
// completed/failed status flag.
type NotebookShellResult = {
  stdout: string
  stderr: string
  exitCode: number | null
  cwd?: string
  cwdBefore?: string
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
  /** Main-only authority; never accepted by a public request schema. */
  managedExecution?: ManagedShellExecutionCapability
  executionInvocationId?: string
  laneKey?: string
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
  grantedRoots?: readonly GrantedLocalRoot[]
}

// Runtime-private port: platform invocation, encoding, env projection, and teardown stay in its adapter.
type NotebookShellProcess = {
  execute(request: NotebookShellProcessRequest): Promise<NotebookShellResult>
  confirmManagedCleanup?(
    scope: { projectId: string; sessionId: string; runId: string },
    retry?: boolean
  ): Promise<{
    state: 'verified' | 'running' | 'cleanup-pending' | 'unknown'
    reaped: boolean
  }>
  shutdown?(scope: {
    projectId?: string
    sessionId?: string
    laneKey?: string
  }): Promise<{ reaped: boolean }>
  prepare?(request: NotebookShellProcessRequest): Promise<{
    execute(signal?: AbortSignal): Promise<NotebookShellResult>
    dispose(): void
  }>
}

type PreparedShellLaunch = {
  onOutput?: import('./managed-shell-execution').ManagedShellExecutionPolicy['onOutput']
  privateServiceValues?: readonly string[]
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
  workloadCacheEnv?: NodeJS.ProcessEnv,
  binding: ShellRuntimeBinding = defaultShellRuntimeBinding(platform)
): NodeJS.ProcessEnv => {
  const env = buildNotebookShellEnvironment(handoffDir, platform, sourceEnv)
  if (runtimeRoot) {
    Object.assign(env, workloadCacheEnv ?? notebookWorkloadCacheEnv(runtimeRoot))
  }
  return binding.kind === 'powershell' && binding.version === '7.6'
    ? windowsNotebookRuntimeEnvironment(env, resolveWindowsNotebookRuntime())
    : env
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
    'try {',
    'if ($Error.Count -gt 0) { throw $Error[0] }',
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
        executable:
          binding.version === '7.6'
            ? resolveWindowsNotebookRuntime().powershell
            : resolveWindowsPowerShellExecutable(),
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
    : protectManagedRuntimeWrites(invocation, runtimeRoot, hostPlatform, [
        shellNpmPaths(runtimeRoot, shellRuntimePlatform(runtimeBinding, hostPlatform)).prefix
      ])
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
  constructor(
    readonly result: NotebookShellResult,
    readonly retryCleanup?: () => Promise<boolean>
  ) {
    super(result.stderr)
  }
}

const prepareShellLaunch = async (
  options: NotebookShellProcessRequest & {
    previewAvailable?: () => boolean
    launchCommand?: string
    windowsShellControlPipe?: string
    deferExecution?: boolean
  },
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
    launchCommand?: string
    windowsShellControlPipe?: string
    deferExecution?: boolean
  }
): Promise<PreparedShellLaunch> => {
  const hostPlatform = options.platform ?? process.platform
  const managed = options.managedExecution
    ? resolveManagedShellExecutionCapability(options.managedExecution, options)
    : undefined
  if (
    managed &&
    (!options.processSandbox ||
      (options.runtimeBinding ?? defaultShellRuntimeBinding(hostPlatform)).kind !== 'native-posix')
  ) {
    throw new Error('Managed Shell execution requires the native process sandbox.')
  }
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
  if (hostPlatform === 'win32' && runtimeBinding.kind === 'powershell') {
    try {
      await options.processSandbox?.resolveWindowsRuntime?.({
        runtime: 'bash',
        binding: runtimeBinding,
        signal: options.signal
      })
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
  }
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
  await assertShellSearchScope(
    options.command,
    options.cwd,
    options.grantedRoots ?? [],
    runtimePlatform,
    options.signal,
    runtimeBinding,
    managed
      ? {
          projectId: managed.projectId,
          sessionId: managed.sessionId,
          executionInvocationId: managed.executionInvocationId,
          capability: options.managedExecution!
        }
      : undefined
  )

  let shellEnv: NodeJS.ProcessEnv
  let workloadCacheEnv: NodeJS.ProcessEnv
  let npmReadRoots: string[] = []
  let localService: import('./process-sandbox').NotebookLocalService | undefined
  try {
    if (managed) {
      // No host environment, shared npm/cache storage, or implicit workspace grants enter this run.
      shellEnv = { ...managed.environment, ...managed.privateEnvironment }
      workloadCacheEnv = {}
      if (managed.localService) {
        if (hostPlatform !== 'darwin' || !options.runId) {
          throw new Error('Managed local services require a native macOS Run owner.')
        }
        // Load the native service adapter only for this capability. Ordinary Notebook consumers
        // (including recovery subprocesses) do not require this ESM-only runtime package.
        const { validateLocalService } = await import('@aipoch/notebook-network-sandbox')
        options.signal?.throwIfAborted()
        const socketPath = await managed.localService.prepareSocket({
          runId: options.runId,
          signal: options.signal
        })
        options.signal?.throwIfAborted()
        localService = validateLocalService(
          { executionId: options.runId, socketPath },
          hostPlatform
        )
        shellEnv.OPEN_SCIENCE_SERVICE_SOCKET = localService.socketPath
        shellEnv.OPEN_SCIENCE_SERVICE_PORT = String(managed.localService.logicalPort)
        if (managed.localService.proof) {
          shellEnv.OPEN_SCIENCE_SERVICE_PROOF = managed.localService.proof.value
          shellEnv.OPEN_SCIENCE_SERVICE_PROOF_PATH = managed.localService.proof.path
        }
      }
    } else {
      workloadCacheEnv = prepareNotebookWorkloadCache(options.runtimeRoot)
      shellEnv = options.environment
        ? { ...options.environment }
        : buildShellEnv(
            options.handoffDir,
            runtimePlatform,
            process.env,
            options.runtimeRoot,
            workloadCacheEnv,
            runtimeBinding
          )
      // Resolve host npm before injecting the workload-writable global bin into PATH.
      if (options.processSandbox && runtimeBinding.kind === 'native-posix') {
        npmReadRoots = shellNpmReadRoots(shellEnv, runtimePlatform)
      }
      shellEnv = prepareShellNpmEnvironment(options.runtimeRoot, runtimePlatform, shellEnv)
      if (options.inputRoot) shellEnv.OPEN_SCIENCE_INPUT_DIR = options.inputRoot
      else delete shellEnv.OPEN_SCIENCE_INPUT_DIR
    }
  } catch (error) {
    throw new ShellPreparationError({
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      exitCode: null,
      ...(managed
        ? {
            runtimeStatus: 'unavailable' as const,
            errorCode: 'shell-runtime-unavailable' as const,
            recovery: { execution: 'not-started' as const, retryAfter: 'runtime-ready' as const },
            ...(options.signal?.aborted ? { cancelled: true } : {})
          }
        : {})
    })
  }

  const platform = hostPlatform
  const invocation = resolveShellProcessInvocation(
    options.launchCommand ?? options.command,
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
          pathEnvironment: managed
            ? {}
            : {
                OPEN_SCIENCE_HANDOFF_DIR: options.handoffDir,
                ...workloadCacheEnv,
                NPM_CONFIG_PREFIX: shellEnv.NPM_CONFIG_PREFIX,
                NPM_CONFIG_CACHE: shellEnv.NPM_CONFIG_CACHE,
                ...(options.inputRoot ? { OPEN_SCIENCE_INPUT_DIR: options.inputRoot } : {})
              },
          cwd: options.cwd,
          commandText: options.command,
          ...(options.executionReference ? { executionReference: options.executionReference } : {}),
          ...(localService ? { localService } : {}),
          ...(managed?.confinement ? { confinement: managed.confinement } : {}),
          sessionId: options.sessionId,
          projectId: options.projectId,
          runtime: 'bash',
          ...(options.windowsShellControlPipe
            ? { windowsShellControlPipe: options.windowsShellControlPipe }
            : {}),
          ...(platform === 'win32' && runtimeBinding.kind === 'powershell'
            ? { superviseProcessTree: true }
            : {}),
          filesystem: managed
            ? {
                readOnlyRoots: [
                  dirname(invocation.executable),
                  ...managed.filesystem.readOnlyRoots
                ],
                readWriteRoots: [
                  ...managed.filesystem.readWriteRoots,
                  ...(localService ? [dirname(localService.socketPath)] : [])
                ],
                deniedReadRoots: [
                  ...managed.filesystem.deniedReadRoots,
                  ...(options.protectedDirs ?? [])
                ],
                deniedWriteRoots: [
                  ...managed.filesystem.deniedWriteRoots,
                  ...(options.protectedDirs ?? [])
                ]
              }
            : {
                readOnlyRoots: [
                  options.runtimeRoot,
                  ...(runtimeBinding.kind === 'powershell' && runtimeBinding.version === '7.6'
                    ? [dirname(resolveWindowsNotebookRuntime().node)]
                    : []),
                  ...(options.inputRoot ? [options.inputRoot] : []),
                  ...(runtimeBinding.kind === 'wsl2-bash'
                    ? []
                    : [
                        dirname(invocation.executable),
                        ...(runtimePlatform === 'win32'
                          ? []
                          : [...environmentPathRoots(baseEnv, runtimePlatform), ...npmReadRoots])
                      ])
                ],
                ...(runtimePlatform === 'win32'
                  ? { optionalReadOnlyRoots: environmentPathRoots(baseEnv, runtimePlatform) }
                  : {}),
                readWriteRoots: [
                  options.notebookSessionRoot ?? options.cwd,
                  options.cwd,
                  options.handoffDir,
                  notebookWorkloadCacheRoot(options.runtimeRoot),
                  shellEnv.NPM_CONFIG_PREFIX!
                ],
                deniedReadRoots: options.protectedDirs ?? [],
                deniedWriteRoots: [
                  ...(options.inputRoot ? [options.inputRoot] : []),
                  ...(options.protectedDirs ?? [])
                ]
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
      const retryCleanup =
        error instanceof Error &&
        'retryCleanup' in error &&
        typeof error.retryCleanup === 'function'
          ? (error.retryCleanup.bind(error) as () => Promise<boolean>)
          : undefined
      throw new ShellPreparationError(
        {
          stdout: '',
          stderr: message,
          exitCode: null,
          errorCode: 'shell-cleanup-incomplete',
          ownedTreeReaped: false,
          recovery: { execution: 'not-started', retryAfter: 'cleanup-verified' }
        },
        retryCleanup
      )
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
    ...(managed?.onOutput ? { onOutput: managed.onOutput } : {}),
    ...(managed
      ? {
          privateServiceValues: [
            ...(managed.secretValues ?? []),
            ...(managed.localService?.proof
              ? [managed.localService.proof.value, managed.localService.proof.path]
              : [])
          ]
        }
      : {}),
    endSandboxExecution: options.deferExecution ? undefined : sandboxed?.beginExecution?.()
  }
}

const disposePreparedShellLaunch = (prepared: PreparedShellLaunch): void => {
  prepared.endSandboxExecution?.()
  void prepared.sandboxed
    ?.cleanup(
      'cancel',
      withNotebookSandboxProcessState({ processesTerminated: true }, 'never-started')
    )
    .catch(() => undefined)
}

const runShellCommand = (
  options: NotebookShellProcessRequest & {
    platform?: NodeJS.Platform
    processSandbox?: NotebookProcessSandbox
    claimProcess?: (child: ChildProcess, platform: NodeJS.Platform) => () => void
    prepareProcessOwnership?: (options: { hosted: boolean }) => ShellProcessLaunchOwnership
    preparedLaunch?: PreparedShellLaunch
    terminateTree?: (process: ChildProcess) => Promise<ProcessTreeKillResult>
    previewAvailable?: () => boolean
    onProcess?: (child: ChildProcessWithoutNullStreams) => void
    onCleanupRetry?: (retry: () => Promise<boolean>) => void
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

    let spawnAdmission: { started(): void; notStarted(): void } | undefined
    let launchOwnership: ShellProcessLaunchOwnership | undefined
    const neverStartedCleanup = (reason: 'cancel' | 'spawn-failed'): (() => Promise<boolean>) => {
      let launchReleased = false,
        admissionReleased = false,
        executionEnded = false
      const attempt = (done: boolean, action: () => void): boolean => {
        if (done) return true
        try {
          action()
          return true
        } catch {
          return false
        }
      }
      return async () => {
        // Each original capability must be released, even if an earlier release throws. Retain
        // failed stages for shutdown retry; never recreate a launch intent to clean one up.
        launchReleased = attempt(launchReleased, () => launchOwnership?.abort())
        admissionReleased = attempt(admissionReleased, () => spawnAdmission?.notStarted())
        executionEnded = attempt(executionEnded, () => endSandboxExecution?.())
        let sandboxClean = false
        try {
          sandboxClean = cleanupCompleted(
            await cleanupSandboxWithRetry(
              reason,
              withNotebookSandboxProcessState({ processesTerminated: true }, 'never-started')
            )
          )
        } catch {
          /* The original sandbox cleanup remains available for retry. */
        }
        return launchReleased && admissionReleased && executionEnded && sandboxClean
      }
    }

    if (options.signal?.aborted) {
      const retryCleanup = neverStartedCleanup('cancel')
      options.onCleanupRetry?.(retryCleanup)
      let complete = false
      try {
        complete = await retryCleanup()
      } catch {
        // Preserve the original cleanup capability for the execution owner's retry.
      }
      const cancelled: NotebookShellResult = {
        stdout: '',
        stderr: 'Shell command was cancelled.',
        exitCode: null,
        cancelled: true
      }
      return complete ? cancelled : withIncompleteCleanup(cancelled, 'not-started')
    }

    let processTreeOwnership: ReturnType<typeof createPosixProcessTreeOwnership>
    let child: ChildProcessWithoutNullStreams
    try {
      spawnAdmission = sandboxed?.beginSpawn?.()
      launchOwnership = options.prepareProcessOwnership?.({
        hosted: platform === 'win32' && Boolean(sandboxed?.confirmProcessTreeTermination)
      })
      const ownershipHost = launchOwnership?.host
      processTreeOwnership = createPosixProcessTreeOwnership(sandboxed?.env ?? baseEnv, platform)
      child = spawn(
        ownershipHost ? process.execPath : (sandboxed?.executable ?? invocation.executable),
        ownershipHost
          ? [
              ownershipHost.path,
              ownershipHost.pendingPath,
              ownershipHost.receiptId,
              '--restore-electron-run-as-node',
              JSON.stringify(processTreeOwnership.env?.ELECTRON_RUN_AS_NODE ?? null),
              sandboxed?.executable ?? invocation.executable,
              ...(sandboxed?.args ?? invocation.args)
            ]
          : (sandboxed?.args ?? invocation.args),
        {
          cwd: options.cwd,
          env: ownershipHost
            ? { ...processTreeOwnership.env, ...nodeRuntimeEnvironment() }
            : processTreeOwnership.env,
          windowsHide: true,
          // On POSIX this makes the shell the leader of a private process group/session. Keep its handle
          // and stdio referenced (no unref), preserving normal completion while enabling safe -PGID kills.
          detached: platform !== 'win32'
        }
      )
    } catch (error) {
      const retryCleanup = neverStartedCleanup('spawn-failed')
      options.onCleanupRetry?.(retryCleanup)
      let complete = false
      try {
        complete = await retryCleanup()
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
        if (
          platform === 'win32' &&
          child.pid !== undefined &&
          launchOwnership &&
          sandboxed &&
          (sandboxed.confirmProcessTreeTermination || runtimeBinding.kind === 'wsl2-bash')
        ) {
          // A supervisor or WSL launcher can exit before the separate start-identity query. Keep
          // the durable intent and real result; native tree proof or exact WSL guest cleanup must
          // still succeed in finish() before the intent is released.
          releaseProcessOwnership = launchOwnership.abort
        } else {
          // spawn can emit its error asynchronously after the missing PID made claim fail.
          child.once('error', () => undefined)
          let reaped = false
          let treeReaped = false
          let launchReleased = false
          // A failed spawn has no process to signal; a no-PID handle must never reach POSIX kill.
          const childNeverStarted = child.pid === undefined
          options.onCleanupRetry?.(async () => {
            if (!treeReaped)
              treeReaped = childNeverStarted || (await terminateProcessTree(child)).reaped
            if (!treeReaped) return false
            if (!launchReleased) {
              launchOwnership?.abort()
              launchReleased = true
            }
            return cleanupCompleted(
              await cleanupSandboxWithRetry(
                'spawn-failed',
                withNotebookSandboxProcessState(
                  { processesTerminated: true },
                  childNeverStarted ? 'never-started' : 'started-and-reaped'
                )
              )
            )
          })
          const termination = childNeverStarted
            ? Promise.resolve({ reaped: true })
            : terminateProcessTree(child)
          void termination
            .then((result) => {
              reaped = result.reaped
              treeReaped = reaped
              if (reaped) {
                launchOwnership?.abort()
                launchReleased = true
              }
            })
            .catch(() => {
              // Retain the ownership receipt when cleanup cannot prove that the child tree is gone.
            })
            .finally(async () => {
              endSandboxExecution?.()
              try {
                if (reaped)
                  reaped = cleanupCompleted(
                    await cleanupSandboxWithRetry(
                      'spawn-failed',
                      withNotebookSandboxProcessState(
                        { processesTerminated: reaped },
                        childNeverStarted
                          ? 'never-started'
                          : reaped
                            ? 'started-and-reaped'
                            : 'termination-unknown'
                      )
                    )
                  )
              } catch {
                reaped = false
              }
              reaped = reaped && launchReleased
              const result: NotebookShellResult = {
                stdout: '',
                stderr: error instanceof Error ? error.message : String(error),
                exitCode: null
              }
              const completed = reaped ? result : withIncompleteCleanup(result, 'may-have-run')
              if (!reaped) Object.defineProperty(completed, 'ownedTreeReaped', { value: false })
              resolve(completed)
            })
          return
        }
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

      const stdoutRedactor = createManagedOutputRedactor(prepared.privateServiceValues)
      const stderrRedactor = createManagedOutputRedactor(prepared.privateServiceValues)
      const observe = (stream: 'stdout' | 'stderr', text: string): void => {
        if (!text) return
        try {
          if (options.runId) prepared.onOutput?.({ runId: options.runId, stream, text })
        } catch {
          // An observer never owns execution or cleanup.
        }
      }
      const finish = async (
        result: NotebookShellResult,
        cleanupReason: NotebookSandboxCleanupReason,
        processOutcome: NotebookSandboxProcessOutcome
      ): Promise<void> => {
        if (settled) return
        const stdoutTail = stdoutRedactor.finish()
        const stderrTail = stderrRedactor.finish()
        observe('stdout', stdoutTail)
        observe('stderr', stderrTail)
        result = {
          ...result,
          stdout: result.stdout + stdoutTail,
          stderr: result.stderr + stderrTail
        }
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
        const stderr = sandboxed ? sandboxed.annotateStderr(normalized, result.stdout) : normalized
        let complete = false
        try {
          const nativeProcessState =
            processOutcome.processState === 'never-started'
              ? processOutcome.processState
              : await sandboxed?.confirmProcessState?.().catch(() => undefined)
          const processesTerminated =
            nativeProcessState !== undefined
              ? nativeProcessState !== 'termination-unknown'
              : sandboxed?.confirmProcessTreeTermination
                ? await sandboxed.confirmProcessTreeTermination().catch(() => false)
                : processOutcome.processesTerminated
          // Retain the original native owner's one-time proof for late reconciliation. Once
          // verified, receipt removal may retry without consuming that proof or signalling a PID.
          let nativeTreeReaped = processesTerminated
          const confirmNativeTermination = sandboxed?.confirmProcessTreeTermination
          const cleanupOutcome: NotebookSandboxProcessOutcome = withNotebookSandboxProcessState(
            {
              processesTerminated,
              ...(!processesTerminated && confirmNativeTermination
                ? {
                    confirmTermination: async () => {
                      nativeTreeReaped ||= await confirmNativeTermination()
                      if (nativeTreeReaped) releaseProcessOwnership?.()
                      return nativeTreeReaped
                    }
                  }
                : !processesTerminated && runtimeBinding.kind === 'native-posix'
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
            },
            processesTerminated
              ? nativeProcessState === 'never-started' ||
                processOutcome.processState === 'never-started'
                ? 'never-started'
                : sandboxed?.confirmProcessState
                  ? 'started-and-reaped'
                  : !sandboxed || runtimeBinding.kind === 'native-posix'
                    ? 'started-and-reaped'
                    : 'termination-unknown'
              : 'termination-unknown'
          )
          const retryCleanup = async (): Promise<boolean> => {
            const done = cleanupCompleted(
              await cleanupSandboxWithRetry(cleanupReason, cleanupOutcome)
            )
            if (done) releaseProcessOwnership?.()
            return done
          }
          options.onCleanupRetry?.(retryCleanup)
          complete = await retryCleanup()
        } catch {
          complete = false
        }
        const redactServiceValues = (text: string): string => {
          return redactManagedOutput(text, prepared.privateServiceValues)
        }
        const normalizedResult = {
          ...result,
          stdout: redactServiceValues(result.stdout),
          stderr: redactServiceValues(stderr)
        }
        const completed = complete
          ? normalizedResult
          : withIncompleteCleanup(normalizedResult, 'may-have-run')
        if (!complete) Object.defineProperty(completed, 'ownedTreeReaped', { value: false })
        resolve(completed)
      }

      const terminateAndFinish = (
        result: NotebookShellResult,
        cleanupReason: 'cancel' | 'timeout'
      ): void => {
        // Let the original native supervisor terminate its own Job first. taskkill can kill that
        // supervisor before it publishes the Job-empty proof, which must remain unknown.
        const nativeTeardown = sandboxed?.requestProcessTreeTermination
          ? sandboxed.requestProcessTreeTermination().catch(() => false)
          : Promise.resolve(false)
        void nativeTeardown.then((nativeReaped) => {
          if (nativeReaped) {
            void finish(
              result,
              cleanupReason,
              withNotebookSandboxProcessState({ processesTerminated: true }, 'started-and-reaped')
            )
            return
          }
          void terminateShellOnTimeout(child, platform, options.terminateTree).then(
            ({ reaped }) => {
              void finish(
                result,
                cleanupReason,
                withNotebookSandboxProcessState(
                  { processesTerminated: reaped },
                  reaped && !sandboxed?.confirmProcessTreeTermination
                    ? 'started-and-reaped'
                    : 'termination-unknown'
                )
              )
            }
          )
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
        if (options.onProcess) return
        chunk = stdoutRedactor.push(chunk)
        observe('stdout', chunk)
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
        if (options.onProcess) return
        chunk = stderrRedactor.push(chunk)
        observe('stderr', chunk)
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
            withNotebookSandboxProcessState(
              { processesTerminated: reaped },
              child.pid === undefined
                ? 'never-started'
                : reaped
                  ? 'started-and-reaped'
                  : 'termination-unknown'
            )
          )
        })
      })
      child.once('exit', (code) => {
        if (timedOut || cancelled || exited || failed) return
        exited = true
        clearTimeout(timeoutTimer)
        if (sandboxed?.confirmProcessTreeTermination) {
          // The helper has already stopped its Job Object. Its proof, not an absent/reused PID or
          // a successful leader exit, establishes full-tree termination in finish().
          void finish(
            { stdout, stderr, exitCode: code, ...(truncated ? { truncated: true } : {}) },
            'exit',
            withNotebookSandboxProcessState({ processesTerminated: false }, 'termination-unknown')
          )
          return
        }
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
            withNotebookSandboxProcessState(
              { processesTerminated },
              processesTerminated ? 'started-and-reaped' : 'termination-unknown'
            )
          )
        })
      })
      if (options.onProcess) {
        clearTimeout(timeoutTimer)
        options.onProcess(child)
      }
    })
  }

  return run().catch((error: unknown) => {
    let result: NotebookShellResult
    if (error instanceof ShellPreparationError) {
      if (error.retryCleanup) options.onCleanupRetry?.(error.retryCleanup)
      result = error.result
    } else {
      result = {
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: null
      }
    }
    // Preparation can fail before PreparedShellLaunch exists. Never let its error projection
    // bypass the same redaction boundary used by live and completed process output.
    if (options.managedExecution) {
      let secrets: readonly string[] = []
      try {
        const policy = resolveManagedShellExecutionCapability(
          options.managedExecution,
          options,
          true
        )
        secrets = [
          ...(policy.secretValues ?? []),
          ...(policy.localService?.proof
            ? [policy.localService.proof.value, policy.localService.proof.path]
            : [])
        ]
      } catch {
        // An invalid capability carries no accessible private bindings.
      }
      result = {
        ...result,
        stdout: redactManagedOutput(result.stdout, secrets),
        stderr: redactManagedOutput(result.stderr, secrets)
      }
    }
    return result
  })
}

type BoundedShellExecution = {
  identity: Pick<NotebookShellProcessRequest, 'projectId' | 'sessionId' | 'laneKey' | 'runId'>
  controller: AbortController
  completion: Promise<NotebookShellResult>
  result?: NotebookShellResult
  cleanupVerified?: boolean
  retryCleanup?: () => Promise<boolean>
  shutdown?: Promise<{ reaped: boolean }>
}

const shellCleanupVerified = (result: NotebookShellResult): boolean =>
  result.ownedTreeReaped !== false && result.errorCode !== 'shell-cleanup-incomplete'

// Each lane owns a live interpreter; runShellCommand remains the one-shot spawn/cleanup owner.
class NotebookShellProcessAdapter implements NotebookShellProcess {
  private readonly sessions = new Map<string, ShellCellSession>()
  private readonly unconfirmedPersistentSessions = new Set<string>()
  // Lifecycle handles only. runShellCommand and the existing receipt registry own every process.
  private readonly boundedExecutions = new Set<BoundedShellExecution>()
  // Cleanup outcomes/closures from the original owner, never a second PID registry.
  private readonly managedExecutions = new Map<string, BoundedShellExecution>()
  private readonly managedCleanupProofs = new Map<
    string,
    { projectId: string; sessionId: string }
  >()
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
        hosted?: boolean
      }): ShellProcessLaunchOwnership
    },
    private readonly executionMode: 'persistent' | 'bounded' = 'persistent'
  ) {}

  async prepare(request: NotebookShellProcessRequest): Promise<{
    execute(signal?: AbortSignal): Promise<NotebookShellResult>
    dispose(): void
  }> {
    let consumed = false
    return {
      execute: (signal?: AbortSignal) => {
        if (consumed)
          return Promise.reject(new Error('Prepared Shell launch was already consumed.'))
        consumed = true
        return this.execute({
          ...request,
          ...(signal ? { signal } : {})
        })
      },
      dispose: () => {
        if (consumed) return
        consumed = true
      }
    }
  }

  async execute(request: NotebookShellProcessRequest): Promise<NotebookShellResult> {
    request = {
      ...request,
      runtimeBinding: request.runtimeBinding ?? defaultShellRuntimeBinding(this.platform)
    }
    // Only a main-issued invocation capability selects bounded execution in a normal adapter.
    // The constructor mode remains a compatibility seam for existing bounded-only consumers.
    if (request.managedExecution) {
      const policy = resolveManagedShellExecutionCapability(request.managedExecution, request, true)
      request = {
        ...request,
        cwd: policy.cwd,
        environment: { ...policy.environment },
        ...(policy.signal
          ? {
              signal: request.signal
                ? AbortSignal.any([request.signal, policy.signal])
                : policy.signal
            }
          : {})
      }
    }
    const bounded = Boolean(request.managedExecution) || this.executionMode === 'bounded'
    const persistentCleanupPending =
      bounded &&
      [...this.unconfirmedPersistentSessions].some((key) => {
        const identity = this.sessions.get(key)?.identity
        return (
          identity?.projectId === request.projectId &&
          identity.sessionId === request.sessionId &&
          identity.laneKey === request.laneKey
        )
      })
    if (this.hasUnconfirmedBoundedExecution(request) || persistentCleanupPending)
      return Promise.resolve({
        stdout: '',
        stderr: SHELL_CLEANUP_INCOMPLETE_MESSAGE,
        exitCode: null,
        errorCode: 'shell-cleanup-incomplete',
        ownedTreeReaped: false,
        recovery: { execution: 'not-started', retryAfter: 'cleanup-verified' }
      })
    if (bounded) {
      return this.executeBounded(request)
    }
    const key = JSON.stringify([
      request.projectId,
      request.sessionId,
      request.laneKey ?? request.notebookSessionRoot,
      request.runtimeBinding
    ])
    let session = this.sessions.get(key)
    if (!session) {
      session = new ShellCellSession(
        request,
        async (cell, startup, signal, onProcess, controlPipe) => {
          let preparedLaunch: PreparedShellLaunch
          try {
            preparedLaunch = await prepareShellLaunch(
              {
                ...cell,
                signal,
                launchCommand: startup,
                deferExecution: true,
                windowsShellControlPipe: controlPipe
              },
              this.platform,
              this.processSandbox
            )
          } catch (error) {
            if (!(error instanceof ShellPreparationError)) throw error
            return {
              completion: Promise.resolve(error.result),
              retryCleanup: error.retryCleanup,
              beginExecution: () => () => undefined
            }
          }
          let retryCleanup: (() => Promise<boolean>) | undefined
          return {
            completion: runShellCommand({
              ...cell,
              signal,
              platform: this.platform,
              preparedLaunch,
              onProcess,
              onCleanupRetry: (retry) => {
                retryCleanup = retry
              },
              ...this.ownershipClaim(cell)
            }),
            beginExecution: (command) =>
              preparedLaunch.sandboxed?.beginExecution?.({ commandText: command }) ??
              (() => undefined),
            retryCleanup: async () => (await retryCleanup?.()) ?? false
          }
        },
        async (cell) => {
          await assertShellSearchScope(
            cell.command,
            cell.cwd,
            cell.grantedRoots ?? [],
            shellRuntimePlatform(cell.runtimeBinding!, this.platform),
            cell.signal,
            cell.runtimeBinding
          )
          const mutation = detectManagedRuntimeMutation({
            source: cell.command,
            surface: cell.runtimeBinding?.kind === 'powershell' ? 'powershell' : 'bash',
            runtimeRoot: cell.runtimeRoot,
            cwd: cell.cwd,
            platform: shellRuntimePlatform(cell.runtimeBinding!, this.platform)
          })
          if (mutation) throw new Error(`MANAGED_RUNTIME_MUTATION_BLOCKED: ${mutation.message}`)
        },
        Boolean(this.processSandbox)
      )
      this.sessions.set(key, session)
    }
    const result = await session.execute(request)
    if (shellCleanupVerified(result)) this.unconfirmedPersistentSessions.delete(key)
    else this.unconfirmedPersistentSessions.add(key)
    return result
  }

  async shutdown(
    scope: { projectId?: string; sessionId?: string; laneKey?: string } = {}
  ): Promise<{ reaped: boolean }> {
    const drainBounded = async (): Promise<{ reaped: boolean }> => {
      const selected = [...this.boundedExecutions].filter(
        ({ identity }) =>
          (scope.projectId === undefined || identity.projectId === scope.projectId) &&
          (scope.sessionId === undefined || identity.sessionId === scope.sessionId) &&
          (scope.laneKey === undefined || identity.laneKey === scope.laneKey)
      )
      for (const execution of selected) execution.controller.abort()
      const results = await Promise.all(
        selected.map((execution) => {
          if (!execution.shutdown) {
            execution.shutdown = (async (): Promise<{ reaped: boolean }> => {
              let reaped = false
              try {
                const result = await execution.completion
                reaped = shellCleanupVerified(result) || (await execution.retryCleanup?.()) === true
              } catch {
                // A failed cleanup never discards the original owner or its retry capability.
              }
              if (reaped) {
                execution.cleanupVerified = true
                this.boundedExecutions.delete(execution)
                this.rememberManagedCleanup(execution)
              }
              return { reaped }
            })().finally(() => {
              execution.shutdown = undefined
            })
          }
          return execution.shutdown
        })
      )
      return { reaped: results.every((result) => result.reaped) }
    }
    // One adapter can own both ordinary persistent interpreters and managed bounded executions.
    const bounded = drainBounded()
    const selected = [...this.sessions].filter(
      ([, session]) =>
        (scope.projectId === undefined || session.identity.projectId === scope.projectId) &&
        (scope.sessionId === undefined || session.identity.sessionId === scope.sessionId) &&
        (scope.laneKey === undefined || session.identity.laneKey === scope.laneKey)
    )
    const results = await Promise.all(
      selected.map(async ([key, session]) => {
        const result = await session.shutdown()
        if (result.reaped && this.sessions.get(key) === session) {
          this.sessions.delete(key)
          this.unconfirmedPersistentSessions.delete(key)
        } else if (!result.reaped) {
          this.unconfirmedPersistentSessions.add(key)
        }
        return result
      })
    )
    return { reaped: (await bounded).reaped && results.every((result) => result.reaped) }
  }

  private hasUnconfirmedBoundedExecution(request: NotebookShellProcessRequest): boolean {
    return [...this.boundedExecutions].some(
      ({ identity, result }) =>
        result !== undefined &&
        !shellCleanupVerified(result) &&
        identity.projectId === request.projectId &&
        identity.sessionId === request.sessionId &&
        identity.laneKey === request.laneKey
    )
  }

  async confirmManagedCleanup(
    scope: { projectId: string; sessionId: string; runId: string },
    retry = false
  ): Promise<{ state: 'verified' | 'running' | 'cleanup-pending' | 'unknown'; reaped: boolean }> {
    const proof = this.managedCleanupProofs.get(scope.runId)
    if (proof?.projectId === scope.projectId && proof.sessionId === scope.sessionId) {
      return { state: 'verified', reaped: true }
    }
    const execution = this.managedExecutions.get(scope.runId)
    if (
      !execution ||
      execution.identity.projectId !== scope.projectId ||
      execution.identity.sessionId !== scope.sessionId
    )
      return { state: 'unknown', reaped: false }
    if (!execution.result) return { state: 'running', reaped: false }
    if (execution.cleanupVerified || shellCleanupVerified(execution.result))
      return { state: 'verified', reaped: true }
    if (!retry) return { state: 'cleanup-pending', reaped: false }
    if (!execution.shutdown) {
      execution.shutdown = (async () => {
        const reaped = (await execution.retryCleanup?.().catch(() => false)) === true
        if (reaped) {
          this.boundedExecutions.delete(execution)
          // Preserve historical failure output; only the retained owner's cleanup fact advances.
          execution.cleanupVerified = true
          this.rememberManagedCleanup(execution)
        }
        return { reaped }
      })().finally(() => {
        execution.shutdown = undefined
      })
    }
    const { reaped } = await execution.shutdown
    return { state: reaped ? 'verified' : 'cleanup-pending', reaped }
  }

  private rememberManagedCleanup(execution: BoundedShellExecution): void {
    const { runId, projectId, sessionId } = execution.identity
    if (runId && this.managedExecutions.get(runId) === execution) {
      this.managedCleanupProofs.set(runId, { projectId, sessionId })
      // Keep original cleanup closures only while unconfirmed; a positive fact needs no process,
      // completion promise or captured output retained in memory.
      this.managedExecutions.delete(runId)
    }
  }

  private executeBounded(request: NotebookShellProcessRequest): Promise<NotebookShellResult> {
    const controller = new AbortController()
    const abort = (): void => controller.abort(request.signal?.reason)
    request.signal?.addEventListener('abort', abort, { once: true })
    if (request.signal?.aborted) abort()
    // Register before preparation starts, so shutdown also covers an in-flight sandbox wrap.
    const completion: Promise<NotebookShellResult> = Promise.resolve()
      .then(() =>
        runShellCommand({
          ...request,
          signal: controller.signal,
          platform: this.platform,
          processSandbox: this.processSandbox,
          ...this.ownershipClaim(request),
          onCleanupRetry: (retry) => {
            execution.retryCleanup = retry
          }
        })
      )
      .then((result) => {
        execution.result = result
        if (shellCleanupVerified(result)) {
          this.boundedExecutions.delete(execution)
          this.rememberManagedCleanup(execution)
        }
        return result
      })
      .finally(() => request.signal?.removeEventListener('abort', abort))
    const execution: BoundedShellExecution = {
      identity: {
        projectId: request.projectId,
        sessionId: request.sessionId,
        laneKey: request.laneKey,
        runId: request.runId
      },
      controller,
      completion
    }
    this.boundedExecutions.add(execution)
    if (request.managedExecution && request.runId)
      this.managedExecutions.set(request.runId, execution)
    return completion
  }

  private ownershipClaim(request: NotebookShellProcessRequest): {
    claimProcess?: (child: ChildProcess, platform: NodeJS.Platform) => () => void
    prepareProcessOwnership?: (options: { hosted: boolean }) => ShellProcessLaunchOwnership
  } {
    if (!this.processOwnership || !request.runId) return {}
    if (this.processOwnership.beginLaunch) {
      return {
        prepareProcessOwnership: ({ hosted }) =>
          this.processOwnership!.beginLaunch!({
            runId: request.runId!,
            projectId: request.projectId,
            sessionId: request.sessionId,
            platform: this.platform,
            hosted: this.platform === 'win32' && hosted
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
