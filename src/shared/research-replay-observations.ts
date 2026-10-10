import { z } from 'zod'
import { recordedObservationTargetSchema } from './run-observation-recorded'

// Application-only presentation evidence. Never portable Run identity or execution authority.
export const researchReplayObservationBindingSchema = z
  .object({
    target: recordedObservationTargetSchema,
    recordingId: z.string().min(1).max(200),
    archiveChecksum: z.string().regex(/^[a-f0-9]{64}$/),
    runId: z.string().min(1).max(256),
    branchIds: z.array(z.string().min(1).max(1024)).min(1).max(1000),
    basis: z.enum(['native-identity', 'import-receipt'])
  })
  .strict()
export type ResearchReplayObservationBinding = z.infer<
  typeof researchReplayObservationBindingSchema
>

export const readObservationBindingsRequestSchema = z
  .object({
    projectId: z.string().min(1).max(200),
    sourceSessionId: z.string().min(1).max(200),
    sourceFingerprint: z.string().min(1).max(1024),
    targets: z.array(recordedObservationTargetSchema).max(64)
  })
  .strict()
export type ReadObservationBindingsRequest = z.infer<typeof readObservationBindingsRequestSchema>
export const readObservationBindingsResultSchema = z
  .object({
    sourceFingerprint: z.string().min(1).max(1024),
    bindings: z.array(researchReplayObservationBindingSchema).max(64),
    unavailableTargets: z.array(recordedObservationTargetSchema).max(64)
  })
  .strict()
export type ReadObservationBindingsResult = z.infer<typeof readObservationBindingsResultSchema>
