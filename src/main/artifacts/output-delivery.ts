import type { PrismaClient } from '@prisma/client'
import type { ArtifactVersionFile } from '../../shared/artifact-provenance'
import { join } from 'node:path'
import type {
  ArtifactOutputDeliveryStatus,
  ManagedFileIdentity,
  ManagedFileRetryOutputDeliveryRequest
} from '../../shared/managed-file-versions'
import { isSafeManagedFileBasename } from '../../shared/managed-file-versions'
import { ManagedFileVersionError } from '../managed-file-versions/error'
import type { ManagedFileReadLease } from '../managed-file-versions/read-port'
import {
  ProjectFolderStagedFiles,
  ProjectFolderConflictError,
  type ProjectFolderDeliveryBaseline
} from '../project-folders/staged-files'
import type { ProjectFolderChange } from '../../shared/project-folder-changes'
import { isImportedResearchSession } from '../storage/session-package-state'
import { LOCAL_RESOURCE_BUDGETS, assertWithinResourceBudget } from '../resource-budget'

type DeliveryRecord = ArtifactOutputDeliveryStatus & {
  format: 1
  lastDelivered?: ProjectFolderDeliveryBaseline
  receiptId?: string
}
export type ArtifactOutputMutation = {
  projectId: string
  sessionId: string
  runId: string
  folder: string
  relativePath: string
  replacementBaseline: ProjectFolderDeliveryBaseline | null
  copyContent: (destination: string) => Promise<void>
  assertCurrent: () => Promise<void>
}
type MutationResult = {
  change?: ProjectFolderChange
  baseline?: ProjectFolderDeliveryBaseline
}
type Options = {
  storageRoot: string
  getClient: () => Promise<PrismaClient>
  openVersion: (request: ManagedFileIdentity, versionId: string) => Promise<ManagedFileReadLease>
  getLayout: (
    projectId: string,
    sessionId: string
  ) => Promise<
    | {
        projectRoot: string
        artifactDirectoryRelativePath: string
      }
    | undefined
  >
  files?: ProjectFolderStagedFiles
}

// One mutable, durable projection of the existing immutable head. This is deliberately event driven:
// inspection, index hydration and restart never export files or revive an externally deleted file.
export class ArtifactOutputDelivery {
  private static readonly queues = new Map<string, Promise<unknown>>()
  private readonly files: ProjectFolderStagedFiles
  private mutate: (input: ArtifactOutputMutation) => Promise<MutationResult>
  constructor(private readonly options: Options) {
    this.files =
      options.files ??
      new ProjectFolderStagedFiles({
        storageRoot: options.storageRoot,
        approve: async () => false,
        authorizeCreatedFile: async () => true
      })
    this.mutate = async (input) => {
      const change = await this.files.prepareMutation({ ...input, operation: 'write' })
      await input.assertCurrent()
      const applied = change
        ? await this.files.apply(
            input,
            change.id,
            undefined,
            undefined,
            input.folder,
            input.assertCurrent
          )
        : undefined
      return {
        change: applied,
        baseline:
          applied?.state === 'rejected'
            ? undefined
            : await this.files.inspectDeliveryTarget(input.folder, input.relativePath)
      }
    }
  }
  setMutationOwner(owner: (input: ArtifactOutputMutation) => Promise<MutationResult>): void {
    this.mutate = owner
  }
  async deliverActivated(versions: ArtifactVersionFile[]): Promise<void> {
    const client = await this.options.getClient()
    for (const version of versions) {
      const lineage = await client.artifactLineage.findUnique({ where: { id: version.artifactId } })
      if (lineage?.currentVersionId === version.versionId) {
        // Activation is already committed. The separate status is inspected/retried by the caller;
        // never reinterpret an external-file problem as a failed immutable publication.
        await this.deliver({
          source: 'artifact',
          projectId: lineage.projectId,
          fileId: lineage.id,
          versionId: version.versionId
        }).catch(() => undefined)
      }
    }
  }
  private parse(text: string | null): DeliveryRecord | undefined {
    if (!text) return undefined
    const value = JSON.parse(text) as DeliveryRecord
    if (
      value.format !== 1 ||
      typeof value.relativePath !== 'string' ||
      typeof value.versionId !== 'string' ||
      !['pending', 'delivered', 'conflict', 'failed', 'cancelled'].includes(value.state)
    )
      throw new Error('Unsupported Artifact output delivery record.')
    return value
  }
  private publicStatus(record: DeliveryRecord): ArtifactOutputDeliveryStatus {
    return {
      state: record.state,
      versionId: record.versionId,
      relativePath: record.relativePath,
      canRetry: record.canRetry,
      ...(record.errorCode ? { errorCode: record.errorCode } : {})
    }
  }
  private async assertCurrent(request: ManagedFileRetryOutputDeliveryRequest): Promise<void> {
    const client = await this.options.getClient()
    const lineage = await client.artifactLineage.findUnique({ where: { id: request.fileId } })
    if (
      !lineage ||
      lineage.projectId !== request.projectId ||
      lineage.currentVersionId !== request.versionId
    )
      throw new ManagedFileVersionError(
        'VERSION_CONFLICT',
        'Artifact output no longer names the current head.'
      )
    const [project, deleting, origin, sync, projection, version] = await Promise.all([
      client.project.findUnique({ where: { id: request.projectId }, select: { archivedAt: true } }),
      client.projectDeletionIntent.findUnique({ where: { projectId: request.projectId } }),
      client.fileOriginSession.findUnique({
        where: {
          projectId_sessionId: { projectId: request.projectId, sessionId: lineage.sessionId }
        }
      }),
      client.managedFileSessionSync.findUnique({
        where: {
          projectId_sessionId: { projectId: request.projectId, sessionId: lineage.sessionId }
        }
      }),
      client.managedFile.findUnique({
        where: {
          projectId_source_sourceFileId: {
            projectId: request.projectId,
            source: 'artifact',
            sourceFileId: request.fileId
          }
        }
      }),
      client.artifactVersion.findUnique({ where: { id: request.versionId } })
    ])
    if (
      !project ||
      project.archivedAt ||
      deleting ||
      (await isImportedResearchSession(
        this.options.storageRoot,
        request.projectId,
        lineage.sessionId
      ))
    )
      throw new ManagedFileVersionError(
        'PROJECT_NOT_WRITABLE',
        'Artifact output Project is not writable.'
      )
    if (
      !origin ||
      origin.state !== 'active' ||
      origin.deletedAt ||
      origin.deletionOperationId ||
      sync?.deletedAt ||
      sync?.deleteOperationId ||
      projection?.deletedAt ||
      projection?.deleteOperationId
    )
      throw new ManagedFileVersionError(
        'FILE_DELETED',
        'Artifact output Session or file is deleted.'
      )
    if (
      !version ||
      version.artifactId !== lineage.id ||
      version.state !== 'finalized' ||
      (version.originKind === 'agent_generated' && !version.managedVisibleAt)
    )
      throw new ManagedFileVersionError(
        'VERSION_NOT_FOUND',
        'Artifact output version is not published.'
      )
  }
  private async store(fileId: string, record: DeliveryRecord): Promise<void> {
    const client = await this.options.getClient()
    await client.artifactLineage.update({
      where: { id: fileId },
      data: { outputDeliveryJson: JSON.stringify(record) }
    })
  }
  async inspect(request: ManagedFileIdentity): Promise<ArtifactOutputDeliveryStatus | undefined> {
    if (request.source !== 'artifact') return undefined
    const client = await this.options.getClient()
    const lineage = await client.artifactLineage.findUnique({ where: { id: request.fileId } })
    if (!lineage || lineage.projectId !== request.projectId || !lineage.currentVersionId)
      return undefined
    const layout = await this.options.getLayout(request.projectId, lineage.sessionId)
    if (!layout) return undefined
    const record = this.parse(lineage.outputDeliveryJson) ?? {
      format: 1 as const,
      state: 'pending' as const,
      versionId: lineage.currentVersionId,
      relativePath: layout.artifactDirectoryRelativePath + '/' + lineage.filename,
      canRetry: true
    }
    // An interrupted attempt remains retryable after reopen; it never starts work here.
    const result: ArtifactOutputDeliveryStatus = {
      state:
        record.versionId === lineage.currentVersionId && record.state !== 'cancelled'
          ? record.state
          : 'pending',
      versionId: lineage.currentVersionId,
      relativePath: record.relativePath,
      canRetry: true,
      ...(record.errorCode ? { errorCode: record.errorCode } : {})
    }
    if (!isSafeManagedFileBasename(lineage.filename))
      return { ...result, state: 'failed', canRetry: false, errorCode: 'UNSAFE_FILENAME' }
    try {
      await this.assertCurrent({ ...request, versionId: lineage.currentVersionId })
    } catch {
      return { ...result, state: 'cancelled', canRetry: false }
    }
    if (result.state === 'delivered') {
      try {
        const actual = await this.files.inspectDeliveryTarget(
          layout.projectRoot,
          record.relativePath
        )
        if (!actual) return { ...result, state: 'pending' }
        if (
          !record.lastDelivered ||
          actual.checksum !== record.lastDelivered.checksum ||
          actual.size !== record.lastDelivered.size ||
          actual.identity !== record.lastDelivered.identity ||
          actual.rootIdentity !== record.lastDelivered.rootIdentity
        )
          return { ...result, state: 'conflict' }
      } catch {
        return { ...result, state: 'conflict' }
      }
    }
    return result
  }
  async deliver(
    request: ManagedFileRetryOutputDeliveryRequest
  ): Promise<ArtifactOutputDeliveryStatus | undefined> {
    if (request.source !== 'artifact') return undefined
    const key = JSON.stringify([this.options.storageRoot, request.projectId, request.fileId])
    const previous = ArtifactOutputDelivery.queues.get(key) ?? Promise.resolve()
    const work = previous.catch(() => undefined).then(() => this.deliverCurrent(request))
    ArtifactOutputDelivery.queues.set(key, work)
    try {
      return await work
    } finally {
      if (ArtifactOutputDelivery.queues.get(key) === work) ArtifactOutputDelivery.queues.delete(key)
    }
  }
  private async deliverCurrent(
    request: ManagedFileRetryOutputDeliveryRequest
  ): Promise<ArtifactOutputDeliveryStatus | undefined> {
    await this.assertCurrent(request)
    const client = await this.options.getClient()
    const lineage = await client.artifactLineage.findUniqueOrThrow({
      where: { id: request.fileId }
    })
    const layout = await this.options.getLayout(request.projectId, lineage.sessionId)
    if (!layout) return undefined
    const old = this.parse(lineage.outputDeliveryJson)
    if (!isSafeManagedFileBasename(lineage.filename))
      throw new ManagedFileVersionError(
        'INVALID_REQUEST',
        'Artifact output filename is not portable.'
      )
    const relativePath =
      old?.relativePath ??
      join(layout.artifactDirectoryRelativePath, lineage.filename).split('\\').join('/')
    // A portable index must not be able to redirect a delivery outside its declared Session tree.
    if (
      !relativePath.startsWith(layout.artifactDirectoryRelativePath + '/') ||
      relativePath.slice(layout.artifactDirectoryRelativePath.length + 1).includes('/') ||
      !isSafeManagedFileBasename(
        relativePath.slice(layout.artifactDirectoryRelativePath.length + 1)
      )
    )
      throw new ManagedFileVersionError(
        'INVALID_REQUEST',
        'Artifact output association is invalid.'
      )
    let record: DeliveryRecord = {
      format: 1,
      state: 'pending',
      versionId: request.versionId,
      relativePath,
      canRetry: true,
      ...(old?.lastDelivered ? { lastDelivered: old.lastDelivered } : {})
    }
    await this.store(request.fileId, record)
    let lease: ManagedFileReadLease | undefined
    try {
      lease = await this.options.openVersion(request, request.versionId)
      assertWithinResourceBudget('file', lease.size, LOCAL_RESOURCE_BUDGETS.artifactFileBytes)
      const result = await this.mutate({
        projectId: request.projectId,
        sessionId: lineage.sessionId,
        runId: request.versionId,
        folder: layout.projectRoot,
        relativePath,
        replacementBaseline: record.lastDelivered ?? null,
        copyContent: async (destination) => {
          await lease!.copyTo(destination, { exclusive: true })
          await lease!.verifyUnchanged()
        },
        assertCurrent: () => this.assertCurrent(request)
      })
      await this.assertCurrent(request)
      if (result.change?.state === 'rejected')
        record = { ...record, state: 'conflict', errorCode: 'APPROVAL_REJECTED' }
      else {
        if (
          !result.baseline ||
          result.baseline.checksum !== lease.version.checksum ||
          result.baseline.size !== lease.size
        )
          throw new Error('Artifact output delivery did not produce the exact version bytes.')
        record = {
          ...record,
          state: 'delivered',
          lastDelivered: result.baseline,
          ...(result.change ? { receiptId: result.change.id } : {})
        }
      }
    } catch (error) {
      const code =
        error instanceof ManagedFileVersionError
          ? error.code
          : error instanceof ProjectFolderConflictError
            ? 'TARGET_CHANGED'
            : ((error as NodeJS.ErrnoException)?.code ?? 'OUTPUT_WRITE_FAILED')
      let cancelled = ['FILE_DELETED', 'PROJECT_NOT_WRITABLE', 'VERSION_CONFLICT'].includes(code)
      if (!cancelled) {
        try {
          await this.assertCurrent(request)
        } catch {
          cancelled = true
        }
      }
      record = {
        ...record,
        state: cancelled ? 'cancelled' : code === 'TARGET_CHANGED' ? 'conflict' : 'failed',
        canRetry: !cancelled,
        errorCode: code
      }
    } finally {
      await lease?.close()
    }
    // A superseding head may have its own intent. Never replace it with the result of old I/O.
    const current = await client.artifactLineage.findUnique({ where: { id: request.fileId } })
    if (current?.currentVersionId === request.versionId) await this.store(request.fileId, record)
    return this.publicStatus(record)
  }
}
