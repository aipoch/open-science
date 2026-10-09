import { z } from 'zod'
import {
  runObservationExecutionContextSchema,
  type RunObservationExecutionContext
} from './run-observation'
import {
  validateRunObservationArchive,
  type RunObservationArchive
} from './run-observation-archive'
import { validateProjectRecording, type ProjectRecording } from './project-recording'
import { recordedBrowserPayloadSchema, type RecordedBrowserPayload } from './browser-recording'

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/)
export const recordedEvidenceFormatSchema = z.enum([
  'run-observation',
  'project-recording',
  'web-recording'
])
export type RecordedEvidenceFormat = z.infer<typeof recordedEvidenceFormatSchema>
/** Receiving Artifact identity, never an author-machine Run or service locator. */
export const recordedObservationTargetSchema = z
  .object({ projectId: id, sessionId: id, artifactId: id, versionId: id })
  .strict()
export type RecordedObservationTarget = z.infer<typeof recordedObservationTargetSchema>
export type RecordedObservationReceivingScope = RecordedObservationTarget
export const resolvedObservationMediaSchema = z
  .object({
    mediaKey: id,
    artifactId: id,
    versionId: id,
    checksum: z.string().regex(/^[a-f0-9]{64}$/),
    sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
  })
  .strict()
export type ResolvedObservationMedia = z.infer<typeof resolvedObservationMediaSchema>
export type RecordedObservationPayload = Readonly<{
  receiving: RecordedObservationTarget
  archive: RunObservationArchive
  media: readonly ResolvedObservationMedia[]
  executionContext?: RunObservationExecutionContext
}>
export type RecordedProjectPayload = Readonly<{
  receiving: RecordedObservationTarget
  recording: ProjectRecording
  media: readonly ResolvedObservationMedia[]
}>
export type RecordedEvidencePayload =
  RecordedObservationPayload | RecordedProjectPayload | RecordedBrowserPayload
export const recordedFileRequestSchema = z
  .object({
    target: recordedObservationTargetSchema,
    mediaKey: id,
    format: z.enum(['run-observation', 'project-recording']).default('run-observation')
  })
  .strict()
export type RecordedFileRequest = z.input<typeof recordedFileRequestSchema>

/** Exact receiving Version evidence. Selecting a file never invents an observation or Run. */
export const recordedFileSelectionSchema = z
  .object({
    kind: z.literal('recorded-observation-file'),
    selectionId: id.optional(),
    selectedAt: z.number().int().nonnegative().optional(),
    source: z.enum(['run-observation', 'project-recording']),
    recordingId: id,
    receiving: recordedObservationTargetSchema,
    mediaKey: id,
    resource: recordedObservationTargetSchema
      .extend({
        name: z.string().min(1).max(512),
        mimeType: z.string().min(1).max(128),
        checksum: z.string().regex(/^[a-f0-9]{64}$/),
        sizeBytes: z
          .number()
          .int()
          .nonnegative()
          .max(16 * 1024 * 1024)
      })
      .strict(),
    scope: z.enum(['step', 'recording']),
    stepKeys: z.array(id).max(2000),
    stage: z.enum(['unspecified', 'intermediate', 'final']),
    executionContext: runObservationExecutionContextSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.scope === 'step') !== value.stepKeys.length > 0 ||
      new Set(value.stepKeys).size !== value.stepKeys.length ||
      value.resource.projectId !== value.receiving.projectId ||
      value.resource.sessionId !== value.receiving.sessionId ||
      (value.source === 'project-recording' && value.stepKeys.length > 0)
    )
      context.addIssue({
        code: 'custom',
        message: 'Recorded file scope does not match its source.'
      })
  })
export type RecordedObservationFileSelection = z.infer<typeof recordedFileSelectionSchema>

export function recordedFileSelectionForPayload(
  payload: RecordedObservationPayload | RecordedProjectPayload,
  mediaKey: string
): RecordedObservationFileSelection {
  const source = 'archive' in payload ? payload.archive : payload.recording
  const declarations = source.media.filter((item) => item.mediaKey === mediaKey)
  const resolutions = payload.media.filter((item) => item.mediaKey === mediaKey)
  if (declarations.length !== 1 || resolutions.length !== 1)
    throw new Error('The recorded file is unavailable.')
  const declared = declarations[0]
  const resolved = resolvedObservationMediaSchema.parse(resolutions[0])
  if (
    !declared ||
    !resolved ||
    declared.checksum !== resolved.checksum ||
    declared.sizeBytes !== resolved.sizeBytes
  )
    throw new Error('The recorded file is unavailable.')
  const stepKeys = 'stepKeys' in declared ? [...new Set(declared.stepKeys)] : []
  return recordedFileSelectionSchema.parse({
    kind: 'recorded-observation-file',
    source: 'archive' in payload ? 'run-observation' : 'project-recording',
    receiving: payload.receiving,
    recordingId: source.recordingId,
    mediaKey,
    resource: {
      projectId: payload.receiving.projectId,
      sessionId: payload.receiving.sessionId,
      artifactId: resolved.artifactId,
      versionId: resolved.versionId,
      name: declared.name,
      mimeType: declared.mimeType,
      checksum: declared.checksum,
      sizeBytes: declared.sizeBytes
    },
    scope: stepKeys.length ? 'step' : 'recording',
    stepKeys,
    // Neither existing content format declares a result stage. Terminal does not mean final.
    stage: 'unspecified',
    ...('executionContext' in payload ? { executionContext: payload.executionContext } : {})
  })
}
export type RecordedRunObservationSelection = Readonly<{
  kind: 'recorded-run-observation'
  /** Present on a server-captured selection; identifies each explicit Ask action. */
  selectionId?: string
  selectedAt?: number
  recordingId: string
  receiving: RecordedObservationTarget
  stepKey: string
  record: RunObservationArchive['records'][number]
  mediaKeys: readonly string[]
  /** Main-captured collection context at this selection's evidence cutoff. */
  executionContext?: RunObservationExecutionContext
}>

export const recordedObservationPayloadSchema = z
  .object({
    receiving: recordedObservationTargetSchema,
    archive: z.unknown().transform((value, context) => {
      try {
        return validateRunObservationArchive(value)
      } catch {
        context.addIssue({ code: 'custom', message: 'Invalid recorded observation archive.' })
        return z.NEVER
      }
    }),
    media: z.array(resolvedObservationMediaSchema).max(2000),
    executionContext: runObservationExecutionContextSchema.optional()
  })
  .strict()
export const recordedProjectPayloadSchema = z
  .object({
    receiving: recordedObservationTargetSchema,
    recording: z.unknown().transform((value, context) => {
      try {
        return validateProjectRecording(value)
      } catch {
        context.addIssue({ code: 'custom', message: 'Invalid project recording.' })
        return z.NEVER
      }
    }),
    media: z.array(resolvedObservationMediaSchema).max(2000)
  })
  .strict()
export const recordedEvidencePayloadSchema = z.union([
  recordedObservationPayloadSchema,
  recordedProjectPayloadSchema,
  recordedBrowserPayloadSchema
])
