import { z } from 'zod'
import { runObservationExecutionContextSchema } from './run-observation'
import {
  recordedObservationTargetSchema,
  type RecordedObservationPayload,
  type RecordedRunObservationSelection
} from './run-observation-recorded'

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/)
export const recordedObservationSelectionSchema = z
  .object({
    kind: z.literal('recorded-run-observation'),
    selectionId: id.optional(),
    selectedAt: z.number().finite().nonnegative().optional(),
    recordingId: id,
    receiving: recordedObservationTargetSchema,
    stepKey: id,
    record: z.unknown(),
    executionContext: runObservationExecutionContextSchema.optional(),
    mediaKeys: z.array(id).max(2000)
  })
  .strict()

export function equalRecordedEvidence(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => equalRecordedEvidence(value, right[index]))
    )
  const a = left as Record<string, unknown>
  const b = right as Record<string, unknown>
  return (
    Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every((key) => Object.hasOwn(b, key) && equalRecordedEvidence(a[key], b[key]))
  )
}

/** The payload has already passed the immutable recording reader's validation and authority. */
export function captureRecordedObservationSelection(
  payload: RecordedObservationPayload,
  stepKey: string,
  metadata: { selectionId?: string; selectedAt?: number } = {}
): RecordedRunObservationSelection {
  const record = payload.archive.records.find((entry) => entry.stepKey === stepKey)
  if (!record) throw new Error('The recorded state is unavailable.')
  return structuredClone({
    kind: 'recorded-run-observation',
    ...metadata,
    receiving: payload.receiving,
    recordingId: payload.archive.recordingId,
    stepKey,
    record,
    executionContext: payload.executionContext ?? { purpose: 'unknown', conditionChanges: [] },
    mediaKeys: payload.archive.media
      .filter((media) => media.stepKeys.includes(stepKey))
      .map((media) => media.mediaKey)
  })
}

/** Compare against the original payload; response-provided logs or source IDs are not authority. */
export function verifyRecordedObservationSelection(
  value: unknown,
  payload: RecordedObservationPayload,
  stepKey?: string
): RecordedRunObservationSelection {
  const selected = recordedObservationSelectionSchema.parse(value)
  const expected = captureRecordedObservationSelection(payload, stepKey ?? selected.stepKey)
  if (
    selected.stepKey !== expected.stepKey ||
    selected.recordingId !== expected.recordingId ||
    !equalRecordedEvidence(selected.receiving, expected.receiving) ||
    !equalRecordedEvidence(selected.record, expected.record) ||
    !equalRecordedEvidence(selected.mediaKeys, expected.mediaKeys) ||
    !equalRecordedEvidence(
      selected.executionContext ?? { purpose: 'unknown', conditionChanges: [] },
      expected.executionContext
    )
  )
    throw new Error('The recorded state does not match its source.')
  return { ...selected, record: structuredClone(expected.record) }
}
