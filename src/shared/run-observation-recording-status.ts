import { z } from 'zod'
import { runObservationTargetSchema } from './run-observation'
import { recordedObservationTargetSchema } from './run-observation-recorded'

/** Read-only status of this exact managed execution, independent of viewer lifetime. */
export const runObservationRecordingStatusSchema = z
  .object({
    target: runObservationTargetSchema,
    state: z.enum(['not-recorded', 'recording', 'saving', 'saved', 'failed', 'capacity']),
    /** Present only after Main verifies the exact finalized and published receiving Version. */
    archive: recordedObservationTargetSchema.optional(),
    capacityLimit: z.enum(['snapshots', 'record-bytes', 'global-bytes']).optional()
  })
  .strict()
  .refine((value) => (value.state === 'saved') === Boolean(value.archive))
export type RunObservationRecordingStatus = z.infer<typeof runObservationRecordingStatusSchema>
