import { z } from 'zod'
import {
  runObservationCursorSchema,
  runObservationIdentitySchema,
  runObservationSnapshotSchema
} from './run-observation'

// Ordinary Artifact content, not a .science manifest extension or a native persistence record.
// Sender identities remain evidence and are never interpreted as receiver-local write authority.
export const MAX_RUN_OBSERVATION_ARCHIVE_BYTES = 16 * 1024 * 1024
export const MAX_RUN_OBSERVATION_ARCHIVE_RECORDS = 4096
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const size = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const snapshotShape = runObservationSnapshotSchema.shape
/** Time/source evidence for an optional image capture, never executable authority. */
export const runObservationMediaCaptureSchema = z
  .object({
    source: z.enum(['host-view', 'project-export']),
    association: z.literal('current-observation'),
    startedAt: size,
    finishedAt: size,
    observedAt: size,
    width: z.number().int().positive().max(16_000_000),
    height: z.number().int().positive().max(16_000_000),
    reportedCapturedAt: size.optional()
  })
  .strict()
  .refine(
    (capture) =>
      capture.finishedAt >= capture.startedAt &&
      capture.width <= Math.floor(16_000_000 / capture.height) &&
      (capture.source === 'project-export' || capture.reportedCapturedAt === undefined)
  )
export type RunObservationMediaCapture = z.infer<typeof runObservationMediaCaptureSchema>
export const runObservationArchiveMediaSchema = z
  .object({
    mediaKey: id,
    name: z.string().min(1).max(512),
    mimeType: z.string().min(1).max(128),
    checksum: digest,
    sizeBytes: size,
    sourceVersionId: id.optional(),
    capture: runObservationMediaCaptureSchema.optional(),
    /** These keys identify recorded observations, not live services or local Notebook Runs. */
    stepKeys: z.array(id).max(MAX_RUN_OBSERVATION_ARCHIVE_RECORDS)
  })
  .strict()
export type RunObservationArchiveMedia = z.infer<typeof runObservationArchiveMediaSchema>
const recordSchema = z
  .object({
    stepKey: id,
    observedAt: size,
    phase: snapshotShape.phase,
    sourceEvidence: z
      .object({
        identity: runObservationIdentitySchema,
        cursor: runObservationCursorSchema,
        stepId: z.string().min(1).max(256)
      })
      .strict(),
    run: snapshotShape.run.unwrap().omit({ runId: true, executionInvocationId: true }).nullable(),
    artifactEvidence: z
      .array(
        snapshotShape.artifacts.element
          .omit({ artifactId: true, versionId: true, producerRunId: true })
          .extend({
            sourceArtifactId: id.optional(),
            sourceVersionId: id,
            sourceProducerRunId: id.optional()
          })
          .strict()
      )
      .max(1000),
    artifactsTruncated: z.boolean()
  })
  .strict()
const archiveSchema = z
  .object({
    format: z.literal('open-science-run-observation'),
    version: z.literal(1),
    recordingId: id,
    capturedAt: size,
    coverage: z
      .object({
        kind: z.literal('sampled-observations'),
        includesPreObservationHistory: z.literal(false),
        firstObservedAt: size,
        lastObservedAt: size,
        droppedEarlierObservations: z.boolean(),
        terminalRunObserved: z.boolean(),
        stopReason: z.enum([
          'run-ended',
          'viewer-closed',
          'app-exit',
          'capture-failed',
          'manual',
          'capacity'
        ]),
        /** Capture stopped at this limit; the amount of later uncaptured activity is unknown. */
        capacityLimit: z.enum(['snapshots', 'record-bytes', 'global-bytes']).optional(),
        logTruncation: z.boolean(),
        redactedContent: z.boolean(),
        /** Sampling diagnostics are optional for earlier version-1 observation Artifacts. */
        samplingFailures: size.optional(),
        unavailableSamples: size.optional(),
        sourceCursorGaps: size.optional(),
        missingMediaKeys: z.array(id).max(2000)
      })
      .strict(),
    records: z.array(recordSchema).min(1).max(MAX_RUN_OBSERVATION_ARCHIVE_RECORDS),
    media: z.array(runObservationArchiveMediaSchema).max(2000)
  })
  .strict()
export type RunObservationArchive = z.infer<typeof archiveSchema>

const terminal = (status: string | undefined): boolean =>
  !!status && ['completed', 'failed', 'timeout', 'interrupted', 'cancelled'].includes(status)

export function validateRunObservationArchive(input: unknown): RunObservationArchive {
  const archive = archiveSchema.parse(input)
  const first = archive.records[0]
  const last = archive.records.at(-1)!
  const steps = new Set<string>()
  const media = new Set<string>()
  const identity = last.sourceEvidence.identity
  const epoch = first.sourceEvidence.cursor.epoch
  for (const [index, record] of archive.records.entries()) {
    const previous = archive.records[index - 1]
    if (
      steps.has(record.stepKey) ||
      record.sourceEvidence.cursor.epoch !== epoch ||
      (previous &&
        (record.observedAt < previous.observedAt ||
          record.sourceEvidence.cursor.sequence <= previous.sourceEvidence.cursor.sequence)) ||
      (
        [
          'projectId',
          'sessionId',
          'operationId',
          'environmentId',
          'executionInvocationId',
          'runId'
        ] as const
      ).some(
        (field) =>
          record.sourceEvidence.identity[field] &&
          record.sourceEvidence.identity[field] !== identity[field]
      ) ||
      (record.run && !record.sourceEvidence.identity.runId)
    )
      throw new Error('Observation archive has inconsistent source evidence.')
    steps.add(record.stepKey)
  }
  for (const item of archive.media) {
    if (media.has(item.mediaKey) || item.stepKeys.some((step) => !steps.has(step)))
      throw new Error('Observation archive has invalid media references.')
    media.add(item.mediaKey)
  }
  const logs = archive.records.flatMap((record) =>
    record.run ? Object.values(record.run.logs) : []
  )
  const cursorGaps = archive.records
    .slice(1)
    .reduce(
      (sum, record, index) =>
        sum +
        record.sourceEvidence.cursor.sequence -
        archive.records[index].sourceEvidence.cursor.sequence -
        1,
      0
    )
  if (
    (archive.coverage.stopReason === 'capacity') !==
      (archive.coverage.capacityLimit !== undefined) ||
    archive.coverage.firstObservedAt !== first.observedAt ||
    archive.coverage.lastObservedAt !== last.observedAt ||
    archive.capturedAt < last.observedAt ||
    archive.coverage.terminalRunObserved !== terminal(last.run?.status) ||
    (archive.coverage.stopReason === 'run-ended' && !archive.coverage.terminalRunObserved) ||
    archive.coverage.logTruncation !== logs.some((log) => log.truncated) ||
    archive.coverage.redactedContent !== logs.some((log) => log.redacted) ||
    (archive.coverage.sourceCursorGaps ?? 0) !== cursorGaps ||
    (first.sourceEvidence.cursor.sequence > 0 && !archive.coverage.droppedEarlierObservations) ||
    archive.coverage.missingMediaKeys.some((key) => media.has(key)) ||
    new Set(archive.coverage.missingMediaKeys).size !== archive.coverage.missingMediaKeys.length
  )
    throw new Error('Observation archive has inconsistent capture coverage.')
  return archive
}

export function parseRunObservationArchive(text: string): RunObservationArchive {
  if (
    text.length > MAX_RUN_OBSERVATION_ARCHIVE_BYTES ||
    new TextEncoder().encode(text).byteLength > MAX_RUN_OBSERVATION_ARCHIVE_BYTES
  )
    throw new Error('Observation archive exceeds its content limit.')
  return validateRunObservationArchive(JSON.parse(text))
}
