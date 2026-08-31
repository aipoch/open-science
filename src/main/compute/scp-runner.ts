// SCP-based file transfer for the remote file browser (compute-file-preview, issue 03).
// Reuses resolveSshTarget for connection config + ControlMaster mux.
// This module never handles credentials — all key material stays in the OS ssh-agent.

import { execFile, spawn } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { platform } from 'node:os'
import { join } from 'node:path'

import {
  GLOB_CHARS,
  quoteRemotePath,
  SHELL_UNSAFE_CHARS,
  shellSingleQuote
} from './remote-path-security'
import type { ResolvedSshTarget } from './ssh-runner'
import { BoundedChildTermination } from './bounded-child-termination'

// Preserve the established public exports while keeping the security policy in one module.
export { GLOB_CHARS, SHELL_UNSAFE_CHARS, shellSingleQuote }

const shellRemotePath = quoteRemotePath

// 2 GiB in bytes — hard upper limit for os-downloads destination.
export const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024

// 50 MB in bytes — hard upper limit for artifact import destination.
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024

// SCP timeout: generous because files can be large, but bounded.
const SCP_TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes

// Timeout for job input uploads — generous because inputs can be GB-scale (bioinformatics).
export const SCP_UPLOAD_TIMEOUT_MS = 30 * 60 * 1000 // 30 minutes

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

// Validates a remote path used as an scp remote spec: must be absolute, no glob chars, and no
// shell-injection metacharacters/control chars (scp may pass the path through a remote shell,
// version-dependent — see SHELL_UNSAFE_CHARS). Returns a RemoteKind string on rejection or
// undefined on success. Applied to every download destination before scp runs.
export const validateImportPath = (
  remotePath: string
): 'outside_roots' | 'not_a_file' | undefined => {
  if (!remotePath.startsWith('/')) return 'outside_roots'
  if (GLOB_CHARS.test(remotePath)) return 'outside_roots'
  if (SHELL_UNSAFE_CHARS.test(remotePath)) return 'outside_roots'
  return undefined
}

// Translates ssh extraArgs to scp-compatible form (shared between download and upload builders).
// ssh uses -p <port>; scp uses -P <port> (or equivalently -o Port=<port>). Both accept -o options.
const buildScpExtraArgs = (target: ResolvedSshTarget): string[] => {
  const scpExtraArgs: string[] = []
  let i = 0
  while (i < target.extraArgs.length) {
    const arg = target.extraArgs[i]
    if (arg === '-p' && i + 1 < target.extraArgs.length) {
      scpExtraArgs.push('-o', `Port=${target.extraArgs[i + 1]}`)
      i += 2
    } else {
      scpExtraArgs.push(arg as string)
      i++
    }
  }
  return scpExtraArgs
}

// Converts a ResolvedSshTarget (built for ssh) into scp-compatible args for downloading.
// Direction: remote → local (remoteSpec first, then localPath).
//
// The extraArgs from resolveSshTarget are already in -o Key=Value form for BatchMode, ConnectTimeout,
// ControlMaster, ControlPath, ControlPersist. The only difference is that -p <port> must become
// -o Port=<port> for scp (scp uses -P <port> for port, but -o works for all options uniformly).
export const buildScpArgs = (
  target: ResolvedSshTarget,
  remotePath: string,
  localPath: string
): string[] => {
  const scpExtraArgs = buildScpExtraArgs(target)

  // Remote source: user@host:path (or just host:path when User is already in -o User=).
  const remoteSpec = `${target.host}:${remotePath}`

  return [...scpExtraArgs, remoteSpec, localPath]
}

// Builds scp args for uploading a local file to a remote destination.
// Direction: local → remote (localPath first, then remoteSpec).
// Uses the same -o Port= translation and ControlMaster args as buildScpArgs.
export const buildScpUploadArgs = (
  target: ResolvedSshTarget,
  localPath: string,
  remotePath: string
): string[] => {
  const scpExtraArgs = buildScpExtraArgs(target)

  // Remote destination: user@host:path.
  const remoteSpec = `${target.host}:${remotePath}`

  return [...scpExtraArgs, localPath, remoteSpec]
}

// Result of a single scp transfer attempt.
export type ScpResult = {
  exitCode: number | null
  stderr: string
  timedOut: boolean
}

export type BoundedScpResult = ScpResult & {
  bytesWritten: number
  exceeded: boolean
}

export type ScpRunOptions = Readonly<{
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
}>

// Injectable scp runner interface for testability. The real implementation spawns system scp.
export interface ScpRunner {
  copy(
    scpBinary: string,
    args: string[],
    timeoutMs?: number,
    options?: ScpRunOptions
  ): Promise<ScpResult>
  copyFromRemoteBounded?(
    target: ResolvedSshTarget,
    remotePath: string,
    localPath: string,
    maxBytes: number,
    timeoutMs?: number,
    options?: ScpRunOptions
  ): Promise<BoundedScpResult>
}

// Production scp runner: spawns the system scp binary. No credentials are passed — key material
// lives in the OS ssh-agent and is used transparently (BatchMode in scp args ensures no prompts).
export class SystemScpRunner implements ScpRunner {
  async copy(
    scpBinary: string,
    args: string[],
    timeoutMs = SCP_TIMEOUT_MS,
    options: ScpRunOptions = {}
  ): Promise<ScpResult> {
    options.signal?.throwIfAborted()
    return new Promise((resolve, reject) => {
      const stderrChunks: Buffer[] = []
      let timedOut = false
      let aborted = false
      let abortReason: unknown
      let settled = false

      const child = execFile(scpBinary, args, {
        timeout: 0,
        encoding: 'buffer',
        ...(options.env ? { env: options.env } : {})
      })

      const finish = (code: number | null, error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        termination.stop()
        options.signal?.removeEventListener('abort', onAbort)
        if (aborted) {
          reject(abortReason)
          return
        }
        resolve({
          exitCode: error ? null : code,
          stderr: error ? error.message : Buffer.concat(stderrChunks).toString('utf8'),
          timedOut
        })
      }

      const termination = new BoundedChildTermination(child, () => finish(null))

      const onAbort = (): void => {
        if (settled || aborted) return
        aborted = true
        abortReason =
          options.signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError')
        termination.request()
      }

      const timer = setTimeout(() => {
        timedOut = true
        termination.request()
      }, timeoutMs)

      child.stderr?.on('data', (chunk: Buffer) => {
        // Cap stderr capture at 8 KB — more than enough for any scp error message.
        if (stderrChunks.reduce((sum, c) => sum + c.length, 0) < 8 * 1024) {
          stderrChunks.push(chunk)
        }
      })

      child.once('exit', () => termination.observeExit())
      child.once('close', (code) => finish(code))

      child.once('error', (err) => {
        if (timedOut || aborted) return
        finish(null, err)
      })

      options.signal?.addEventListener('abort', onAbort, { once: true })
      if (options.signal?.aborted) onAbort()
    })
  }

  async copyFromRemoteBounded(
    target: ResolvedSshTarget,
    remotePath: string,
    localPath: string,
    maxBytes: number,
    timeoutMs = SCP_TIMEOUT_MS,
    options: ScpRunOptions = {}
  ): Promise<BoundedScpResult> {
    options.signal?.throwIfAborted()
    const boundedBytes = Math.max(0, Math.floor(maxBytes))
    const remoteCommand =
      'head -c ' + String(boundedBytes + 1) + ' -- ' + shellRemotePath(remotePath)

    return new Promise((resolve, reject) => {
      const stderrChunks: Buffer[] = []
      let bytesWritten = 0
      let exceeded = false
      let timedOut = false
      let processClosed = false
      let outputClosed = false
      let settled = false
      let exitCode: number | null = null
      let outputError: string | undefined
      let aborted = false
      let abortReason: unknown

      const child = spawn(target.sshBinary, [...target.extraArgs, target.host, remoteCommand], {
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(options.env ? { env: options.env } : {})
      })
      const output = createWriteStream(localPath, { flags: 'w' })

      const finish = (force = false): void => {
        if (settled || (!force && (!processClosed || !outputClosed))) return
        settled = true
        clearTimeout(timer)
        termination.stop()
        options.signal?.removeEventListener('abort', onAbort)
        if (force && !output.destroyed) output.destroy()
        if (aborted) {
          reject(abortReason)
          return
        }
        resolve({
          exitCode,
          stderr: outputError ?? Buffer.concat(stderrChunks).toString('utf8'),
          timedOut,
          bytesWritten,
          exceeded
        })
      }

      const closeOutput = (): void => {
        if (!output.destroyed && !output.writableEnded) output.end()
      }

      const termination = new BoundedChildTermination(child, () => finish(true))

      const onAbort = (): void => {
        if (settled || aborted) return
        aborted = true
        abortReason =
          options.signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError')
        termination.request()
      }

      const timer = setTimeout(() => {
        timedOut = true
        termination.request()
      }, timeoutMs)

      child.stdout?.on('data', (chunk: Buffer) => {
        if (exceeded) return
        const remaining = Math.max(0, boundedBytes - bytesWritten)
        const accepted = chunk.subarray(0, remaining)
        if (accepted.length > 0) {
          bytesWritten += accepted.length
          if (!output.write(accepted)) {
            child.stdout?.pause()
            output.once('drain', () => child.stdout?.resume())
          }
        }
        if (chunk.length > remaining) {
          exceeded = true
          termination.request()
        }
      })

      child.stdout?.on('end', closeOutput)
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderrChunks.reduce((sum, current) => sum + current.length, 0) < 8 * 1024) {
          stderrChunks.push(chunk)
        }
      })

      output.on('error', (error) => {
        outputError = error.message
        outputClosed = true
        termination.request()
        finish()
      })
      output.on('close', () => {
        outputClosed = true
        finish()
      })

      child.once('exit', () => termination.observeExit())
      child.once('close', (code) => {
        exitCode = code
        processClosed = true
        closeOutput()
        finish()
      })

      child.once('error', (error) => {
        if (timedOut || exceeded || outputError !== undefined || aborted) return
        outputError = error.message
        processClosed = true
        closeOutput()
        finish()
      })

      options.signal?.addEventListener('abort', onAbort, { once: true })
      if (options.signal?.aborted) onAbort()
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

// Runs an scp upload (local → remote) and classifies any failure.
// Throws an error with a .remoteFsError property on failure; resolves on success.
export const runScpUpload = async (
  scpRunner: ScpRunner,
  target: ResolvedSshTarget,
  localPath: string,
  remotePath: string,
  timeoutMs = SCP_UPLOAD_TIMEOUT_MS
): Promise<void> => {
  const scpBinary = resolveScpBinary()
  const args = buildScpUploadArgs(target, localPath, remotePath)
  const result = await scpRunner.copy(scpBinary, args, timeoutMs)

  if (result.timedOut) {
    const err = new Error('scp upload timed out') as Error & {
      remoteFsError: { detail: string; remoteKind: string }
    }
    err.remoteFsError = { detail: 'scp upload timed out.', remoteKind: 'connection' }
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
