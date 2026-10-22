import { z } from 'zod'
import { normalizeLiteratureIdentifierValue } from '@aipoch/literature-citations/contracts'

export const LITERATURE_SUPPLEMENT_PROVIDERS = ['figshare', 'datacite', 'europe-pmc'] as const
const text = z.string().trim().min(1).max(2048)
const provider = z.enum(LITERATURE_SUPPLEMENT_PROVIDERS)
export const literatureSupplementRequestSchema = z
  .object({
    itemId: text,
    expectedMetadataRevision: z.number().int().positive(),
    provider
  })
  .strict()
export const literatureSupplementRecordSchema = z
  .object({
    id: text,
    doi: text.optional(),
    title: text,
    sourceUrl: text.url().refine((value) => {
      try {
        const url = new URL(value)
        return (
          url.protocol === 'https:' &&
          !url.username &&
          !url.password &&
          !url.port &&
          (['doi.org', 'figshare.com', 'europepmc.org'].includes(url.hostname) ||
            url.hostname.endsWith('.figshare.com'))
        )
      } catch {
        return false
      }
    }),
    evidence: z.enum(['source-declared', 'article-section']),
    files: z
      .array(
        z
          .object({
            name: text,
            downloadId: z.string().uuid().optional(),
            sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional()
          })
          .strict()
      )
      .max(100)
      .optional(),
    license: text.optional()
  })
  .strict()
export const literatureSupplementResultSchema = z
  .object({
    itemId: text,
    metadataRevision: z.number().int().positive(),
    doi: text.optional(),
    provider,
    state: z.enum(['complete', 'partial', 'unavailable']),
    records: z.array(literatureSupplementRecordSchema).max(50),
    issues: z
      .array(
        z.enum([
          'doi-required',
          'reference-changed',
          'reference-unavailable',
          'unavailable',
          'rate-limited',
          'timeout',
          'response-invalid',
          'search-incomplete',
          'full-text-unavailable'
        ])
      )
      .max(9),
    retryAt: z.number().int().nonnegative().optional()
  })
  .strict()
export type LiteratureSupplementRequest = z.infer<typeof literatureSupplementRequestSchema>
export type LiteratureSupplementResult = z.infer<typeof literatureSupplementResultSchema>
export type LiteratureSupplementRecord = z.infer<typeof literatureSupplementRecordSchema>
export type LiteratureSupplementProvider = LiteratureSupplementRequest['provider']

export function normalizeSupplementDoi(value: string): string | undefined {
  const doi = normalizeLiteratureIdentifierValue('doi', value).toLowerCase()
  return doi.length <= 2048 && /^10\.\d{4,9}\/[^\s\p{Cc}]+$/u.test(doi) ? doi : undefined
}

export function getSupplementDoi(
  identifiers: readonly { scheme: string; value: string }[]
): string | undefined {
  const dois = identifiers
    .filter(({ scheme }) => scheme === 'doi')
    .map(({ value }) => normalizeSupplementDoi(value))
  return dois.length && !dois.includes(undefined) && new Set(dois).size === 1 ? dois[0] : undefined
}

// Exact DOI identity only: a concept DOI and a version DOI remain separate records.
export function mergeSupplementResults(
  results: readonly LiteratureSupplementResult[]
): (LiteratureSupplementRecord & { providers: LiteratureSupplementProvider[] })[] {
  const merged = new Map<
    string,
    LiteratureSupplementRecord & { providers: LiteratureSupplementProvider[] }
  >()
  for (const provider of LITERATURE_SUPPLEMENT_PROVIDERS) {
    for (const result of results.filter((result) => result.provider === provider)) {
      for (const record of result.records) {
        const doi = record.doi && normalizeSupplementDoi(record.doi)
        const key = doi ? `doi:${doi}` : `${provider}:${record.id}`
        const existing = merged.get(key)
        if (existing) {
          if (!existing.providers.includes(provider)) existing.providers.push(provider)
          existing.files ??= record.files
          existing.license ??= record.license
        } else merged.set(key, { ...record, providers: [provider] })
      }
    }
  }
  return [...merged.values()]
}

export const literatureSupplementAttachmentRequestSchema = z
  .object({
    itemId: text,
    expectedMetadataRevision: z.number().int().positive(),
    downloadId: z.string().uuid()
  })
  .strict()
export const literatureSupplementAttachmentResultSchema = z
  .object({
    attachmentId: text,
    versionId: text
  })
  .strict()
export type LiteratureSupplementAttachmentRequest = z.infer<
  typeof literatureSupplementAttachmentRequestSchema
>
export type LiteratureSupplementAttachmentResult = z.infer<
  typeof literatureSupplementAttachmentResultSchema
>
