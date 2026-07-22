import { execFile } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import type { SshOverrides } from '../../shared/compute'

// Maximum bytes captured per stream before we truncate. Caller can pass a smaller cap.
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024

// Short connect timeout used for probe calls; SSH itself honors ConnectTimeout from config but we
// add it explicitly to override any large value from ~/.ssh/config (design.md §1).
const DEFAULT_CONNECT_TIMEOUT_SECS = 10

// The resolved SSH connection target ready for spawning a command.
export type ResolvedSshTarget = {
  // Full path to the ssh binary (e.g. /usr/bin/ssh, C:\Windows\System32\OpenSSH\ssh.exe).
  sshBinary: string
  // Hostname or alias to pass to ssh.
  host: string
  // Connection flags resolved from `ssh -G <alias>` plus overrides: -p, -l/-o User, -i, control args.
  extraArgs: string[]
}

// The injectable SSH execution interface. The real implementation spawns system ssh; tests substitute
// a fake. All SSH logic stays in the main process — callers in the renderer are never exposed to it.
export interface SshRunner {
  run(
    target: ResolvedSshTarget,
    remoteCommand: string,
    opts: {
      timeoutMs: number
      loginShell?: boolean
      maxOutputBytes?: number
    }
  ): Promise<{
    exitCode: number | null
    stdout: string
    stderr: string
    truncated: boolean
    timedOut: boolean
  }>
}

// Builds the ControlMaster args used on mac/linux to reuse a single SSH connection across the probe
// bundle. Windows does not support ControlMaster so this returns an empty array there.
export const controlMasterArgs = (alias: string): string[] => {
  if (platform() === 'win32') return []
  // Use a per-alias socket under ~/.ssh/ctrl/ so multiple hosts don't share a socket. ssh does not
  // create the ControlPath parent directory itself, so ensure it exists (mode 0700 like ~/.ssh) —
  // otherwise the control socket bind fails with "unix_listener: cannot bind ... No such file".
  const ctrlDir = join(homedir(), '.ssh', 'ctrl')
  try {
    mkdirSync(ctrlDir, { recursive: true, mode: 0o700 })
  } catch {
    // Best-effort: if we can't create it, ssh will surface the bind error as before.
  }
  const socketPath = join(ctrlDir, `%r@%h:%p.${alias}`)
  return ['-o', `ControlMaster=auto`, '-o', `ControlPath=${socketPath}`, '-o', `ControlPersist=60`]
}

// Locate ssh.exe on Windows. Tries System32\OpenSSH first (built-in since Win10 1803), then Git for
// Windows. Throws if neither is found so the caller can surface a readable prompt.
const findWindowsSsh = (): string => {
  const candidates = [
    join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe'),
    'C:\\Program Files\\Git\\usr\\bin\\ssh.exe',
    'C:\\Program Files (x86)\\Git\\usr\\bin\\ssh.exe'
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(
    'ssh.exe not found. Install OpenSSH (Settings → Optional features → OpenSSH Client) ' +
      'or Git for Windows, then retry.'
  )
}

// Returns the path to the ssh binary appropriate for the current platform.
export const resolveSshBinary = (): string => {
  if (platform() === 'win32') return findWindowsSsh()
  return 'ssh' // On mac/linux ssh is on PATH.
}

// Parses the output of `ssh -G <alias>` (one "key value" line per setting) into a plain object.
// Returns an empty object if parsing fails rather than throwing — the caller will still build a
// usable connection using only the overrides.
const parseSshG = (output: string): Record<string, string> => {
  const result: Record<string, string> = {}
  for (const line of output.split('\n')) {
    const space = line.indexOf(' ')
    if (space === -1) continue
    const key = line.slice(0, space).toLowerCase()
    const value = line.slice(space + 1).trim()
    if (key && value) result[key] = value
  }
  return result
}

// Resolves a ResolvedSshTarget for the given alias + optional overrides. Runs `ssh -G <alias>` to
// read the effective config, then layers the overrides on top. BatchMode=yes and ConnectTimeout are
// always set so the process never hangs on passphrase or slow networks.
export const resolveSshTarget = async (
  alias: string,
  overrides: SshOverrides | undefined
): Promise<ResolvedSshTarget> => {
  const sshBinary = resolveSshBinary()
  const execFileAsync = promisify(execFile)

  // Read the effective connection config from ~/.ssh/config for this alias.
  let sshGConfig: Record<string, string> = {}
  try {
    const { stdout } = await execFileAsync(sshBinary, ['-G', alias], { timeout: 5000 })
    sshGConfig = parseSshG(stdout)
  } catch {
    // ssh -G failed (e.g. no ~/.ssh/config) — proceed with overrides and defaults only.
  }

  const extraArgs: string[] = []

  // User: override > ssh -G user > alias itself.
  const resolvedUser = overrides?.user?.trim() ?? sshGConfig['user']
  if (resolvedUser && resolvedUser !== alias) {
    extraArgs.push('-o', `User=${resolvedUser}`)
  }

  // Port: override > ssh -G port.
  if (overrides?.port != null) {
    extraArgs.push('-p', String(overrides.port))
  } else if (sshGConfig['port'] && sshGConfig['port'] !== '22') {
    extraArgs.push('-p', sshGConfig['port'])
  }

  // Identity file: override only (ssh -G resolves it for us when not overriding).
  if (overrides?.identityFile?.trim()) {
    extraArgs.push('-i', overrides.identityFile.trim())
  }

  // BatchMode: never hang on passphrase / host-key prompt. Combined with StrictHostKeyChecking
  // (default or explicit from config) this means an unknown host key returns exit 255 immediately.
  extraArgs.push('-o', 'BatchMode=yes')

  // ConnectTimeout: override a potentially large value from config so probes fail fast.
  extraArgs.push('-o', `ConnectTimeout=${DEFAULT_CONNECT_TIMEOUT_SECS}`)

  // ControlMaster on mac/linux for connection reuse across the probe bundle.
  extraArgs.push(...controlMasterArgs(alias))

  // Resolve the hostname from ssh -G (may differ from the alias due to HostName directives).
  const host = sshGConfig['hostname'] ?? alias

  return { sshBinary, host, extraArgs }
}

// Accumulates stream chunks up to maxBytes, capping stored content and recording whether any bytes
// were dropped. Truncation is tracked here — at the point bytes are actually discarded — rather than
// re-checked afterwards against the already-capped buffer (whose length can never exceed maxBytes,
// which is why the old length-based check could never fire). See design.md §5 "cap-exceeded → truncated=true".
export class CappedOutput {
  private readonly chunks: Buffer[] = []
  private bytes = 0
  private truncated = false

  constructor(private readonly maxBytes: number) {}

  push(chunk: Buffer): void {
    const remaining = this.maxBytes - this.bytes
    if (chunk.length > remaining) {
      // Chunk overflows the cap: keep only what fits (if anything) and flag the drop.
      if (remaining > 0) {
        this.chunks.push(chunk.subarray(0, remaining))
        this.bytes += remaining
      }
      this.truncated = true
      return
    }
    this.chunks.push(chunk)
    this.bytes += chunk.length
  }

  toString(): string {
    return Buffer.concat(this.chunks).toString('utf8')
  }

  wasTruncated(): boolean {
    return this.truncated
  }
}

// Real SSH runner: spawns the system ssh binary. Credentials stay in the OS ssh-agent — this code
// never handles, stores, or transmits keys or passphrases (design.md §1, §2).
export class SystemSshRunner implements SshRunner {
  async run(
    target: ResolvedSshTarget,
    remoteCommand: string,
    opts: {
      timeoutMs: number
      loginShell?: boolean
      maxOutputBytes?: number
    }
  ): Promise<{
    exitCode: number | null
    stdout: string
    stderr: string
    truncated: boolean
    timedOut: boolean
  }> {
    const maxBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    const { loginShell = false } = opts

    // When loginShell is requested wrap the command in `bash -lc '...'` so module / conda PATHs
    // are loaded. This matches the call_command semantic (design.md §5).
    const finalCommand = loginShell ? `bash -lc ${JSON.stringify(remoteCommand)}` : remoteCommand

    const args = [...target.extraArgs, target.host, finalCommand]

    return new Promise((resolve) => {
      const stdoutBuf = new CappedOutput(maxBytes)
      const stderrBuf = new CappedOutput(maxBytes)
      let timedOut = false

      const child = execFile(target.sshBinary, args, { timeout: 0, encoding: 'buffer' })

      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
      }, opts.timeoutMs)

      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutBuf.push(chunk)
      })

      child.stderr?.on('data', (chunk: Buffer) => {
        stderrBuf.push(chunk)
      })

      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({
          exitCode: code,
          stdout: stdoutBuf.toString(),
          stderr: stderrBuf.toString(),
          truncated: stdoutBuf.wasTruncated() || stderrBuf.wasTruncated(),
          timedOut
        })
      })

      child.on('error', (err) => {
        clearTimeout(timer)
        resolve({
          exitCode: null,
          stdout: '',
          stderr: err.message,
          truncated: false,
          timedOut
        })
      })
    })
  }
}
