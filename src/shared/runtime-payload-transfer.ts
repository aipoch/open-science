import { z } from 'zod'
import { MAX_PERSISTED_SESSION_BYTES } from './session-persistence/errors'

export const RUNTIME_PAYLOAD_CAPABILITY = 'bounded-payload-v1' as const
export const RUNTIME_PAYLOAD_PAGE_BYTES = 1024 * 1024
export const RUNTIME_PAYLOAD_INLINE_BYTES = 8 * 1024 * 1024
// A decoded Session includes both its canonical graph and the active-message projection.
export const MAX_RUNTIME_PAYLOAD_BYTES = 2 * MAX_PERSISTED_SESSION_BYTES
export const RUNTIME_PAYLOAD_UPLOAD_CHANNELS = new Set([
  'sessions:save-session',
  'sessions:update-configuration'
])
export const RUNTIME_PAYLOAD_CHANNELS = new Set([
  'sessions:load-one',
  'sessions:save-session',
  'sessions:update-configuration',
  'sessions:edit-details',
  'sessions:set-delegation-policy',
  'sessions:update-archive',
  'notebook:state'
])

const snapshotId = z.string().uuid()
const offset = z.number().int().nonnegative().max(MAX_RUNTIME_PAYLOAD_BYTES)
export const runtimePayloadRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('read'), snapshotId, offset }).strict(),
  z.object({ kind: z.literal('release'), snapshotId }).strict(),
  z.object({ kind: z.literal('upload'), byteLength: offset.positive() }).strict(),
  z
    .object({ kind: z.literal('append'), snapshotId, offset, data: z.string().max(1_398_104) })
    .strict(),
  z.object({ kind: z.literal('commit'), snapshotId }).strict()
])
export type RuntimePayloadRequest = z.infer<typeof runtimePayloadRequestSchema>
export type RuntimePayloadOptions = { acceptPayload?: 1; transfer?: RuntimePayloadRequest }
export const runtimePayloadDescriptorSchema = z
  .object({
    $payload: z.object({ snapshotId, byteLength: offset.positive() }).strict()
  })
  .strict()
export type RuntimePayloadDescriptor = z.infer<typeof runtimePayloadDescriptorSchema>
export const runtimePayloadPageSchema = z
  .object({
    snapshotId,
    offset,
    nextOffset: offset,
    data: z.string().max(1_398_104)
  })
  .strict()
