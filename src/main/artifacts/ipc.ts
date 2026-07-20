import { ipcMain, shell } from 'electron'

import type { ArtifactFile, ArtifactPreviewResult } from '../../shared/artifacts'
import type {
  FinalizeRunArtifactsRequest,
  ListProjectArtifactsRequest,
  OpenArtifactFileRequest,
  ReadArtifactPreviewRequest,
  ReconcilePendingArtifactsRequest
} from '../../shared/artifacts'
import { resolveDataRoot } from '../storage-root'
import { withDataRootWrite } from '../storage/migration-state'
import { ArtifactRepository } from './repository'
import { ArtifactRunRegistry } from './run-registry'

type ArtifactHandlers = {
  finalizeRunArtifacts: (request: FinalizeRunArtifactsRequest) => Promise<ArtifactFile[]>
  listProjectFiles: (request: ListProjectArtifactsRequest) => Promise<ArtifactFile[]>
  reconcilePendingArtifacts: (request: ReconcilePendingArtifactsRequest) => Promise<ArtifactFile[]>
  openFile: (request: OpenArtifactFileRequest) => Promise<void>
  readPreview: (request: ReadArtifactPreviewRequest) => Promise<ArtifactPreviewResult>
}

type ArtifactHandlerDependencies = {
  openPath?: (path: string) => Promise<string>
  // Run ids of turns in flight right now (live runtime state). Their pending files are still being
  // written, so the orphan scan excludes them; a crashed run is absent here and correctly surfaces.
  getActiveArtifactRunIds?: () => string[]
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

  return {
    finalizeRunArtifacts: (request) =>
      withDataRootWrite(() =>
        withClaimLock(finalizeLocks, request.claimId, () =>
          finalizeRunArtifacts(repository, runRegistry, request)
        )
      ),
    listProjectFiles: (request) =>
      repository.listProjectArtifacts(request.projectName, new Set(getActiveArtifactRunIds())),
    reconcilePendingArtifacts: (request) =>
      withDataRootWrite(() => repository.reconcilePendingArtifactPaths(request)),
    openFile: async (request) => {
      // Resolve through the repository first so shell.openPath never sees unmanaged locations.
      const filePath = await repository.resolveManagedFilePath(request)
      const openError = await openPath(filePath)

      if (openError) {
        throw new Error(openError)
      }
    },
    readPreview: (request) => repository.readManagedFilePreview(request)
  }
}

// Turns a runtime claim into message-owned files and permits idempotent replay for the same message.
const finalizeRunArtifacts = async (
  repository: ArtifactRepository,
  runRegistry: ArtifactRunRegistry,
  request: FinalizeRunArtifactsRequest
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

  const artifacts = await repository.finalizeRunArtifacts({
    projectName: claim.projectName,
    sourceSessionId: claim.artifactSessionId,
    sessionId: claim.sessionId,
    runId: claim.runId,
    messageId: request.messageId
  })

  runRegistry.markFinalized(request.claimId, request.messageId)

  return artifacts
}

// Artifacts are data-class: they follow the configurable data root (defaults to the config root).
const createDefaultArtifactRepository = (): ArtifactRepository =>
  new ArtifactRepository(resolveDataRoot())

// Registers the renderer-visible artifact commands without exposing internal message-file listing.
const registerArtifactIpcHandlers = (
  repository = createDefaultArtifactRepository(),
  runRegistry = new ArtifactRunRegistry(),
  getActiveArtifactRunIds?: () => string[]
): void => {
  const handlers = createArtifactHandlers(repository, runRegistry, { getActiveArtifactRunIds })

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
}

export { createArtifactHandlers, createDefaultArtifactRepository, registerArtifactIpcHandlers }
export type { ArtifactHandlers }
