import { shell } from 'electron'

import { ipcMainHandle } from '../ipc-handler-registry'

import {
  ARTIFACT_OWNERSHIP_PERSISTENCE_RACE,
  type ArtifactFile,
  type ArtifactPreviewResult,
  type FinalizeRunArtifactsResult,
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
  ListProjectArtifactsRequest,
  OpenArtifactFileRequest,
  ReadArtifactPreviewRequest,
  ReconcilePendingArtifactsRequest
} from '../../shared/artifacts'
import { resolveDataRoot } from '../storage-root'
import { withDataRootWrite } from '../storage/migration-state'
import {
  readBoundedManagedFilePreview,
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
  listProjectFiles: (request: ListProjectArtifactsRequest) => Promise<ArtifactFile[]>
  reconcilePendingArtifacts: (request: ReconcilePendingArtifactsRequest) => Promise<ArtifactFile[]>
  openFile: (request: OpenArtifactFileRequest) => Promise<void>
  readPreview: (request: ReadArtifactPreviewRequest) => Promise<ArtifactPreviewResult>
  getLineage: (request: GetArtifactLineageRequest) => Promise<ArtifactLineageProvenance | undefined>
  getVersionProvenance: (
    request: GetArtifactVersionProvenanceRequest
  ) => Promise<ArtifactVersionProvenance>
  getVersionExecution: (
    request: GetArtifactVersionProvenanceRequest
  ) => Promise<ArtifactVersionExecutionProvenance>
  getVersionMessages: (
    request: GetArtifactVersionProvenanceRequest
  ) => Promise<ArtifactVersionMessagesProvenance>
  getVersionReview: (
    request: GetArtifactVersionProvenanceRequest
  ) => Promise<ArtifactVersionReviewProvenance>
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
  resolveManagedFilePath?: (request: ReadArtifactPreviewRequest) => Promise<string>
  openManagedFileVersion?: (
    request: ReadArtifactPreviewRequest
  ) => Promise<ManagedFilePreviewReadLease>
  // Run ids of turns in flight right now (live runtime state). Their pending files are still being
  // written, so the orphan scan excludes them; a crashed run is absent here and correctly surfaces.
  getActiveArtifactRunIds?: () => string[]
  withSessionMutation?: <Result>(
    projectId: string,
    sessionId: string,
    mutation: () => Promise<Result>
  ) => Promise<Result>
  provenance?: Pick<
    ArtifactProvenanceRepository,
    | 'finalizeRun'
    | 'activateFinalizedRun'
    | 'getLineage'
    | 'getVersionProvenance'
    | 'getVersionCore'
    | 'getVersionExecution'
    | 'getVersionMessages'
    | 'getVersionReview'
    | 'resolveVersionDescriptors'
    | 'resolveVersionContent'
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
  const getActiveArtifactRunIds = dependencies.getActiveArtifactRunIds ?? ((): string[] => [])

  // A pending run must be treated as in-flight (not orphaned) for its whole lifecycle: while the prompt
  // runs (getActiveArtifactRunIds), AND after stop while its claim awaits the renderer's finalize call
  // (runRegistry unfinalized claims) — the run leaves the runtime's active set at stop, before finalize.
  const inFlightRunIds = (): Set<string> =>
    new Set([...getActiveArtifactRunIds(), ...runRegistry.getUnfinalizedRunIds()])

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
    listProjectFiles: (request) =>
      repository.listProjectArtifacts(resolveProjectId(request), inFlightRunIds()),
    reconcilePendingArtifacts: (request) =>
      withDataRootWrite(() =>
        repository.reconcilePendingArtifactPaths({
          projectId: resolveProjectId(request),
          sessionId: request.sessionId,
          messageId: request.messageId,
          pendingPaths: request.pendingPaths
        })
      ),
    openFile: async (request) => {
      // Resolve through the repository first so shell.openPath never sees unmanaged locations.
      const versionIdentity = parseArtifactVersionLocator(request.path)
      const filePath = versionIdentity
        ? await dependencies.provenance
            ?.resolveVersionContent(versionIdentity)
            .then((resolved) => resolved.path)
        : await repository.resolveManagedFilePath(request)
      if (!filePath) throw new Error('Artifact Provenance is not configured.')
      const openError = await openPath(filePath)

      if (openError) {
        throw new Error(openError)
      }
    },
    readPreview: async (request) => {
      if (request.projectId && request.fileId && dependencies.openManagedFileVersion) {
        const lease = await dependencies.openManagedFileVersion(request)
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
      if (request.projectId && request.fileId && dependencies.resolveManagedFilePath) {
        const path = await dependencies.resolveManagedFilePath(request)
        return readBoundedManagedFilePreview(path, request, 'Invalid artifact preview encoding.')
      }
      const versionIdentity = parseArtifactVersionLocator(request.path)
      if (!versionIdentity) return repository.readManagedFilePreview(request)
      if (!dependencies.provenance) throw new Error('Artifact Provenance is not configured.')
      const { path } = await dependencies.provenance.resolveVersionContent(versionIdentity)
      return readBoundedManagedFilePreview(path, request, 'Invalid artifact preview encoding.')
    },
    getLineage: (request) => {
      if (!dependencies.provenance) throw new Error('Artifact Provenance is not configured.')
      return dependencies.provenance.getLineage(request)
    },
    getVersionProvenance: (request) => {
      if (!dependencies.provenance) throw new Error('Artifact Provenance is not configured.')
      return dependencies.provenance.getVersionCore(request)
    },
    getVersionExecution: (request) => {
      if (!dependencies.provenance) throw new Error('Artifact Provenance is not configured.')
      return dependencies.provenance.getVersionExecution(request)
    },
    getVersionMessages: (request) => {
      if (!dependencies.provenance) throw new Error('Artifact Provenance is not configured.')
      return dependencies.provenance.getVersionMessages(request)
    },
    getVersionReview: (request) => {
      if (!dependencies.provenance) throw new Error('Artifact Provenance is not configured.')
      return dependencies.provenance.getVersionReview(request)
    },
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
  provenance?: Pick<ArtifactProvenanceRepository, 'finalizeRun' | 'activateFinalizedRun'>,
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

    return repository.listMessageFiles({
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
  getActiveArtifactRunIds?: () => string[],
  provenance?: Pick<
    ArtifactProvenanceRepository,
    | 'finalizeRun'
    | 'activateFinalizedRun'
    | 'getLineage'
    | 'getVersionProvenance'
    | 'getVersionCore'
    | 'getVersionExecution'
    | 'getVersionMessages'
    | 'getVersionReview'
    | 'resolveVersionDescriptors'
    | 'resolveVersionContent'
  >,
  withSessionMutation?: ArtifactHandlerDependencies['withSessionMutation'],
  handlers: ArtifactHandlers = createArtifactHandlers(repository, runRegistry, {
    getActiveArtifactRunIds,
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
        if (!(error instanceof ArtifactOwnershipPersistenceRaceError)) throw error
        return {
          ok: false,
          code: ARTIFACT_OWNERSHIP_PERSISTENCE_RACE,
          message: error.message
        }
      }
    }
  )
  ipcMainHandle('artifacts:list-project-files', (_event, request: ListProjectArtifactsRequest) =>
    handlers.listProjectFiles(request)
  )
  ipcMainHandle(
    'artifacts:reconcile-pending',
    (_event, request: ReconcilePendingArtifactsRequest) =>
      handlers.reconcilePendingArtifacts(request)
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
