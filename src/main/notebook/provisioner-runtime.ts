import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// Merges extra vars over the current process env for a subprocess (used to inject the CA-bundle vars
// so an online provision behind an enterprise TLS proxy verifies HTTPS). Undefined → inherit as-is.
const withEnv = (extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv | undefined =>
  extra && Object.keys(extra).length > 0 ? { ...process.env, ...extra } : undefined

// Verifies a materialized interpreter actually runs `<bin> --version` (spec §5 step 4 — the arm64 /
// ad-hoc signature verification point). Rejects with the captured stderr on failure.
export const verifyExecutable = async (bin: string, env?: NodeJS.ProcessEnv): Promise<void> => {
  try {
    await execFileAsync(bin, ['--version'], {
      timeout: 15_000,
      windowsHide: true,
      env: withEnv(env)
    })
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
  onChild?: (pid: number) => void
): Promise<void> =>
  // Raw execFile (not promisified) so we can read the ChildProcess's pid up front; execFile's `signal`
  // still kills the child on abort (user cancel), surfacing as ABORT_ERR.
  new Promise<void>((resolve, reject) => {
    const child = execFile(
      argv[0],
      argv.slice(1),
      { timeout: 600_000, windowsHide: true, env: withEnv(env), signal },
      (error) => {
        if (!error) {
          resolve()
          return
        }
        if ((error as { name?: string }).name === 'AbortError') {
          reject(new Error('Runtime setup cancelled.'))
          return
        }
        const stderr = (error as { stderr?: string }).stderr ?? ''
        reject(new Error(`micromamba failed (${argv.join(' ')}): ${stderr.slice(0, 400)}`))
      }
    )
    if (child.pid !== undefined) onChild?.(child.pid)
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
      env: withEnv(env)
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
