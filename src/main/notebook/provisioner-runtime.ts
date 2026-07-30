import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, realpathSync } from 'node:fs'
import { basename, resolve, sep, win32 } from 'node:path'
import { promisify } from 'node:util'

import { condaActivatedPath } from './runtime-paths'

const execFileAsync = promisify(execFile)

// Marker on the error thrown when a child could NOT be confirmed stopped after a recording failure. The
// caller must then RETAIN the crash-recovery evidence (sidecar + journal) rather than clearing it, since
// a live worker may still be writing the prefix. See killAndConfirmExit / runMicromamba.
export const CHILD_UNCONFIRMED = 'RUNTIME_CHILD_UNCONFIRMED'
export const isChildUnconfirmedError = (error: unknown): boolean =>
  error instanceof Error && error.message.includes(CHILD_UNCONFIRMED)

// Structured payload attached to a runMicromamba failure (exit / timeout). The user-facing
// `Error.message` carries only a short excerpt; the full stdout/stderr tails live here so machine
// consumers (cache-corruption / MAX_PATH recovery parsers, startup-gate logging) keep the complete
// diagnostics the message no longer holds.
export type MicromambaErrorData = {
  argv: string[]
  exitCode?: number | null
  stderrTail?: string
  stdoutTail?: string
}

const hasMicromambaErrorData = (error: unknown): error is { data: MicromambaErrorData } =>
  error instanceof Error &&
  typeof (error as { data?: unknown }).data === 'object' &&
  (error as { data?: unknown }).data !== null

// The FULL micromamba diagnostic text for machine parsing (not for the UI). Prefers the untruncated
// stdout+stderr tails on `error.data`; falls back to `error.message` for errors raised without the
// structured payload (e.g. captureMicromamba, spawn-failure). Recovery heuristics regex-match this, so
// it must reconstruct what the pre-excerpt `Error.message` used to contain.
export const micromambaDiagnosticText = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error)
  if (!hasMicromambaErrorData(error)) return message
  const { stdoutTail, stderrTail } = error.data
  return [
    message,
    stdoutTail && `stdout tail:\n${stdoutTail}`,
    stderrTail && `stderr tail:\n${stderrTail}`
  ]
    .filter(Boolean)
    .join('\n')
}

// Kills a child and resolves ONLY once it has actually exited, escalating SIGTERM -> SIGKILL. Resolves
// true when exit is confirmed, false when it can't be confirmed within the deadline (SIGTERM can be
// ignored/delayed and kill() can return false, so a single kill() is not proof of exit). The caller
// decides what an unconfirmed exit means (here: retain recovery evidence, fail closed).
export const killAndConfirmExit = (child: ChildProcess, deadlineMs = 5000): Promise<boolean> =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true)
      return
    }
    let done = false
    const finish = (confirmed: boolean): void => {
      if (done) return
      done = true
      clearTimeout(escalate)
      clearTimeout(giveUp)
      resolve(confirmed)
    }
    child.once('exit', () => finish(true))
    try {
      child.kill('SIGTERM')
    } catch {
      // Already gone or un-signalable; the exit listener / timeout below still resolves.
    }
    const escalate = setTimeout(
      () => {
        try {
          child.kill('SIGKILL')
        } catch {
          // Best-effort escalation.
        }
      },
      Math.floor(deadlineMs / 2)
    )
    const giveUp = setTimeout(() => finish(false), deadlineMs)
  })

// Merges extra vars over the current process env for a subprocess (used to inject the CA-bundle vars
// so an online provision behind an enterprise TLS proxy verifies HTTPS). Undefined → inherit as-is.
type VerifyExecutableOptions = {
  prefix?: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}

const executableEnv = ({
  prefix,
  env,
  platform = process.platform
}: VerifyExecutableOptions): NodeJS.ProcessEnv | undefined => {
  if (platform !== 'win32' || !prefix) {
    return env && Object.keys(env).length > 0 ? { ...process.env, ...env } : undefined
  }
  const merged = { ...process.env, ...env }
  return { ...merged, PATH: condaActivatedPath(prefix, merged.PATH, platform) }
}

const R_RUNTIME_PATH_PROBE = [
  'normalize <- function(path) normalizePath(path, winslash="/", mustWork=FALSE)',
  'cat("OPEN_SCIENCE_R_HOME=", normalize(R.home()), "\\n", sep="")',
  'cat("OPEN_SCIENCE_R_BASE_LIBRARY=", normalize(R.home("library")), "\\n", sep="")',
  'for (path in .libPaths()) cat("OPEN_SCIENCE_R_LIBRARY=", normalize(path), "\\n", sep="")'
].join('; ')

const canonicalPath = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

const pathIsWithin = (
  candidate: string,
  root: string,
  platform: NodeJS.Platform = process.platform
): boolean => {
  const normalizeCase = (value: string): string =>
    platform === 'win32' ? value.toLowerCase() : value
  const normalizePath = (value: string): string =>
    platform === 'win32' ? win32.resolve(value) : canonicalPath(value)
  const normalizedCandidate = normalizeCase(normalizePath(candidate))
  const normalizedRoot = normalizeCase(normalizePath(root))
  const separator = platform === 'win32' ? win32.sep : sep
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}${separator}`)
  )
}

const assertRRuntimePaths = (
  stdout: string,
  prefix: string,
  platform: NodeJS.Platform = process.platform
): void => {
  const values = (marker: string): string[] =>
    stdout
      .split(/\r?\n/u)
      .filter((line) => line.startsWith(marker))
      .map((line) => line.slice(marker.length).trim())
      .filter(Boolean)
  const homes = values('OPEN_SCIENCE_R_HOME=')
  const baseLibraries = values('OPEN_SCIENCE_R_BASE_LIBRARY=')
  const libraries = values('OPEN_SCIENCE_R_LIBRARY=')
  if (
    homes.length !== 1 ||
    baseLibraries.length !== 1 ||
    !pathIsWithin(homes[0], prefix, platform) ||
    !pathIsWithin(baseLibraries[0], prefix, platform) ||
    !libraries.some((library) => pathIsWithin(library, prefix, platform))
  ) {
    throw new Error(
      `R runtime paths resolve outside the expected prefix ${prefix}; the environment may have been ` +
        'copied or relocated without being rebuilt.'
    )
  }
}

// Verifies a materialized interpreter actually runs `<bin> --version` (spec §5 step 4 — the arm64 /
// ad-hoc signature verification point). Rejects with the captured stderr on failure.
export const verifyExecutable = async (
  bin: string,
  options: VerifyExecutableOptions = {}
): Promise<void> => {
  try {
    const isR = ['r', 'r.exe'].includes(basename(bin).toLowerCase())
    const { stdout } = await execFileAsync(
      bin,
      isR ? ['--vanilla', '--slave', '-e', R_RUNTIME_PATH_PROBE] : ['--version'],
      {
        timeout: 15_000,
        windowsHide: true,
        env: executableEnv(options),
        encoding: 'utf8'
      }
    )
    if (isR) {
      if (!options.prefix) throw new Error('an expected prefix is required to verify R')
      assertRRuntimePaths(stdout, options.prefix, options.platform)
    }
  } catch (error) {
    throw new Error(`interpreter not executable: ${bin} (${(error as Error).message})`)
  }
}

// Runs a micromamba argv (argv[0] is the binary). Rejects with a stderr summary on non-zero exit so
// provisioning surfaces a solvable error to the UI (spec §12).
export const runMicromamba = (
  argv: string[],
  env?: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  // Invoked with the spawned child's PID so the caller can journal it — crash recovery then kills a
  // surviving orphan (a micromamba the dead parent left running) before reconciling its target prefix.
  onChild?: (pid: number) => void,
  // Invoked SYNCHRONOUSLY immediately before the spawn so the caller can (re)record the spawn intent for
  // THIS spawn — a single op can spawn more than once (create + cache-repair retry), and each spawn must
  // re-arm the intent so a crash before its PID is recorded blocks rather than trusting a prior PID.
  // Throwing here fails closed: nothing is spawned.
  onBeforeSpawn?: () => void,
  timeoutMs = 600_000
): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Runtime setup cancelled.'))
      return
    }

    // Re-arm the per-spawn intent for THIS spawn before launching. Throwing fails closed: nothing is
    // spawned, so a crash before the PID is recorded blocks rather than trusting a prior spawn's PID.
    try {
      onBeforeSpawn?.()
    } catch (error) {
      reject(
        new Error(
          `Failed to record the spawn intent; not spawning: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      )
      return
    }

    const child = spawn(argv[0], argv.slice(1), {
      windowsHide: true,
      // `runMicromamba` receives the complete app-owned environment. Do not merge process.env back
      // in here: that would reintroduce inherited CONDA_*/MAMBA_* values removed by micromambaSpawnEnv.
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const maxTail = 16 * 1024
    // Cap the excerpt embedded in the user-facing error message; full tails still reach the logs via
    // the error's structured `data`.
    const MESSAGE_TAIL_LIMIT = 500
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let cancelled = false
    let settled = false
    const startedAt = Date.now()
    const appendTail = (current: string, chunk: unknown): string =>
      `${current}${String(chunk)}`.slice(-maxTail)
    child.stdout.on('data', (chunk) => {
      stdout = appendTail(stdout, chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr = appendTail(stderr, chunk)
    })

    const timeout = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    const onAbort = (): void => {
      cancelled = true
      child.kill()
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    const cleanup = (): void => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
    }
    // Full tails go into the error's structured `data` for the logs; the user-facing message gets only
    // this short excerpt. micromamba writes its package plan (thousands of pinned specs) to stdout, so
    // embedding the raw tails in the message floods the provisioning banner — prefer the stderr reason,
    // capped, and fall back to stdout only when stderr is empty.
    const briefTail = (): string => {
      const source = stderr.trim() || stdout.trim()
      return source.length > MESSAGE_TAIL_LIMIT
        ? `…${source.slice(-MESSAGE_TAIL_LIMIT).trimStart()}`
        : source
    }

    // Record the spawned PID for crash-recovery supervision. If recording FAILS, fail closed: kill the
    // child and only settle once it is CONFIRMED gone — the close handler then rejects with
    // recordingError. If it can't be confirmed, reject with the CHILD_UNCONFIRMED marker so the caller
    // RETAINS the recovery evidence (a worker may still be writing) instead of clearing it.
    let recordingError: Error | undefined
    if (child.pid !== undefined) {
      try {
        onChild?.(child.pid)
      } catch (error) {
        recordingError = new Error(
          `Failed to record the runtime worker PID; aborted to avoid an unrecoverable process: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
        void killAndConfirmExit(child).then((confirmed) => {
          if (!confirmed && !settled) {
            settled = true
            cleanup()
            reject(
              new Error(
                `${CHILD_UNCONFIRMED}: recording failed and the runtime worker could not be confirmed ` +
                  'stopped; leaving the operation for recovery to block.'
              )
            )
          }
          // If confirmed, the close handler below rejects with recordingError.
        })
      }
    }

    child.once('error', (error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error(`micromamba failed to start (${argv.join(' ')}): ${error.message}`))
    })
    child.once('close', (code, closeSignal) => {
      if (settled) return
      settled = true
      cleanup()
      if (recordingError) {
        reject(recordingError)
        return
      }
      if (cancelled || signal?.aborted) {
        reject(new Error('Runtime setup cancelled.'))
        return
      }
      const excerpt = briefTail()
      if (timedOut) {
        const timeoutError = Object.assign(
          new Error(
            `micromamba timed out after ${timeoutMs}ms (${argv.join(' ')})${excerpt ? `:\n${excerpt}` : ''}`
          ),
          {
            code: 'MICROMAMBA_TIMEOUT',
            data: {
              argv,
              cachePath: env?.CONDA_PKGS_DIRS,
              durationMs: Date.now() - startedAt,
              offline: argv.includes('--offline'),
              pid: child.pid,
              stderrTail: stderr,
              stdoutTail: stdout,
              timeoutMs
            }
          }
        )
        reject(timeoutError)
        return
      }
      if (code === 0) {
        resolve()
        return
      }
      const status = code === null ? `signal ${closeSignal ?? 'unknown'}` : `exit ${code}`
      // Short message for the UI banner; full tails attached to `data` for the logs (see briefTail).
      reject(
        Object.assign(
          new Error(
            `micromamba failed (${status}; ${argv.join(' ')})${excerpt ? `:\n${excerpt}` : ''}`
          ),
          {
            code: 'MICROMAMBA_EXIT',
            data: { argv, exitCode: code, stderrTail: stderr, stdoutTail: stdout }
          }
        )
      )
    })
  })

// Runs a micromamba argv and returns its stdout (for `list --explicit --md5` when exporting an env's
// lock during a runtime relocation). Rejects with a stderr summary on non-zero exit.
export const captureMicromamba = async (
  argv: string[],
  env?: NodeJS.ProcessEnv
): Promise<string> => {
  try {
    const { stdout } = await execFileAsync(argv[0], argv.slice(1), {
      timeout: 600_000,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
      env: env && Object.keys(env).length > 0 ? { ...process.env, ...env } : undefined
    })
    return stdout
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? ''
    throw new Error(`micromamba failed (${argv.join(' ')}): ${stderr.slice(0, 400)}`)
  }
}

// Streams a file through md5 and returns the lowercase hex digest (matches the `#<md5>` suffix on
// @EXPLICIT lock lines used to verify downloaded tarballs).
export const md5File = (path: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash('md5')
    const stream = createReadStream(path)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
