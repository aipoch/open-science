export {
  conflictFreeLiteratureMerge,
  planLiteratureMerge,
  supplementLiteratureMetadata
} from './duplicate-metadata.js'
export { findLiteratureDuplicateGroups } from './duplicates.js'
export {
  candidateDedupeKey,
  canonicalJson,
  normalizeIdentifier,
  normalizeSpace,
  normalizedIdentifiers
} from './identity.js'
export { LibraryImporter } from './importer.js'
export { LibraryTransaction } from './library.js'
export type {
  CandidateRecord,
  LibraryPdf,
  LibraryImportStore,
  LibraryStore,
  MetadataReceipt,
  NormalizedIdentifier
} from './ports.js'

export { LITERATURE_OVERSIZED_REFERENCE, oversizedLiteratureReference } from './export.js'
export { mergeLiteratureDuplicates } from './merge-batch.js'
export type { MergeGroupResult, RunMergeGroup } from './merge-batch.js'
