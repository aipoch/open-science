import {
  captureProvenanceRead,
  type ProvenanceReadResult
} from '../../shared/provenance-read-result'
import { shell } from 'electron'
import { basename, dirname } from 'node:path'

import { ipcMainHandle } from '../ipc-handler-registry'

import {
  ARTIFACT_FINALIZATION_INVALID_PROOF,
  ARTIFACT_OWNERSHIP_PERSISTENCE_RACE,
  type ArtifactFile,
  type ArtifactPreviewResult,
  type FinalizeRunArtifactsResult,
  type ReconcilePendingArtifactsResult,
  type ResolveArtifactVersionDescriptorsRequest
} from '../../shared/artifacts'
import type {
  ArtifactLineageProvenance,
  ArtifactVersionDescriptor,
  ArtifactVersionExecutionProvenance,
  ArtifactVersionMessagesProvenance,
  ArtifactVersionProvenance,
  ArtifactVersionReviewProvenance,
  GetArtifactLineageRequest,
  GetArtifactVersionProvenanceRequest
} from '../../shared/artifact-provenance'
import type {
  ArtifactCodeReconstructionState,
  GenerateArtifactCodeReconstructionRequest,
  GetArtifactCodeReconstructionRequest
} from '../../shared/artifact-code-reconstruction'
import { parseArtifactVersionLocator } from '../../shared/artifact-provenance'
import { resolveProjectId } from '../../shared/project-scope'
import type {
  FinalizeRunArtifactsRequest,
  OpenArtifactFileRequest,
  ReadArtifactPreviewRequest,
  ReconcilePendingArtifactsRequest
} from '../../shared/artifacts'
import { resolveDataRoot } from '../storage-root'
import { withDataRootWrite } from '../storage/migration-state'
import {
  readBoundedManagedFilePreviewLease,
  type ManagedFilePreviewReadLease
} from '../managed-file-preview'
import { createLogger, type Logger } from '../logger'
import { ArtifactRepository } from './repository'
import { ArtifactRunRegistry } from './run-registry'
import {
  ArtifactFinalizationProofError,
  ArtifactOwnershipPersistenceRaceError,
  type ArtifactProvenanceRepository
} from './provenance-repository'

const log = createLogger('artifacts:finalization')

type ArtifactHandlers = {
  finalizeRunArtifacts: (request: FinalizeRunArtifactsRequest) => Promise<ArtifactFile[]>
  reconcilePendingArtifacts: (request: ReconcilePendingArtifactsRequest) => Promise<ArtifactFile[]>
  openFile: (request: OpenArtifactFileRequest) => Promise<void>
  readPreview: (request: ReadArtifactPreviewRequest) => Promise<ArtifactPreviewResult>
  getLineage: (
    request: GetArtifactLineageRequest
  ) => Promise<ProvenanceReadResult<ArtifactLineageProvenance | undefined>>
  getVersionProvenance: (
    request: GetArtifactVersionProvenanceRequest
  ) => Promise<ProvenanceReadResult<ArtifactVersionProvenance>>
  getVersionExecution: (
    request: GetArtifactVersionProvenanceRequest
  ) => Promise<ProvenanceReadResult<ArtifactVersionExecutionProvenance>>
  getVersionMessages: (
    request: GetArtifactVersionProvenanceRequest
  ) => Promise<ProvenanceReadResult<ArtifactVersionMessagesProvenance>>
  getVersionReview: (
    request: GetArtifactVersionProvenanceRequest
  ) => Promise<ProvenanceReadResult<ArtifactVersionReviewProvenance>>
  getCodeReconstruction: (
    request: GetArtifactCodeReconstructionRequest
  ) => Promise<ArtifactCodeReconstructionState>
  generateCodeReconstruction: (
    request: GenerateArtifactCodeReconstructionRequest
  ) => Promise<ArtifactCodeReconstructionState>
  resolveVersionDescriptors: (
    request: ResolveArtifactVersionDescriptorsRequest
  ) => Promise<ArtifactVersionDescriptor[]>
}

type ArtifactHandlerDependencies = {
  openPath?: (path: string) => Promise<string>
  logger?: Pick<Logger, 'error'>
  openLatestManagedFile?: (
    request: Omit<ReadArtifactPreviewRequest, 'versionId'> & { versionId?: never }
  ) => Promise<ManagedFilePreviewReadLease & { path?: string }>
  openManagedFileVersion?: (
    request: ReadArtifactPreviewRequest & { versionId: string }
  ) => Promise<ManagedFilePreviewReadLease>
  withSessionMutation?: <Result>(
    projectId: string,
    sessionId: string,
    mutation: () => Promise<Result>
  ) => Promise<Result>
  recoverPendingArtifacts?: (
    request: ReconcilePendingArtifactsRequest
  ) => Promise<{ artifacts: ArtifactFile[]; nativeRunIds: string[] } | undefined>
  provenance?: Pick<
    ArtifactProvenanceRepository,
    | 'finalizeRun'
    | 'activateFinalizedRun'
    | 'listRunVersions'
    | 'getLineage'
    | 'getVersionProvenance'
    | 'getVersionCore'
    | 'getVersionExecution'
    | 'getVersionMessages'
    | 'getVersionReview'
    | 'resolveVersionDescriptors'
  >
  codeReconstruction?: {
    get(request: GetArtifactCodeReconstructionRequest): Promise<ArtifactCodeReconstructionState>
    generate(
      request: GenerateArtifactCodeReconstructionRequest
    ): Promise<ArtifactCodeReconstructionState>
  }
}

// Serializes finalization per claim so duplicate renderer event processing cannot move files twice.
const withClaimLock = async <Result>(
  locks: Map<string, Promise<void>>,
  claimId: string,
  action: () => Promise<Result>
): Promise<Result> => {
  const previous = locks.get(claimId) ?? Promise.resolve()
  let release!: () => void
  const current = previous.then(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
  )

  locks.set(claimId, current)
  await previous

  try {
    return await action()
  } finally {
    release()

    if (locks.get(claimId) === current) {
      locks.delete(claimId)
    }
  }
}

// Creates artifact handlers with injectable dependencies for tests and Electron shell integration.
const createArtifactHandlers = (
  repository: ArtifactRepository,
  runRegistry: ArtifactRunRegistry,
  dependencies: ArtifactHandlerDependencies = {}
): ArtifactHandlers => {
  const finalizeLocks = new Map<string, Promise<void>>()
  const openPath =
    dependencies.openPath ?? ((filePath: string): Promise<string> => shell.openPath(filePath))
  return {
    finalizeRunArtifacts: (request) =>
      withDataRootWrite(() =>
        withClaimLock(finalizeLocks, request.claimId, () => {
          const claim = runRegistry.resolve(request.claimId)
          const finalize = (): Promise<ArtifactFile[]> =>
            finalizeRunArtifacts(
              repository,
              runRegistry,
              request,
              dependencies.provenance,
              dependencies.logger ?? log
            )
          return dependencies.withSessionMutation
            ? dependencies.withSessionMutation(claim.projectId, claim.sessionId, finalize)
            : finalize()
        })
      ),
    reconcilePendingArtifacts: (request) =>
      withDataRootWrite(async () => {
        const reconcileCompatibility = (pendingPaths: string[]): Promise<ArtifactFile[]> =>
          repository.reconcilePendingArtifactPaths({
            projectId: resolveProjectId(request),
            sessionId: request.sessionId,
            messageId: request.messageId,
            pendingPaths
          })
        if (dependencies.recoverPendingArtifacts) {
          const recovered = await dependencies.recoverPendingArtifacts(request)
          if (recovered) {
            const nativeRunIds = new Set(recovered.nativeRunIds)
            const compatibilityPaths = request.pendingPaths.filter(
              (pendingPath) => !nativeRunIds.has(basename(dirname(pendingPath)))
            )
            if (compatibilityPaths.length === 0) return recovered.artifacts

            const compatibilityArtifacts = await reconcileCompatibility(compatibilityPaths)
            const nativePaths = new Set(recovered.artifacts.map((artifact) => artifact.path))
            return [
              ...recovered.artifacts,
              ...compatibilityArtifacts.filter((artifact) => !nativePaths.has(artifact.path))
            ]
          }
        }
        return reconcileCompatibility(request.pendingPaths)
      }),
    openFile: async (request) => {
      // Resolve through the repository first so shell.openPath never sees unmanaged locations.
      const versionIdentity = parseArtifactVersionLocator(request.path)
      if (!versionIdentity) {
        const openError = await openPath(await repository.resolveManagedFilePath(request))
        if (openError) throw new Error(openError)
        return
      }
      if (!dependencies.openLatestManagedFile) {
        throw new Error('Managed Artifact Version reader is not configured.')
      }
      const lease = await dependencies.openLatestManagedFile({
        ...request,
        projectId: versionIdentity.projectId,
        sessionId: versionIdentity.appSessionId,
        fileId: versionIdentity.artifactId,
        versionId: undefined
      })
      try {
        if (!lease.path) throw new Error('Managed Artifact Version reader returned no path.')
        const openError = await openPath(lease.path)
        if (openError) throw new Error(openError)
      } catch (error) {
        await lease.close().catch(() => undefined)
        throw error
      }
      await lease.close()
    },
    readPreview: async (request) => {
      const versionIdentity = parseArtifactVersionLocator(request.path)
      const logicalRequest =
        request.projectId && request.fileId
          ? request
          : versionIdentity
            ? {
                ...request,
                projectId: versionIdentity.projectId,
                sessionId: versionIdentity.appSessionId,
                fileId: versionIdentity.artifactId,
                versionId: undefined
              }
            : undefined
      const lease = logicalRequest
        ? logicalRequest.versionId
          ? dependencies.openManagedFileVersion
            ? await dependencies.openManagedFileVersion({
                ...logicalRequest,
                versionId: logicalRequest.versionId
              })
            : undefined
          : dependencies.openLatestManagedFile
            ? await dependencies.openLatestManagedFile({ ...logicalRequest, versionId: undefined })
            : undefined
        : undefined
      if (lease) {
        try {
          return await readBoundedManagedFilePreviewLease(
            lease,
            request,
            'Invalid artifact preview encoding.'
          )
        } finally {
          await lease.close()
        }
      }
      if (logicalRequest) {
        throw new Error('Managed Artifact Version reader is not configured.')
      }
      throw new Error('Managed Artifact preview requires a logical identity.')
    },
    getLineage: (request) =>
      captureProvenanceRead(async () => {
        if (!dependencies.provenance) throw new Error('Artifact Provenance is not configured.')
        return dependencies.provenance.getLineage(request)
      }),
    getVersionProvenance: (request) =>
      captureProvenanceRead(async () => {
        if (!dependencies.provenance) throw new Error('Artifact Provenance is not configured.')
        return dependencies.provenance.getVersionCore(request)
      }),
    getVersionExecution: (request) =>
      captureProvenanceRead(async () => {
        if (!dependencies.provenance) throw new Error('Artifact Provenance is not configured.')
        return dependencies.provenance.getVersionExecution(request)
      }),
    getVersionMessages: (request) =>
      captureProvenanceRead(async () => {
        if (!dependencies.provenance) throw new Error('Artifact Provenance is not configured.')
        return dependencies.provenance.getVersionMessages(request)
      }),
    getVersionReview: (request) =>
      captureProvenanceRead(async () => {
        if (!dependencies.provenance) throw new Error('Artifact Provenance is not configured.')
        return dependencies.provenance.getVersionReview(request)
      }),
    getCodeReconstruction: (request) => {
      if (!dependencies.codeReconstruction) {
        throw new Error('Artifact code reconstruction is not configured.')
      }
      return dependencies.codeReconstruction.get(request)
    },
    generateCodeReconstruction: (request) => {
      const codeReconstruction = dependencies.codeReconstruction
      if (!codeReconstruction) {
        throw new Error('Artifact code reconstruction is not configured.')
      }
      // Hold one migration lease across evidence reads, model work, and the cache commit so a data
      // root move cannot switch beneath an in-flight reconstruction.
      return withDataRootWrite(() => codeReconstruction.generate(request))
    },
    resolveVersionDescriptors: (request) => {
      if (!dependencies.provenance) throw new Error('Artifact Provenance is not configured.')
      return dependencies.provenance.resolveVersionDescriptors(request)
    }
  }
}

// Turns a runtime claim into message-owned files and permits idempotent replay for the same message.
const finalizeRunArtifacts = async (
  repository: ArtifactRepository,
  runRegistry: ArtifactRunRegistry,
  request: FinalizeRunArtifactsRequest,
  provenance?: Pick<
    ArtifactProvenanceRepository,
    'finalizeRun' | 'activateFinalizedRun' | 'listRunVersions'
  >,
  logger: Pick<Logger, 'error'> = log
): Promise<ArtifactFile[]> => {
  const claim = runRegistry.resolve(request.claimId)

  if (claim.finalizedMessageId) {
    // A retry for the same message should return the final list; a different message is a bug.
    if (claim.finalizedMessageId !== request.messageId) {
      throw new Error(
        `Artifact run claim already finalized for message: ${claim.finalizedMessageId}`
      )
    }

    return provenance
      ? provenance.listRunVersions({
          projectId: claim.projectId,
          appSessionId: claim.sessionId,
          artifactRunId: claim.runId
        })
      : repository.listMessageFiles({
          projectId: claim.projectId,
          sessionId: claim.sessionId,
          messageId: request.messageId
        })
  }

  let durableFinalizationCompleted = false
  let compatibilityPublicationCompleted = false
  let stage: 'durable-finalization' | 'compatibility-publication' = 'durable-finalization'

  try {
    let provenanceArtifacts: ArtifactFile[] | undefined
    let provenanceRequest: Parameters<ArtifactProvenanceRepository['finalizeRun']>[0] | undefined
    if (provenance) {
      if (
        !claim.rootFrameId ||
        !claim.agentFrameId ||
        !claim.messageBranchId ||
        !claim.runtimeSegmentId ||
        !claim.promptMessageId
      ) {
        throw new ArtifactFinalizationProofError(
          'claim-context-missing',
          'Artifact run claim is missing complete provenance context.'
        )
      }
      if (!claim.artifactVersionIds || claim.artifactVersionIds.length === 0) {
        throw new ArtifactFinalizationProofError(
          'claim-version-ids-missing',
          'Artifact run claim is missing exact Artifact Version ids.'
        )
      }
      provenanceRequest = {
        projectId: claim.projectId,
        appSessionId: claim.sessionId,
        artifactRunId: claim.runId,
        artifactVersionIds: [...claim.artifactVersionIds],
        rootFrameId: claim.rootFrameId,
        agentFrameId: claim.agentFrameId,
        messageBranchId: claim.messageBranchId,
        runtimeSegmentId: claim.runtimeSegmentId,
        promptMessageId: claim.promptMessageId,
        messageId: request.messageId
      }
      // Commit the complete provenance proof and immutable message ownership before compatibility bytes
      // move. A later compatibility failure is retryable because the prepared marker remains durable.
      provenanceArtifacts = await provenance.finalizeRun(provenanceRequest)
      durableFinalizationCompleted = true
    }

    stage = 'compatibility-publication'
    // Publish compatibility bytes only after the complete provenance transaction succeeds. The move is
    // idempotent, so a finalized-but-unlinked run can replay here or during prepared-marker recovery.
    const artifacts = await repository.finalizeRunArtifacts({
      projectId: claim.projectId,
      sourceSessionId: claim.artifactSessionId,
      sessionId: claim.sessionId,
      runId: claim.runId,
      messageId: request.messageId,
      ...(claim.artifactVersionIds ? { artifactVersionIds: claim.artifactVersionIds } : {}),
      ...(claim.rootFrameId &&
      claim.agentFrameId &&
      claim.messageBranchId &&
      claim.runtimeSegmentId &&
      claim.promptMessageId
        ? {
            provenanceContext: {
              rootFrameId: claim.rootFrameId,
              agentFrameId: claim.agentFrameId,
              messageBranchId: claim.messageBranchId,
              runtimeSegmentId: claim.runtimeSegmentId,
              promptMessageId: claim.promptMessageId
            }
          }
        : {})
    })
    compatibilityPublicationCompleted = true

    if (provenance && provenanceRequest) {
      provenanceArtifacts = await provenance.activateFinalizedRun(provenanceRequest)
    }

    runRegistry.markFinalized(request.claimId, request.messageId)

    return provenanceArtifacts ?? artifacts
  } catch (error) {
    const failureKind =
      error instanceof ArtifactOwnershipPersistenceRaceError
        ? ARTIFACT_OWNERSHIP_PERSISTENCE_RACE
        : error instanceof ArtifactFinalizationProofError
          ? 'invalid-proof'
          : 'operational-failure'
    logger.error('artifact finalization attempt failed', {
      stage,
      failureKind,
      ...(error instanceof ArtifactFinalizationProofError
        ? { proofFailureReason: error.reasonCode }
        : {}),
      durableFinalizationCompleted,
      compatibilityPublicationCompleted,
      claimId: request.claimId,
      artifactRunId: claim.runId,
      messageId: request.messageId,
      artifactVersionCount: claim.artifactVersionIds?.length ?? 0,
      ...(claim.artifactVersionIds ? { artifactVersionIds: [...claim.artifactVersionIds] } : {}),
      ...(claim.rootFrameId ? { rootFrameId: claim.rootFrameId } : {}),
      ...(claim.agentFrameId ? { agentFrameId: claim.agentFrameId } : {}),
      ...(claim.messageBranchId ? { messageBranchId: claim.messageBranchId } : {}),
      ...(claim.runtimeSegmentId ? { runtimeSegmentId: claim.runtimeSegmentId } : {}),
      ...(claim.promptMessageId ? { promptMessageId: claim.promptMessageId } : {})
    })
    throw error
  }
}

// Artifacts are data-class: they follow the configurable data root (defaults to the config root).
const createDefaultArtifactRepository = (): ArtifactRepository =>
  new ArtifactRepository(resolveDataRoot())

// Registers the renderer-visible artifact commands without exposing internal message-file listing.
const registerArtifactIpcHandlers = (
  repository = createDefaultArtifactRepository(),
  runRegistry = new ArtifactRunRegistry(),
  provenance?: Pick<
    ArtifactProvenanceRepository,
    | 'finalizeRun'
    | 'activateFinalizedRun'
    | 'listRunVersions'
    | 'getLineage'
    | 'getVersionProvenance'
    | 'getVersionCore'
    | 'getVersionExecution'
    | 'getVersionMessages'
    | 'getVersionReview'
    | 'resolveVersionDescriptors'
  >,
  withSessionMutation?: ArtifactHandlerDependencies['withSessionMutation'],
  handlers: ArtifactHandlers = createArtifactHandlers(repository, runRegistry, {
    provenance,
    withSessionMutation
  })
): void => {
  ipcMainHandle(
    'artifacts:finalize-run',
    async (_event, request: FinalizeRunArtifactsRequest): Promise<FinalizeRunArtifactsResult> => {
      try {
        return { ok: true, artifacts: await handlers.finalizeRunArtifacts(request) }
      } catch (error) {
        if (
          !(error instanceof ArtifactOwnershipPersistenceRaceError) &&
          !(error instanceof ArtifactFinalizationProofError)
        ) {
          throw error
        }
        return {
          ok: false,
          code:
            error instanceof ArtifactOwnershipPersistenceRaceError
              ? ARTIFACT_OWNERSHIP_PERSISTENCE_RACE
              : ARTIFACT_FINALIZATION_INVALID_PROOF,
          message: error.message
        }
      }
    }
  )
  ipcMainHandle(
    'artifacts:reconcile-pending',
    async (
      _event,
      request: ReconcilePendingArtifactsRequest
    ): Promise<ReconcilePendingArtifactsResult> => {
      try {
        return await handlers.reconcilePendingArtifacts(request)
      } catch (error) {
        if (
          typeof error !== 'object' ||
          error === null ||
          !('code' in error) ||
          error.code !== ARTIFACT_FINALIZATION_INVALID_PROOF
        ) {
          throw error
        }
        return {
          ok: false,
          code: ARTIFACT_FINALIZATION_INVALID_PROOF,
          message:
            error instanceof Error ? error.message : 'Artifact finalization proof is invalid.'
        }
      }
    }
  )
  ipcMainHandle('artifacts:open-file', (_event, request: OpenArtifactFileRequest) =>
    handlers.openFile(request)
  )
  ipcMainHandle('artifacts:read-preview', (_event, request: ReadArtifactPreviewRequest) =>
    handlers.readPreview(request)
  )
  ipcMainHandle('artifacts:get-lineage', (_event, request: GetArtifactLineageRequest) =>
    handlers.getLineage(request)
  )
  ipcMainHandle(
    'artifacts:get-version-provenance',
    (_event, request: GetArtifactVersionProvenanceRequest) => handlers.getVersionProvenance(request)
  )
  ipcMainHandle(
    'artifacts:get-version-execution',
    (_event, request: GetArtifactVersionProvenanceRequest) => handlers.getVersionExecution(request)
  )
  ipcMainHandle(
    'artifacts:get-version-messages',
    (_event, request: GetArtifactVersionProvenanceRequest) => handlers.getVersionMessages(request)
  )
  ipcMainHandle(
    'artifacts:get-version-review',
    (_event, request: GetArtifactVersionProvenanceRequest) => handlers.getVersionReview(request)
  )
  ipcMainHandle(
    'artifacts:get-code-reconstruction',
    (_event, request: GetArtifactCodeReconstructionRequest) =>
      handlers.getCodeReconstruction(request)
  )
  ipcMainHandle(
    'artifacts:generate-code-reconstruction',
    (_event, request: GenerateArtifactCodeReconstructionRequest) =>
      handlers.generateCodeReconstruction(request)
  )
  ipcMainHandle(
    'artifacts:resolve-version-descriptors',
    (_event, request: ResolveArtifactVersionDescriptorsRequest) =>
      handlers.resolveVersionDescriptors(request)
  )
}

export { createArtifactHandlers, createDefaultArtifactRepository, registerArtifactIpcHandlers }
export type { ArtifactHandlers }
