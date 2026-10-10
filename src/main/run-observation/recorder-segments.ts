import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
  runObservationSnapshotSchema,
  runObservationTargetSchema,
  type RunObservationSnapshot,
  type RunObservationTarget
} from '../../shared/run-observation'
import {
  DurableJsonRecoveryBarrierError,
  readDurableJsonFile,
  writeDurableJsonFile,
  type DurableJsonFileDependencies
} from '../storage/durable-json-file'
import { projectRunObservationArchiveRecord } from './archive'

/** Private persistence only. These files are never interpreted as .science entries or Run authority. */
export const RECORDING_SEGMENT_SAMPLES = 128
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const recordingSegmentReferenceSchema = z
  .object({
    ordinal: integer.max(31),
    checksum: digest,
    sizeBytes: integer.max(12 * 1024 * 1024),
    snapshotCount: integer.min(1).max(RECORDING_SEGMENT_SAMPLES),
    archiveRecordBytes: integer.max(16 * 1024 * 1024)
  })
  .strict()
export type RecordingSegmentReference = z.infer<typeof recordingSegmentReferenceSchema>
const segmentSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordingId: digest,
    target: runObservationTargetSchema,
    ordinal: integer.max(31),
    snapshots: z.array(runObservationSnapshotSchema).min(1).max(RECORDING_SEGMENT_SAMPLES)
  })
  .strict()
export type RecordingSegmentWrite = Readonly<{
  reference: RecordingSegmentReference
  text: string
}>
export const archiveRecordsBytes = (snapshots: readonly RunObservationSnapshot[]): number =>
  snapshots.reduce(
    (bytes, snapshot) =>
      bytes + Buffer.byteLength(JSON.stringify(projectRunObservationArchiveRecord(snapshot))) + 1,
    0
  )
export const segmentFilename = (recordingId: string, ordinal: number): string =>
  `${recordingId}.segment-${ordinal.toString().padStart(2, '0')}.json`
export function prepareRecordingSegment(
  recordingId: string,
  target: RunObservationTarget,
  ordinal: number,
  snapshots: readonly RunObservationSnapshot[]
): RecordingSegmentWrite {
  const segment = segmentSchema.parse({ schemaVersion: 1, recordingId, target, ordinal, snapshots })
  const text = JSON.stringify(segment)
  return {
    text,
    reference: {
      ordinal,
      checksum: createHash('sha256').update(text).digest('hex'),
      sizeBytes: Buffer.byteLength(text),
      snapshotCount: segment.snapshots.length,
      archiveRecordBytes: archiveRecordsBytes(segment.snapshots)
    }
  }
}
export async function readRecordingSegment(input: {
  directory: string
  recordingId: string
  target: RunObservationTarget
  reference: RecordingSegmentReference
  dependencies?: Partial<DurableJsonFileDependencies>
}): Promise<RunObservationSnapshot[]> {
  const path = join(input.directory, segmentFilename(input.recordingId, input.reference.ordinal))
  try {
    if (!(await lstat(path)).isFile()) throw new Error('not a regular file')
    const result = await readDurableJsonFile(
      path,
      (text) => {
        const value = segmentSchema.parse(JSON.parse(text))
        if (
          Buffer.byteLength(text) !== input.reference.sizeBytes ||
          createHash('sha256').update(text).digest('hex') !== input.reference.checksum ||
          value.recordingId !== input.recordingId ||
          value.ordinal !== input.reference.ordinal ||
          JSON.stringify(value.target) !== JSON.stringify(input.target) ||
          value.snapshots.length !== input.reference.snapshotCount ||
          archiveRecordsBytes(value.snapshots) !== input.reference.archiveRecordBytes
        )
          throw new Error('segment does not match its recording index')
        return value.snapshots
      },
      input.dependencies,
      { maxBytes: Math.min(input.reference.sizeBytes, 12 * 1024 * 1024) }
    )
    if (result.status === 'missing') throw new Error('missing segment')
    return result.value
  } catch {
    throw new DurableJsonRecoveryBarrierError(
      'Observation recording segment is missing or inconsistent; preserving the recording.'
    )
  }
}
/** An index is committed only after its immutable segment is fsynced. A crash before the index
 * rename leaves an unreferenced segment; an identical retry can claim it, never overwrite it. */
export async function writeRecordingSegment(input: {
  directory: string
  recordingId: string
  target: RunObservationTarget
  segment: RecordingSegmentWrite
  dependencies?: Partial<DurableJsonFileDependencies>
}): Promise<void> {
  const path = join(
    input.directory,
    segmentFilename(input.recordingId, input.segment.reference.ordinal)
  )
  try {
    const stat = await lstat(path)
    if (!stat.isFile())
      throw new DurableJsonRecoveryBarrierError('Invalid observation segment entry; preserving it.')
    await readRecordingSegment({ ...input, reference: input.segment.reference })
    return
  } catch (failure) {
    if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure
  }
  await writeDurableJsonFile(path, input.segment.text, input.dependencies)
}
