import { z } from 'zod'
import { defineApplicationCommandContract, validationCodec } from './application-command-contract'

const id = z.string().trim().min(1).max(256)
const offset = z.number().int().min(0).max(20_000_000).optional()
const text = z.string().trim().min(1).max(4000)
export const comparisonFieldSchema = z
  .object({
    id,
    name: z.string().trim().min(1).max(120),
    rule: text,
    version: z.number().int().min(1)
  })
  .strict()
const fieldInput = comparisonFieldSchema.omit({ version: true })
export const comparisonEvidenceSchema = z
  .object({
    pageStart: z.number().int().min(1).nullable(),
    pageEnd: z.number().int().min(1).nullable(),
    quote: z.string().min(1).max(12000)
  })
  .strict()
export const comparisonAttemptSchema = z
  .object({
    id,
    fieldVersion: z.number().int().min(1),
    fieldSnapshot: comparisonFieldSchema.optional(),
    sourcePolicy: z.enum(['abstract', 'full-text']).optional(),
    sourceKey: z.string().max(4096),
    at: z.string().max(64),
    status: z.enum(['succeeded', 'failed']),
    value: z.string().max(8000).nullable(),
    issue: z.string().max(256).optional(),
    coverage: z.enum(['abstract', 'passages', 'full-text']).optional(),
    model: z.string().max(256).optional(),
    metadataRevision: z.number().int().min(0).optional(),
    attachmentVersionId: id.optional(),
    attachmentFilename: z.string().max(1024).optional(),
    attachmentVersionNumber: z.number().int().min(1).optional(),
    evidence: z.array(comparisonEvidenceSchema).max(12)
  })
  .strict()
export const comparisonCellSchema = z
  .object({
    id,
    itemId: id,
    fieldId: id,
    status: z.enum(['pending', 'running', 'succeeded', 'failed', 'unavailable']),
    history: z.array(comparisonAttemptSchema).max(30),
    manual: z
      .object({
        value: z.string().max(8000),
        confirmed: z.boolean(),
        fieldVersion: z.number().int().min(1),
        sourceKey: z.string().max(4096),
        attemptId: id.optional(),
        updatedAt: z.string().max(64)
      })
      .strict()
      .optional()
  })
  .strict()
export const comparisonTableSchema = z
  .object({
    id,
    name: z.string().trim().min(1).max(160),
    language: z.string().min(1).max(64),
    sourcePolicy: z.enum(['abstract', 'full-text']),
    revision: z.number().int().min(1),
    fields: z.array(comparisonFieldSchema).max(12),
    members: z
      .array(
        z
          .object({
            itemId: id,
            title: z.string().max(4000),
            abstract: z.string().max(100000),
            sourceKey: z.string().max(4096)
          })
          .strict()
      )
      .max(100),
    itemIds: z.array(id).max(100),
    cells: z.array(comparisonCellSchema).max(1200),
    state: z.enum(['idle', 'running', 'paused', 'interrupted', 'completed']),
    taskId: id.optional(),
    remainingCellIds: z.array(id).max(1200),
    taskSources: z
      .array(
        z
          .object({
            cellId: id,
            sourceKey: z.string().max(4096),
            fieldVersion: z.number().int().min(1)
          })
          .strict()
      )
      .max(1200)
      .optional(),
    issue: z.string().max(256).optional()
  })
  .strict()
const expectedSources = z
  .array(z.object({ itemId: id, sourceKey: z.string().max(4096) }).strict())
  .max(100)
  .optional()
const launchChecks = {
  expectedSources,
  expectedRevision: z.number().int().min(1).optional()
}

export const comparisonRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('read'), tableId: id, offset }).strict(),
  z.object({ action: z.literal('delete'), tableId: id }).strict(),
  z
    .object({
      action: z.literal('check-sources'),
      tableId: id,
      itemIds: z.array(id).min(1).max(100).optional()
    })
    .strict(),
  z.object({ action: z.literal('read-cell'), tableId: id, cellId: id, offset }).strict(),
  z
    .object({
      action: z.literal('create'),
      name: z.string().trim().min(1).max(160),
      language: z.string().min(1).max(64),
      sourcePolicy: z.enum(['abstract', 'full-text']),
      fields: z.array(fieldInput).max(12),
      itemIds: z.array(id).max(100)
    })
    .strict(),
  z
    .object({
      action: z.literal('update'),
      tableId: id,
      expectedRevision: z.number().int().min(1),
      name: z.string().trim().min(1).max(160),
      sourcePolicy: z.enum(['abstract', 'full-text']),
      fields: z.array(fieldInput).max(12)
    })
    .strict(),
  z
    .object({ action: z.literal('add-members'), tableId: id, itemIds: z.array(id).min(1).max(100) })
    .strict(),
  z
    .object({
      action: z.literal('run'),
      tableId: id,
      ...launchChecks,
      unattemptedOnly: z.boolean().optional(),
      itemIds: z.array(id).min(1).max(100).optional()
    })
    .strict(),
  z.object({ action: z.literal('pause'), tableId: id }).strict(),
  z
    .object({
      action: z.literal('resume'),
      tableId: id,
      ...launchChecks,
      useCurrentSources: z.boolean().optional()
    })
    .strict(),
  z
    .object({
      action: z.literal('retry'),
      tableId: id,
      ...launchChecks,
      cellIds: z.array(id).min(1).max(1200)
    })
    .strict(),
  z
    .object({
      action: z.literal('rerun-field'),
      tableId: id,
      ...launchChecks,
      fieldId: id,
      itemIds: z.array(id).min(1).max(100).optional()
    })
    .strict(),
  z
    .object({
      action: z.literal('edit-cell'),
      tableId: id,
      cellId: id,
      value: z.string().max(8000),
      confirmed: z.boolean(),
      expectedFieldVersion: z.number().int().min(1),
      expectedSourceKey: z.string().max(4096),
      expectedAttemptId: id.optional()
    })
    .strict(),
  z
    .object({
      action: z.literal('export'),
      tableId: id,
      kind: z.enum(['matrix', 'evidence']),
      offset,
      exportToken: id.optional(),
      releaseOnComplete: z.boolean().optional()
    })
    .strict()
])
export const comparisonTableSummarySchema = comparisonTableSchema
  .pick({
    id: true,
    name: true,
    state: true,
    issue: true
  })
  .extend({
    revision: z.number().int().min(1).optional(),
    memberCount: z.number().int().min(0).max(100),
    total: z.number().int().min(0).max(1200),
    pending: z.number().int().min(0).max(1200),
    running: z.number().int().min(0).max(1200),
    succeeded: z.number().int().min(0).max(1200),
    failed: z.number().int().min(0).max(1200),
    unavailable: z.number().int().min(0).max(1200),
    pendingItemIds: z.array(id).max(100).default([]),
    reference: z
      .object({ itemId: id, title: z.string().max(4000) })
      .strict()
      .optional()
  })
  .strict()
export type ComparisonTableSummary = z.infer<typeof comparisonTableSummarySchema>

/** A task link names one exact reference, preferring the in-flight cell over queued work. */
export function comparisonTaskReference(
  table: Pick<ComparisonTable, 'cells' | 'members' | 'taskSources' | 'remainingCellIds'>
): ComparisonTableSummary['reference'] {
  const cell =
    table.cells.find((entry) => entry.status === 'running') ??
    table.cells.find((entry) => entry.id === table.remainingCellIds?.[0]) ??
    table.cells.find((entry) => entry.status !== 'succeeded') ??
    table.cells.find((entry) => entry.id === table.taskSources?.at(-1)?.cellId) ??
    table.cells.at(-1)
  const member = table.members.find((entry) => entry.itemId === cell?.itemId)
  return member ? { itemId: member.itemId, title: member.title } : undefined
}
export const comparisonResultSchema = z
  .object({
    tables: z.array(comparisonTableSchema).max(30),
    summaries: z.array(comparisonTableSummarySchema).max(30).optional(),
    cell: comparisonCellSchema.optional(),
    nextOffset: offset,
    exportToken: id.optional(),
    csv: z.string().max(100000).optional(),
    sourceChecks: z
      .array(
        z
          .object({
            itemId: id,
            sourceKey: z.string().max(4096),
            status: z.enum(['available', 'missing', 'unreadable']),
            coverage: z.enum(['abstract', 'passages', 'full-text']).optional()
          })
          .strict()
      )
      .max(100)
      .optional()
  })
  .strict()
export const literatureComparisonsContract = defineApplicationCommandContract(
  validationCodec(z.tuple([comparisonRequestSchema])),
  validationCodec(comparisonResultSchema)
)
export type ComparisonRequest = z.infer<typeof comparisonRequestSchema>
export type ComparisonLaunchRequest = Extract<
  ComparisonRequest,
  { action: 'run' | 'resume' | 'retry' | 'rerun-field' }
>
export type ComparisonResult = z.infer<typeof comparisonResultSchema>
export type ComparisonTable = z.infer<typeof comparisonTableSchema>
export type ComparisonCell = z.infer<typeof comparisonCellSchema>
export type ComparisonAttempt = z.infer<typeof comparisonAttemptSchema>
export type ComparisonField = z.infer<typeof comparisonFieldSchema>

/** Candidates include unread sources that have never produced an extraction attempt. */
export function isUnattemptedComparisonCell(cell: ComparisonCell): boolean {
  return ['pending', 'unavailable'].includes(cell.status) && cell.history.length === 0
}

/** Pending work includes invalidated results, without automatically retrying failures. */
export function isPendingComparisonCell(cell: ComparisonCell): boolean {
  return cell.status === 'pending' || isUnattemptedComparisonCell(cell)
}

/** Shared result semantics for the review surface and exported review flags. */
export function comparisonCellView(
  cell: ComparisonCell,
  field: ComparisonField,
  sourceKey?: string
): {
  attempt: ComparisonAttempt | undefined
  stale: boolean
  value: string
  confirmed: boolean
  needsReview: boolean
  insufficient: boolean
  waiting: boolean
} {
  const attempt = cell.history.at(-1)
  const stale = Boolean(
    attempt &&
    (attempt.fieldVersion !== field.version ||
      (sourceKey !== undefined && attempt.sourceKey !== sourceKey) ||
      cell.status === 'pending' ||
      cell.status === 'running')
  )
  const needsReview = Boolean(
    cell.manual &&
    (cell.manual.fieldVersion !== field.version ||
      (sourceKey !== undefined && cell.manual.sourceKey !== sourceKey) ||
      cell.manual.attemptId !== attempt?.id ||
      cell.status !== 'succeeded')
  )
  return {
    attempt,
    stale,
    value: cell.manual?.value ?? attempt?.value ?? '',
    confirmed: Boolean(
      cell.manual?.confirmed && attempt?.status === 'succeeded' && !stale && !needsReview
    ),
    needsReview,
    insufficient: attempt?.status === 'succeeded' && !attempt.value,
    waiting: cell.status === 'pending' && !attempt
  }
}
