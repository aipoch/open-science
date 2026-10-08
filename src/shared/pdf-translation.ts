import {
  pdfTranslationLayoutSnapshotSchema,
  pdfTranslationSnapshotMatchesSources,
  type PdfTranslationLayoutSnapshot
} from './pdf-translation-snapshot'
import { z } from 'zod'
import { sanitizePdfDocumentSource, type PdfDocumentSource } from './pdf-bookmarks'

// Use the same immutable PDF identity as Notes & Annotations. Paths are display hints,
// never authority to read bytes; main resolves and verifies the referenced version.
export const pdfTranslationDocumentSourceSchema = z.custom<PdfDocumentSource>(
  (value) => sanitizePdfDocumentSource(value) !== undefined
)
export type PdfTranslationCheckpointRequest = string | PdfDocumentSource

export function pdfTranslationSourceKey(source: PdfTranslationCheckpointRequest): string {
  return typeof source === 'string'
    ? JSON.stringify(['literature-attachment-version', source])
    : JSON.stringify([
        source.kind,
        source.projectId ?? null,
        source.sourceFileId,
        source.versionId,
        source.checksum
      ])
}

export type PdfTranslationApiModel = Readonly<{ providerId: string; modelId: string }>
export const pdfTranslationAgentModelSchema = z
  .object({
    frameworkId: z.enum(['claude-code', 'opencode', 'codex', 'codebuddy']),
    providerId: z.string().trim().min(1).max(256),
    modelId: z.string().trim().min(1).max(512).optional(),
    reasoningEffort: z.enum(['default', 'low', 'medium', 'high', 'xhigh', 'max'])
  })
  .strict()
export type PdfTranslationAgentModel = Readonly<z.infer<typeof pdfTranslationAgentModelSchema>>

export const pdfTranslationGlossarySchema = z
  .array(
    z
      .object({
        source: z.string().trim().min(1).max(1000),
        target: z.string().trim().min(1).max(1000)
      })
      .strict()
  )
  .max(1000)
  .superRefine((entries, context) => {
    const sources = new Set<string>()
    for (const [index, entry] of entries.entries()) {
      if (sources.has(entry.source))
        context.addIssue({ code: 'custom', message: 'duplicate-source', path: [index, 'source'] })
      sources.add(entry.source)
    }
    if (JSON.stringify(entries).length > 20000)
      context.addIssue({ code: 'custom', message: 'glossary-too-large' })
  })
export type PdfTranslationGlossary = readonly Readonly<
  z.infer<typeof pdfTranslationGlossarySchema>[number]
>[]

export const formatPdfTranslationGlossary = (entries: PdfTranslationGlossary): string =>
  entries.map(({ source, target }) => `${source} → ${target}`).join('\n')

export type PdfTranslationBeginRequest = Readonly<{
  resourceRequestKey: string
  fingerprint: string
  /** Translation route selected by the reader. Omitted means the historical Agent route. */
  targetId?: 'agent' | 'api' | 'local'
  apiModel?: PdfTranslationApiModel
  agentModel?: PdfTranslationAgentModel
  /** Prefetch adjacent short units; each unit is still validated and saved separately. */
  batchShortSources?: boolean
  /** Maximum simultaneous paragraph requests; omitted preserves serial execution. */
  concurrency?: 1 | 2 | 4
  language: string
  glossary: PdfTranslationGlossary
  sources: readonly string[]
  /** Diagnostic locations only; never authority for reading or replacing PDF content. */
  layoutSnapshot?: PdfTranslationLayoutSnapshot
  sourceLocations?: readonly Readonly<{ pageNumbers: readonly number[]; fragmentCount: number }>[]
  expectedTargetKey?: string
  attachmentVersionId?: string
  documentSource?: PdfDocumentSource
  checkpoint?: PdfTranslationCheckpointReference
}>
export type PdfTranslationRunRequest = Readonly<{
  operationId: string
  sourceIndex: number
  source: string
  replaceExisting?: boolean
}>
// A rejected model answer is recoverable paragraph state, not an IPC failure.
export type PdfTranslationRunResult =
  | string
  | Readonly<{
      failure: 'incomplete-output' | 'cancelled'
      message: string
      diagnostic?: PdfTranslationBlockFailure
    }>
export type PdfTranslationOperationRequest = Readonly<{ operationId: string }>
export type PdfTranslationBeginResult = Readonly<{
  operationId: string
  targetKey: string
  checkpoint?: PdfTranslationCheckpointReference
  model?: PdfTranslationModel
}>

export type PdfTranslationModel = Readonly<{
  frameworkId: string
  providerId?: string
  /** Human-readable name captured when this edition was created. */
  providerName?: string
  modelId?: string
  /** Optional for compatibility with checkpoints created before direct API translation. */
  mode?: 'agent' | 'api' | 'local'
  reasoningEffort?: PdfTranslationAgentModel['reasoningEffort']
}>

/** Metadata only: listing editions must not load every layout snapshot and paragraph. */
export type PdfTranslationEdition = Readonly<{
  id: string
  key: string
  language: string
  glossary: PdfTranslationGlossary
  concurrency: 1 | 2 | 4
  model: PdfTranslationModel
  updatedAt: number
}>
export const pdfTranslationSelectEditionSchema = z
  .object({
    source: z.union([z.string().min(1).max(256), pdfTranslationDocumentSourceSchema]),
    translationId: z.string().min(1).max(256)
  })
  .strict()
export type PdfTranslationSelectEditionRequest = z.infer<typeof pdfTranslationSelectEditionSchema>
export type PdfTranslationFailure =
  | 'model-changed'
  | 'unsupported-model'
  | 'unsupported-language'
  | 'timeout'
  | 'cancelled'
  | 'incomplete-output'
  | 'checkpoint-failed'
  | 'document-busy'
  | 'unknown'

export const pdfTranslationBlockFailureSchema = z
  .object({
    // A saved failure is pending until the reader explicitly finishes/skips its retries.
    disposition: z.enum(['retryable', 'skipped']).optional(),
    reasonCode: z.enum([
      'missing-numeric-literals',
      'unexpected-numeric-literals',
      'changed-numeric-sign',
      'changed-numeric-unit',
      'changed-label-meaning',
      'missing-citation-identities',
      'missing-math-identifiers',
      'missing-proper-name',
      'reordered-inline-math',
      'math-markup',
      'untranslated-output',
      'commentary-output',
      'context-leakage',
      'incomplete-output',
      'timeout',
      'provider-failed',
      'skipped'
    ]),
    pageNumbers: z.array(z.number().int().min(1).max(500)).max(500),
    attempts: z.number().int().nonnegative().max(1000000)
  })
  .strict()
export type PdfTranslationBlockFailure = z.infer<typeof pdfTranslationBlockFailureSchema>

export function isPdfTranslationFailureRetryable(
  failure: PdfTranslationBlockFailure | undefined
): boolean {
  if (failure?.disposition) return failure.disposition === 'retryable'
  // Earlier checkpoints did not distinguish transient failures from skipped paragraphs.
  return failure?.reasonCode === 'timeout' || failure?.reasonCode === 'provider-failed'
}

// Electron preserves Error.message but not custom fields across invoke rejection.
// Only these application-owned markers are shown as actionable failures; provider text stays private.
export class PdfTranslationError extends Error {
  constructor(
    readonly code: Exclude<PdfTranslationFailure, 'unknown'>,
    message: string,
    readonly diagnostic?: PdfTranslationBlockFailure
  ) {
    super(`[pdf-translation:${code}] ${message}`)
  }
}
export function pdfTranslationFailure(error: unknown): PdfTranslationFailure {
  const message = error instanceof Error ? error.message : ''
  for (const code of [
    'model-changed',
    'unsupported-model',
    'unsupported-language',
    'timeout',
    'cancelled',
    'incomplete-output',
    'checkpoint-failed',
    'document-busy'
  ] as const) {
    if (message.includes(`[pdf-translation:${code}]`)) return code
  }
  return 'unknown'
}

const pdfGenerationCodes = [
  'unsupported-layout',
  'annotations',
  'multi-region',
  'font',
  'overflow',
  'source-mismatch',
  'busy',
  'timeout',
  'invalid-input',
  'worker-failed',
  'validation-failed'
] as const
export type PdfGenerationFailure = Readonly<{
  code: (typeof pdfGenerationCodes)[number]
  pageNumber?: number
}>
export function isPdfGenerationFailure(value: unknown): value is PdfGenerationFailure {
  if (!value || typeof value !== 'object') return false
  const { code, pageNumber } = value as PdfGenerationFailure
  return (
    pdfGenerationCodes.includes(code) &&
    (pageNumber === undefined ||
      (Number.isInteger(pageNumber) && pageNumber >= 1 && pageNumber <= 500))
  )
}
// Match the existing Electron error transport: no raw engine error or document text crosses IPC.
export class PdfGenerationError extends Error {
  constructor(readonly failure: PdfGenerationFailure) {
    super(`[pdf-generation:${failure.code}:${failure.pageNumber ?? 0}]`)
  }
}
export function pdfGenerationFailure(error: unknown): PdfGenerationFailure {
  const match =
    error instanceof Error ? error.message.match(/\[pdf-generation:([a-z-]+):(\d+)\]/) : null
  const failure = match
    ? { code: match[1], ...(Number(match[2]) ? { pageNumber: Number(match[2]) } : {}) }
    : undefined
  return isPdfGenerationFailure(failure) ? failure : { code: 'worker-failed' }
}

/** Local rendering input. The main process owns all cache destinations. */
export type PdfTranslationPdfRequest = Readonly<{
  id: string
  /** Keep safely verified source regions when their translations cannot preserve layout. */
  preserveUnsupported?: boolean
  /** Reuse only this saved edition; permission and content checks remain main-owned. */
  cache?: Readonly<{
    source: PdfTranslationCheckpointRequest
    checkpointKey: string
    bypass?: boolean
  }>
  data: Uint8Array
  /** Previously verified complete PDF; only these source pages are replaced. */
  incremental?: Readonly<{ data: Uint8Array; pageNumbers: readonly number[] }>
  pages: readonly Readonly<{ width: number; height: number }>[]
  units: readonly Readonly<{
    source: string
    translation: string
    fragments: readonly Readonly<{
      pageNumber: number
      rect: Readonly<{ x: number; y: number; width: number; height: number }>
    }>[]
  }>[]
}>

export const pdfTranslationLayoutFailureSchema = z
  .object({
    code: z.enum([
      'annotations',
      'overflow',
      'unsupported-layout',
      'source-mismatch',
      'multi-region',
      'font',
      'validation-failed',
      'worker-failed',
      'timeout'
    ]),
    phase: z.enum(['planning', 'ownership', 'glyphs', 'generation', 'verification']),
    pageNumbers: z.array(z.number().int().min(1).max(500)).max(500),
    fragmentCount: z.number().int().min(0).max(10000)
  })
  .strict()
export type PdfTranslationLayoutFailure = z.infer<typeof pdfTranslationLayoutFailureSchema>
export type PdfTranslationPdfResult = Readonly<{
  data: Uint8Array
  /** A generated candidate is published only after renderer verification. */
  cacheToken?: string
  cacheHit?: boolean
  layoutFailures: readonly (PdfTranslationLayoutFailure & { unitIndex: number })[]
}>
export const pdfTranslationLayoutReportSchema = z
  .object({
    sourceIndex: z.number().int().min(0).max(9999),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    translationHash: z.string().regex(/^[a-f0-9]{64}$/),
    generatedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    failure: pdfTranslationLayoutFailureSchema.optional()
  })
  .strict()
export const pdfTranslationRecordLayoutSchema = z
  .object({
    pdfCacheToken: z.string().uuid().optional(),
    source: z.union([z.string().min(1).max(256), pdfTranslationDocumentSourceSchema]),
    checkpointKey: z.string().uuid(),
    generatedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    units: z
      .array(
        z
          .object({
            sourceIndex: z.number().int().min(0).max(9999),
            source: z.string().min(1).max(100000),
            translation: z.string().min(1).max(100000),
            failure: pdfTranslationLayoutFailureSchema.optional()
          })
          .strict()
      )
      .max(10000)
  })
  .strict()
  .refine(
    (value) =>
      value.units.reduce((size, unit) => size + unit.source.length + unit.translation.length, 0) <=
      2_000_000
  )
export type PdfTranslationRecordLayoutRequest = z.infer<typeof pdfTranslationRecordLayoutSchema>

export const pdfTranslationSaveSnapshotSchema = z
  .object({
    source: z.union([z.string().min(1).max(256), pdfTranslationDocumentSourceSchema]),
    checkpointKey: z.string().uuid(),
    snapshot: pdfTranslationLayoutSnapshotSchema
  })
  .strict()
export type PdfTranslationSaveSnapshotRequest = z.infer<typeof pdfTranslationSaveSnapshotSchema>

export type PdfTranslationCheckpointReference = Readonly<{ key: string; revision: number }>
export const pdfTranslationCheckpointSchema = z
  .object({
    version: z.literal(1),
    key: z.string().uuid(),
    revision: z.number().int().nonnegative(),
    attachmentVersionId: z.string().min(1).max(256).optional(),
    documentSource: pdfTranslationDocumentSourceSchema.optional(),
    checksum: z.string().regex(/^[a-f0-9]{64}$/),
    fingerprint: z.string().min(1).max(256),
    language: z.string().trim().min(1).max(80),
    glossary: pdfTranslationGlossarySchema,
    concurrency: z.union([z.literal(1), z.literal(2), z.literal(4)]).optional(),
    targetKey: z.string().regex(/^[a-f0-9]{64}$/),
    model: z.object({
      frameworkId: z.string().min(1).max(80),
      providerId: z.string().min(1).max(256).optional(),
      providerName: z.string().max(512).optional(),
      modelId: z.string().max(512).optional(),
      reasoningEffort: pdfTranslationAgentModelSchema.shape.reasoningEffort.optional(),
      mode: z.enum(['agent', 'api', 'local']).optional()
    }),
    sources: z.array(z.string().min(1).max(100000)).min(1).max(10000),
    translations: z.array(z.string().min(1).max(100000)).max(10000),
    // Explicit indices preserve paragraph identity after parallel completion or skipped blocks.
    translatedSourceIndices: z.array(z.number().int().nonnegative()).max(10000),
    failedSourceIndices: z.array(z.number().int().nonnegative()).max(10000).optional(),
    layoutSnapshot: pdfTranslationLayoutSnapshotSchema.optional(),
    layoutReports: z.array(pdfTranslationLayoutReportSchema).max(10000).optional(),
    failures: z
      .array(
        pdfTranslationBlockFailureSchema.extend({
          sourceIndex: z.number().int().nonnegative().max(9999)
        })
      )
      .max(10000)
      .optional()
  })
  .strict()
  .refine(
    (value) =>
      value.documentSource
        ? value.attachmentVersionId === undefined &&
          value.documentSource.kind !== 'literature-attachment-version' &&
          value.documentSource.checksum === value.checksum
        : value.attachmentVersionId !== undefined,
    { message: 'Translation checkpoint must belong to one immutable PDF source.' }
  )
  .refine(
    (value) =>
      (!value.layoutSnapshot ||
        pdfTranslationSnapshotMatchesSources(
          value.layoutSnapshot,
          value.fingerprint,
          value.sources
        )) &&
      value.translatedSourceIndices.length === value.translations.length &&
      value.translatedSourceIndices.every(
        (index, position, indices) =>
          index < value.sources.length && (position === 0 || index > indices[position - 1])
      ) &&
      (value.failedSourceIndices ?? []).every(
        (index, position, indices) =>
          index < value.sources.length &&
          (position === 0 || index > indices[position - 1]) &&
          !value.translatedSourceIndices.includes(index)
      ) &&
      (value.failures ?? []).every(
        (failure, position, failures) =>
          (value.failedSourceIndices ?? []).includes(failure.sourceIndex) &&
          (position === 0 || failure.sourceIndex > failures[position - 1].sourceIndex)
      ) &&
      value.translations.length <= value.sources.length &&
      value.translations.every((text) => text.trim().length > 0) &&
      JSON.stringify({ ...value, layoutSnapshot: undefined }).length <= 8 * 1024 * 1024
  )
export type PdfTranslationCheckpoint = z.infer<typeof pdfTranslationCheckpointSchema>

export function pdfTranslationCheckpointMatchesSource(
  checkpoint: PdfTranslationCheckpoint,
  source: PdfTranslationCheckpointRequest
): boolean {
  if (typeof source === 'string') return checkpoint.attachmentVersionId === source
  if (source.kind === 'literature-attachment-version')
    return (
      checkpoint.attachmentVersionId === source.versionId && checkpoint.checksum === source.checksum
    )
  return Boolean(
    checkpoint.documentSource &&
    pdfTranslationSourceKey(checkpoint.documentSource) === pdfTranslationSourceKey(source)
  )
}
