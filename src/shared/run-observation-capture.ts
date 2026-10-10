import { z } from 'zod'
import { runObservationMediaCaptureSchema } from './run-observation-archive'
import { runObservationCursorSchema } from './run-observation'

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/)
const exportKey = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !/[\\/]/.test(value) &&
      ![...value].some((character) => character.charCodeAt(0) < 32) &&
      value !== '.' &&
      value !== '..'
  )

/** Public requests select a declared capability, never a path, frame, URL or historical step. */
export const observationMediaCaptureRequestSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('host-view'), idempotencyKey: id }).strict(),
  z.object({ source: z.literal('project-export'), exportKey, idempotencyKey: id }).strict()
])
export type ObservationMediaCaptureRequest = z.infer<typeof observationMediaCaptureRequestSchema>

export const observationMediaCaptureOptionsSchema = z
  .object({ hostView: z.boolean(), projectExports: z.array(exportKey).max(100) })
  .strict()
export type ObservationMediaCaptureOptions = z.infer<typeof observationMediaCaptureOptionsSchema>

export const observationMediaCaptureResultSchema = z
  .object({
    captureId: id,
    recordingId: id,
    stepKey: id,
    artifactId: id,
    versionId: id,
    checksum: z.string().regex(/^[a-f0-9]{64}$/),
    sizeBytes: z
      .number()
      .int()
      .positive()
      .max(16 * 1024 * 1024),
    mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
    publication: z.enum(['published', 'awaiting-publication']),
    capture: runObservationMediaCaptureSchema
  })
  .strict()
export type ObservationMediaCaptureResult = z.infer<typeof observationMediaCaptureResultSchema>

/** Optional explicit association minted by the viewer that actually initiated this capture. */
export const observationViewerCaptureSchema = observationMediaCaptureResultSchema.extend({
  viewerEvidence: z
    .object({
      cursor: runObservationCursorSchema,
      observedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      stepId: z.string().min(1).max(256)
    })
    .strict()
    .optional()
})
export type ObservationViewerCapture = z.infer<typeof observationViewerCaptureSchema>

export const MAX_OBSERVATION_CAPTURE_CHUNK_BYTES = 1024 * 1024
export const observationCapturesRequestSchema = z.object({ viewerId: z.string().uuid() }).strict()
export type ObservationCapturesRequest = z.infer<typeof observationCapturesRequestSchema>
export const observationCapturesSchema = z.array(observationViewerCaptureSchema).max(2000)
export type ObservationCaptures = z.infer<typeof observationCapturesSchema>

/** A Main/viewer-owned capture identifier, never a local path or arbitrary remote URL. */
export const observationCaptureContentRequestSchema = z
  .object({
    captureId: id,
    offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    length: z.number().int().min(1).max(MAX_OBSERVATION_CAPTURE_CHUNK_BYTES).optional()
  })
  .strict()
export type ObservationCaptureContentRequest = z.infer<
  typeof observationCaptureContentRequestSchema
>
export const observationViewerCaptureContentRequestSchema = observationCaptureContentRequestSchema
  .extend({ viewerId: z.string().uuid() })
  .strict()
export type ObservationViewerCaptureContentRequest = z.infer<
  typeof observationViewerCaptureContentRequestSchema
>

const base64Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const decodedLength = (value: string): number =>
  (value.length / 4) * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0)
export const observationCaptureContentSchema = z
  .object({
    captureId: id,
    mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
    /** SHA-256 and size of the entire captured image, shared by every chunk. */
    checksum: z.string().regex(/^[a-f0-9]{64}$/),
    sizeBytes: z
      .number()
      .int()
      .positive()
      .max(16 * 1024 * 1024),
    offset: z
      .number()
      .int()
      .nonnegative()
      .max(16 * 1024 * 1024),
    dataBase64: z
      .string()
      .max(4 * Math.ceil(MAX_OBSERVATION_CAPTURE_CHUNK_BYTES / 3))
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
      .refine((value) =>
        value.endsWith('==')
          ? (base64Alphabet.indexOf(value.at(-3)!) & 15) === 0
          : !value.endsWith('=') || (base64Alphabet.indexOf(value.at(-2)!) & 3) === 0
      ),
    nextOffset: z
      .number()
      .int()
      .positive()
      .max(16 * 1024 * 1024)
      .optional()
  })
  .strict()
  .refine((value) => {
    const length = decodedLength(value.dataBase64)
    const end = value.offset + length
    return (
      length <= MAX_OBSERVATION_CAPTURE_CHUNK_BYTES &&
      end <= value.sizeBytes &&
      (length > 0 || value.offset === value.sizeBytes) &&
      (end < value.sizeBytes ? value.nextOffset === end : value.nextOffset === undefined)
    )
  })
export type ObservationCaptureContent = z.infer<typeof observationCaptureContentSchema>
