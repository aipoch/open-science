import { z } from 'zod'
import {
  browserRecordingEventSchema,
  browserRecordingGapSchema
} from '../../shared/browser-recording'

const id = z.string().uuid()
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const origin = z
  .string()
  .max(512)
  .url()
  .refine((value) => {
    const url = new URL(value)
    return (
      url.origin === value &&
      url.protocol === 'http:' &&
      !!url.port &&
      /^(viewer|rv)-[a-zA-Z0-9-]+\.localhost$/.test(url.hostname)
    )
  })
const surface = { viewerOrigin: origin, projectOrigin: origin }
export const observationNativeRequestSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('register-viewer'), origin, expiresAt: time }).strict(),
  z
    .object({
      method: z.literal('register-runtime'),
      origin,
      parents: z.array(origin).min(1).max(8),
      expiresAt: time,
      excludedPath: z.string().startsWith('/').max(4096)
    })
    .strict(),
  z
    .object({
      method: z.literal('grant'),
      registrationId: id,
      url: z.string().url().max(4096),
      expiresAt: time
    })
    .strict(),
  z
    .object({
      method: z.literal('authenticate'),
      registrationId: id,
      grant: z.string().regex(/^[a-f0-9]{64}$/)
    })
    .strict(),
  z.object({ method: z.literal('unregister'), registrationId: id }).strict(),
  z.object({ method: z.literal('capture'), ...surface }).strict(),
  z.object({ method: z.literal('record-start'), ...surface }).strict(),
  z.object({ method: z.literal('record-poll'), recordingId: id, ack: time }).strict(),
  z
    .object({
      method: z.literal('record-control'),
      recordingId: id,
      action: z.enum(['pause', 'resume', 'stop', 'release'])
    })
    .strict()
])
export type ObservationNativeRequest = z.infer<typeof observationNativeRequestSchema>
export type ObservationNativeInvoke = (
  operation: { operation: 'observation'; request: ObservationNativeRequest },
  clientId: string,
  signal?: AbortSignal
) => Promise<unknown>
// Only finalized WebM segments cross processes. Raw compositor pixels stay inside Electron.
export const MAX_NATIVE_SEGMENT_BYTES = 8 * 1024 * 1024
const bytes = z
  .instanceof(Uint8Array)
  .refine((value) => value.byteLength > 0 && value.byteLength <= MAX_NATIVE_SEGMENT_BYTES)
export const observationSegmentSchema = z
  .object({
    bytes,
    startMs: time,
    endMs: time,
    width: z.number().int().positive().max(1920),
    height: z.number().int().positive().max(1080),
    codec: z.literal('vp8'),
    frameRate: z.number().int().positive().max(30)
  })
  .strict()
  .refine((value) => value.endMs >= value.startMs && value.width * value.height <= 2_073_600)
export const observationPacketSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('segment'),
      sequence: time.positive(),
      value: observationSegmentSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal('event'),
      sequence: time.positive(),
      value: browserRecordingEventSchema.omit({ eventId: true })
    })
    .strict(),
  z
    .object({ kind: z.literal('gap'), sequence: time.positive(), value: browserRecordingGapSchema })
    .strict(),
  z.object({ kind: z.literal('started'), sequence: time.positive(), value: time }).strict(),
  z.object({ kind: z.literal('dropped'), sequence: time.positive(), value: time }).strict(),
  z
    .object({
      kind: z.literal('ended'),
      sequence: time.positive(),
      value: z.enum(['source-lost', 'capture-failed', 'interrupted'])
    })
    .strict()
])
export type ObservationPacket = z.infer<typeof observationPacketSchema>
export const observationBatchSchema = z
  .object({ packets: z.array(observationPacketSchema).max(64), stopped: z.boolean() })
  .strict()
export function parseObservationNativeResult(
  request: ObservationNativeRequest,
  result: unknown
): unknown {
  switch (request.method) {
    case 'register-viewer':
    case 'register-runtime':
    case 'record-start':
      return id.parse(result)
    case 'capture':
      return z.object({ bytes }).strict().parse(result)
    case 'record-poll': {
      const batch = observationBatchSchema.parse(result)
      if (batch.packets.filter((packet) => packet.kind === 'segment').length > 1)
        throw new Error('Too many native recording segments.')
      return batch
    }
    default:
      return z.null().parse(result)
  }
}
