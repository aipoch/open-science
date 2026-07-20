// SCP-based file transfer for the remote file browser (compute-file-preview, issue 03).
// Reuses resolveSshTarget for connection config + ControlMaster mux.
// This module never handles credentials — all key material stays in the OS ssh-agent.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { platform } from 'node:os'
import { join } from 'node:path'

import type { ResolvedSshTarget } from './ssh-runner'

// Glob metacharacters that must not appear in an import path (prevents shell expansion).
const GLOB_CHARS = /[*?[\]{}\\]/

// 2 GiB in bytes — hard upper limit for os-downloads destination.
export const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024

// 50 MB in bytes — hard upper limit for artifact import destination.
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024

// SCP timeout: generous because files can be large, but bounded.
const SCP_TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes

// Locates scp.exe on Windows. Mirrors the ssh.exe search in ssh-runner.ts.
const findWindowsScp = (): string => {
  const candidates = [
    join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'OpenSSH', 'scp.exe'),
    'C:\\Program Files\\Git\\usr\\bin\\scp.exe',
    'C:\\Program Files (x86)\\Git\\usr\\bin\\scp.exe'
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(
    'scp.exe not found. Install OpenSSH (Settings → Optional features → OpenSSH Client) ' +
      'or Git for Windows, then retry.'
  )
}

// Returns the path to the scp binary for the current platform.
export const resolveScpBinary = (): string => {
  if (platform() === 'win32') return findWindowsScp()
  return 'scp'
}

// Validates a remote path for import: must be absolute, no glob chars.
// Returns a RemoteKind string on rejection or undefined on success.
export const validateImportPath = (
  remotePath: string
): 'outside_roots' | 'not_a_file' | undefined => {
  if (!remotePath.startsWith('/')) return 'outside_roots'
  if (GLOB_CHARS.test(remotePath)) return 'outside_roots'
  return undefined
}

// Converts a ResolvedSshTarget (built for ssh) into scp-compatible args.
// scp does not accept -p <port>; ports must be passed as -P <port> or -o Port=.
// We use -o Port=<n> to stay consistent with the mux options style.
//
// The extraArgs from resolveSshTarget are already in -o Key=Value form for BatchMode, ConnectTimeout,
// ControlMaster, ControlPath, ControlPersist. The only difference is that -p <port> must become
// -o Port=<port> for scp (scp uses -P <port> for port, but -o works for all options uniformly).
export const buildScpArgs = (
  target: ResolvedSshTarget,
  remotePath: string,
  localPath: string
): string[] => {
  const scpExtraArgs: string[] = []

  // Translate ssh extraArgs to scp-compatible form.
  // ssh uses -p <port>; scp uses -P <port>. Both accept -o options identically.
  let i = 0
  while (i < target.extraArgs.length) {
    const arg = target.extraArgs[i]
    if (arg === '-p' && i + 1 < target.extraArgs.length) {
      // Convert ssh -p <port> → scp -o Port=<port>
      scpExtraArgs.push('-o', `Port=${target.extraArgs[i + 1]}`)
      i += 2
    } else {
      scpExtraArgs.push(arg as string)
      i++
    }
  }

  // Remote source: user@host:path (or just host:path when User is already in -o User=).
  const remoteSpec = `${target.host}:${remotePath}`

  return [...scpExtraArgs, remoteSpec, localPath]
}

// Result of a single scp transfer attempt.
export type ScpResult = {
  exitCode: number | null
  stderr: string
  timedOut: boolean
}

// Injectable scp runner interface for testability. The real implementation spawns system scp.
export interface ScpRunner {
  copy(scpBinary: string, args: string[], timeoutMs?: number): Promise<ScpResult>
}

// Production scp runner: spawns the system scp binary. No credentials are passed — key material
// lives in the OS ssh-agent and is used transparently (BatchMode in scp args ensures no prompts).
export class SystemScpRunner implements ScpRunner {
  async copy(scpBinary: string, args: string[], timeoutMs = SCP_TIMEOUT_MS): Promise<ScpResult> {
    return new Promise((resolve) => {
      const stderrChunks: Buffer[] = []
      let timedOut = false

      const child = execFile(scpBinary, args, { timeout: 0, encoding: 'buffer' })

      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
      }, timeoutMs)

      child.stderr?.on('data', (chunk: Buffer) => {
        // Cap stderr capture at 8 KB — more than enough for any scp error message.
        if (stderrChunks.reduce((sum, c) => sum + c.length, 0) < 8 * 1024) {
          stderrChunks.push(chunk)
        }
      })

      child.on('close', (code) => {
        clearTimeout(timer)
        const stderr = Buffer.concat(stderrChunks).toString('utf8')
        resolve({ exitCode: code, stderr, timedOut })
      })

      child.on('error', (err) => {
        clearTimeout(timer)
        resolve({ exitCode: null, stderr: err.message, timedOut })
      })
    })
  }
}

// Runs scp and classifies any failure as a RemoteFsError-compatible object.
// Throws an error with a .remoteFsError property on failure; resolves undefined on success.
export const runScpTransfer = async (
  scpRunner: ScpRunner,
  target: ResolvedSshTarget,
  remotePath: string,
  localDestPath: string
): Promise<void> => {
  const scpBinary = resolveScpBinary()
  const args = buildScpArgs(target, remotePath, localDestPath)
  const result = await scpRunner.copy(scpBinary, args)

  if (result.timedOut) {
    const err = new Error('scp transfer timed out') as Error & {
      remoteFsError: { detail: string; remoteKind: string }
    }
    err.remoteFsError = { detail: 'scp transfer timed out.', remoteKind: 'connection' }
    throw err
  }

  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || `scp exited with code ${String(result.exitCode)}`
    const kind = classifyScpError(result.stderr)
    const err = new Error(detail) as Error & {
      remoteFsError: { detail: string; remoteKind: string }
    }
    err.remoteFsError = { detail, remoteKind: kind }
    throw err
  }
}

// Classifies scp stderr into a RemoteKind string.
const classifyScpError = (stderr: string): string => {
  const s = stderr.toLowerCase()
  if (s.includes('no such file') || s.includes('not found')) return 'not_found'
  if (s.includes('permission denied') && !s.includes('publickey')) return 'permission'
  if (s.includes('is a directory')) return 'not_a_file'
  if (
    s.includes('connection refused') ||
    s.includes('no route to host') ||
    s.includes('timed out') ||
    s.includes('kex') ||
    s.includes('publickey') ||
    s.includes('255')
  )
    return 'connection'
  return 'other'
}

// Infers a MIME type from a file extension.
export const inferMimeType = (filename: string): string => {
  const dot = filename.lastIndexOf('.')
  if (dot === -1 || dot === filename.length - 1) return 'application/octet-stream'
  const ext = filename.slice(dot + 1).toLowerCase()
  const map: Record<string, string> = {
    txt: 'text/plain',
    md: 'text/markdown',
    html: 'text/html',
    css: 'text/css',
    js: 'application/javascript',
    ts: 'text/typescript',
    json: 'application/json',
    xml: 'application/xml',
    csv: 'text/csv',
    tsv: 'text/tab-separated-values',
    py: 'text/x-python',
    sh: 'text/x-sh',
    r: 'text/x-r',
    yaml: 'application/yaml',
    yml: 'application/yaml',
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    zip: 'application/zip',
    tar: 'application/x-tar',
    gz: 'application/gzip',
    bz2: 'application/x-bzip2',
    h5: 'application/x-hdf5',
    hdf5: 'application/x-hdf5',
    nc: 'application/x-netcdf',
    ipynb: 'application/x-ipynb+json'
  }
  return map[ext] ?? 'application/octet-stream'
}

// Resolves a name-collision in a directory by appending (1), (2), etc.
// Checks whether `baseName` exists; if so, tries `stem (1).ext`, `stem (2).ext`, etc.
export const resolveDestFilename = async (dir: string, baseName: string): Promise<string> => {
  const dot = baseName.lastIndexOf('.')
  const stem = dot > 0 ? baseName.slice(0, dot) : baseName
  const ext = dot > 0 ? baseName.slice(dot) : ''

  // Check the base name first.
  const basePath = join(dir, baseName)
  const baseExists = await stat(basePath)
    .then(() => true)
    .catch(() => false)
  if (!baseExists) return baseName

  // Try suffixes (1), (2), ... up to 999.
  for (let n = 1; n < 1000; n++) {
    const candidate = `${stem} (${n})${ext}`
    const exists = await stat(join(dir, candidate))
      .then(() => true)
      .catch(() => false)
    if (!exists) return candidate
  }

  // Fallback: append timestamp to guarantee uniqueness.
  return `${stem} (${Date.now()})${ext}`
}
