import { z } from 'zod'
import { webAttemptSchema, webRoutingSchema, webSynthesisSchema } from './web-tools'

export const webEvidenceComponentSchema = z.enum([
  'query_history',
  'source_manifest',
  'provider_excerpt',
  'model_synthesis',
  'fetch_body'
])
export type WebEvidenceComponent = z.infer<typeof webEvidenceComponentSchema>
export const webPolicyDecisionSchema = z.enum(['allow', 'deny', 'unknown'])
export type WebPolicyDecision = z.infer<typeof webPolicyDecisionSchema>
export const packageWebOmissionSchema = z
  .object({
    component: webEvidenceComponentSchema,
    reason: z.enum([
      'policy-denied',
      'policy-unknown',
      'missing',
      'invalid',
      'redacted',
      'size-limit'
    ]),
    count: z.number().int().positive().max(100000)
  })
  .strict()
export type PackageWebOmission = z.infer<typeof packageWebOmissionSchema>
const id = z.string().min(1).max(512)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const url = z
  .string()
  .max(2048)
  .url()
  .refine((value) => {
    try {
      const parsed = new URL(value)
      return (
        ['http:', 'https:'].includes(parsed.protocol) &&
        !parsed.username &&
        !parsed.password &&
        !Array.from(parsed.searchParams.keys()).some((key) =>
          /(?:token|secret|password|credential|signature|api.?key|access.?key|auth|x-amz-|x-goog-)/i.test(
            key
          )
        )
      )
    } catch {
      return false
    }
  })
const provenance = z
  .object({
    origin: z.enum(['provider-search', 'independent-fetch']),
    policyVersion: z.string().min(1).max(128),
    providerId: z.string().min(1).max(128).optional(),
    providerAuthMode: z.enum(['anonymous', 'api_key', 'platform', 'managed']).optional()
  })
  .strict()
export const packageWebActivityEvidenceSchema = z
  .object({
    schema: z.literal('open-science.package-web.v1'),
    sourceSchema: z
      .enum(['open-science.web.v1', 'open-science.web.v2', 'open-science.web.v3'])
      .optional(),
    minReaderVersion: z.union([z.literal(2), z.literal(3)]).optional(),
    resultKind: z.literal('restricted_grounded_result').optional(),
    presentationStatus: z.literal('presentation_only').optional(),
    routing: webRoutingSchema.optional(),
    attempts: z.array(webAttemptSchema).max(2).optional(),
    dispatches: z
      .array(webAttemptSchema.omit({ status: true, duration_ms: true }))
      .max(2)
      .optional(),
    synthesis: webSynthesisSchema.optional(),
    activityId: id,
    invocationId: id,
    operation: z.enum(['search', 'fetch']),
    status: z.enum(['ok', 'error', 'unavailable']),
    provenance,
    retrievedAt: z.string().datetime().optional(),
    durationMs: z.number().finite().nonnegative().optional(),
    query: z.string().max(7000).optional(),
    requestUrl: url.optional(),
    sources: z
      .array(
        z
          .object({
            sourceId: id,
            evidenceKind: z
              .enum(['search_snippet', 'provider_excerpt', 'page_extract', 'provider_citation'])
              .optional(),
            attemptIndex: z.union([z.literal(1), z.literal(2)]).optional(),
            url: url.optional(),
            title: z.string().max(512).optional(),
            snippet: z.string().max(8000).optional(),
            publishedAt: z.string().datetime({ offset: true }).optional()
          })
          .strict()
      )
      .max(10),
    document: z
      .object({
        snapshotId: id.optional(),
        originalUrl: url.optional(),
        finalUrl: url.optional(),
        fetchedAt: z.string().datetime().optional(),
        contentType: z.string().max(128).optional(),
        extractionMethod: z.enum(['main_content', 'semantic_dom', 'plain_text']).optional(),
        extractionQuality: z.enum(['normal', 'degraded']).optional(),
        extractorVersion: z.string().max(128).optional(),
        sourceSha256: hash.optional(),
        projectedSha256: hash.optional(),
        text: z.string().max(16000).optional(),
        startLine: z.number().int().nonnegative().optional(),
        endLine: z.number().int().nonnegative().optional(),
        totalLines: z.number().int().nonnegative().optional(),
        truncated: z.boolean()
      })
      .strict()
      .optional(),
    errorCode: z.string().max(128).optional(),
    omissions: z.array(packageWebOmissionSchema).max(100)
  })
  .strict()
export type PackageWebActivityEvidence = z.infer<typeof packageWebActivityEvidenceSchema>
export const packageWebSnapshotSchema = z
  .object({
    snapshotId: id,
    invocationId: id,
    provenance,
    sourceSha256: hash,
    projectedSha256: hash,
    text: z.string().max(6 * 1024 * 1024),
    truncated: z.boolean(),
    originalUrl: url.optional(),
    finalUrl: url.optional(),
    title: z.string().max(512).optional(),
    fetchedAt: z.string().datetime(),
    contentType: z.string().max(128),
    extractorVersion: z.string().max(128),
    extractionMethod: z.enum(['main_content', 'semantic_dom', 'plain_text']),
    extractionQuality: z.enum(['normal', 'degraded'])
  })
  .strict()
export type PackageWebSnapshot = z.infer<typeof packageWebSnapshotSchema>
export const packageWebEvidenceSchema = z
  .object({
    version: z.literal(1),
    requiredCapabilities: z
      .array(z.enum(['web-result-v2', 'web-restricted-result-v1', 'web-search-operations-v1']))
      .max(3)
      .optional(),
    activities: z.array(packageWebActivityEvidenceSchema).max(10000),
    snapshots: z.array(packageWebSnapshotSchema).max(1000),
    omissions: z.array(packageWebOmissionSchema).max(100)
  })
  .strict()
  .superRefine((value, context) => {
    if (new TextEncoder().encode(JSON.stringify(value)).length > 64 * 1024 * 1024)
      context.addIssue({ code: 'custom', message: 'Web package evidence exceeds its size budget.' })
  })
export type PackageWebEvidence = z.infer<typeof packageWebEvidenceSchema>
