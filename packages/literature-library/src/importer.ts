import {
  LITERATURE_IMPORT_IDENTITY_CONFLICT,
  literatureItemInputSchema,
  type LiteratureDuplicatePolicy,
  type LiteratureItemInput,
  type LiteratureRecordImportEntry,
  type LiteratureRecordImportError,
  type LiteratureRecordImportReceipt
} from './contracts.js'
import { supplementLiteratureMetadata } from './duplicate-metadata.js'
import { canonicalJson, importIdentityMap, resolveImportItems } from './identity.js'
import type { LibraryImportStore } from './ports.js'

/** Import and preview within the caller's transaction; any rejection must roll back all writes. */
export class LibraryImporter {
  constructor(protected readonly store: LibraryImportStore) {}
  async importItems(
    inputs: readonly LiteratureItemInput[],
    collectionId?: string,
    duplicatePolicy: LiteratureDuplicatePolicy = 'reuse'
  ): Promise<LiteratureRecordImportReceipt> {
    const items = inputs.map((item) => literatureItemInputSchema.parse(item))
    let nextSortOrder = 0
    if (collectionId) {
      const collection = await this.store.collection(collectionId)
      if (!collection) throw new Error('Literature Collection is unavailable.')
      if (collection.smart)
        throw new Error(
          'Import into the library or an ordinary collection, then update the smart collection.'
        )
      nextSortOrder = (await this.store.lastCollectionOrder(collectionId)) + 1
    }
    const identities = await importIdentityMap(this.store, items)
    const resolutions = duplicatePolicy === 'separate' ? [] : resolveImportItems(identities, items)
    if (resolutions.some(({ conflict }) => conflict))
      throw new Error(LITERATURE_IMPORT_IDENTITY_CONFLICT)
    const importedTargets = new Map<number, string>(),
      itemIds: string[] = []
    let createdCount = 0,
      reusedCount = 0
    for (const [inputIndex, item] of items.entries()) {
      const target = resolutions[inputIndex]?.target
      const existingId =
        typeof target === 'string'
          ? target
          : target === undefined
            ? undefined
            : importedTargets.get(target)
      const itemId = existingId ?? (await this.store.createItem(item))
      if (existingId) {
        await this.store.restoreItem(existingId)
        if (duplicatePolicy === 'fill-missing') {
          const existing = await this.store.item(existingId)
          if (!existing) throw new Error('Literature Item is unavailable.')
          const supplemented = supplementLiteratureMetadata(existing.item, item).item
          if (canonicalJson(existing.item) !== canonicalJson(supplemented))
            await this.store.replaceMetadata(existingId, existing.metadataRevision, supplemented)
        }
        reusedCount++
      } else createdCount++
      importedTargets.set(inputIndex, itemId)
      if (!itemIds.includes(itemId)) itemIds.push(itemId)
      if (collectionId) await this.store.linkCollection(collectionId, itemId, nextSortOrder++)
    }
    return { itemIds, createdCount, reusedCount }
  }
  async inspectImportItems(
    inputs: readonly LiteratureItemInput[],
    errors: readonly LiteratureRecordImportError[],
    parserWarnings: readonly LiteratureRecordImportEntry['warnings'][] = []
  ): Promise<LiteratureRecordImportEntry[]> {
    const items = inputs.map((item) => literatureItemInputSchema.parse(item))
    const resolutions = resolveImportItems(await importIdentityMap(this.store, items), items)
    return [
      ...items.map((item, index): LiteratureRecordImportEntry => {
        const { target, conflict } = resolutions[index]!
        const warnings: LiteratureRecordImportEntry['warnings'] = [
          ...(parserWarnings[index] ?? []),
          ...(item.creators.length === 0 ? ['missing-authors' as const] : []),
          ...(item.issuedYear === undefined && !item.issuedText ? ['missing-year' as const] : []),
          ...(!item.containerTitle &&
          ['journalArticle', 'conferencePaper', 'preprint'].includes(item.itemType)
            ? ['missing-container-title' as const]
            : [])
        ]
        return {
          index,
          title: item.title,
          status: conflict
            ? 'conflict'
            : target !== undefined
              ? 'existing'
              : warnings.length
                ? 'warning'
                : 'ready',
          ...(conflict ? { conflict } : {}),
          warnings,
          item,
          ...(!conflict && typeof target === 'string' ? { existingItemId: target } : {})
        }
      }),
      ...errors.map((error, index): LiteratureRecordImportEntry => ({
        index: items.length + index,
        title: error.preview,
        status: 'invalid',
        warnings: [],
        error: error.error
      }))
    ]
  }
}
