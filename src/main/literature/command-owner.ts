import type { JournalAttributes } from './journal-attributes'
import { withDataRootWrite } from '../storage/migration-state'
import { broadcastToRenderers } from '../renderer-broadcast'
import { transactLiterature } from './transact'
import type { LiteratureCommandOwner } from './application-commands'
import type { LiteratureBatchJobs } from './batch-jobs'
import type { LiteratureCitationStyleLibrary } from './citation-style-library'
import type { LiteratureCitationFormatter } from './citation-formatter'
import type { LiteratureReferenceResolver } from './reference-resolver'
import type { LiteratureMetadataEnricher } from './metadata-enricher'
import type { LiteratureFullTextFinder } from './full-text-finder'
import type { ArtifactProvenanceRepository } from '../artifacts/provenance-repository'
import type { ManagedFileVersionService } from '../managed-file-versions/service'
import type { LiteratureCitationDocument } from './citation-document'
import type { LiteratureCatalog } from './catalog'
import type { LiteraturePdfImporter } from './pdf-importer'
import type { ContentRepository } from '../storage/content-repository'

type LiteratureCommandServices = Readonly<{
  journalAttributes: Pick<JournalAttributes, 'run'>
  literatureBatchJobs: Pick<LiteratureBatchJobs, 'run'>
  literatureCitationStyles: Pick<LiteratureCitationStyleLibrary, 'list' | 'import' | 'delete'>
  literatureCitationFormatter: Pick<
    LiteratureCitationFormatter,
    | 'formatStyleExample'
    | 'invalidateStyles'
    | 'formatReferences'
    | 'exportReferences'
    | 'parseReferences'
  >
  literatureReferenceResolver: Pick<LiteratureReferenceResolver, 'resolve'>
  literatureMetadataEnricher: Pick<LiteratureMetadataEnricher, 'complete'>
  literatureFullTextFinder: Pick<LiteratureFullTextFinder, 'run'>
  artifactProvenanceRepository: Pick<ArtifactProvenanceRepository, 'getVersionLiterature'>
  managedFileVersionService: Pick<
    ManagedFileVersionService,
    'openVersion' | 'saveDerivedArtifactEdit'
  >
  literatureCitationDocument: Pick<LiteratureCitationDocument, 'reformat'>
  literatureCatalog: Pick<
    LiteratureCatalog,
    | 'getMany'
    | 'exportRecord'
    | 'get'
    | 'sources'
    | 'inspectImportItems'
    | 'importItems'
    | 'search'
    | 'transact'
    | 'contentBlobIdsForItems'
  >
  literaturePdfImporter: Pick<LiteraturePdfImporter, 'import' | 'cancelImport' | 'addToLiterature'>
  contentRepository: Pick<ContentRepository, 'sweep'>
}>

export const createLiteratureCommandOwner = ({
  journalAttributes,
  literatureBatchJobs,
  literatureCitationStyles,
  literatureCitationFormatter,
  literatureReferenceResolver,
  literatureMetadataEnricher,
  literatureFullTextFinder,
  artifactProvenanceRepository,
  managedFileVersionService,
  literatureCitationDocument,
  literatureCatalog,
  literaturePdfImporter,
  contentRepository
}: LiteratureCommandServices): LiteratureCommandOwner => ({
  journals: (request) => journalAttributes.run(request),
  jobs: (request) => literatureBatchJobs.run(request),
  citationStyles: async (request) => {
    if (request.kind === 'preview') {
      const [styles, preview] = await Promise.all([
        literatureCitationStyles.list(),
        literatureCitationFormatter.formatStyleExample(request.styleId)
      ])
      return { styles, preview: { styleId: request.styleId, ...preview } }
    }
    let changedStyleId: string | undefined
    if (request.kind === 'import') {
      changedStyleId = await literatureCitationStyles.import(request.content)
      literatureCitationFormatter.invalidateStyles()
    } else if (request.kind === 'delete') {
      await literatureCitationStyles.delete(request.styleId)
      changedStyleId = request.styleId
      literatureCitationFormatter.invalidateStyles()
    }
    return {
      styles: await literatureCitationStyles.list(),
      ...(changedStyleId ? { changedStyleId } : {})
    }
  },
  lookupMetadata: async (doi) => {
    const [resolved] = await literatureReferenceResolver.resolve([
      doi.startsWith('pmid:') ? doi : 'doi:' + doi
    ])
    return resolved.item
  },
  completeMetadata: (request) => literatureMetadataEnricher.complete(request),
  fullText: (request) => literatureFullTextFinder.run(request),
  formatDocument: async (request) => {
    const literature = await artifactProvenanceRepository.getVersionLiterature({
      projectId: request.projectId,
      appSessionId: request.sessionId,
      artifactId: request.artifactId,
      versionId: request.versionId
    })
    if (!literature) {
      throw new Error('This Artifact Version has no Literature manifest.')
    }
    if (request.mode === 'preview') {
      const references = await literatureCitationFormatter.formatReferences(
        literature.references.map((reference) => ({
          id: reference.itemId,
          item: reference.item
        })),
        request.styleId,
        request.locale
      )
      return { mode: 'preview' as const, references }
    }

    const lease = await managedFileVersionService.openVersion(
      { source: 'artifact', projectId: request.projectId, fileId: request.artifactId },
      request.versionId
    )
    let content: Uint8Array
    try {
      content = lease.size === 0 ? new Uint8Array() : await lease.readRange(0, lease.size)
    } finally {
      await lease.close()
    }
    const formatted = await literatureCitationDocument.reformat({
      content,
      literature,
      styleId: request.styleId,
      locale: request.locale
    })
    const saved = await withDataRootWrite(() =>
      managedFileVersionService.saveDerivedArtifactEdit({
        source: 'artifact',
        projectId: request.projectId,
        fileId: request.artifactId,
        basedOnVersionId: request.versionId,
        expectedHeadVersionId: request.expectedHeadVersionId,
        operationId: request.operationId,
        content: formatted.content,
        literature: formatted.literature
      })
    )
    if (saved.kind !== 'created') {
      throw new Error(
        saved.kind === 'conflict'
          ? 'This file has a newer version.'
          : 'Citation formatting did not create a new version.'
      )
    }
    if (!saved.replayed) {
      broadcastToRenderers('project-files:changed', {
        projectId: request.projectId,
        sources: ['artifact'],
        kind: 'upsert'
      })
    }
    return {
      mode: 'save' as const,
      versionId: saved.version.id,
      versionNumber: saved.version.versionNumber
    }
  },
  formatReferences: async (request) => {
    const items = await literatureCatalog.getMany(request.itemIds)
    const itemsById = new Map(items.map((item) => [item.id, item]))
    const references = request.itemIds.map((itemId) => {
      const item = itemsById.get(itemId)
      if (!item) throw new Error(`Literature Item is unavailable: ${itemId}`)
      return { id: itemId, item: item.item }
    })
    const [formatted, bibtex, ris] = await Promise.all([
      literatureCitationFormatter.formatReferences(references, request.styleId, request.locale),
      literatureCitationFormatter.exportReferences(references, 'bibtex'),
      literatureCitationFormatter.exportReferences(references, 'ris')
    ])
    return {
      references: formatted,
      exports: { bibtex, ris }
    }
  },
  exportRecord: (request) => literatureCatalog.exportRecord(request),
  get: (itemId) => literatureCatalog.get(itemId),
  sources: (itemId) => literatureCatalog.sources(itemId),
  addPdf: (request, signal) => literaturePdfImporter.addToLiterature(request, signal),
  importPdf: (request, signal) => literaturePdfImporter.import(request, signal),
  cancelPdfImport: (request) => literaturePdfImporter.cancelImport(request.operationId),
  importRecords: async (request) => {
    const { warnings, ...parsed } = await literatureCitationFormatter.parseReferences(
      request.content
    )
    const entries = await literatureCatalog.inspectImportItems(
      parsed.items,
      parsed.errors,
      warnings
    )
    if (request.mode === 'preview') return { ...parsed, entries }
    if (parsed.items.length === 0) throw new Error('No valid references were found.')
    return {
      ...parsed,
      entries,
      imported: await literatureCatalog.importItems(
        parsed.items,
        request.collectionId,
        request.duplicatePolicy
      )
    }
  },
  search: (request) => literatureCatalog.search(request),
  transact: (command) => transactLiterature(literatureCatalog, contentRepository, command)
})
