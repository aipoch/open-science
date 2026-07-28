import { ipcMain, shell } from 'electron'

import type { ArtifactFile, ArtifactPreviewResult } from '../../shared/artifacts'
import type {
  ArtifactLineageProvenance,
  ArtifactVersionExecutionProvenance,
  ArtifactVersionMessagesProvenance,
  ArtifactVersionProvenance,
  ArtifactVersionReviewProvenance,
  GetArtifactLineageRequest,
  GetArtifactVersionProvenanceRequest
} from '../../shared/artifact-provenance'
import { parseArtifactVersionLocator } from '../../shared/artifact-provenance'
import type {
  FinalizeRunArtifactsRequest,
  ListProjectArtifactsRequest,
  OpenArtifactFileRequest,
  ReadArtifactPreviewRequest,
  ReconcilePendingArtifactsRequest
} from '../../shared/artifacts'
import { resolveDataRoot } from '../storage-root'
import { withDataRootWrite } from '../storage/migration-state'
import { readBoundedManagedFilePreview } from '../managed-file-preview'
import { ArtifactRepository } from './repository'
import { ArtifactRunRegistry } from './run-registry'
import type { ArtifactProvenanceRepository } from './provenance-repository'

type ArtifactHandlers = {
  finalizeRunArtifacts: (request: FinalizeRunArtifactsRequest) => Promise<ArtifactFile[]>
  listProjectFiles: (request: ListProjectArtifactsRequest) => Promise<ArtifactFile[]>
  reconcilePendingArtifacts: (request: ReconcilePendingArtifactsRequest) => Promise<ArtifactFile[]>
  openFile: (request: OpenArtifactFileRequest) => Promise<void>
  readPreview: (request: ReadArtifactPreviewRequest) => Promise<ArtifactPreviewResult>
  getLineage: (request: GetArtifactLineageRequest) => Promise<ArtifactLineageProvenance>
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
}

type ArtifactHandlerDependencies = {
  openPath?: (path: string) => Promise<string>
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
    | 'validateFinalizationOwnership'
    | 'getLineage'
    | 'getVersionProvenance'
    | 'getVersionCore'
    | 'getVersionExecution'
    | 'getVersionMessages'
    | 'getVersionReview'
    | 'resolveVersionContent'
  >
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
            finalizeRunArtifacts(repository, runRegistry, request, dependencies.provenance)
          return dependencies.withSessionMutation
            ? dependencies.withSessionMutation(claim.projectName, claim.sessionId, finalize)
            : finalize()
        })
      ),
    listProjectFiles: (request) =>
      repository.listProjectArtifacts(request.projectName, inFlightRunIds()),
    reconcilePendingArtifacts: (request) =>
      withDataRootWrite(() => repository.reconcilePendingArtifactPaths(request)),
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
    }
  }
}

// Turns a runtime claim into message-owned files and permits idempotent replay for the same message.
const finalizeRunArtifacts = async (
  repository: ArtifactRepository,
  runRegistry: ArtifactRunRegistry,
  request: FinalizeRunArtifactsRequest,
  provenance?: Pick<ArtifactProvenanceRepository, 'finalizeRun' | 'validateFinalizationOwnership'>
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
      projectName: claim.projectName,
      sessionId: claim.sessionId,
      messageId: request.messageId
    })
  }

  let provenanceArtifacts: ArtifactFile[] | undefined
  let provenanceRequest: Parameters<ArtifactProvenanceRepository['finalizeRun']>[0] | undefined
  if (
    provenance &&
    claim.rootFrameId &&
    claim.agentFrameId &&
    claim.messageBranchId &&
    claim.runtimeSegmentId &&
    claim.promptMessageId
  ) {
    provenanceRequest = {
      projectId: claim.projectName,
      appSessionId: claim.sessionId,
      artifactRunId: claim.runId,
      rootFrameId: claim.rootFrameId,
      agentFrameId: claim.agentFrameId,
      messageBranchId: claim.messageBranchId,
      runtimeSegmentId: claim.runtimeSegmentId,
      promptMessageId: claim.promptMessageId,
      messageId: request.messageId
    }
    // Preflight the renderer-provided terminal message against the durable conversation graph before
    // touching compatibility storage. The same proof is repeated when SQLite ownership commits.
    await provenance.validateFinalizationOwnership(provenanceRequest)
  }

  // Publish the durable compatibility marker and move first. If SQLite finalization then fails or the
  // process crashes, startup recovery can replay from this marker; the reverse order is unrecoverable.
  const artifacts = await repository.finalizeRunArtifacts({
    projectName: claim.projectName,
    sourceSessionId: claim.artifactSessionId,
    sessionId: claim.sessionId,
    runId: claim.runId,
    messageId: request.messageId,
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

  if (provenance && provenanceRequest) {
    provenanceArtifacts = await provenance.finalizeRun(provenanceRequest)
  }

  runRegistry.markFinalized(request.claimId, request.messageId)

  return provenanceArtifacts ?? artifacts
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
    | 'validateFinalizationOwnership'
    | 'getLineage'
    | 'getVersionProvenance'
    | 'getVersionCore'
    | 'getVersionExecution'
    | 'getVersionMessages'
    | 'getVersionReview'
    | 'resolveVersionContent'
  >,
  withSessionMutation?: ArtifactHandlerDependencies['withSessionMutation']
): void => {
  const handlers = createArtifactHandlers(repository, runRegistry, {
    getActiveArtifactRunIds,
    provenance,
    withSessionMutation
  })

  ipcMain.handle('artifacts:finalize-run', (_event, request: FinalizeRunArtifactsRequest) =>
    handlers.finalizeRunArtifacts(request)
  )
  ipcMain.handle('artifacts:list-project-files', (_event, request: ListProjectArtifactsRequest) =>
    handlers.listProjectFiles(request)
  )
  ipcMain.handle(
    'artifacts:reconcile-pending',
    (_event, request: ReconcilePendingArtifactsRequest) =>
      handlers.reconcilePendingArtifacts(request)
  )
  ipcMain.handle('artifacts:open-file', (_event, request: OpenArtifactFileRequest) =>
    handlers.openFile(request)
  )
  ipcMain.handle('artifacts:read-preview', (_event, request: ReadArtifactPreviewRequest) =>
    handlers.readPreview(request)
  )
  ipcMain.handle('artifacts:get-lineage', (_event, request: GetArtifactLineageRequest) =>
    handlers.getLineage(request)
  )
  ipcMain.handle(
    'artifacts:get-version-provenance',
    (_event, request: GetArtifactVersionProvenanceRequest) => handlers.getVersionProvenance(request)
  )
  ipcMain.handle(
    'artifacts:get-version-execution',
    (_event, request: GetArtifactVersionProvenanceRequest) => handlers.getVersionExecution(request)
  )
  ipcMain.handle(
    'artifacts:get-version-messages',
    (_event, request: GetArtifactVersionProvenanceRequest) => handlers.getVersionMessages(request)
  )
  ipcMain.handle(
    'artifacts:get-version-review',
    (_event, request: GetArtifactVersionProvenanceRequest) => handlers.getVersionReview(request)
  )
}

export { createArtifactHandlers, createDefaultArtifactRepository, registerArtifactIpcHandlers }
export type { ArtifactHandlers }
