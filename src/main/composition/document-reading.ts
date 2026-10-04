import { app } from 'electron'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { PENDING_UPLOAD_SESSION_ID } from '../../shared/uploads'
import { isPathInsideWorkspace } from '../acp/workspace-path'
import type { ApplicationEvents } from '../application-events'
import { type ApplicationModuleBuilder } from '../application-runtime'
import { BookmarkRepository } from '../bookmarks/repository'
import { BookmarkService } from '../bookmarks/service'
import { LiteratureAttachmentAuthority } from '../literature/attachment-authority'
import { LiteratureDocumentReader } from '../literature/document-reader'
import { LiteratureFullTextIndex } from '../literature/full-text-index'
import { PdfElementAgentReader } from '../literature/pdf-structure/agent-reader'
import { createPdfStructureEngine } from '../literature/pdf-structure/engine'
import { createPdfStructureOwner } from '../literature/pdf-structure/owner'
import { PdfStructureReader } from '../literature/pdf-structure/reader'
import { PdfStructureSourceAuthority } from '../literature/pdf-structure/source'
import { SessionPdfSourceResolver } from '../literature/session-pdf-source-resolver'
import { registerLocalModelIpcHandlers } from '../local-models/ipc'
import { createLocalModelOwner } from '../local-models/owner'
import { createLogger, errorLogFields } from '../logger'
import { PdfAnnotationRepository } from '../pdf-annotations/repository'
import { PdfAnnotationService } from '../pdf-annotations/service'
import { getProjectDbClient } from '../projects/prisma-client'
import type { SessionPersistenceCommands } from '../session-persistence/coordinator'
import { createDefaultSessionRepository } from '../session-persistence/ipc'
import { SessionPdfContextOwner } from '../session-persistence/pdf-context-owner'
import { resolveConfigRoot, resolveDataRoot } from '../storage-root'
import { createDefaultUploadRepository } from '../uploads/ipc'

export async function composeDocumentReading({
  declareElectronAdapter,
  applicationEvents,
  pdfUploadImporter,
  uploadRepository,
  sessionPackageService,
  sessionRepository,
  literatureAttachmentAuthority,
  sessionPdfSourceResolver,
  bookmarkRepository,
  sessionPersistenceCoordinator,
  modules
}: {
  declareElectronAdapter: (name: string, install: () => void | (() => void)) => void
  applicationEvents: ApplicationEvents
  pdfUploadImporter: { current?: PdfAnnotationService }
  sessionPackageService: Pick<
    import('../session-package/service').SessionPackageService,
    'readPdfNotes'
  >
  uploadRepository: ReturnType<typeof createDefaultUploadRepository>
  sessionRepository: ReturnType<typeof createDefaultSessionRepository>
  literatureAttachmentAuthority: LiteratureAttachmentAuthority
  sessionPdfSourceResolver: SessionPdfSourceResolver
  bookmarkRepository: BookmarkRepository
  sessionPersistenceCoordinator: Pick<
    SessionPersistenceCommands,
    | 'loadSessionForContinuation'
    | 'patchSessionRuntimeContext'
    | 'readSessionRuntimeContext'
    | 'runSessionMutation'
  >
  modules: ApplicationModuleBuilder
}): Promise<{
  bookmarkService: BookmarkService
  pdfAnnotationTagEvents: { notify?: () => Promise<void> }
  pdfAnnotationRepository: PdfAnnotationRepository
  pdfAnnotationService: PdfAnnotationService
  sessionPdfContextOwner: SessionPdfContextOwner
  literatureContextLog: ReturnType<typeof createLogger>
  localModelOwner: ReturnType<typeof createLocalModelOwner>
  pdfStructureReader: PdfStructureReader
  pdfElementReader: PdfElementAgentReader
  literatureDocumentReader: LiteratureDocumentReader
}> {
  const bookmarkService = new BookmarkService({
    repository: bookmarkRepository,
    sessions: sessionRepository,
    pdfVersions: sessionPdfSourceResolver,
    runWithSessionAuthority: (projectId, sessionId, operation) =>
      sessionPersistenceCoordinator.runSessionMutation(projectId, sessionId, operation),
    validateProjectFile: async (source, owningSession) => {
      if (source.kind !== 'project-file' || source.sessionId !== owningSession.id) return false
      try {
        const [canonicalRoot, canonicalSource] = await Promise.all([
          realpath(owningSession.cwd),
          realpath(source.path)
        ])
        return isPathInsideWorkspace(canonicalRoot, canonicalSource)
      } catch {
        return false
      }
    }
  })
  const pdfAnnotationTagEvents: { notify?: () => Promise<void> } = {}
  const pdfAnnotationRepository = new PdfAnnotationRepository(
    () => getProjectDbClient(resolveConfigRoot()),
    async (event, tagsChanged) => {
      if (event) applicationEvents.publish('pdf-annotations:changed', event)
      if (tagsChanged) await pdfAnnotationTagEvents.notify?.()
    }
  )
  const pdfAnnotationService = new PdfAnnotationService({
    packageNotes: (request) => sessionPackageService.readPdfNotes(request),
    literature: literatureAttachmentAuthority,
    repository: pdfAnnotationRepository,
    sessions: sessionRepository,
    runWithSessionAuthority: (projectId, sessionId, operation) =>
      sessionPersistenceCoordinator.runSessionMutation(projectId, sessionId, operation),
    resolveSessionPdfVersion: (request) =>
      sessionPdfSourceResolver.resolveVersion({
        projectId: request.projectId,
        sourceKind: request.sourceKind,
        sourceVersionId: request.versionId,
        expectedSourceFileId: request.sourceFileId
      }),
    onNativeImportProgress: (progress) =>
      applicationEvents.publish('pdf-annotations:import-progress', progress)
  })
  pdfUploadImporter.current = pdfAnnotationService
  await modules.add(undefined, () => ({
    name: 'pdf-native-annotation-imports',
    capability: undefined,
    dispose: async () => {
      pdfUploadImporter.current = undefined
      await pdfAnnotationService.dispose()
    }
  }))
  const sessionPdfContextOwner = new SessionPdfContextOwner({
    sources: sessionPdfSourceResolver,
    pendingUploads: {
      resolveContent: ({ projectId, path }) =>
        uploadRepository.resolveManagedUploadPath(
          { path },
          { projectId, sessionId: PENDING_UPLOAD_SESSION_ID }
        )
    },
    sessions: sessionPersistenceCoordinator
  })
  const literatureContextLog = createLogger('literature-reading-context')
  let stopLiteratureIndexRetention: (() => Promise<void>) | undefined
  await modules.add(undefined, () => ({
    name: 'literature-index-retention',
    capability: undefined,
    start: () => {
      stopLiteratureIndexRetention = LiteratureFullTextIndex.startRetentionSweep(
        resolveDataRoot(),
        (error) => {
          literatureContextLog.error('Literature index maintenance failed', errorLogFields(error))
        }
      )
    },
    dispose: () => stopLiteratureIndexRetention?.()
  }))
  const localModelOwner = createLocalModelOwner()
  await modules.add({ localModelOwner }, ({ localModelOwner: owner }) => ({
    name: 'local-models',
    capability: undefined,
    dispose: async () => {
      await owner.close()
    }
  }))
  declareElectronAdapter('local-models', () => registerLocalModelIpcHandlers(localModelOwner))
  const pdfStructureSources = new PdfStructureSourceAuthority({
    literature: literatureAttachmentAuthority,
    sources: sessionPdfSourceResolver,
    sessions: sessionPersistenceCoordinator
  })
  const pdfStructureOwner = createPdfStructureOwner({
    models: localModelOwner,
    sources: pdfStructureSources,
    engine: createPdfStructureEngine(
      join(
        app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked'),
        'resources',
        'pdf-structure'
      )
    )
  })
  const pdfStructureReader = new PdfStructureReader(pdfStructureOwner)
  await modules.add({ pdfStructureOwner }, ({ pdfStructureOwner: owner }) => ({
    name: 'pdf-structure',
    capability: undefined,
    dispose: () => owner.close()
  }))

  const pdfElementReader = new PdfElementAgentReader({
    owner: pdfStructureOwner,
    sources: pdfStructureSources,
    sessions: sessionPersistenceCoordinator
  })

  const literatureDocumentReader = new LiteratureDocumentReader({
    storageRoot: resolveDataRoot(),
    sources: sessionPdfSourceResolver,
    sessions: sessionPersistenceCoordinator
  })
  return {
    bookmarkService,
    pdfAnnotationTagEvents,
    pdfAnnotationRepository,
    pdfAnnotationService,
    sessionPdfContextOwner,
    literatureContextLog,
    localModelOwner,
    pdfStructureReader,
    pdfElementReader,
    literatureDocumentReader
  }
}
