import { mkdir, mkdtemp, rename, stat as fsStat, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { app } from 'electron'

import type { ComputeCallError, ComputeHost, ExecResult } from '../../shared/compute'
import type { DirListing, DownloadDest, LocalFile, RemoteFsError } from '../../shared/remote-fs'
import { classifyRemoteError, parseFindListing } from '../../shared/remote-fs'
import type { ComputeApprovalBroker } from './compute-approval-broker'
import {
  ComputeConnectionError,
  type ComputeConnectionBrokerAcquirer,
  type ComputeConnectionLease
} from './connection-broker'
import type { ComputeHostRepository } from './repository'
import { quoteRemotePath } from './remote-path-security'
import type { SessionCacheOwner } from './session-cache-owner'
import { withDataRootWrite } from '../storage/migration-state'
import {
  MAX_DOWNLOAD_BYTES,
  MAX_IMPORT_BYTES,
  inferMimeType,
  resolveDestFilename,
  validateImportPath
} from './scp-runner'
import {
  parseRemoteFileStat,
  remoteFileStatCommand,
  sameRemoteFileSnapshot,
  type RemoteFileSnapshot,
  type RemoteFileStat
} from './remote-file-snapshot'

const CALL_COMMAND_DEFAULT_TIMEOUT_MS = 60_000
const CALL_COMMAND_MAX_OUTPUT_BYTES = 64 * 1024
const LIST_DIR_MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const MAX_LIST_ENTRIES = 5000
const LIST_DIR_TIMEOUT_MS = 30_000
const COMMAND_PREVIEW_MAX_LEN = 120

const errorTail = (stderr: string, stdout: string, maxLines = 10): string => {
  const lines = [stderr, stdout]
    .filter(Boolean)
    .join('\n')
    .split('\n')
    .filter((line) => line.trim())
  return lines.slice(-maxLines).join('\n')
}

const hostNotFound = (providerId: string): Error =>
  new Error(`No compute host found with provider id "${providerId}".`)

const remoteConnectionError = (
  error: unknown
): Error & { remoteFsError: RemoteFsError & { retry_after_user_action: boolean } } => {
  if (error instanceof Error && error.name === 'AbortError') throw error
  const message = error instanceof Error ? error.message : String(error)
  const failure = new Error(message) as Error & {
    remoteFsError: RemoteFsError & { retry_after_user_action: boolean }
  }
  failure.remoteFsError = {
    detail: message,
    remoteKind: 'connection',
    retry_after_user_action: true,
    ...(error instanceof ComputeConnectionError ? { authenticationCode: error.code } : {})
  }
  return failure
}

const computeCallConnectionError = (
  error: unknown
): Error & { computeCallError: ComputeCallError } => {
  if (error instanceof Error && error.name === 'AbortError') throw error
  const message = error instanceof Error ? error.message : String(error)
  const failure = new Error(message) as Error & { computeCallError: ComputeCallError }
  failure.computeCallError = {
    error_code: error instanceof ComputeConnectionError ? error.code : 'host_unreachable',
    message,
    retry_after_user_action: true
  }
  return failure
}

export class ComputeRemoteOperationOwner {
  constructor(
    private readonly connectionBroker: ComputeConnectionBrokerAcquirer,
    private readonly repository: ComputeHostRepository,
    private readonly approvalBroker: ComputeApprovalBroker | undefined,
    private readonly overrideDownloadsDir?: string,
    private readonly sessionCacheOwner?: SessionCacheOwner
  ) {}

  async listDir(providerId: string, path: string): Promise<DirListing> {
    const host = await this.repository.get(providerId)
    if (!host) throw hostNotFound(providerId)

    let connection
    try {
      connection = await this.connectionBroker.acquire(providerId, { intent: 'direct_browse' })
    } catch (error) {
      throw remoteConnectionError(error)
    }

    const quotedPath = quoteRemotePath(path)
    const remoteCommand = [
      `realpath ${quotedPath} 2>/dev/null || echo ${quotedPath}`,
      `cd ${quotedPath} || exit 1`,
      'echo "$HOME"',
      `find . -maxdepth 1 -mindepth 1 -printf '%Y\\t%s\\t%T@\\t%f\\0' 2>/dev/null`
    ].join('\n')

    let runResult
    try {
      runResult = await connection.run(remoteCommand, {
        timeoutMs: LIST_DIR_TIMEOUT_MS,
        loginShell: false,
        maxOutputBytes: LIST_DIR_MAX_OUTPUT_BYTES
      })
    } catch (error) {
      throw remoteConnectionError(error)
    }

    if (runResult.timedOut || runResult.exitCode === 255) {
      const tail = errorTail(runResult.stderr, runResult.stdout)
      const fsError = new Error(tail || 'Connection failed') as Error & {
        remoteFsError: RemoteFsError & { retry_after_user_action: boolean }
      }
      fsError.remoteFsError = {
        detail: tail || 'SSH connection failed.',
        remoteKind: 'connection',
        retry_after_user_action: true
      }
      throw fsError
    }

    if (runResult.exitCode !== 0 && runResult.stderr) {
      const classified = classifyRemoteError({ stderr: runResult.stderr })
      const fsError = new Error(runResult.stderr) as Error & {
        remoteFsError: RemoteFsError & { retry_after_user_action: boolean }
      }
      fsError.remoteFsError = {
        detail: runResult.stderr,
        remoteKind: classified.remoteKind,
        retry_after_user_action: classified.retry_after_user_action
      }
      throw fsError
    }

    const firstNewline = runResult.stdout.indexOf('\n')
    const secondNewline = runResult.stdout.indexOf('\n', firstNewline + 1)
    const resolvedPath = firstNewline !== -1 ? runResult.stdout.slice(0, firstNewline).trim() : path
    const home =
      secondNewline !== -1 ? runResult.stdout.slice(firstNewline + 1, secondNewline).trim() : ''
    const findOutput = secondNewline !== -1 ? runResult.stdout.slice(secondNewline + 1) : ''
    const parsed = parseFindListing(findOutput)

    parsed.sort((left, right) => {
      if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1
      return left.name.localeCompare(right.name)
    })

    const truncated = parsed.length > MAX_LIST_ENTRIES
    return {
      entries: truncated ? parsed.slice(0, MAX_LIST_ENTRIES) : parsed,
      truncated,
      roots: {
        home: home || '~',
        scratch: host.scratchRoot ?? undefined
      },
      resolvedPath: resolvedPath || path
    }
  }

  async callCommand(
    providerId: string,
    cmd: string,
    intent: string,
    loginShell = true,
    timeoutSeconds?: number,
    context?: { sessionId: string; projectId: string },
    signal?: AbortSignal
  ): Promise<ExecResult> {
    const host = await this.repository.get(providerId)
    if (!host) throw hostNotFound(providerId)
    if (!this.approvalBroker) {
      throw new Error('ComputeApprovalBroker is required to call callCommand.')
    }

    const commandPreview =
      cmd.length > COMMAND_PREVIEW_MAX_LEN ? `${cmd.slice(0, COMMAND_PREVIEW_MAX_LEN)}…` : cmd
    const approvalInfo = {
      operation: 'call_command' as const,
      provider_id: host.providerId,
      provider_name: host.displayName,
      shape: host.shape,
      intent,
      command_preview: commandPreview,
      command_full: cmd
    }
    const decision = context
      ? await this.approvalBroker.requestWithContext(
          approvalInfo,
          {
            sessionId: context.sessionId,
            projectId: context.projectId,
            operation: 'call_command' as const,
            ownerId: host.id
          },
          signal
        )
      : await this.approvalBroker.request(approvalInfo, undefined, signal)

    if (decision === 'deny') {
      const error = new Error(
        `Remote command approval was denied for host "${host.displayName}".`
      ) as Error & { computeCallError: ComputeCallError }
      error.computeCallError = {
        error_code: 'approval_denied',
        message: `Approval denied for call_command on ${host.displayName}.`,
        retry_after_user_action: false
      }
      throw error
    }

    let connection
    try {
      connection = await this.connectionBroker.acquire(providerId, {
        intent: 'direct_command',
        ...(signal ? { signal } : {})
      })
    } catch (error) {
      throw computeCallConnectionError(error)
    }

    const cwdExpression = host.scratchRoot
      ? `cd ${quoteRemotePath(host.scratchRoot)} 2>/dev/null || cd ~`
      : 'cd ~'
    const wrappedCommand = `${cwdExpression}; ${cmd}`
    const timeoutMs =
      typeof timeoutSeconds === 'number' && timeoutSeconds > 0
        ? timeoutSeconds * 1000
        : CALL_COMMAND_DEFAULT_TIMEOUT_MS
    let runResult
    try {
      runResult = await connection.run(wrappedCommand, {
        timeoutMs,
        loginShell,
        maxOutputBytes: CALL_COMMAND_MAX_OUTPUT_BYTES,
        ...(signal ? { signal } : {})
      })
    } catch (error) {
      throw computeCallConnectionError(error)
    }

    if (runResult.timedOut) {
      const callError = new Error(
        `call_command on "${host.displayName}" timed out after ${timeoutMs}ms.`
      ) as Error & { computeCallError: ComputeCallError }
      callError.computeCallError = {
        error_code: 'timeout',
        message: `Command timed out after ${timeoutMs / 1000}s.`,
        retry_after_user_action: false
      }
      throw callError
    }

    if (runResult.exitCode === 255) {
      const tail = errorTail(runResult.stderr, runResult.stdout)
      const callError = new Error(
        `SSH connection to "${host.displayName}" failed: ${tail || 'exit 255'}`
      ) as Error & { computeCallError: ComputeCallError }
      callError.computeCallError = {
        error_code: 'host_unreachable',
        message: tail || 'SSH exit 255: connection failed.',
        retry_after_user_action: true
      }
      throw callError
    }

    return {
      exit_code: runResult.exitCode,
      stdout: runResult.stdout,
      stderr: runResult.stderr,
      truncated: runResult.truncated
    }
  }

  async download(
    providerId: string,
    remotePath: string,
    dest: DownloadDest,
    context?: { sessionId: string; projectId: string },
    signal?: AbortSignal
  ): Promise<LocalFile> {
    const host = await this.repository.get(providerId)
    if (!host) throw hostNotFound(providerId)

    const pathError = validateImportPath(remotePath)
    if (pathError) {
      const fsError = new Error(`Invalid remote path: ${remotePath}`) as Error & {
        remoteFsError: RemoteFsError
      }
      fsError.remoteFsError = {
        detail: 'Path must be absolute and contain no glob or shell metacharacters.',
        remoteKind: pathError
      }
      throw fsError
    }

    const filename = basename(remotePath)
    if (dest.kind === 'session-cache') {
      if (!this.approvalBroker) {
        throw new Error('ComputeApprovalBroker is required for session-cache downloads.')
      }
      if (!context || !this.sessionCacheOwner) {
        throw new Error('Session cache downloads require an owning Project and Session.')
      }
      const approvalInfo = {
        operation: 'download' as const,
        provider_id: host.providerId,
        provider_name: host.displayName,
        shape: host.shape,
        intent: 'Download remote file to session workspace',
        remote_path: remotePath
      }
      const decision = await this.approvalBroker.requestWithContext(
        approvalInfo,
        {
          sessionId: context.sessionId,
          projectId: context.projectId,
          operation: 'download',
          ownerId: host.id
        },
        signal
      )

      if (decision === 'deny') {
        const error = new Error(
          `Download approval was denied for "${remotePath}" on host "${host.displayName}".`
        ) as Error & { code: string }
        error.code = 'download_denied'
        throw error
      }
    }

    let connection
    try {
      connection = await this.connectionBroker.acquire(providerId, {
        intent: 'direct_download',
        ...(signal ? { signal } : {})
      })
    } catch (error) {
      throw remoteConnectionError(error)
    }

    if (dest.kind === 'os-downloads') {
      return this.downloadToOsDownloads(host, connection, remotePath, filename)
    }
    if (dest.kind === 'artifact') {
      return this.downloadToArtifact(host, connection, remotePath, filename)
    }

    return withDataRootWrite(() =>
      this.downloadToSessionCache(host, connection, remotePath, filename, context!)
    )
  }

  private async downloadToOsDownloads(
    host: ComputeHost,
    connection: ComputeConnectionLease,
    remotePath: string,
    filename: string
  ): Promise<LocalFile> {
    const remoteSnapshot = await this.statRemoteFile(host, connection, remotePath)
    if (remoteSnapshot.sizeBytes > MAX_DOWNLOAD_BYTES) {
      const fsError = new Error(
        `File exceeds 2 GiB download limit (${remoteSnapshot.sizeBytes} bytes)`
      ) as Error & { remoteFsError: RemoteFsError }
      fsError.remoteFsError = {
        detail: `File size ${remoteSnapshot.sizeBytes} bytes exceeds the 2 GiB download limit.`,
        remoteKind: 'too_large'
      }
      throw fsError
    }

    const downloadsDir = this.overrideDownloadsDir ?? this.getDownloadsDir()
    await mkdir(downloadsDir, { recursive: true })
    const destName = await resolveDestFilename(downloadsDir, filename)
    const destPath = join(downloadsDir, destName)
    const stagingPath = `${destPath}.${randomUUID()}.partial`
    try {
      await this.transferDownload(connection, remotePath, stagingPath, MAX_DOWNLOAD_BYTES)
      const localSize = await this.verifyStableDownload(
        host,
        connection,
        remotePath,
        stagingPath,
        remoteSnapshot
      )
      await rename(stagingPath, destPath)

      return {
        path: destPath,
        name: destName,
        size: localSize,
        mimeType: inferMimeType(filename)
      }
    } catch (error) {
      await rm(stagingPath, { force: true }).catch(() => undefined)
      throw error
    }
  }

  private async downloadToArtifact(
    host: ComputeHost,
    connection: ComputeConnectionLease,
    remotePath: string,
    filename: string
  ): Promise<LocalFile> {
    const pathError = validateImportPath(remotePath)
    if (pathError) {
      const fsError = new Error(`Invalid remote path: ${remotePath}`) as Error & {
        remoteFsError: RemoteFsError
      }
      fsError.remoteFsError = {
        detail: `Path must be absolute and contain no glob characters.`,
        remoteKind: pathError
      }
      throw fsError
    }

    const remoteSnapshot = await this.statRemoteFile(host, connection, remotePath)
    if (remoteSnapshot.sizeBytes === 0) {
      const fsError = new Error(`Remote file is empty: ${remotePath}`) as Error & {
        remoteFsError: RemoteFsError
      }
      fsError.remoteFsError = { detail: 'Cannot import an empty file.', remoteKind: 'not_a_file' }
      throw fsError
    }
    if (remoteSnapshot.sizeBytes > MAX_IMPORT_BYTES) {
      const fsError = new Error(
        `File exceeds 50 MB import limit (${remoteSnapshot.sizeBytes} bytes)`
      ) as Error & {
        remoteFsError: RemoteFsError
      }
      fsError.remoteFsError = {
        detail: `File size ${remoteSnapshot.sizeBytes} bytes exceeds the 50 MB import limit.`,
        remoteKind: 'too_large'
      }
      throw fsError
    }

    const tempBase = this.overrideDownloadsDir ?? tmpdir()
    const tempDir = await mkdtemp(join(tempBase, 'cs-import-'))
    const tempPath = join(tempDir, filename)
    try {
      await this.transferDownload(connection, remotePath, tempPath, MAX_IMPORT_BYTES)
      const localSize = await this.verifyStableDownload(
        host,
        connection,
        remotePath,
        tempPath,
        remoteSnapshot
      )

      return {
        path: tempPath,
        name: filename,
        size: localSize,
        mimeType: inferMimeType(filename),
        artifactId: `${randomUUID()}|ssh:${host.displayName}:${remotePath}`
      }
    } catch (error) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  private async downloadToSessionCache(
    host: ComputeHost,
    connection: ComputeConnectionLease,
    remotePath: string,
    filename: string,
    context: { sessionId: string; projectId: string }
  ): Promise<LocalFile> {
    const remoteSnapshot = await this.statRemoteFile(host, connection, remotePath)
    if (remoteSnapshot.sizeBytes > MAX_DOWNLOAD_BYTES) {
      const fsError = new Error(
        `File exceeds 2 GiB download limit (${remoteSnapshot.sizeBytes} bytes)`
      ) as Error & { remoteFsError: RemoteFsError }
      fsError.remoteFsError = {
        detail: `File size ${remoteSnapshot.sizeBytes} bytes exceeds the 2 GiB download limit.`,
        remoteKind: 'too_large'
      }
      throw fsError
    }

    const operation = await this.sessionCacheOwner!.createOperationFile(
      context.projectId,
      context.sessionId,
      filename
    )
    try {
      await this.transferDownload(connection, remotePath, operation.path, MAX_DOWNLOAD_BYTES)
      const localSize = await this.verifyStableDownload(
        host,
        connection,
        remotePath,
        operation.path,
        remoteSnapshot
      )
      const committedPath = await operation.commit()
      return {
        path: committedPath,
        name: filename,
        size: localSize,
        mimeType: inferMimeType(filename)
      }
    } catch (error) {
      await this.sessionCacheOwner!.removeOperation(
        context.projectId,
        context.sessionId,
        operation.operationId
      ).catch(() => undefined)
      throw error
    } finally {
      operation.release()
    }
  }

  private getDownloadsDir(): string {
    try {
      return app.getPath('downloads')
    } catch {
      return join(tmpdir(), 'downloads')
    }
  }

  private async statRemote(
    _host: ComputeHost,
    connection: ComputeConnectionLease,
    remotePath: string
  ): Promise<RemoteFileStat> {
    const command = remoteFileStatCommand(remotePath)
    let result
    try {
      result = await connection.run(command, {
        timeoutMs: 10_000,
        loginShell: false,
        maxOutputBytes: 64
      })
    } catch (error) {
      if (error instanceof Error && 'remoteFsError' in error) throw error
      throw remoteConnectionError(error)
    }

    if (result.timedOut || result.exitCode === 255) {
      const fsError = new Error('SSH connection failed during stat') as Error & {
        remoteFsError: RemoteFsError & { retry_after_user_action: boolean }
      }
      fsError.remoteFsError = {
        detail: 'Connection failed.',
        remoteKind: 'connection',
        retry_after_user_action: true
      }
      throw fsError
    }

    return parseRemoteFileStat(result.stdout)
  }

  private async statRemoteFile(
    host: ComputeHost,
    connection: ComputeConnectionLease,
    remotePath: string
  ): Promise<RemoteFileSnapshot> {
    const { fileType, snapshot } = await this.statRemote(host, connection, remotePath)
    if (fileType === 'm') {
      const fsError = new Error(`Remote path not found: ${remotePath}`) as Error & {
        remoteFsError: RemoteFsError
      }
      fsError.remoteFsError = {
        detail: 'Path not found.',
        remoteKind: 'not_found'
      }
      throw fsError
    }
    if (fileType !== 'f' || !snapshot) {
      const fsError = new Error(`Remote path is not a regular file: ${remotePath}`) as Error & {
        remoteFsError: RemoteFsError
      }
      fsError.remoteFsError = {
        detail: fileType === 'd' ? 'Path is a directory.' : 'Path is not a regular file.',
        remoteKind: 'not_a_file'
      }
      throw fsError
    }
    return snapshot
  }

  private async verifyStableDownload(
    host: ComputeHost,
    connection: ComputeConnectionLease,
    remotePath: string,
    localPath: string,
    expectedSnapshot: RemoteFileSnapshot
  ): Promise<number> {
    const localStat = await fsStat(localPath)
    const localSize = Number(localStat.size)
    const postTransferSnapshot = await this.statRemoteFile(host, connection, remotePath)
    if (
      localSize !== expectedSnapshot.sizeBytes ||
      !sameRemoteFileSnapshot(postTransferSnapshot, expectedSnapshot)
    ) {
      const fsError = new Error(`File changed during transfer: ${remotePath}`) as Error & {
        remoteFsError: RemoteFsError
      }
      fsError.remoteFsError = {
        detail: 'File changed during transfer — download rejected.',
        remoteKind: 'not_a_file'
      }
      throw fsError
    }
    return localSize
  }

  private async transferDownload(
    connection: ComputeConnectionLease,
    remotePath: string,
    localPath: string,
    maxBytes: number
  ): Promise<void> {
    let result
    try {
      result = await connection.download(remotePath, localPath, maxBytes)
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error
      throw remoteConnectionError(error)
    }
    if (result.exceeded) {
      const fsError = new Error('Remote file exceeds the download size limit.') as Error & {
        remoteFsError: RemoteFsError
      }
      fsError.remoteFsError = {
        detail: `Remote file exceeds the ${maxBytes} byte download limit.`,
        remoteKind: 'too_large'
      }
      throw fsError
    }
    if (result.timedOut || result.exitCode === 255) {
      const fsError = new Error('Compute Host connection failed during download.') as Error & {
        remoteFsError: RemoteFsError & { retry_after_user_action: boolean }
      }
      fsError.remoteFsError = {
        detail: result.timedOut ? 'Download timed out.' : 'Compute Host connection failed.',
        remoteKind: 'connection',
        retry_after_user_action: true
      }
      throw fsError
    }
    if (result.exitCode !== 0) {
      const classified = classifyRemoteError({ stderr: result.stderr })
      const fsError = new Error(result.stderr || 'Remote file transfer failed.') as Error & {
        remoteFsError: RemoteFsError
      }
      fsError.remoteFsError = {
        detail: result.stderr || 'Remote file transfer failed.',
        remoteKind: classified.remoteKind
      }
      throw fsError
    }
  }
}
