import { netFetchStandard } from '../network-fetch'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { PENDING_UPLOAD_SESSION_ID } from '../../shared/uploads'
import { RestrictedInferenceRunner } from '../acp/restricted-inference-runner'
import { isPathInsideWorkspace } from '../acp/workspace-path'
import type { ApplicationEvents } from '../application-events'
import { type ApplicationModuleBuilder } from '../application-runtime'
import { QUIT_SHUTDOWN_BUDGET_MS } from '../lifecycle-shutdown'
import { BookmarkRepository } from '../bookmarks/repository'
import { BookmarkService } from '../bookmarks/service'
import { registerLocalModelIpcHandlers } from '../desktop-surface-declarations'
import { LiteratureAttachmentAuthority } from '../literature/attachment-authority'
import { LiteratureDocumentReader } from '../literature/document-reader'
import { literatureIndex } from '../literature/full-text-index'
import { PdfElementAgentReader } from '../literature/pdf-structure/agent-reader'
import { createPdfStructureEngine } from '../literature/pdf-structure/engine'
import { createPdfStructureOwner } from '../literature/pdf-structure/owner'
import { PdfStructureReader } from '../literature/pdf-structure/reader'
import { PdfStructureSourceAuthority } from '../literature/pdf-structure/source'
import { capturePdfTranslationAgentTarget } from '../literature/pdf-translation/agent-target'
import { capturePdfTranslationApiTarget } from '../literature/pdf-translation/api-target'
import { PdfTranslationCheckpoints } from '../literature/pdf-translation/checkpoints'
import { PdfTranslationOwner } from '../literature/pdf-translation/index'
import { createPdfTranslationLocalRuntime } from '../literature/pdf-translation/local'
import { PdfTranslationUsageRecorder } from '../literature/pdf-translation/usage'
import { SessionPdfSourceResolver } from '../literature/session-pdf-source-resolver'
import { PDF_TRANSLATION_MODEL_REVISIONS } from '../local-models/catalog'
import { createLocalModelApi } from '../local-models/owner'
import { runtimeMetadata } from '../runtime-metadata'
import { ProviderTextGenerationService } from '../literature/pdf-translation/text-generation'
import type { SettingsService } from '../settings/service'

import { createLogger, errorLogFields } from '@aipoch/diagnostics/node'
import { createLocalModelOwner } from '../local-models/owner'
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
      stopLiteratureIndexRetention = literatureIndex(resolveDataRoot()).startRetentionSweep(
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
    engine: createPdfStructureEngine()
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
      apiRunner: new ProviderTextGenerationService(netFetchStandard),
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
      // Cancellation drains inference and its owned process before releasing profiles and usage.
      // The generic one-second module cap can expire before that existing shutdown finishes.
      disposeTimeoutMs: QUIT_SHUTDOWN_BUDGET_MS,
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
