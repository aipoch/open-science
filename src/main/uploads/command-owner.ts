import { stat } from 'node:fs/promises'

import type { ApplicationCallerLease, ApplicationInvocation } from '../application-command-router'
import { acquireDataRootWriter, withDataRootWrite } from '../storage/migration-state'
import {
  readBoundedManagedFilePreviewLease,
  type ManagedFilePreviewReadLease
} from '../managed-file-preview'

import type { ArtifactPreviewResult, ReadArtifactPreviewRequest } from '../../shared/artifacts'
import type {
  AppendUploadTransferRequest,
  BeginUploadTransferRequest,
  DeleteUploadRequest,
  FinalizeUploadSessionRequest,
  StageLocalPathUploadRequest,
  StageLocalUploadRequest,
  UploadTransferRequest,
  UploadTransferProgress,
  UploadTransferStatus
} from '../../shared/uploads'
import {
  parseUploadVersionReference,
  DEFAULT_UPLOAD_PROJECT_ID,
  STANDALONE_UPLOAD_SESSION_ID,
  type UploadedAttachment
} from '../../shared/uploads'
import { validateLocalPath } from '../../shared/local-fs'
import type { UploadRepository } from './repository'

type UploadCaller = {
  transferIds: Set<string>
  release: () => void
}

type ChunkWriter = {
  owner: UploadCaller
  release: () => void
  ready: Promise<UploadTransferStatus>
  cancelled: boolean
  settling: boolean
  inFlight: Set<Promise<unknown>>
  cleanup?: Promise<void>
}

type LocalWriter = {
  owner: UploadCaller
  release: () => void
  cancelled: boolean
  ready?: Promise<UploadedAttachment>
  attachment?: UploadedAttachment
  cleanup?: Promise<void>
}

type UploadProgressTarget = Readonly<{
  report: (progress: UploadTransferProgress) => void
}>

type UploadCommandOwnerOptions = Readonly<{
  openLatestManagedFile?: (
    request: Omit<ReadArtifactPreviewRequest, 'versionId'> & { versionId?: never }
  ) => Promise<ManagedFilePreviewReadLease>
  openManagedFileVersion?: (
    request: ReadArtifactPreviewRequest & { versionId: string }
  ) => Promise<ManagedFilePreviewReadLease>
  withSessionMutation?: <Result>(
    projectId: string,
    sessionId: string,
    mutation: () => Promise<Result>
  ) => Promise<Result>
}>

type UploadCommandOwner = Readonly<{
  releaseCaller(lease: ApplicationCallerLease): void
  stageLocalFile(
    invocation: ApplicationInvocation<readonly [StageLocalUploadRequest]>,
    progressTarget: UploadProgressTarget
  ): Promise<UploadedAttachment>
  claimLocalFile(invocation: ApplicationInvocation<readonly [UploadTransferRequest]>): void
  stageLocalPath(
    invocation: ApplicationInvocation<readonly [StageLocalPathUploadRequest]>,
    progressTarget?: UploadProgressTarget
  ): Promise<UploadedAttachment>
  beginTransfer(
    invocation: ApplicationInvocation<readonly [BeginUploadTransferRequest]>
  ): Promise<UploadTransferStatus>
  appendTransfer(
    invocation: ApplicationInvocation<readonly [AppendUploadTransferRequest]>
  ): Promise<UploadTransferStatus>
  transferStatus(
    invocation: ApplicationInvocation<readonly [UploadTransferRequest]>
  ): Promise<UploadTransferStatus | null>
  finishTransfer(
    invocation: ApplicationInvocation<readonly [UploadTransferRequest]>
  ): Promise<Awaited<ReturnType<UploadRepository['finishTransfer']>>>
  abortTransfer(invocation: ApplicationInvocation<readonly [UploadTransferRequest]>): Promise<void>
  deleteUpload(invocation: ApplicationInvocation<readonly [DeleteUploadRequest]>): Promise<void>
  finalizeSession(
    invocation: ApplicationInvocation<readonly [FinalizeUploadSessionRequest]>
  ): Promise<UploadedAttachment[]>
  readPreview(
    invocation: ApplicationInvocation<readonly [ReadArtifactPreviewRequest]>
  ): Promise<ArtifactPreviewResult>
}>

// T2h0a1 deliberately has no live transport consumer. T2h0a2 replaces the legacy IPC closure
// atomically and injects this same owner into both IPC and staged application commands.
const createUploadCommandOwner = (
  repository: UploadRepository,
  options: UploadCommandOwnerOptions = {}
): UploadCommandOwner => {
  const callers = new WeakMap<ApplicationCallerLease, UploadCaller>()
  const chunkWriters = new Map<string, ChunkWriter>()
  const localWriters = new Map<string, LocalWriter>()

  const releaseChunkWriter = (transferId: string, writer: ChunkWriter): void => {
    if (chunkWriters.get(transferId) !== writer) return
    chunkWriters.delete(transferId)
    writer.owner.transferIds.delete(transferId)
    writer.release()
  }
  const abortChunkWriter = (transferId: string, writer: ChunkWriter): Promise<void> => {
    if (writer.cleanup) return writer.cleanup

    writer.cancelled = true
    writer.cleanup = (async () => {
      try {
        await writer.ready.catch(() => undefined)
        await Promise.allSettled([...writer.inFlight])
        await repository.abortTransfer({ transferId }).catch(() => undefined)
      } finally {
        releaseChunkWriter(transferId, writer)
      }
    })()
    return writer.cleanup
  }
  const releaseLocalWriter = (transferId: string, writer: LocalWriter): void => {
    if (localWriters.get(transferId) !== writer) return
    localWriters.delete(transferId)
    writer.owner.transferIds.delete(transferId)
    writer.release()
  }
  const abortLocalWriter = (transferId: string, writer: LocalWriter): Promise<void> => {
    if (writer.cleanup) return writer.cleanup

    writer.cancelled = true
    writer.cleanup = (async () => {
      try {
        await repository.abortTransfer({ transferId }).catch(() => undefined)
        const attachment = writer.attachment ?? (await writer.ready?.catch(() => undefined))
        if (attachment) {
          await repository.deleteUpload({ path: attachment.path }).catch(() => undefined)
        }
      } finally {
        releaseLocalWriter(transferId, writer)
      }
    })()
    return writer.cleanup
  }
  const registerCaller = (lease: ApplicationCallerLease): UploadCaller => {
    const existing = callers.get(lease)
    if (existing) return existing
    if (lease.signal.aborted || !lease.isCurrent()) {
      throw new Error('Upload renderer is no longer available.')
    }

    function release(): void {
      if (callers.get(lease) !== caller) return
      callers.delete(lease)
      lease.signal.removeEventListener('abort', release)
      for (const transferId of [...caller.transferIds]) {
        const writer = chunkWriters.get(transferId)
        if (writer?.owner === caller && !writer.settling) {
          void abortChunkWriter(transferId, writer)
        }
        const localWriter = localWriters.get(transferId)
        if (localWriter?.owner === caller) void abortLocalWriter(transferId, localWriter)
      }
    }
    const caller: UploadCaller = { transferIds: new Set(), release }
    callers.set(lease, caller)
    lease.signal.addEventListener('abort', release, { once: true })
    if (lease.signal.aborted || !lease.isCurrent()) {
      release()
      throw new Error('Upload renderer is no longer available.')
    }
    return caller
  }
  const getOwnedChunkWriter = (
    lease: ApplicationCallerLease,
    transferId: string
  ): ChunkWriter | undefined => {
    const owner = registerCaller(lease)
    const writer = chunkWriters.get(transferId)
    if (writer && writer.owner !== owner) {
      throw new Error(`Upload transfer belongs to another renderer: ${transferId}`)
    }
    return writer
  }
  const getOwnedLocalWriter = (
    lease: ApplicationCallerLease,
    transferId: string
  ): LocalWriter | undefined => {
    const owner = registerCaller(lease)
    const writer = localWriters.get(transferId)
    if (writer && writer.owner !== owner) {
      throw new Error(`Upload transfer belongs to another renderer: ${transferId}`)
    }
    return writer
  }
  const runLocalStaging = async (
    invocation: ApplicationInvocation<readonly [StageLocalUploadRequest]>,
    progressTarget: UploadProgressTarget,
    releaseOnCommit: boolean
  ): Promise<UploadedAttachment> => {
    const {
      callerLease,
      args: [request]
    } = invocation
    const owner = registerCaller(callerLease)
    const existing = localWriters.get(request.transferId) ?? chunkWriters.get(request.transferId)
    if (existing) {
      if (existing.owner !== owner) {
        throw new Error(`Upload transfer belongs to another renderer: ${request.transferId}`)
      }
      throw new Error(`Upload transfer already exists: ${request.transferId}`)
    }

    const writer: LocalWriter = {
      owner,
      release: acquireDataRootWriter(),
      cancelled: false
    }
    localWriters.set(request.transferId, writer)
    owner.transferIds.add(request.transferId)
    try {
      writer.ready = repository.stageLocalFile(request, (progress) => {
        if (!writer.cancelled) progressTarget.report(progress)
      })
      const attachment = await writer.ready
      writer.attachment = attachment
      if (writer.cancelled) {
        await writer.cleanup
        throw new Error(`Upload renderer is no longer available: ${request.transferId}`)
      }
      if (releaseOnCommit) releaseLocalWriter(request.transferId, writer)
      return attachment
    } catch (error) {
      if (writer.cancelled) await writer.cleanup
      else releaseLocalWriter(request.transferId, writer)
      throw error
    }
  }

  return Object.freeze({
    releaseCaller: (lease) => callers.get(lease)?.release(),
    stageLocalFile: (invocation, progressTarget) =>
      runLocalStaging(invocation, progressTarget, false),
    claimLocalFile: ({ callerLease, args: [request] }) => {
      const writer = getOwnedLocalWriter(callerLease, request.transferId)
      if (!writer) return
      if (!writer.attachment) {
        throw new Error(`Upload transfer is not ready to claim: ${request.transferId}`)
      }
      if (writer.cancelled) {
        throw new Error(`Upload renderer is no longer available: ${request.transferId}`)
      }
      releaseLocalWriter(request.transferId, writer)
    },
    stageLocalPath: async (invocation, progressTarget = { report: () => undefined }) => {
      const request = invocation.args[0]
      if (
        typeof request !== 'object' ||
        request === null ||
        typeof request.transferId !== 'string' ||
        typeof request.name !== 'string' ||
        typeof request.sourcePath !== 'string' ||
        validateLocalPath(request.sourcePath, process.platform) !== undefined
      ) {
        throw new Error('Invalid local path upload request.')
      }
      const sourceInfo = await stat(request.sourcePath)
      const attachment = await runLocalStaging(
        { ...invocation, args: [{ ...request, size: sourceInfo.size }] },
        progressTarget,
        true
      )
      const projectId = request.projectId ?? DEFAULT_UPLOAD_PROJECT_ID
      try {
        const published = await withDataRootWrite(() =>
          repository.finalizePendingSessionUploads(
            STANDALONE_UPLOAD_SESSION_ID,
            [attachment],
            projectId
          )
        )
        if (published.length !== 1) {
          throw new Error(
            `Expected exactly one published standalone upload, received ${published.length}.`
          )
        }
        return published[0]
      } catch (error) {
        await repository.deleteUpload({ path: attachment.path }).catch(() => undefined)
        throw error
      }
    },
    beginTransfer: async ({ callerLease, args: [request] }) => {
      const owner = registerCaller(callerLease)
      const localWriter = localWriters.get(request.transferId)
      if (localWriter) {
        if (localWriter.owner !== owner) {
          throw new Error(`Upload transfer belongs to another renderer: ${request.transferId}`)
        }
        throw new Error(`Upload transfer already exists: ${request.transferId}`)
      }
      const existing = chunkWriters.get(request.transferId)
      if (existing) {
        if (existing.owner !== owner) {
          throw new Error(`Upload transfer belongs to another renderer: ${request.transferId}`)
        }
        await existing.ready
        return repository.beginTransfer(request)
      }

      const writer: ChunkWriter = {
        owner,
        release: acquireDataRootWriter(),
        ready: repository.beginTransfer(request),
        cancelled: false,
        settling: false,
        inFlight: new Set()
      }
      chunkWriters.set(request.transferId, writer)
      owner.transferIds.add(request.transferId)
      try {
        const status = await writer.ready
        if (writer.cancelled) {
          await writer.cleanup
          throw new Error(`Upload renderer is no longer available: ${request.transferId}`)
        }
        return status
      } catch (error) {
        releaseChunkWriter(request.transferId, writer)
        throw error
      }
    },
    appendTransfer: async ({ callerLease, args: [request] }) => {
      const writer = getOwnedChunkWriter(callerLease, request.transferId)
      if (!writer) return withDataRootWrite(() => repository.appendTransfer(request))

      await writer.ready
      if (writer.cancelled) {
        throw new Error(`Upload renderer is no longer available: ${request.transferId}`)
      }
      const operation = repository.appendTransfer(request)
      writer.inFlight.add(operation)
      try {
        return await operation
      } finally {
        writer.inFlight.delete(operation)
      }
    },
    transferStatus: ({ callerLease, args: [request] }) => {
      getOwnedChunkWriter(callerLease, request.transferId)
      return repository.getTransferStatus(request)
    },
    finishTransfer: async ({ callerLease, args: [request] }) => {
      const writer = getOwnedChunkWriter(callerLease, request.transferId)
      if (!writer) return withDataRootWrite(() => repository.finishTransfer(request))

      try {
        await writer.ready
      } catch (error) {
        await abortChunkWriter(request.transferId, writer)
        throw error
      }
      if (writer.cancelled) {
        await writer.cleanup
        throw new Error(`Upload renderer is no longer available: ${request.transferId}`)
      }
      if (writer.settling) {
        throw new Error(`Upload transfer is already finishing: ${request.transferId}`)
      }
      writer.settling = true

      try {
        await Promise.allSettled([...writer.inFlight])
        return await repository.finishTransfer(request)
      } catch (error) {
        await repository.abortTransfer(request).catch(() => undefined)
        throw error
      } finally {
        releaseChunkWriter(request.transferId, writer)
      }
    },
    abortTransfer: async ({ callerLease, args: [request] }) => {
      const localWriter = getOwnedLocalWriter(callerLease, request.transferId)
      if (localWriter) return abortLocalWriter(request.transferId, localWriter)

      const writer = getOwnedChunkWriter(callerLease, request.transferId)
      if (!writer) return withDataRootWrite(() => repository.abortTransfer(request))
      if (writer.settling) {
        throw new Error(`Upload transfer is already finishing: ${request.transferId}`)
      }

      await abortChunkWriter(request.transferId, writer)
    },
    deleteUpload: ({ args: [request] }) =>
      withDataRootWrite(() => repository.deleteUpload(request)),
    finalizeSession: ({ args: [request] }) =>
      withDataRootWrite(() => {
        const projectId = request.projectId?.trim() || DEFAULT_UPLOAD_PROJECT_ID
        const finalize = (): Promise<UploadedAttachment[]> =>
          repository.finalizePendingSessionUploads(
            request.sessionId,
            request.attachments,
            projectId
          )
        return options.withSessionMutation
          ? options.withSessionMutation(projectId, request.sessionId, finalize)
          : finalize()
      }),
    readPreview: async ({ args: [request] }) => {
      const versionIdentity = parseUploadVersionReference(request.path)
      const logicalRequest =
        request.projectId && request.fileId
          ? request
          : versionIdentity?.projectId && versionIdentity.sessionId && versionIdentity.fileId
            ? {
                ...request,
                projectId: versionIdentity.projectId,
                sessionId: versionIdentity.sessionId,
                fileId: versionIdentity.fileId,
                versionId: versionIdentity.versionId
              }
            : undefined
      if (!logicalRequest) {
        throw new Error('Managed Upload preview requires a logical identity.')
      }
      const lease = logicalRequest.versionId
        ? await options.openManagedFileVersion?.({
            ...logicalRequest,
            versionId: logicalRequest.versionId
          })
        : await options.openLatestManagedFile?.({ ...logicalRequest, versionId: undefined })
      if (!lease) {
        throw new Error('Managed Upload Version lease is not configured.')
      }
      try {
        return await readBoundedManagedFilePreviewLease(
          lease,
          request,
          'Invalid upload preview encoding.'
        )
      } finally {
        await lease.close()
      }
    }
  })
}

export { createUploadCommandOwner }
export type { UploadCommandOwner }
