import { z } from 'zod'
import { canonicalJson } from '@aipoch/literature-library'

const contextSchema = z
  .object({
    rootItemId: z.string().min(1).max(256),
    rootMetadataRevision: z.number().int().positive(),
    seedPaperId: z.string().min(1).max(256).optional(),
    exploredPaperId: z.string().min(1).max(256).optional(),
    origin: z.literal('exploration-center').optional(),
    direction: z.enum(['references', 'citations']).optional(),
    directions: z.array(z.enum(['references', 'citations'])).optional(),
    lookupMode: z.enum(['skg-if', 'index']).optional()
  })
  .refine((context) => context.seedPaperId || context.exploredPaperId)

/** Preserve distinct discovery paths, not a timestamped history of source snapshots. */
export function mergeCitationSourceMetadata(
  provider: string,
  previous: Record<string, unknown> | undefined,
  next: Record<string, unknown>
): Record<string, unknown> {
  if (!['europe-pmc', 'opencitations'].includes(provider)) return next
  const contexts = new Map<string, unknown>()
  for (const metadata of [previous, next]) {
    if (!metadata) continue
    for (const value of [
      metadata,
      ...(Array.isArray(metadata.citationContexts) ? metadata.citationContexts : [])
    ]) {
      const parsed = contextSchema.safeParse(value)
      if (!parsed.success) continue
      const { direction, directions, ...context } = parsed.data
      const normalized = {
        ...context,
        ...(direction || directions?.length
          ? {
              directions: [
                ...new Set([...(direction ? [direction] : []), ...(directions ?? [])])
              ].sort()
            }
          : {})
      }
      contexts.set(canonicalJson(normalized), normalized)
    }
  }
  return contexts.size
    ? { ...next, citationContexts: [...contexts.keys()].sort().map((key) => contexts.get(key)) }
    : next
}
