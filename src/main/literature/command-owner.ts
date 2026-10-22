import type { LiteratureCitationFormatter } from '@aipoch/literature-citations'
import type {
  LiteratureBatchJobs,
  LiteratureFullTextFinder,
  LiteratureMetadataEnricher,
  LiteratureReferenceResolver
} from '@aipoch/literature-discovery'
import type { LiteratureItemView } from '@aipoch/literature-library/contracts'
import type { ArtifactLiteratureManifest } from '../../shared/artifact-literature'
import type { GetArtifactVersionProvenanceRequest } from '../../shared/artifact-provenance'
import type { ManagedFileVersionService } from '../managed-file-versions/service'
import { broadcastToRenderers } from '../renderer-broadcast'
import type { ContentRepository } from '../storage/content-repository'
import { withDataRootWrite } from '../storage/migration-state'
import type { LiteratureCommandOwner } from './application-commands'
import type { LiteratureCatalog } from './catalog'
import type { LiteratureCitationDocument } from './citation-document'
import { withCitationStyleErrors } from './citation-errors'
import type { JournalAttributes } from './journal-attributes'
import type { LiteraturePdfImporter } from './pdf-importer'
import { transactLiterature } from './transact'

type LiteratureCommandServices = Readonly<{
  journalAttributes: Pick<JournalAttributes, 'run'>
  literatureBatchJobs: Pick<LiteratureBatchJobs, 'run'>
  literatureCitationFormatter: Pick<
    LiteratureCitationFormatter,
    'citationStyles' | 'formatReferences' | 'exportReferences' | 'parseReferences'
  >
  literatureReferenceResolver: Pick<LiteratureReferenceResolver, 'resolve'>
  literatureMetadataEnricher: Pick<LiteratureMetadataEnricher<LiteratureItemView>, 'complete'>
  literatureFullTextFinder: Pick<LiteratureFullTextFinder<LiteratureItemView>, 'run'>
  artifactProvenanceRepository: {
    getVersionLiterature(
      request: GetArtifactVersionProvenanceRequest
    ): Promise<ArtifactLiteratureManifest | undefined>
  }
  managedFileVersionService: Pick<
    ManagedFileVersionService,
    'openVersion' | 'saveDerivedArtifactEdit'
  >
  literatureCitationDocument: Pick<LiteratureCitationDocument, 'reformat'>
  literatureCatalog: Pick<
    LiteratureCatalog,
    | 'getCandidateStates'
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
  getCandidateStates: (request) => literatureCatalog.getCandidateStates(request),
  journals: (request) => journalAttributes.run(request),
  jobs: (request) => literatureBatchJobs.run(request),
  citationStyles: (request) =>
    withCitationStyleErrors(() => literatureCitationFormatter.citationStyles(request)),
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
    const indexes = request.selectedItemIndexes
    if (
      indexes &&
      (indexes.length === 0 ||
        new Set(indexes).size !== indexes.length ||
        indexes.some(
          (index) => !Number.isInteger(index) || index < 0 || index >= parsed.items.length
        ))
    )
      throw new Error('Import selection is invalid. Preview the file again.')
    // Preserve source order and recheck selected identities in the existing write transaction.
    const selected = indexes ? new Set(indexes) : undefined
    const items = selected ? parsed.items.filter((_, index) => selected.has(index)) : parsed.items
    const sourceIndexes = parsed.items
      .map((_, index) => index)
      .filter((index) => !selected || selected.has(index))
    const inspected = await literatureCatalog.inspectImportItems(
      items,
      parsed.errors,
      sourceIndexes.map((index) => warnings?.[index] ?? [])
    )
    const entries = selected
      ? inspected.map((entry) => ({
          ...entry,
          ...(entry.conflict
            ? {
                conflict: {
                  ...entry.conflict,
                  matches: entry.conflict.matches.map((match) =>
                    typeof match.inputIndex === 'number'
                      ? { ...match, inputIndex: sourceIndexes[match.inputIndex]! }
                      : match
                  )
                }
              }
            : {}),
          index: entry.item
            ? sourceIndexes[entry.index]!
            : parsed.items.length + entry.index - items.length
        }))
      : inspected
    if (request.mode === 'preview') return { ...parsed, entries }
    if (items.length === 0) throw new Error('No valid references were found.')
    return {
      ...parsed,
      entries,
      imported: await literatureCatalog.importItems(
        items,
        request.collectionId,
        request.duplicatePolicy
      )
    }
  },
  search: (request) => literatureCatalog.search(request),
  transact: (command) => transactLiterature(literatureCatalog, contentRepository, command)
})
