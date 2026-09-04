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
}

type NotebookShellProcessRequest = {
  command: string
  cwd: string
  handoffDir: string
  runtimeRoot: string
  notebookSessionRoot?: string
  inputRoot?: string
  protectedDirs?: readonly string[]
  sessionId: string
  projectId: string
  timeoutMs?: number
  signal?: AbortSignal
}

// Runtime-private port: platform invocation, encoding, env projection, and teardown stay in its adapter.
type NotebookShellProcess = {
  execute(request: NotebookShellProcessRequest): Promise<NotebookShellResult>
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

// Cancellation and timeout settle only after the bounded process-tree terminator finishes, so callers
// may safely tear down or remove the Session workspace after this promise resolves.
const terminateShellOnTimeout = async (
  child: ChildProcess,
  terminateTree: (process: ChildProcess) => Promise<unknown> = terminateProcessTree
): Promise<void> => {
  try {
    await terminateTree(child)
  } catch {
    // Preserve runShellCommand's never-reject contract even when the best-effort terminator fails.
  }
}

// Runs one fresh platform-native process with the Session cwd and handoff channel. Spawn failure,
// non-zero exit, and timeout all resolve as ordinary results instead of rejecting.
const runShellCommand = (
  options: NotebookShellProcessRequest & {
    platform?: NodeJS.Platform
    processSandbox?: NotebookProcessSandbox
  }
): Promise<NotebookShellResult> => {
  const run = async (): Promise<NotebookShellResult> => {
    if (options.signal?.aborted) {
      return {
        stdout: '',
        stderr: 'Shell command was cancelled.',
        exitCode: null,
        cancelled: true
      }
    }

    let shellEnv: NodeJS.ProcessEnv
    try {
      const workloadCacheEnv = prepareNotebookWorkloadCache(options.runtimeRoot)
      shellEnv = buildShellEnv(
        options.handoffDir,
        options.platform ?? process.platform,
        process.env,
        options.runtimeRoot,
        workloadCacheEnv
      )
    } catch (error) {
      return {
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: null
      }
    }

    const timeoutMs = options.timeoutMs ?? NOTEBOOK_SHELL_DEFAULT_TIMEOUT_MS
    const platform = options.platform ?? process.platform
    const nativeInvocation = resolveShellInvocation(options.command, platform)
    const invocation = options.processSandbox
      ? nativeInvocation
      : protectManagedRuntimeWrites(nativeInvocation, options.runtimeRoot, platform)
    const baseEnv = shellEnv
    const sandboxed = options.processSandbox
      ? await options.processSandbox.wrap({
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
    const endSandboxExecution = sandboxed?.beginExecution?.()

    return new Promise((resolve) => {
      const child = spawn(
        sandboxed?.executable ?? invocation.executable,
        sandboxed?.args ?? invocation.args,
        {
          cwd: options.cwd,
          env: sandboxed?.env ?? baseEnv,
          // On POSIX this makes the shell the leader of a private process group/session. Keep its handle
          // and stdio referenced (no unref), preserving normal completion while enabling safe -PGID kills.
          detached: platform !== 'win32'
        }
      )
      if (platform !== 'win32') registerOwnedPosixProcessGroup(child)

      let stdout = ''
      let stderr = ''
      let stdoutBytes = 0
      let stderrBytes = 0
      let truncated = false
      let settled = false
      // Timeout owns settlement even if Windows taskkill emits exit before its promise resolves.
      let timedOut = false
      let cancelled = false

      const finish = (result: NotebookShellResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timeoutTimer)
        options.signal?.removeEventListener('abort', abort)
        endSandboxExecution?.()
        const normalized = normalizePowerShellStderr(result.stderr)
        const stderr = sandboxed ? sandboxed.annotateStderr(normalized) : normalized
        sandboxed?.cleanup()
        resolve({ ...result, stderr })
      }

      const terminateAndFinish = (result: NotebookShellResult): void => {
        void terminateShellOnTimeout(child).then(() => finish(result))
      }

      const abort = (): void => {
        if (settled || timedOut || cancelled) return
        cancelled = true
        clearTimeout(timeoutTimer)
        terminateAndFinish({
          stdout,
          stderr:
            stderr + `${stderr && !stderr.endsWith('\n') ? '\n' : ''}Shell command was cancelled.`,
          exitCode: null,
          cancelled: true
        })
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

      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
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
      child.stdout.on('data', (chunk: string) => {
        stdout = appendOutput(
          stdout,
          chunk,
          NOTEBOOK_TEXT_LIMIT_BYTES - NOTEBOOK_DIAGNOSTIC_RESERVE_BYTES - stdoutBytes,
          (captured) => {
            stdoutBytes += captured
          }
        )
      })
      child.stderr.on('data', (chunk: string) => {
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
        if (!timedOut && !cancelled)
          finish({
            stdout,
            stderr: stderr || error.message,
            exitCode: null,
            ...(truncated ? { truncated: true } : {})
          })
      })
      child.once('exit', (code) => {
        if (!timedOut && !cancelled)
          finish({ stdout, stderr, exitCode: code, ...(truncated ? { truncated: true } : {}) })
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
    private readonly processSandbox?: NotebookProcessSandbox
  ) {}

  execute(request: NotebookShellProcessRequest): Promise<NotebookShellResult> {
    return runShellCommand({
      ...request,
      platform: this.platform,
      ...(this.processSandbox ? { processSandbox: this.processSandbox } : {})
    })
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
