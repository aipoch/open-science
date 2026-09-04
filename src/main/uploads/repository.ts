import { createReadStream } from 'node:fs'

import type { PrismaClient } from '@prisma/client'

import {
  DEFAULT_UPLOAD_PROJECT_ID,
  type AppendUploadTransferRequest,
  type BeginUploadTransferRequest,
  type DeleteUploadRequest,
  type StageLocalUploadRequest,
  type UploadTransferProgress,
  type UploadTransferRequest,
  type UploadTransferStatus,
  type UploadedAttachment
} from '../../shared/uploads'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { isDataRootMissing } from '../storage/path-presence'
import { ActiveTransferOwner } from './active-transfer-owner'
import { LegacyRecoveryOwner, type LegacyUploadUpgradeOptions } from './legacy-recovery-owner'
import { ManagedUploadResolver, type ResolvedManagedUpload } from './managed-upload-resolver'
import {
  OrphanLegacyUploadAuthorityMissingError,
  StagedPublicationOwner
} from './staged-publication-owner'
import {
  UnsafeLegacyUploadResidualError,
  VerifiedLegacyCleanupOwner
} from './verified-legacy-cleanup-owner'

type UploadRepositoryOptions = {
  maxFileBytes?: number
  getClient?: () => Promise<PrismaClient>
  getLegacyFileChecksum?: (path: string) => Promise<string>
  renameLegacyForCleanup?: (source: string, destination: string) => Promise<void>
  createLocalReadStream?: (
    sourcePath: string,
    options: { highWaterMark: number; signal: AbortSignal }
  ) => ReturnType<typeof createReadStream>
}

// Public upload seam. Owners are composed once here; all behavior lives behind the existing 15
// async methods so Electron, Web, CLI, Task, local-RPC and MCP callers retain the same interface.
class UploadRepository {
  private readonly transferOwner: ActiveTransferOwner
  private readonly managedUploadResolver: ManagedUploadResolver
  private readonly stagedPublicationOwner: StagedPublicationOwner
  private readonly legacyRecoveryOwner: LegacyRecoveryOwner
  private readonly dataRoot: string

  constructor(dataRoot: string, options: UploadRepositoryOptions = {}) {
    this.dataRoot = dataRoot
    this.transferOwner = new ActiveTransferOwner(dataRoot, options)
    this.managedUploadResolver = new ManagedUploadResolver(dataRoot, options)
    const cleanupOwner = new VerifiedLegacyCleanupOwner(dataRoot, options, {
      resolveManagedUploadPath: (...args) =>
        this.managedUploadResolver.resolveManagedUploadPath(...args)
    })
    this.stagedPublicationOwner = new StagedPublicationOwner(dataRoot, options, {
      resolver: this.managedUploadResolver,
      completeStagingUpload: (...args) => this.legacyRecoveryOwner.completeStagingUpload(...args),
      hasOrphanLegacyCandidate: (...args) =>
        this.legacyRecoveryOwner.hasOrphanLegacyCandidate(...args),
      removeVerifiedLegacyCopy: (input) => this.legacyRecoveryOwner.removeVerifiedLegacyCopy(input)
    })
    this.legacyRecoveryOwner = new LegacyRecoveryOwner(dataRoot, options, {
      resolveManagedUploadPath: (request) =>
        this.managedUploadResolver.resolveManagedUploadPath(request),
      finalizeSessionUploads: (...args) =>
        this.stagedPublicationOwner.finalizeSessionUploads(...args),
      cleanup: cleanupOwner
    })
  }

  async beginTransfer(request: BeginUploadTransferRequest): Promise<UploadTransferStatus> {
    return this.transferOwner.beginTransfer(request)
  }

  async appendTransfer(request: AppendUploadTransferRequest): Promise<UploadTransferStatus> {
    return this.transferOwner.appendTransfer(request)
  }

  async getTransferStatus(request: UploadTransferRequest): Promise<UploadTransferStatus | null> {
    return this.transferOwner.getTransferStatus(request)
  }

  async finishTransfer(request: UploadTransferRequest): Promise<UploadedAttachment> {
    return this.transferOwner.finishTransfer(request)
  }

  async abortTransfer(request: UploadTransferRequest): Promise<void> {
    return this.transferOwner.abortTransfer(request)
  }

  async stageLocalFile(
    request: StageLocalUploadRequest,
    onProgress?: (progress: UploadTransferProgress) => void
  ): Promise<UploadedAttachment> {
    return this.transferOwner.stageLocalFile(request, onProgress)
  }

  async finalizePendingSessionUploads(
    sessionId: string,
    attachments: UploadedAttachment[],
    projectId = DEFAULT_UPLOAD_PROJECT_ID
  ): Promise<UploadedAttachment[]> {
    return this.stagedPublicationOwner.finalizePendingSessionUploads(
      sessionId,
      attachments,
      projectId
    )
  }

  async upgradeLegacySessionUploads(
    session: PersistedChatSession,
    options: LegacyUploadUpgradeOptions = {}
  ): Promise<PersistedChatSession> {
    return this.legacyRecoveryOwner.upgradeLegacySessionUploads(session, options)
  }

  async recoverStagingUploads(): Promise<void> {
    // Recovery must never manufacture an absent data root merely to discover that no recoverable
    // bytes are available. In particular, recursive staging mkdir would hide the configured-root
    // recovery prompt before the renderer can observe it.
    if (await isDataRootMissing(this.dataRoot)) return
    await this.legacyRecoveryOwner.recoverStagingUploads()
    await this.transferOwner.reconcileCrashOrphanedTransfers()
  }

  async deleteUpload(request: DeleteUploadRequest): Promise<void> {
    return this.managedUploadResolver.deleteUpload(request)
  }

  async resolveManagedUploadPath(
    request: DeleteUploadRequest,
    scope: { projectId?: string; sessionId?: string } = {}
  ): Promise<string> {
    return this.managedUploadResolver.resolveManagedUploadPath(request, scope)
  }

  async resolveSessionUploadPath(
    sessionId: string,
    request: DeleteUploadRequest,
    projectId?: string
  ): Promise<string> {
    return this.managedUploadResolver.resolveSessionUploadPath(sessionId, request, projectId)
  }

  async resolveSessionUpload(
    sessionId: string,
    request: DeleteUploadRequest,
    projectId?: string
  ): Promise<ResolvedManagedUpload> {
    return this.managedUploadResolver.resolveSessionUpload(sessionId, request, projectId)
  }

  async resolveManagedUpload(
    request: DeleteUploadRequest,
    scope: { projectId?: string; sessionId?: string } = {}
  ): Promise<ResolvedManagedUpload> {
    return this.managedUploadResolver.resolveManagedUpload(request, scope)
  }
}

export {
  OrphanLegacyUploadAuthorityMissingError,
  UnsafeLegacyUploadResidualError,
  UploadRepository
}
