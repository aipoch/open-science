import { z } from 'zod'

import { literatureItemInputSchema } from './literature'

const ARTIFACT_LITERATURE_SIDECAR_SUFFIX = '.open-science-literature.json'

const artifactCitationLocatorSchema = z
  .object({
    label: z.enum(['page', 'chapter', 'section', 'figure', 'table', 'paragraph']),
    value: z.string().trim().min(1).max(128)
  })
  .strict()

const artifactCitationInputSchema = z
  .object({
    citationId: z.string().trim().min(1).max(128),
    itemId: z.string().trim().min(1).max(512),
    locator: artifactCitationLocatorSchema.optional(),
    prefix: z.string().max(512).optional(),
    suffix: z.string().max(512).optional(),
    suppressAuthor: z.boolean().optional()
  })
  .strict()

const artifactCitationManifestSchema = artifactCitationInputSchema.extend({
  metadataRevision: z.number().int().positive()
})

const artifactLiteratureItemRevisionSchema = z
  .object({
    itemId: z.string().trim().min(1).max(512),
    metadataRevision: z.number().int().positive()
  })
  .strict()

const artifactLiteratureRetrievalCriteriaFields = {
  scope: z.enum(['library', 'project', 'collection', 'items']),
  query: z.string().trim().min(1).max(2_000).optional(),
  collectionId: z.string().trim().min(1).max(512).optional(),
  itemIds: z.array(z.string().trim().min(1).max(512)).min(1).max(200).optional()
} as const

type ArtifactLiteratureRetrievalCriteria = {
  scope: 'library' | 'project' | 'collection' | 'items'
  query?: string
  collectionId?: string
  itemIds?: string[]
}

const validateRetrievalCriteria = (
  { scope, collectionId, itemIds }: ArtifactLiteratureRetrievalCriteria,
  context: z.RefinementCtx
): void => {
  if ((scope === 'collection') !== Boolean(collectionId)) {
    context.addIssue({
      code: 'custom',
      message: 'Collection retrieval requires collectionId and no other scope accepts it.',
      path: ['collectionId']
    })
  }
  if ((scope === 'items') !== Boolean(itemIds)) {
    context.addIssue({
      code: 'custom',
      message: 'Items retrieval requires itemIds and no other scope accepts them.',
      path: ['itemIds']
    })
  }
  if (itemIds && new Set(itemIds).size !== itemIds.length) {
    context.addIssue({
      code: 'custom',
      message: 'Retrieval item ids must be unique.',
      path: ['itemIds']
    })
  }
}

const artifactLiteratureRetrievalSchema = z
  .object({
    ...artifactLiteratureRetrievalCriteriaFields,
    resultCount: z.number().int().nonnegative(),
    totalCount: z.number().int().nonnegative(),
    complete: z.boolean()
  })
  .strict()
  .superRefine(validateRetrievalCriteria)
  .superRefine(({ resultCount, totalCount, complete }, context) => {
    if (resultCount > totalCount) {
      context.addIssue({
        code: 'custom',
        message: 'Retrieval result count cannot exceed total count.',
        path: ['resultCount']
      })
    }
    if (complete !== resultCount >= totalCount) {
      context.addIssue({
        code: 'custom',
        message: 'Retrieval completeness must match its result and total counts.',
        path: ['complete']
      })
    }
  })

const artifactLiteratureCoverageSchema = z
  .object({
    searchedCount: z.number().int().nonnegative(),
    candidateCount: z.number().int().nonnegative(),
    fullTextCount: z.number().int().nonnegative(),
    abstractOnlyCount: z.number().int().nonnegative(),
    unprocessedCount: z.number().int().nonnegative()
  })
  .strict()

const artifactLiteratureCorpusRequestSchema = z
  .object({
    itemIds: z.array(z.string().trim().min(1).max(512)).min(1).max(1_000),
    candidateCount: z.number().int().nonnegative()
  })
  .strict()
  .superRefine(({ itemIds, candidateCount }, context) => {
    const uniqueItemIds = new Set<string>()
    for (const [index, itemId] of itemIds.entries()) {
      if (!uniqueItemIds.has(itemId)) uniqueItemIds.add(itemId)
      else {
        context.addIssue({
          code: 'custom',
          message: 'Corpus item ids must be unique.',
          path: ['itemIds', index]
        })
      }
    }
    if (itemIds.length > candidateCount) {
      context.addIssue({
        code: 'custom',
        message: 'Frozen corpus cannot exceed candidate count.',
        path: ['candidateCount']
      })
    }
  })

const artifactLiteratureCorpusManifestSchema = z
  .object({
    items: z.array(artifactLiteratureItemRevisionSchema).min(1).max(1_000),
    retrievals: z.array(artifactLiteratureRetrievalSchema).min(1).max(100),
    coverage: artifactLiteratureCoverageSchema,
    capturedAt: z.string().datetime({ offset: true })
  })
  .strict()
  .superRefine(({ items, coverage }, context) => {
    const itemIds = new Set<string>()
    for (const [index, item] of items.entries()) {
      if (!itemIds.has(item.itemId)) itemIds.add(item.itemId)
      else {
        context.addIssue({
          code: 'custom',
          message: 'Corpus item ids must be unique.',
          path: ['items', index, 'itemId']
        })
      }
    }
    if (coverage.candidateCount > coverage.searchedCount) {
      context.addIssue({
        code: 'custom',
        message: 'Candidate count cannot exceed searched count.',
        path: ['coverage', 'candidateCount']
      })
    }
    if (items.length > coverage.candidateCount) {
      context.addIssue({
        code: 'custom',
        message: 'Frozen corpus cannot exceed candidate count.',
        path: ['coverage', 'candidateCount']
      })
    }
    if (coverage.fullTextCount + coverage.abstractOnlyCount !== items.length) {
      context.addIssue({
        code: 'custom',
        message: 'Every frozen corpus item must be classified as full text or abstract only.',
        path: ['coverage']
      })
    }
    if (coverage.unprocessedCount !== coverage.searchedCount - coverage.candidateCount) {
      context.addIssue({
        code: 'custom',
        message: 'Unprocessed count must equal searched count minus candidate count.',
        path: ['coverage', 'unprocessedCount']
      })
    }
  })

const artifactLiteratureRequestSchema = z
  .object({
    styleId: z.string().trim().min(1).max(256).default('apa'),
    locale: z.string().trim().min(2).max(32).default('en-US'),
    corpus: artifactLiteratureCorpusRequestSchema.optional(),
    citations: z.array(artifactCitationInputSchema).min(1).max(200)
  })
  .strict()
  .superRefine(({ citations }, context) => {
    const ids = new Set<string>()
    for (const [index, citation] of citations.entries()) {
      if (!ids.has(citation.citationId)) ids.add(citation.citationId)
      else {
        context.addIssue({
          code: 'custom',
          message: 'Citation ids must be unique.',
          path: ['citations', index, 'citationId']
        })
      }
    }
  })

const artifactLiteratureReferenceSchema = z
  .object({
    itemId: z.string().trim().min(1).max(512),
    metadataRevision: z.number().int().positive(),
    item: literatureItemInputSchema
  })
  .strict()

const artifactLiteratureManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    styleId: z.string().trim().min(1).max(256),
    locale: z.string().trim().min(2).max(32),
    references: z.array(artifactLiteratureReferenceSchema).min(1).max(200),
    corpus: artifactLiteratureCorpusManifestSchema.optional(),
    citations: z.array(artifactCitationManifestSchema).min(1).max(200)
  })
  .strict()

const artifactLiteratureSidecarSchema = z
  .object({
    schemaVersion: z.literal(1),
    contentChecksum: z.string().regex(/^[a-f0-9]{64}$/u),
    literature: artifactLiteratureRequestSchema
  })
  .strict()

type ArtifactCitationInput = z.infer<typeof artifactCitationInputSchema>
type ArtifactCitationLocator = z.infer<typeof artifactCitationLocatorSchema>
type ArtifactLiteratureManifest = z.infer<typeof artifactLiteratureManifestSchema>
type ArtifactLiteratureReference = z.infer<typeof artifactLiteratureReferenceSchema>
type ArtifactLiteratureRequest = z.input<typeof artifactLiteratureRequestSchema>
type ArtifactLiteratureSidecar = z.infer<typeof artifactLiteratureSidecarSchema>
type ArtifactLiteratureCoverage = z.infer<typeof artifactLiteratureCoverageSchema>
type ArtifactLiteratureCorpus = z.infer<typeof artifactLiteratureCorpusManifestSchema>
type ArtifactLiteratureCorpusRequest = z.input<typeof artifactLiteratureCorpusRequestSchema>
type ArtifactLiteratureRetrieval = z.infer<typeof artifactLiteratureRetrievalSchema>

export {
  ARTIFACT_LITERATURE_SIDECAR_SUFFIX,
  artifactCitationInputSchema,
  artifactCitationManifestSchema,
  artifactCitationLocatorSchema,
  artifactLiteratureCoverageSchema,
  artifactLiteratureCorpusManifestSchema,
  artifactLiteratureCorpusRequestSchema,
  artifactLiteratureManifestSchema,
  artifactLiteratureReferenceSchema,
  artifactLiteratureRequestSchema,
  artifactLiteratureSidecarSchema
}
export type {
  ArtifactCitationInput,
  ArtifactCitationLocator,
  ArtifactLiteratureCoverage,
  ArtifactLiteratureCorpus,
  ArtifactLiteratureCorpusRequest,
  ArtifactLiteratureManifest,
  ArtifactLiteratureReference,
  ArtifactLiteratureRequest,
  ArtifactLiteratureSidecar,
  ArtifactLiteratureRetrievalCriteria,
  ArtifactLiteratureRetrieval
}
