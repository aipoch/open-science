import { z } from 'zod'
import { AGENT_FRAMEWORK_ID_VALUES } from './agent-framework-id'
import {
  pdfTranslationAgentModelSchema as packageAgentModelSchema,
  type PdfTranslationBeginRequest as PackageBeginRequest
} from '@aipoch/pdf-translation/contracts'

// Application-supported frameworks are host policy. The standalone package accepts adapter IDs.
export const pdfTranslationAgentModelSchema = packageAgentModelSchema.extend({
  frameworkId: z.enum(AGENT_FRAMEWORK_ID_VALUES)
})
export type PdfTranslationAgentModel = Readonly<z.infer<typeof pdfTranslationAgentModelSchema>>
export type PdfTranslationBeginRequest = Omit<PackageBeginRequest, 'agentModel' | 'sourceId'> & {
  readonly attachmentVersionId?: string
  readonly documentSource?: PdfDocumentSource
  readonly agentModel?: PdfTranslationAgentModel
}

import {
  pdfTranslationCheckpointSchema as packageCheckpointSchema,
  pdfTranslationRecordLayoutSchema as packageRecordLayoutSchema,
  pdfTranslationSaveSnapshotSchema as packageSaveSnapshotSchema,
  pdfTranslationSelectEditionSchema as packageSelectEditionSchema,
  type PdfTranslationCheckpoint as PackageCheckpoint,
  type PdfTranslationPdfRequest as PackagePdfRequest
} from '@aipoch/pdf-translation/contracts'
import { sanitizePdfDocumentSource, type PdfDocumentSource } from './pdf-document-source'

export const pdfTranslationDocumentSourceSchema = z.custom<PdfDocumentSource>(
  (value) => sanitizePdfDocumentSource(value) !== undefined
)
export type PdfTranslationCheckpointRequest = string | PdfDocumentSource
export const pdfTranslationCheckpointRequestSchema = z.union([
  z.string().min(1).max(256),
  pdfTranslationDocumentSourceSchema
])
/** Encode an application source as an opaque package ID; paths remain display hints. */
export function toTranslationSourceId(source: PdfTranslationCheckpointRequest): string {
  return JSON.stringify(typeof source === 'string' ? ['attachment', source] : ['document', source])
}
export function fromTranslationSourceId(id: string): PdfTranslationCheckpointRequest {
  const value: unknown = JSON.parse(id)
  if (!Array.isArray(value) || value.length !== 2) throw new Error('Invalid PDF source identity.')
  if (value[0] === 'attachment') return z.string().min(1).max(256).parse(value[1])
  if (value[0] === 'document') return pdfTranslationDocumentSourceSchema.parse(value[1])
  throw new Error('Invalid PDF source identity.')
}
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
export function translationSourceReservationKey(id: string): string {
  const source = fromTranslationSourceId(id)
  return pdfTranslationSourceKey(
    typeof source !== 'string' && source.kind === 'literature-attachment-version'
      ? source.versionId
      : source
  )
}
export type PdfTranslationCheckpoint = Omit<PackageCheckpoint, 'sourceId'> & {
  attachmentVersionId?: string
  documentSource?: PdfDocumentSource
}
const hostCheckpoints = new WeakMap<PackageCheckpoint, PdfTranslationCheckpoint>()
const packageCheckpoints = new WeakMap<PdfTranslationCheckpoint, PackageCheckpoint>()
export function toPackageCheckpoint(checkpoint: PdfTranslationCheckpoint): PackageCheckpoint {
  const cached = packageCheckpoints.get(checkpoint)
  if (cached && Object.isFrozen(checkpoint)) return cached
  const { attachmentVersionId, documentSource, ...value } = checkpoint
  const source = documentSource ?? attachmentVersionId
  if (!source) throw new Error('Translation checkpoint has no source.')
  const next = { ...value, sourceId: toTranslationSourceId(source) }
  // Preserve the storage owner's reference while reflecting edits to a mutable admission snapshot.
  const result = cached ?? next
  if (cached) {
    for (const key of Object.keys(cached)) if (!(key in next)) Reflect.deleteProperty(cached, key)
    Object.assign(cached, next)
  }
  packageCheckpoints.set(checkpoint, result)
  hostCheckpoints.set(result, checkpoint)
  return result
}
export function fromPackageCheckpoint(checkpoint: PackageCheckpoint): PdfTranslationCheckpoint {
  const cached = hostCheckpoints.get(checkpoint)
  if (cached) return cached
  const { sourceId, ...value } = checkpoint
  const source = fromTranslationSourceId(sourceId)
  const result = {
    ...value,
    ...(typeof source === 'string' ? { attachmentVersionId: source } : { documentSource: source })
  }
  hostCheckpoints.set(checkpoint, result)
  packageCheckpoints.set(result, checkpoint)
  // Only freeze the projection if its package snapshot is immutable too.
  return Object.isFrozen(checkpoint) ? Object.freeze(result) : result
}
export function toPackageBegin(input: PdfTranslationBeginRequest): PackageBeginRequest {
  const { attachmentVersionId, documentSource, ...value } = input
  if (attachmentVersionId !== undefined && documentSource !== undefined)
    throw new Error('Invalid PDF translation source.')
  const source = documentSource ?? attachmentVersionId
  if (source !== undefined && !pdfTranslationCheckpointRequestSchema.safeParse(source).success)
    throw new Error('Invalid PDF translation source.')
  return { ...value, ...(source === undefined ? {} : { sourceId: toTranslationSourceId(source) }) }
}
export function fromPackageBegin(input: PackageBeginRequest): PdfTranslationBeginRequest {
  const { sourceId, agentModel, ...value } = input
  const source = sourceId === undefined ? undefined : fromTranslationSourceId(sourceId)
  return {
    ...value,
    ...(agentModel ? { agentModel: pdfTranslationAgentModelSchema.parse(agentModel) } : {}),
    ...(source === undefined
      ? {}
      : typeof source === 'string'
        ? { attachmentVersionId: source }
        : { documentSource: source })
  }
}
const { sourceId, ...checkpointFields } = packageCheckpointSchema.shape
void sourceId
export const pdfTranslationCheckpointSchema = z
  .object({
    ...checkpointFields,
    attachmentVersionId: z.string().min(1).max(256).optional(),
    documentSource: pdfTranslationDocumentSourceSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.documentSource
        ? value.attachmentVersionId !== undefined ||
          value.documentSource.kind === 'literature-attachment-version' ||
          value.documentSource.checksum !== value.checksum
        : value.attachmentVersionId === undefined
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Translation checkpoint must belong to one immutable PDF source.'
      })
      return
    }
    const parsed = packageCheckpointSchema.safeParse(toPackageCheckpoint(value))
    if (!parsed.success)
      for (const issue of parsed.error.issues)
        context.addIssue({ code: 'custom', path: issue.path, message: issue.message })
  })
export const pdfTranslationRecordLayoutSchema = z
  .object({ ...packageRecordLayoutSchema.shape, source: pdfTranslationCheckpointRequestSchema })
  .strict()
  .refine(
    (value) =>
      packageRecordLayoutSchema.safeParse({ ...value, source: toTranslationSourceId(value.source) })
        .success
  )
export const pdfTranslationSaveSnapshotSchema = packageSaveSnapshotSchema.extend({
  source: pdfTranslationCheckpointRequestSchema
})
export const pdfTranslationSelectEditionSchema = packageSelectEditionSchema.extend({
  source: pdfTranslationCheckpointRequestSchema
})
export type PdfTranslationRecordLayoutRequest = z.infer<typeof pdfTranslationRecordLayoutSchema>
export type PdfTranslationSaveSnapshotRequest = z.infer<typeof pdfTranslationSaveSnapshotSchema>
export type PdfTranslationSelectEditionRequest = z.infer<typeof pdfTranslationSelectEditionSchema>
export type PdfTranslationPdfRequest = Omit<PackagePdfRequest, 'cache'> & {
  cache?: Readonly<{
    source: PdfTranslationCheckpointRequest
    checkpointKey: string
    bypass?: boolean
  }>
}
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
