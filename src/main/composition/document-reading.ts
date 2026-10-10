import { createPdfTranslationLocalRuntime } from '../literature/pdf-translation/local'
import { PDF_TRANSLATION_MODEL_REVISIONS } from '../local-models/catalog'
import { PdfTranslationCheckpoints } from '../literature/pdf-translation/checkpoints'
import { PdfTranslationOwner } from '../literature/pdf-translation/index'
import { capturePdfTranslationApiTarget } from '../literature/pdf-translation/api-target'
import { capturePdfTranslationAgentTarget } from '../literature/pdf-translation/agent-target'
import { ProviderTextGenerationService } from '../settings/provider-text-generation'
import { PdfTranslationUsageRecorder } from '../literature/pdf-translation/usage'
import { RestrictedInferenceRunner } from '../acp/restricted-inference-runner'
import type { SettingsService } from '../settings/service'
import { registerLocalModelIpcHandlers } from '../desktop-surface-declarations'
import { runtimeMetadata } from '../runtime-metadata'
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
import { createLocalModelApi } from '../local-models/owner'

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
  modules,
  settingsService
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
  settingsService: SettingsService
  modules: ApplicationModuleBuilder
}): Promise<{
  bookmarkService: BookmarkService
  pdfAnnotationTagEvents: { notify?: () => Promise<void> }
  pdfAnnotationRepository: PdfAnnotationRepository
  pdfAnnotationService: PdfAnnotationService
  sessionPdfContextOwner: SessionPdfContextOwner
  literatureContextLog: ReturnType<typeof createLogger>
  localModelOwner: ReturnType<typeof createLocalModelOwner>
  pdfTranslationOwner: PdfTranslationOwner
  localModels: ReturnType<typeof createLocalModelApi>
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
  const localTranslationModels = createLocalModelOwner({
    namespace: 'pdf-translation',
    revisions: PDF_TRANSLATION_MODEL_REVISIONS
  })
  await modules.add({ localTranslationModels }, ({ localTranslationModels: owner }) => ({
    name: 'local-translation-models',
    capability: undefined,
    dispose: () => owner.close()
  }))
  const localModels = createLocalModelApi(localModelOwner, localTranslationModels)
  declareElectronAdapter('local-models', () => registerLocalModelIpcHandlers(localModels))
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
        runtimeMetadata().applicationPath.replace(/app\.asar$/, 'app.asar.unpacked'),
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
  const pdfTranslationOwner = await modules.add({}, () => {
    const owner = new PdfTranslationOwner({
      usage: new PdfTranslationUsageRecorder(() => getProjectDbClient(resolveConfigRoot())),
      checkpoints: new PdfTranslationCheckpoints({
        getClient: () => getProjectDbClient(resolveConfigRoot()),
        authority: literatureAttachmentAuthority,
        resolveDocumentSource: (source) => sessionPdfSourceResolver.resolveDocumentSource(source)
      }),
      captureTarget: (model) => capturePdfTranslationAgentTarget(settingsService, model),
      captureApiTarget: (model) => capturePdfTranslationApiTarget(settingsService, model),
      apiRunner: new ProviderTextGenerationService(),
      localRunner: createPdfTranslationLocalRuntime(
        join(
          runtimeMetadata().applicationPath.replace(/app\.asar$/, 'app.asar.unpacked'),
          'resources',
          'pdf-translation-local'
        ),
        localTranslationModels
      ),
      runner: new RestrictedInferenceRunner({
        appVersion: runtimeMetadata().version,
        configRoot: resolveConfigRoot(),
        profileNamespace: 'pdf-translation',
        resolveTarget: (target, context) =>
          settingsService.resolveExplicitAgentBackend(target, context)
      })
    })
    return {
      name: 'pdf-translation',
      capability: owner,
      start: () => owner.sweepStaleProfiles(),
      dispose: () => owner.shutdown()
    }
  })
  return {
    bookmarkService,
    pdfAnnotationTagEvents,
    pdfAnnotationRepository,
    pdfAnnotationService,
    sessionPdfContextOwner,
    literatureContextLog,
    localModelOwner,
    localModels,
    pdfTranslationOwner,
    pdfStructureReader,
    pdfElementReader,
    literatureDocumentReader
  }
}
