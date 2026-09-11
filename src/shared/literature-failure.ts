import { z } from 'zod'

// Only controlled diagnostics cross the provider boundary; never response bodies or URLs.
export const literatureFailureSchema = z
  .object({
    code: z.enum([
      'rate-limit',
      'authentication',
      'timeout',
      'network',
      'unavailable',
      'conflict',
      'no-result',
      'no-full-text',
      'unknown'
    ]),
    phase: z.enum(['search', 'apply']),
    source: z.enum([
      'crossref',
      'pubmed',
      'europe-pmc',
      'openalex',
      'unpaywall',
      'pmc',
      'arxiv',
      'catalog',
      'provider'
    ]),
    retryable: z.boolean()
  })
  .strict()
export type LiteratureFailure = z.infer<typeof literatureFailureSchema>
