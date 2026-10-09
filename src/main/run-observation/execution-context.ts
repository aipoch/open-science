import { z } from 'zod'
import { redactSensitiveText } from '../../shared/diagnostic-redaction'
import type { RunObservationArchive } from '../../shared/run-observation-archive'
import {
  runObservationDemoViewingAdmissionSchema,
  type RunObservationDemoViewing,
  type RunObservationDemoViewingAdmission,
  type RunObservationExecutionContext,
  type RunObservationRun
} from '../../shared/run-observation'

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/)
// Collection receipts are ordinary JSON Artifacts. Parse only this public projection; never copy
// variables, source locators, runtime settings or the rest of a receipt into a viewer response.
const receiptSchema = z.object({
  kind: z.literal('managed-research-execution'),
  version: z.literal(1),
  purpose: z.enum(['offline-demo', 'research']).optional(),
  demoViewing: runObservationDemoViewingAdmissionSchema.optional(),
  executionProfile: z
    .object({
      displayName: z.string().max(160),
      conditionChanges: z.array(z.string().max(2048)).max(32)
    })
    .optional(),
  result: z.object({
    runId: id,
    executionInvocationId: id,
    observation: z.object({ recordingId: id, versionId: id }).optional()
  })
})
export const unknownExecutionContext = (): RunObservationExecutionContext => ({
  purpose: 'unknown',
  conditionChanges: []
})

/** Only verified admission facts and an actual observed Run determine this public summary. */
export function projectDemoViewing(
  admission: RunObservationDemoViewingAdmission | undefined,
  run: Pick<RunObservationRun, 'status'> | null | undefined
): RunObservationDemoViewing | undefined {
  if (!admission) return undefined
  const admitted = runObservationDemoViewingAdmissionSchema.parse(admission)
  const endReason: RunObservationDemoViewing['endReason'] =
    run?.status === 'completed'
      ? 'process-exited'
      : run?.status === 'timeout'
        ? 'time-limit'
        : run?.status === 'cancelled'
          ? 'stopped'
          : run?.status === 'failed'
            ? 'failed'
            : run?.status === 'interrupted'
              ? 'interrupted'
              : undefined
  return {
    ...admitted,
    ...(endReason ? { endReason } : {})
  }
}

/** Caller must first verify immutable bytes, receiving scope and shared native Artifact Run. */
export function readCollectionExecutionContext(
  bytes: Uint8Array,
  archive: RunObservationArchive
): RunObservationExecutionContext | undefined {
  let receipt: z.infer<typeof receiptSchema>
  try {
    receipt = receiptSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    )
  } catch {
    return undefined
  }
  if (receipt.demoViewing && receipt.purpose !== 'offline-demo') return undefined
  if (receipt.result.observation?.recordingId !== archive.recordingId) return undefined
  const runs = archive.records.filter((record) => record.run !== null)
  if (
    !runs.length ||
    runs.some(
      (record) =>
        record.sourceEvidence.identity.runId !== receipt.result.runId ||
        record.sourceEvidence.identity.executionInvocationId !==
          receipt.result.executionInvocationId
    )
  )
    return undefined
  // A completed process and a legacy receipt without an explicit purpose prove neither intent
  // nor successful scientific replication. Missing intent stays unknown even when a profile exists.
  const redact = (text: string): string =>
    redactSensitiveText(text)
      .replace(
        /(?:file:\/\/)?\/(?:Users|home|private|var|tmp|etc|opt|Applications|Volumes)\/[^\s"'<>]*/g,
        '[local path]'
      )
      .replace(/\b[A-Za-z]:\\[^\s"'<>]+/g, '[local path]')
  return {
    purpose: receipt.purpose ?? 'unknown',
    ...(receipt.executionProfile
      ? { profileName: redact(receipt.executionProfile.displayName).slice(0, 160) }
      : {}),
    conditionChanges: (receipt.executionProfile?.conditionChanges ?? []).map((text) =>
      redact(text).slice(0, 2048)
    ),
    ...(receipt.demoViewing
      ? { demoViewing: projectDemoViewing(receipt.demoViewing, archive.records.at(-1)?.run) }
      : {})
  }
}
