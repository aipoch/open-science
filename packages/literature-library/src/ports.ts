import type { LiteratureIdentifierInput } from '@aipoch/literature-citations/contracts'
import type { SmartScope } from '@aipoch/literature-screening/contracts'
import type {
  LiteratureCandidateInput,
  LiteratureItemInput,
  LiteratureItemView,
  LiteraturePdfProvenance,
  LiteratureSourceInput
} from './contracts.js'
export type NormalizedIdentifier = LiteratureIdentifierInput & { normalizedValue: string }
export type LibraryPdf = {
  contentBlobId: string
  filename: string
  sizeBytes: number
  checksum: string
  pageCount: number
  sourceUrl: string
  provenance?: LiteraturePdfProvenance
}
export type CandidateRecord = {
  id: string
  state: string
  candidateJson: string
  acceptedItemId: string | null
  discoveries: { projectId: string | null; origin: string }[]
}
export type MetadataReceipt = {
  itemId: string
  expectedMetadataRevision: number
  committedMetadataRevision: number
}
/** All operations run on the caller's active transaction. Reads see earlier writes.
 * Implementations perform conditional writes and relation updates without committing independently.
 * A thrown domain error MUST roll back all preceding writes in the transaction.
 */
export interface LibraryStore {
  identityMatches(
    identifiers: readonly NormalizedIdentifier[]
  ): Promise<{ id: string; identifiers: { scheme: string; normalizedValue: string }[] }[]>
  importIdentityRecords(
    identifiers: readonly NormalizedIdentifier[]
  ): Promise<{ id: string; item: Pick<LiteratureItemInput, 'title' | 'identifiers'> }[]>
  collection(id: string): Promise<{ id: string; smart: boolean } | null>
  collectionState(id: string): Promise<{
    description: string
    smart: { scopeKind: string; scopeId: string | null; evidenceMode: string } | null
  } | null>
  lastSiblingOrder(parentId?: string): Promise<number>
  createCollection(input: {
    name: string
    description: string
    parentId?: string
    sortOrder: number
  }): Promise<string>
  updateCollection(
    id: string,
    revision: number,
    input: { name: string; description: string }
  ): Promise<number>
  scopeAvailable(scope: SmartScope): Promise<boolean>
  updateSmartCollection(
    id: string,
    input: { ruleChanged: boolean; scope?: SmartScope; evidenceMode?: string; autoUpdate?: boolean }
  ): Promise<void>
  saveSmartRuleVersion(id: string): Promise<void>
  removeCollection(id: string): Promise<void>
  deletionItems(ids: readonly string[]): Promise<{ id: string; deleted: boolean }[]>
  mergedItemIds(ids: readonly string[]): Promise<string[]>
  attachmentIds(ids: readonly string[]): Promise<string[]>
  assertAttachmentsUnreferenced(ids: readonly string[]): void
  deleteItemsAndRelations(ids: readonly string[]): Promise<boolean>
  lastCollectionOrder(id: string): Promise<number>
  linkCollection(collectionId: string, itemId: string, sortOrder: number): Promise<void>
  unlinkCollection(collectionId: string, itemId: string): Promise<void>
  createItem(item: LiteratureItemInput): Promise<string>
  restoreItem(id: string): Promise<void>
  item(id: string): Promise<LiteratureItemView | undefined>
  replaceMetadata(id: string, expectedRevision: number, item: LiteratureItemInput): Promise<void>
  metadataReceipt(operationId: string): Promise<MetadataReceipt | null>
  saveMetadataReceipt(operationId: string, receipt: MetadataReceipt): Promise<void>
  attachSource(input: {
    source: LiteratureSourceInput
    itemId?: string
    candidateId?: string
  }): Promise<void>
  candidate(id: string): Promise<CandidateRecord | null>
  candidateByKey(
    key: string
  ): Promise<{ id: string; state: string; acceptedDeleted: boolean } | null>
  retireCandidateKey(id: string): Promise<void>
  createCandidate(
    key: string,
    candidate: LiteratureCandidateInput,
    candidateJson: string,
    checksum: string
  ): Promise<{ id: string; state: string }>
  recordDiscovery(
    candidateId: string,
    candidate: LiteratureCandidateInput,
    contextKey: string
  ): Promise<void>
  stagePdf(candidateId: string, pdf: LibraryPdf, provenanceJson: string | null): Promise<void>
  attachProjectIfPresent(
    projectId: string | undefined,
    itemId: string,
    source: string
  ): Promise<void>
  transferCandidateSources(candidateId: string, itemId: string): Promise<void>
  acceptCandidate(id: string, itemId: string): Promise<void>
  transferCandidatePdfs(candidateId: string, itemId: string): Promise<void>
  changeCandidates(
    ids: readonly string[],
    from: 'pending' | 'dismissed',
    to: 'pending' | 'dismissed'
  ): Promise<number>
  activeItemCount(ids: readonly string[]): Promise<number>
  projectAvailable(id: string): Promise<boolean>
  linkProject(projectId: string, itemId: string, source: string): Promise<void>
  unlinkProject(projectId: string, itemIds: readonly string[]): Promise<void>
  setLifecycle(ids: readonly string[], state: 'active' | 'deleted'): Promise<number>
  invalidateAssessments(ids: readonly string[]): Promise<void>
  mergeViews(ids: readonly string[]): Promise<LiteratureItemView[]>
  mergeOverrides(ids: readonly string[]): Promise<{ collectionId: string; decision: string }[]>
  prepareMerge(
    survivorId: string,
    duplicateIds: readonly string[],
    decisions: ReadonlyMap<string, string>
  ): Promise<void>
  /** Transfer existing relationships, preserving source evidence and annotation identity atomically. */
  moveMergedRelations(survivorId: string, duplicateIds: readonly string[]): Promise<boolean>
}

/** Storage needed for import, preview, duplicate reuse and metadata supplementation only. */
export type LibraryImportStore = Pick<
  LibraryStore,
  | 'importIdentityRecords'
  | 'collection'
  | 'lastCollectionOrder'
  | 'linkCollection'
  | 'createItem'
  | 'restoreItem'
  | 'item'
  | 'replaceMetadata'
>
