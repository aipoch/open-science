import { spawn, type ChildProcess } from 'node:child_process'
import { win32 } from 'node:path'

import { protectManagedRuntimeWrites } from './managed-runtime-guard'
import { terminateProcessTree } from '../process-tree'
import { resolveWindowsPowerShellExecutable } from '../windows-powershell'
import { NOTEBOOK_SHELL_DEFAULT_TIMEOUT_MS } from '../../shared/notebook'
import {
  notebookWorkloadCacheEnv,
  prepareNotebookWorkloadCache
} from './notebook-workload-cache-paths'
import {
  NOTEBOOK_DIAGNOSTIC_RESERVE_BYTES,
  NOTEBOOK_TEXT_LIMIT_BYTES,
  limitUtf8
} from './content-limits'

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
}

type NotebookShellProcessRequest = {
  command: string
  cwd: string
  handoffDir: string
  runtimeRoot: string
  timeoutMs?: number
  signal?: AbortSignal
}

// Runtime-private port: platform invocation, encoding, env projection, and teardown stay in its adapter.
type NotebookShellProcess = {
  execute(request: NotebookShellProcessRequest): Promise<NotebookShellResult>
}

// Benign variables the shell may inherit; all other host variables are denied by default.
const SHELL_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TZ',
  'TMPDIR',
  'TEMP',
  'TMP'
]

// Safe OS paths PowerShell and Windows child processes need to locate built-in tools.
const WINDOWS_SHELL_ENV_ALLOWLIST = ['ComSpec', 'PATHEXT', 'SystemRoot', 'WINDIR', 'USERPROFILE']

// Builds a minimal, secret-free environment because the stateless shell cannot enforce the Python
// kernel's protected-dir audit. Only safe host variables and the shared handoff channel are projected;
// filesystem/network egress isolation remains a separate follow-up.
const buildShellEnv = (
  handoffDir: string,
  platform: NodeJS.Platform = process.platform,
  sourceEnv: NodeJS.ProcessEnv = process.env,
  runtimeRoot?: string,
  workloadCacheEnv?: NodeJS.ProcessEnv
): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {}
  const keys =
    platform === 'win32'
      ? [...SHELL_ENV_ALLOWLIST, ...WINDOWS_SHELL_ENV_ALLOWLIST]
      : SHELL_ENV_ALLOWLIST
  for (const key of keys) {
    const value = sourceEnv[key]
    if (value !== undefined) env[key] = value
  }
  if (platform === 'win32') {
    const modulePaths: string[] = []
    const programFiles = sourceEnv.ProgramFiles
    if (programFiles) {
      modulePaths.push(win32.join(programFiles, 'WindowsPowerShell', 'Modules'))
    }
    const windowsRoot = sourceEnv.SystemRoot ?? sourceEnv.WINDIR
    if (windowsRoot) {
      // PowerShell's built-in cmdlets are module-backed. Supplying no PSModulePath makes Windows
      // PowerShell perform extremely slow first-use discovery on hosted machines, while inheriting
      // the host value would expose arbitrary user/third-party modules. Preserve only the standard
      // AllUsers and in-box module locations, excluding CurrentUser and host-specific additions.
      modulePaths.push(win32.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'))
    }
    if (modulePaths.length > 0) {
      const controlledModulePath = modulePaths.join(win32.delimiter)
      env.PSModulePath = controlledModulePath
      // Windows PowerShell reconstructs PSModulePath at startup and can reinsert CurrentUser paths.
      // Carry the controlled value through startup so the wrapper can restore it before user code.
      env.OPEN_SCIENCE_PSMODULEPATH = controlledModulePath
    }
  }
  env.OPEN_SCIENCE_HANDOFF_DIR = handoffDir
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
    : { executable: 'sh', args: ['-c', command] }

// Signals only the independently spawned POSIX shell group. A validated positive child pid is also its
// process-group id because POSIX spawn uses detached:true below. If group signaling is unavailable, fall
// back to the direct handle without allowing timeout cleanup to reject.
const signalPosixShellGroup = (child: ChildProcess, signal: NodeJS.Signals): void => {
  const groupId = child.pid
  if (groupId !== undefined && Number.isSafeInteger(groupId) && groupId > 0) {
    try {
      process.kill(-groupId, signal)
      return
    } catch {
      // The group may already be gone or the platform may reject group signaling; try the leader.
    }
  }

  try {
    child.kill(signal)
  } catch {
    // It exited between the timeout and this best-effort signal.
  }
}

// POSIX returns immediately after arming bounded group teardown. Windows continues to await taskkill so
// callers can safely inspect or remove cwd after PowerShell and every descendant release their handles.
const terminateShellOnTimeout = async (
  child: ChildProcess,
  platform: NodeJS.Platform = process.platform,
  terminateTree: (process: ChildProcess) => Promise<unknown> = terminateProcessTree
): Promise<boolean> => {
  if (platform !== 'win32') {
    signalPosixShellGroup(child, 'SIGTERM')
    setTimeout(() => signalPosixShellGroup(child, 'SIGKILL'), SHELL_KILL_GRACE_MS)
    return false
  }

  try {
    await terminateTree(child)
  } catch {
    // Preserve runShellCommand's never-reject contract even when the best-effort terminator fails.
  }
  return true
}

// Runs one fresh platform-native process with the Session cwd and handoff channel. Spawn failure,
// non-zero exit, and timeout all resolve as ordinary results instead of rejecting.
const runShellCommand = (
  options: NotebookShellProcessRequest & {
    platform?: NodeJS.Platform
  }
): Promise<NotebookShellResult> =>
  new Promise((resolve) => {
    if (options.signal?.aborted) {
      resolve({
        stdout: '',
        stderr: 'Shell command was cancelled.',
        exitCode: null,
        cancelled: true
      })
      return
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
      resolve({
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: null
      })
      return
    }

    const timeoutMs = options.timeoutMs ?? NOTEBOOK_SHELL_DEFAULT_TIMEOUT_MS
    const platform = options.platform ?? process.platform
    const invocation = protectManagedRuntimeWrites(
      resolveShellInvocation(options.command, platform),
      options.runtimeRoot,
      platform
    )
    const child = spawn(invocation.executable, invocation.args, {
      cwd: options.cwd,
      env: shellEnv,
      // On POSIX this makes the shell the leader of a private process group/session. Keep its handle
      // and stdio referenced (no unref), preserving normal completion while enabling safe -PGID kills.
      detached: platform !== 'win32'
    })

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
      resolve({ ...result, stderr: normalizePowerShellStderr(result.stderr) })
    }

    const terminateAndFinish = (result: NotebookShellResult): void => {
      void terminateShellOnTimeout(child, platform).then((usedWindowsTerminator) => {
        if (usedWindowsTerminator) {
          // child.kill() only reaches the PowerShell parent on Windows; taskkill /T /F reaps the
          // full tree. Settle only after it completes so callers can safely inspect or remove cwd.
          finish(result)
          return
        }

        // POSIX group teardown continues in the background so a wedged command tree cannot delay the
        // result. Its SIGKILL timer intentionally survives the shell leader's exit.
        finish(result)
      })
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

// Stateless production adapter: a shared instance adds no queue or process registry.
class NotebookShellProcessAdapter implements NotebookShellProcess {
  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  execute(request: NotebookShellProcessRequest): Promise<NotebookShellResult> {
    return runShellCommand({ ...request, platform: this.platform })
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
