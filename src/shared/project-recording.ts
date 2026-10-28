import { z } from 'zod'
import {
  validateRunObservationArchive,
  type RunObservationArchive
} from './run-observation-archive'

// Optional, ordinary Artifact content. This does not extend the .science container or the
// existing run-observation archive. Source identities describe evidence, never local authority.
export const MAX_PROJECT_RECORDING_BYTES = 4 * 1024 * 1024
export const MAX_PROJECT_RECORDING_ITEMS = 2000
export const MAX_PROJECT_RECORDING_VALUE_BYTES = 64 * 1024
export const MAX_PROJECT_RECORDING_MEDIA_BYTES = 16 * 1024 * 1024
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/)
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const count = time
const digest = z.string().regex(/^[a-f0-9]{64}$/)

export type ProjectRecordingValue =
  | null
  | boolean
  | number
  | string
  | ProjectRecordingValue[]
  | { [key: string]: ProjectRecordingValue }

/** Bounded declarative JSON only; no programs, expressions, prototype objects or cycles. */
export function isProjectRecordingValue(input: unknown): input is ProjectRecordingValue {
  let nodes = 0
  const seen = new Set<object>()
  const visit = (value: unknown, depth: number): boolean => {
    if (++nodes > 4096 || depth > 16) return false
    if (value === null || typeof value === 'boolean') return true
    if (typeof value === 'number') return Number.isFinite(value)
    if (typeof value === 'string') return value.length <= MAX_PROJECT_RECORDING_VALUE_BYTES
    if (typeof value !== 'object' || seen.has(value)) return false
    seen.add(value)
    if (Array.isArray(value)) return value.every((entry) => visit(entry, depth + 1))
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false
    return Object.entries(value).every(
      ([key, entry]) =>
        key.length <= 256 &&
        !['__proto__', 'prototype', 'constructor'].includes(key) &&
        visit(entry, depth + 1)
    )
  }
  try {
    return (
      visit(input, 0) &&
      new TextEncoder().encode(JSON.stringify(input)).byteLength <=
        MAX_PROJECT_RECORDING_VALUE_BYTES
    )
  } catch {
    return false
  }
}
export const projectRecordingValueSchema = z.custom<ProjectRecordingValue>(isProjectRecordingValue)
export const projectRecordingSourceSchema = z
  .object({
    projectId: id.optional(),
    sessionId: id.optional(),
    operationId: id.optional(),
    executionInvocationId: id.optional(),
    runId: id.optional()
  })
  .strict()
export const projectRecordingMediaSchema = z
  .object({
    mediaKey: id,
    name: z.string().min(1).max(512),
    mimeType: z.string().min(1).max(128),
    checksum: digest,
    sizeBytes: count.max(MAX_PROJECT_RECORDING_MEDIA_BYTES),
    sourceVersionId: id
  })
  .strict()
export const projectRecordingProvenanceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('capture'),
      source: z.enum(['project-export', 'host-view']),
      sourceKey: id.optional(),
      startedAt: time,
      finishedAt: time,
      width: z.number().int().positive().max(16_000_000),
      height: z.number().int().positive().max(16_000_000),
      reportedCapturedAt: time.optional()
    })
    .strict(),
  z
    .object({
      kind: z.literal('derived'),
      method: z.string().min(1).max(2048),
      sourceMediaKeys: z.array(id).min(1).max(64)
    })
    .strict()
])
export const projectRecordingFrameSchema = z
  .object({
    frameId: id,
    sequence: count,
    recordedAt: time,
    mediaKey: id,
    provenance: projectRecordingProvenanceSchema
  })
  .strict()
export const projectRecordingStateSchema = z
  .object({
    stateId: id,
    sequence: count,
    recordedAt: time,
    label: z.string().min(1).max(512).optional(),
    source: z.literal('author-declared'),
    sourceId: id.optional(),
    reportedAt: time.optional(),
    value: projectRecordingValueSchema
  })
  .strict()
export const projectRecordingEventSchema = z
  .object({
    eventId: id,
    sequence: count,
    recordedAt: time,
    name: z.string().min(1).max(512),
    source: z.literal('author-declared'),
    sourceId: id.optional(),
    reportedAt: time.optional(),
    data: projectRecordingValueSchema.optional()
  })
  .strict()
export const projectRecordingCoverageSchema = z
  .object({
    kind: z.literal('sampled-project-recording'),
    stopReason: z.enum(['finished', 'stopped', 'interrupted', 'capacity', 'capture-failed']),
    failures: count,
    unchangedSamples: count,
    droppedSamples: count,
    missingMediaKeys: z.array(id).max(MAX_PROJECT_RECORDING_ITEMS)
  })
  .strict()
export const projectRecordingSchema = z
  .object({
    format: z.literal('open-science-project-recording'),
    version: z.literal(1),
    recordingId: id,
    title: z.string().min(1).max(512).optional(),
    startedAt: time,
    endedAt: time,
    source: projectRecordingSourceSchema.optional(),
    media: z.array(projectRecordingMediaSchema).max(MAX_PROJECT_RECORDING_ITEMS),
    frames: z.array(projectRecordingFrameSchema).max(MAX_PROJECT_RECORDING_ITEMS),
    states: z.array(projectRecordingStateSchema).max(MAX_PROJECT_RECORDING_ITEMS),
    events: z.array(projectRecordingEventSchema).max(MAX_PROJECT_RECORDING_ITEMS),
    coverage: projectRecordingCoverageSchema
  })
  .strict()
  .superRefine((recording, ctx) => {
    const fail = (): void => {
      ctx.addIssue({ code: 'custom', message: 'Project recording has inconsistent evidence.' })
    }
    if (recording.endedAt < recording.startedAt) fail()
    const media = new Map(recording.media.map((item) => [item.mediaKey, item]))
    if (media.size !== recording.media.length) fail()
    const missing = new Set(recording.coverage.missingMediaKeys)
    if (missing.size !== recording.coverage.missingMediaKeys.length) fail()
    if ([...missing].some((key) => media.has(key))) fail()
    for (const entries of [recording.frames, recording.states, recording.events]) {
      const ids = new Set<string>()
      for (const [index, entry] of entries.entries()) {
        const key =
          'frameId' in entry ? entry.frameId : 'stateId' in entry ? entry.stateId : entry.eventId
        if (
          ids.has(key) ||
          entry.sequence !== index ||
          entry.recordedAt < recording.startedAt ||
          entry.recordedAt > recording.endedAt ||
          (index > 0 && entry.recordedAt < entries[index - 1].recordedAt)
        )
          fail()
        ids.add(key)
      }
    }
    for (const frame of recording.frames) {
      const item = media.get(frame.mediaKey)
      if (!item || !['image/png', 'image/jpeg', 'image/webp'].includes(item.mimeType)) fail()
      const provenance = frame.provenance
      if (provenance.kind === 'capture') {
        if (
          provenance.startedAt < recording.startedAt ||
          provenance.finishedAt < provenance.startedAt ||
          provenance.finishedAt > frame.recordedAt ||
          provenance.width > Math.floor(16_000_000 / provenance.height) ||
          (provenance.source === 'host-view' && provenance.reportedCapturedAt !== undefined)
        )
          fail()
      } else if (
        new Set(provenance.sourceMediaKeys).size !== provenance.sourceMediaKeys.length ||
        provenance.sourceMediaKeys.some((key) => key === frame.mediaKey || !media.has(key))
      )
        fail()
    }
  })
export type ProjectRecording = z.infer<typeof projectRecordingSchema>
export type ProjectRecordingMedia = z.infer<typeof projectRecordingMediaSchema>
export type ProjectRecordingFrame = z.infer<typeof projectRecordingFrameSchema>
export type ProjectRecordingState = z.infer<typeof projectRecordingStateSchema>
export type ProjectRecordingEvent = z.infer<typeof projectRecordingEventSchema>
export type ProjectRecordingSource = z.infer<typeof projectRecordingSourceSchema>

export function validateProjectRecording(input: unknown): ProjectRecording {
  const result = projectRecordingSchema.parse(input)
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_PROJECT_RECORDING_BYTES)
    throw new Error('Project recording exceeds its content limit.')
  return result
}
export function parseProjectRecording(content: string): ProjectRecording {
  if (
    content.length > MAX_PROJECT_RECORDING_BYTES ||
    new TextEncoder().encode(content).byteLength > MAX_PROJECT_RECORDING_BYTES
  )
    throw new Error('Project recording exceeds its content limit.')
  return validateProjectRecording(JSON.parse(content))
}

/** Pure presentation data. No Notebook object, service endpoint, command or executable adapter. */
export type ProjectReplayTrack = Readonly<{
  format: 'project-recording' | 'legacy-run-observation'
  recordingId: string
  title?: string
  startedAt: number
  endedAt: number
  source?: ProjectRecordingSource
  media: readonly (Omit<ProjectRecordingMedia, 'sourceVersionId'> & { sourceVersionId?: string })[]
  frames: readonly (ProjectRecordingFrame & { sourceStepKeys?: readonly string[] })[]
  states: readonly ProjectRecordingState[]
  events: readonly ProjectRecordingEvent[]
  coverage: ProjectRecording['coverage']
}>
const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
export function projectRecordingToTrack(recording: ProjectRecording): ProjectReplayTrack {
  const value = validateProjectRecording(recording)
  return freeze({
    format: 'project-recording',
    recordingId: value.recordingId,
    title: value.title,
    startedAt: value.startedAt,
    endedAt: value.endedAt,
    source: value.source,
    media: value.media,
    frames: value.frames,
    states: value.states,
    events: value.events,
    coverage: value.coverage
  })
}

/** Original observation keys remain source evidence. Images get their own time/sequence;
 * neither a Notebook Run nor an observation revision is invented for a captured frame. */
export function projectLegacyObservationToTrack(input: RunObservationArchive): ProjectReplayTrack {
  const archive = validateRunObservationArchive(input)
  const frames = archive.media
    .filter((media) => !!media.capture)
    .sort(
      (a, b) =>
        a.capture!.finishedAt - b.capture!.finishedAt || a.mediaKey.localeCompare(b.mediaKey)
    )
    .map((media, sequence) => ({
      frameId: media.mediaKey,
      sequence,
      recordedAt: media.capture!.finishedAt,
      mediaKey: media.mediaKey,
      sourceStepKeys: [...media.stepKeys],
      provenance: {
        kind: 'capture' as const,
        source: media.capture!.source,
        startedAt: media.capture!.startedAt,
        finishedAt: media.capture!.finishedAt,
        width: media.capture!.width,
        height: media.capture!.height,
        ...(media.capture!.reportedCapturedAt === undefined
          ? {}
          : { reportedCapturedAt: media.capture!.reportedCapturedAt })
      }
    }))
  const source = archive.records.at(-1)!.sourceEvidence.identity
  return freeze({
    format: 'legacy-run-observation',
    recordingId: archive.recordingId,
    startedAt: Math.min(
      archive.coverage.firstObservedAt,
      ...frames.map((frame) => frame.provenance.startedAt)
    ),
    endedAt: Math.max(archive.coverage.lastObservedAt, ...frames.map((frame) => frame.recordedAt)),
    source: {
      projectId: source.projectId,
      sessionId: source.sessionId,
      ...(source.operationId ? { operationId: source.operationId } : {}),
      ...(source.executionInvocationId
        ? { executionInvocationId: source.executionInvocationId }
        : {}),
      ...(source.runId ? { runId: source.runId } : {})
    },
    media: archive.media.map((media) => ({
      mediaKey: media.mediaKey,
      name: media.name,
      mimeType: media.mimeType,
      checksum: media.checksum,
      sizeBytes: media.sizeBytes,
      ...(media.sourceVersionId ? { sourceVersionId: media.sourceVersionId } : {})
    })),
    frames,
    states: [],
    events: [],
    coverage: {
      kind: 'sampled-project-recording',
      stopReason:
        archive.coverage.stopReason === 'run-ended'
          ? 'finished'
          : archive.coverage.stopReason === 'capacity'
            ? 'capacity'
            : archive.coverage.stopReason === 'capture-failed'
              ? 'capture-failed'
              : 'interrupted',
      failures:
        (archive.coverage.samplingFailures ?? 0) + (archive.coverage.unavailableSamples ?? 0),
      unchangedSamples: 0,
      droppedSamples:
        (archive.coverage.sourceCursorGaps ?? 0) +
        Number(archive.coverage.droppedEarlierObservations),
      missingMediaKeys: [...archive.coverage.missingMediaKeys]
    }
  })
}
