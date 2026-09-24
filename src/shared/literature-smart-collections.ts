import { automaticClassificationPauseReasons } from './classification'
import { serializedSmartRuleSchema } from './smart-collection-rule'
import { classificationFailureCategories } from './classification'
import { z } from 'zod'
const id = z.string().trim().min(1).max(512)
export const SMART_COLLECTION_RESUME_UNAVAILABLE = 'SMART_COLLECTION_RESUME_UNAVAILABLE'
export const smartEvidenceModeSchema = z.enum(['abstract', 'full-text'])
export const smartEvidenceSchema = z
  .object({
    coverage: z.enum(['abstract', 'full-text', 'passages', 'unavailable']),
    attachmentVersionId: id.optional(),
    filename: z.string().optional(),
    passage: z
      .object({
        pageStart: z.number().int().positive(),
        pageEnd: z.number().int().positive(),
        content: z.string().max(12000)
      })
      .strict()
      .optional()
  })
  .strict()
export type SmartEvidence = z.infer<typeof smartEvidenceSchema>
export type SmartEvidenceMode = z.infer<typeof smartEvidenceModeSchema>
export const smartScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('library') }).strict(),
  z.object({ kind: z.literal('project'), id }).strict(),
  z.object({ kind: z.literal('collection'), id }).strict()
])
export const smartHistorySchema = z
  .object({
    currentRevision: z.number().int().positive(),
    entries: z
      .array(
        z
          .object({
            runId: id,
            revision: z.number().int().positive(),
            rule: serializedSmartRuleSchema,
            model: z.string(),
            evaluatedAt: z.number(),
            verdict: z.enum(['match', 'no-match', 'uncertain']),
            probabilities: z.record(z.string(), z.number()).optional()
          })
          .strict()
      )
      .max(20),
    nextOffset: z.number().int().nonnegative().optional()
  })
  .strict()
export const smartCollectionCommandSchemas = [
  z
    .object({
      kind: z.literal('read-smart-run-progress'),
      collectionId: id,
      runId: id
    })
    .strict(),
  z
    .object({
      kind: z.literal('read-smart-history'),
      collectionId: id,
      itemId: id,
      offset: z.number().int().nonnegative().default(0)
    })
    .strict(),
  z
    .object({
      kind: z.literal('preview-smart-collection'),
      evidenceMode: smartEvidenceModeSchema.optional(),
      requestId: id,
      description: serializedSmartRuleSchema,
      scope: smartScopeSchema
    })
    .strict(),
  z.object({ kind: z.literal('cancel-smart-preview'), requestId: id }).strict(),
  z
    .object({
      kind: z.literal('read-smart-decisions'),
      collectionId: id,
      itemIds: z.array(id).min(1).max(100)
    })
    .strict(),
  z
    .object({
      kind: z.literal('create-smart-collection'),
      evidenceMode: smartEvidenceModeSchema.optional(),
      autoUpdate: z.boolean().optional(),
      name: z.string().trim().min(1).max(120),
      description: serializedSmartRuleSchema,
      scope: smartScopeSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal('smart-collection'),
      collectionId: id,
      action: z.enum([
        'read',
        'resume-automatic',
        'resume',
        'refresh',
        'recompute',
        'preview',
        'cancel',
        'abandon',
        'override',
        'reset-overrides'
      ]),
      itemId: id.optional(),
      runId: id.optional(),
      summaryOnly: z.boolean().optional(),
      itemIds: z.array(id).min(1).max(10000).optional(),
      decision: z.enum(['include', 'exclude', 'automatic']).optional(),
      filter: z.enum(['all', 'match', 'review', 'no-match', 'pending']).optional(),
      offset: z.number().int().nonnegative().default(0)
    })
    .strict()
] as const
export const smartCollectionRowSchema = z
  .object({
    id,
    title: z.string(),
    collectionId: id.optional(),
    verdict: z.enum(['match', 'no-match', 'uncertain', 'pending', 'stale', 'error']),
    failure: z.enum(classificationFailureCategories).optional(),
    override: z.enum(['include', 'exclude']).optional(),
    decisionSource: z.enum(['ai', 'manual']).optional(),
    reason: z
      .enum([
        'rule-changed',
        'input-changed',
        'model-changed',
        'missing-evidence',
        'input-too-long',
        'uncertain'
      ])
      .optional(),
    assessment: z
      .object({
        ruleRevision: z.number().int().positive().optional(),
        currentRuleRevision: z.number().int().positive().optional(),
        rule: serializedSmartRuleSchema.optional(),
        evidence: smartEvidenceSchema.optional(),
        model: z.string(),
        evaluatedAt: z.number(),
        current: z.boolean(),
        probabilities: z
          .object({
            match: z.number().min(0).max(1),
            'no-match': z.number().min(0).max(1),
            uncertain: z.number().min(0).max(1)
          })
          .optional()
      })
      .strict()
      .optional()
  })
  .strict()
export type SmartCollectionRow = z.infer<typeof smartCollectionRowSchema>
export const smartRunSnapshotSchema = z
  .object({
    description: z.string(),
    scope: smartScopeSchema,
    evidenceMode: smartEvidenceModeSchema,
    model: z.string().optional(),
    action: z.enum(['refresh', 'recompute', 'preview']),
    selectedCount: z.number().int().nonnegative().optional()
  })
  .strict()
export const smartCollectionViewSchema = z
  .object({
    automaticPauseReason: z.enum(automaticClassificationPauseReasons).optional(),
    ruleRevision: z.number().int().positive().optional(),
    evidenceMode: smartEvidenceModeSchema.optional(),
    autoUpdate: z.boolean().optional(),
    scope: smartScopeSchema,
    sourceAvailable: z.boolean(),
    configured: z.boolean(),
    sourceName: z.string(),
    model: z.string().optional(),
    overrides: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    matches: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    counts: z
      .object({
        match: z.number().int().nonnegative(),
        review: z.number().int().nonnegative(),
        'no-match': z.number().int().nonnegative(),
        pending: z.number().int().nonnegative()
      })
      .strict(),
    countsBySource: z
      .object({
        ai: z
          .object({
            match: z.number().int().nonnegative(),
            review: z.number().int().nonnegative(),
            'no-match': z.number().int().nonnegative(),
            pending: z.number().int().nonnegative()
          })
          .strict(),
        manual: z
          .object({
            match: z.number().int().nonnegative(),
            review: z.number().int().nonnegative(),
            'no-match': z.number().int().nonnegative(),
            pending: z.number().int().nonnegative()
          })
          .strict()
      })
      .strict()
      .optional(),
    rows: z.array(smartCollectionRowSchema).max(100),
    nextOffset: z.number().int().nonnegative().optional(),
    run: z
      .object({
        id,
        kind: z.enum(['preview', 'refresh']),
        snapshot: smartRunSnapshotSchema.optional(),
        state: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted']),
        done: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
        inputTokens: z.number().nonnegative(),
        outputTokens: z.number().nonnegative(),
        usageIncomplete: z.boolean(),
        failure: z.enum(classificationFailureCategories).optional(),
        updatedAt: z.number()
      })
      .strict()
      .optional()
  })
  .strict()
export type SmartCollectionView = z.infer<typeof smartCollectionViewSchema>
export type SmartScope = z.infer<typeof smartScopeSchema>
export type SmartCollectionCommand = z.infer<(typeof smartCollectionCommandSchemas)[number]>

export const smartCollectionPreviewSchema = z
  .object({
    configured: z.boolean(),
    rows: z.array(smartCollectionRowSchema).max(4),
    inputTokens: z.number().nonnegative(),
    outputTokens: z.number().nonnegative()
  })
  .strict()
export type SmartCollectionPreview = z.infer<typeof smartCollectionPreviewSchema>

const smartRunProgressRowSchema = z
  .object({
    id,
    title: z.string().nullable(),
    state: z.enum(['pending', 'done', 'error']),
    verdict: z.enum(['match', 'no-match', 'uncertain']).optional(),
    evaluatedAt: z.number().optional(),
    override: z.enum(['include', 'exclude']).optional()
  })
  .strict()

// A bounded current snapshot, not a replay log. Counts cover non-deferred run items.
export const smartRunProgressSchema = z
  .object({
    runId: id,
    state: smartCollectionViewSchema.shape.run.unwrap().shape.state,
    total: z.number().int().nonnegative(),
    done: z.number().int().nonnegative(),
    counts: z
      .object({
        match: z.number().int().nonnegative(),
        review: z.number().int().nonnegative(),
        noMatch: z.number().int().nonnegative(),
        pending: z.number().int().nonnegative(),
        error: z.number().int().nonnegative(),
        unavailable: z.number().int().nonnegative()
      })
      .strict(),
    candidates: z.array(smartRunProgressRowSchema).max(4),
    outcomes: z.array(smartRunProgressRowSchema).max(24)
  })
  .strict()
export type SmartRunProgress = z.infer<typeof smartRunProgressSchema>
export type SmartRunProgressRow = z.infer<typeof smartRunProgressRowSchema>
