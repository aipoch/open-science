import { JournalAttributes } from '../literature/journal-attributes'
import { QUIT_SHUTDOWN_BUDGET_MS } from '../lifecycle-shutdown'
import { session } from 'electron'
import { join } from 'node:path'
import type { ApplicationEvents } from '../application-events'
import { type ApplicationModuleBuilder } from '../application-runtime'
import { AgentPdfAcquisition } from '../literature/agent-pdf-acquisition'
import { LiteratureBatchJobs } from '../literature/batch-jobs'
import { LiteratureCatalog } from '../literature/catalog'
import { LiteratureCitationDocument } from '../literature/citation-document'
import { LiteratureCitationFormatter } from '../literature/citation-formatter'
import { LiteratureCitationStyleLibrary } from '../literature/citation-style-library'
import { LiteratureDocumentReader } from '../literature/document-reader'
import { downloadFullText } from '../literature/full-text-download'
import { LiteratureFullTextFinder } from '../literature/full-text-finder'
import { LiteratureMetadataEnricher } from '../literature/metadata-enricher'
import { LiteraturePdfImporter } from '../literature/pdf-importer'
import { LiteratureReferenceResolver } from '../literature/reference-resolver'
import { LiteratureSmartCollections } from '../literature/smart-collections'
import { createLogger, errorLogFields } from '../logger'
import { MemoryRepository } from '../memory/repository'
import { MemoryService } from '../memory/service'
import { PdfAnnotationRepository } from '../pdf-annotations/repository'
import { PdfAnnotationService } from '../pdf-annotations/service'
import { getProjectDbClient } from '../projects/prisma-client'
import type { SessionPersistenceCommands } from '../session-persistence/coordinator'
import { tryDecryptKey } from '../settings/crypto'
import { SettingsService } from '../settings/service'
import { parseSystemProxyRules } from '../settings/system-proxy'
import { netFetchStandard } from '../skills/net-fetch'
import { SpecialistService } from '../specialist/service'
import { resolveConfigRoot, resolveDataRoot } from '../storage-root'
import { ContentRepository } from '../storage/content-repository'
import { TagRepository } from '../tags/repository'
import { TagResourceCatalog } from '../tags/resource-catalog'
import { TagService } from '../tags/service'
import { createDefaultUploadRepository } from '../uploads/ipc'

export async function composeResearchCatalog({
  applicationEvents,
  settingsService,
  uploadRepository,
  contentRepository,
  configRoot,
  sessionPersistenceCoordinator,
  pdfAnnotationTagEvents,
  pdfAnnotationRepository,
  pdfAnnotationService,
  literatureContextLog,
  literatureDocumentReader,
  specialistService,
  modules
}: {
  applicationEvents: ApplicationEvents
  settingsService: SettingsService
  uploadRepository: ReturnType<typeof createDefaultUploadRepository>
  contentRepository: ContentRepository
  configRoot: ReturnType<typeof resolveConfigRoot>
  sessionPersistenceCoordinator: Pick<SessionPersistenceCommands, 'withLiteratureAttachmentRemoval'>
  pdfAnnotationTagEvents: { notify?: () => Promise<void> }
  pdfAnnotationRepository: PdfAnnotationRepository
  pdfAnnotationService: PdfAnnotationService
  literatureContextLog: ReturnType<typeof createLogger>
  literatureDocumentReader: LiteratureDocumentReader
  specialistService: SpecialistService
  modules: ApplicationModuleBuilder
}): Promise<{
  tagService: TagService
  memoryService: MemoryService
  literatureCatalog: LiteratureCatalog
  journalAttributes: JournalAttributes
  literatureCitationStyles: LiteratureCitationStyleLibrary
  literatureCitationFormatter: LiteratureCitationFormatter
  literatureCitationDocument: LiteratureCitationDocument
  literatureReferenceResolver: LiteratureReferenceResolver
  literatureMetadataEnricher: LiteratureMetadataEnricher
  literatureFullTextFinder: LiteratureFullTextFinder
  literaturePdfImporter: LiteraturePdfImporter
  literaturePdfAcquisition: AgentPdfAcquisition
  literatureBatchJobs: LiteratureBatchJobs
  removeResourceTagsOrThrow: (
    resources: Parameters<TagService['removeResources']>[0]
  ) => Promise<void>
  removeResourceTags: (resources: Parameters<TagService['removeResources']>[0]) => Promise<void>
}> {
  const tagService = new TagService(
    new TagRepository(() => getProjectDbClient(configRoot)),
    new TagResourceCatalog({
      listSkills: () => settingsService.listSkills(),
      listConnectors: () => settingsService.listConnectors(),
      listSpecialists: async () =>
        (await specialistService.listForSettings()).filter(({ kind }) => kind !== 'reviewer'),
      listPdfAnnotations: async () =>
        (await getProjectDbClient(configRoot)).pdfAnnotation.findMany({ select: { id: true } }),
      listLiteratureItems: async () => {
        const database = await getProjectDbClient(configRoot)
        return database.literatureItem.findMany({
          select: { id: true }
        })
      }
    }),
    applicationEvents,
    (request) => pdfAnnotationService.setTagAssignment(request)
  )
  pdfAnnotationTagEvents.notify = () => tagService.notifyAssignmentsChanged()
  const memoryService = new MemoryService(
    new MemoryRepository(() => getProjectDbClient(configRoot)),
    applicationEvents
  )
  let smartCollectionRevision = 0
  const smartCollections = new LiteratureSmartCollections(
    () => getProjectDbClient(configRoot),
    settingsService.classification,
    (id) =>
      applicationEvents.publish('literature:changed', {
        revision: ++smartCollectionRevision,
        collectionIds: [id]
      }),
    (request) => literatureDocumentReader.classificationEvidence(request)
  )
  await modules.add({ smartCollections }, ({ smartCollections: owner }) => ({
    name: 'literature-smart-collections',
    capability: owner,
    start: () => owner.start(),
    dispose: () => owner.dispose()
  }))
  const journalAttributes = new JournalAttributes(
    () => getProjectDbClient(configRoot),
    () => applicationEvents.publish('literature:changed', { revision: ++smartCollectionRevision })
  )
  await modules.add({ journalAttributes }, ({ journalAttributes: owner }) => ({
    name: 'literature-journal-attributes',
    capability: owner,
    dispose: () => owner.dispose(),
    disposeTimeoutMs: QUIT_SHUTDOWN_BUDGET_MS
  }))
  const literatureCatalog = new LiteratureCatalog(
    () => getProjectDbClient(configRoot),
    () => tagService.notifyAssignmentsChanged(),
    contentRepository,
    (remove) => sessionPersistenceCoordinator.withLiteratureAttachmentRemoval(remove),
    (event) => {
      journalAttributes.referencesChanged()
      applicationEvents.publish('literature:changed', {
        ...event,
        revision: ++smartCollectionRevision
      })
    },
    smartCollections,
    journalAttributes
  )
  const literatureCitationStyles = new LiteratureCitationStyleLibrary(
    join(resolveDataRoot(), 'literature', 'citation-styles')
  )
  const literatureCitationFormatter = new LiteratureCitationFormatter(literatureCitationStyles)
  const literatureCitationDocument = new LiteratureCitationDocument(
    literatureCatalog,
    literatureCitationFormatter
  )
  const literatureReferenceResolver = new LiteratureReferenceResolver(netFetchStandard)
  const literatureMetadataEnricher = new LiteratureMetadataEnricher(
    literatureCatalog,
    netFetchStandard
  )
  const downloadLiteraturePdf: typeof downloadFullText = (
    url,
    maxBytes,
    onProgress,
    _resolveProxy,
    signal
  ) =>
    downloadFullText(
      url,
      maxBytes,
      onProgress,
      async (target) => {
        const environment = parseSystemProxyRules(await session.defaultSession.resolveProxy(target))
        return environment.HTTPS_PROXY ?? environment.ALL_PROXY
      },
      signal
    )
  const literatureFullTextFinder = new LiteratureFullTextFinder({
    catalog: literatureCatalog,
    content: contentRepository,
    download: downloadLiteraturePdf,
    openAlexKey: async () =>
      tryDecryptKey((await settingsService.getConnectors())?.openAlexApiKeyRef),
    contactEmail: async () => (await settingsService.getConnectors())?.contactEmail
  })
  const literaturePdfImporter = new LiteraturePdfImporter({
    uploads: uploadRepository,
    content: contentRepository,
    catalog: literatureCatalog,
    annotations: pdfAnnotationRepository,
    workspace: { annotations: pdfAnnotationRepository, sources: pdfAnnotationService },
    onNativeImportProgress: (progress) =>
      applicationEvents.publish('pdf-annotations:import-progress', progress)
  })
  const literaturePdfAcquisition = new AgentPdfAcquisition({
    catalog: literatureCatalog,
    fullText: literatureFullTextFinder,
    content: contentRepository,
    download: downloadLiteraturePdf
  })
  const literatureBatchJobs = new LiteratureBatchJobs({
    path: join(resolveDataRoot(), 'literature', 'batch-jobs.json'),
    catalog: literatureCatalog,
    metadata: literatureMetadataEnricher,
    fullText: literatureFullTextFinder,
    onError: (error) =>
      literatureContextLog.error('Literature batch task failed', errorLogFields(error))
  })
  await modules.add(undefined, () => ({
    name: 'literature-batch-jobs',
    capability: undefined,
    dispose: () => literatureBatchJobs.close()
  }))
  const tagCleanupLog = createLogger('tags:cleanup')
  const removeResourceTagsOrThrow = async (
    resources: Parameters<TagService['removeResources']>[0]
  ): Promise<void> => tagService.removeResources(resources)
  const removeResourceTags = async (
    resources: Parameters<TagService['removeResources']>[0]
  ): Promise<void> => {
    try {
      await removeResourceTagsOrThrow(resources)
    } catch (error) {
      tagCleanupLog.warn('resource deletion Tag cleanup failed', { error, resources })
    }
  }
  return {
    tagService,
    memoryService,
    journalAttributes,
    literatureCatalog,
    literatureCitationStyles,
    literatureCitationFormatter,
    literatureCitationDocument,
    literatureReferenceResolver,
    literatureMetadataEnricher,
    literatureFullTextFinder,
    literaturePdfImporter,
    literaturePdfAcquisition,
    literatureBatchJobs,
    removeResourceTagsOrThrow,
    removeResourceTags
  }
}
