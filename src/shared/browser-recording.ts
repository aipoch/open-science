import { z } from 'zod'

/** Ordinary optional Artifact content; this is not a .science container extension. */
export const MAX_BROWSER_RECORDING_INDEX_BYTES = 4 * 1024 * 1024
export const MAX_BROWSER_RECORDING_SEGMENT_BYTES = 16 * 1024 * 1024
export const MAX_BROWSER_RECORDING_ITEMS = 2000
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/)
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const browserRecordingTargetSchema = z
  .object({
    projectId: id,
    sessionId: id,
    artifactId: id,
    versionId: id
  })
  .strict()
export type BrowserRecordingTarget = z.infer<typeof browserRecordingTargetSchema>
export const browserRecordingMediaSchema = z
  .object({
    mediaKey: id,
    name: z.string().min(1).max(512),
    mimeType: z.literal('video/webm'),
    checksum: digest,
    sizeBytes: time.positive().max(MAX_BROWSER_RECORDING_SEGMENT_BYTES),
    sourceVersionId: id
  })
  .strict()
export const browserRecordingSegmentSchema = z
  .object({
    segmentId: id,
    mediaKey: id,
    startMs: time,
    endMs: time,
    width: z.number().int().positive().max(8192),
    height: z.number().int().positive().max(8192),
    codec: z.enum(['vp8', 'vp9']),
    frameRate: z.number().positive().max(60)
  })
  .strict()
export const browserRecordingEventSchema = z
  .object({
    eventId: id,
    offsetMs: time,
    kind: z.enum(['click', 'scroll', 'navigation', 'resize', 'visibility', 'author']),
    source: z.enum(['host-observed', 'browser-observed', 'author-declared']),
    label: z.string().min(1).max(256).optional(),
    x: z.number().finite().optional(),
    y: z.number().finite().optional()
  })
  .strict()
export const browserRecordingGapSchema = z
  .object({
    startMs: time,
    endMs: time,
    reason: z.enum(['paused', 'hidden', 'source-lost', 'capture-failed', 'capacity', 'interrupted'])
  })
  .strict()
export const browserRecordingSchema = z
  .object({
    format: z.literal('open-science-web-recording'),
    version: z.literal(1),
    recordingId: id,
    title: z.string().min(1).max(512).optional(),
    startedAt: time,
    durationMs: time,
    source: z
      .object({
        projectId: id.optional(),
        sessionId: id.optional(),
        operationId: id.optional(),
        executionInvocationId: id.optional(),
        runId: id.optional()
      })
      .strict()
      .optional(),
    media: z.array(browserRecordingMediaSchema).max(MAX_BROWSER_RECORDING_ITEMS),
    segments: z.array(browserRecordingSegmentSchema).max(MAX_BROWSER_RECORDING_ITEMS),
    events: z.array(browserRecordingEventSchema).max(MAX_BROWSER_RECORDING_ITEMS),
    coverage: z
      .object({
        stopReason: z.enum(['finished', 'stopped', 'interrupted', 'capacity', 'capture-failed']),
        gaps: z.array(browserRecordingGapSchema).max(MAX_BROWSER_RECORDING_ITEMS),
        droppedFrames: time
      })
      .strict()
  })
  .strict()
  .superRefine((value, context) => {
    const fail = (): void => {
      context.addIssue({ code: 'custom', message: 'Inconsistent browser recording evidence.' })
    }
    const media = new Map(value.media.map((item) => [item.mediaKey, item]))
    if (media.size !== value.media.length) fail()
    const segments = new Set<string>()
    const usedMedia = new Set<string>()
    let endMs = 0
    for (const segment of value.segments) {
      if (
        segments.has(segment.segmentId) ||
        usedMedia.has(segment.mediaKey) ||
        !media.has(segment.mediaKey) ||
        segment.endMs <= segment.startMs ||
        segment.startMs < endMs ||
        segment.endMs > value.durationMs ||
        segment.width * segment.height > 16_000_000
      )
        fail()
      segments.add(segment.segmentId)
      usedMedia.add(segment.mediaKey)
      endMs = segment.endMs
    }
    if (usedMedia.size !== media.size) fail()
    const events = new Set<string>()
    let eventTime = 0
    for (const event of value.events) {
      if (
        events.has(event.eventId) ||
        event.offsetMs < eventTime ||
        event.offsetMs > value.durationMs ||
        (event.source === 'author-declared') !== (event.kind === 'author')
      )
        fail()
      events.add(event.eventId)
      eventTime = event.offsetMs
    }
    let gapEnd = 0
    for (const gap of value.coverage.gaps) {
      if (
        gap.endMs <= gap.startMs ||
        gap.startMs < gapEnd ||
        gap.endMs > value.durationMs ||
        value.segments.some((segment) => gap.startMs < segment.endMs && gap.endMs > segment.startMs)
      )
        fail()
      gapEnd = gap.endMs
    }
  })
export type BrowserRecording = z.infer<typeof browserRecordingSchema>
export type BrowserRecordingSegment = z.infer<typeof browserRecordingSegmentSchema>
export type BrowserRecordingEvent = z.infer<typeof browserRecordingEventSchema>
export function validateBrowserRecording(value: unknown): BrowserRecording {
  const result = browserRecordingSchema.parse(value)
  if (
    new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_BROWSER_RECORDING_INDEX_BYTES
  )
    throw new Error('Browser recording exceeds its content limit.')
  return result
}
export function parseBrowserRecording(content: string): BrowserRecording {
  if (
    content.length > MAX_BROWSER_RECORDING_INDEX_BYTES ||
    new TextEncoder().encode(content).byteLength > MAX_BROWSER_RECORDING_INDEX_BYTES
  )
    throw new Error('Browser recording exceeds its content limit.')
  return validateBrowserRecording(JSON.parse(content))
}
export const resolvedBrowserRecordingMediaSchema = z
  .object({
    mediaKey: id,
    artifactId: id,
    versionId: id,
    checksum: digest,
    sizeBytes: time.positive().max(MAX_BROWSER_RECORDING_SEGMENT_BYTES)
  })
  .strict()
export const recordedBrowserPayloadSchema = z
  .object({
    receiving: browserRecordingTargetSchema,
    recording: z.unknown().transform((value, context) => {
      try {
        return validateBrowserRecording(value)
      } catch {
        context.addIssue({ code: 'custom', message: 'Invalid browser recording.' })
        return z.NEVER
      }
    }),
    indexChecksum: digest,
    media: z.array(resolvedBrowserRecordingMediaSchema).max(MAX_BROWSER_RECORDING_ITEMS)
  })
  .strict()
export type RecordedBrowserPayload = z.infer<typeof recordedBrowserPayloadSchema>
export const browserRecordingMomentSchema = z
  .object({
    kind: z.literal('recorded-project-moment'),
    selectionId: id,
    selectedAt: time,
    receiving: browserRecordingTargetSchema,
    indexChecksum: digest,
    recordingId: id,
    offsetMs: time,
    segmentId: id,
    mediaKey: id,
    segmentOffsetMs: time,
    resource: browserRecordingTargetSchema
      .extend({
        name: z.string().min(1).max(512),
        mimeType: z.literal('video/webm'),
        checksum: digest,
        sizeBytes: time.positive().max(MAX_BROWSER_RECORDING_SEGMENT_BYTES)
      })
      .strict()
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.receiving.projectId !== value.resource.projectId ||
      value.receiving.sessionId !== value.resource.sessionId ||
      value.segmentOffsetMs > value.offsetMs
    )
      context.addIssue({ code: 'custom', message: 'Invalid browser recording moment scope.' })
  })
export type BrowserRecordingMoment = z.infer<typeof browserRecordingMomentSchema>
export const browserRecordingStatusSchema = z
  .object({
    recordingId: id.optional(),
    state: z.enum([
      'idle',
      'starting',
      'recording',
      'paused',
      'finalizing',
      'finalized',
      'partial',
      'failed'
    ]),
    elapsedMs: time,
    segments: time,
    bytes: time,
    droppedFrames: time,
    target: browserRecordingTargetSchema.optional(),
    error: z.enum(['unavailable', 'capture-failed', 'publication-failed', 'capacity']).optional()
  })
  .strict()
export type BrowserRecordingStatus = z.infer<typeof browserRecordingStatusSchema>
export const browserRecordingInspectionSchema = z
  .object({
    supported: z.boolean(),
    reason: z
      .enum(['desktop-required', 'source-unavailable', 'not-authorized', 'surface-unavailable'])
      .optional(),
    active: browserRecordingStatusSchema.optional(),
    sources: z
      .array(z.object({ sourceViewId: id, label: z.literal('Desktop project page') }).strict())
      .max(128)
      .optional()
  })
  .strict()
export type BrowserRecordingInspection = z.infer<typeof browserRecordingInspectionSchema>
export const browserRecordingControlRequestSchema = z
  .object({
    requestId: id,
    recordingId: id.optional(),
    sourceViewId: id.optional()
  })
  .strict()
export type BrowserRecordingControlRequest = z.infer<typeof browserRecordingControlRequestSchema>
export const browserRecordingMethodSchema = z.enum([
  'inspect',
  'start',
  'status',
  'pause',
  'resume',
  'stop'
])
export type BrowserRecordingMethod = z.infer<typeof browserRecordingMethodSchema>
