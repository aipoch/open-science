import type { ResearchReplayObservationBinding } from './research-replay-observations'
export type { ResearchReplayObservationBinding } from './research-replay-observations'
import { z } from 'zod'
import type { ReplayDocument, ReplayStep, ReplayResource, ReplayNotebookRunDetails } from './replay'
import type {
  RecordedEvidencePayload,
  RecordedObservationTarget,
  RecordedRunObservationSelection
} from './run-observation-recorded'
import type { BrowserRecordingMoment } from './browser-recording'

// Application read model only: no change to the .science package protocol.
const id = z.string().min(1).max(256)
export const researchReplayTargetSchema = z.object({ projectId: id, sessionId: id }).strict()
export type ResearchReplayTarget = z.infer<typeof researchReplayTargetSchema>
export const researchReplayPositionSchema = z
  .object({
    branchId: id,
    stepId: id,
    scope: z.enum(['step', 'session']).optional(),
    notebookRunId: id.optional(),
    inspectStep: z.enum(['visible', 'saved-history']).optional(),
    timeMs: z.number().finite().nonnegative(),
    recordedAt: z.number().finite().nonnegative().optional(),
    resourceId: id.optional(),
    recordingId: id.optional(),
    /** A saved observation within a verified recording; never a new research step. */
    observation: z.object({ recordingId: id, stepKey: id }).strict().optional(),
    offsetMs: z.number().finite().nonnegative().optional()
  })
  .strict()
export type ResearchReplayPosition = z.infer<typeof researchReplayPositionSchema>
export const researchReplayReadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('overview') }).strict(),
  z
    .object({
      kind: z.literal('steps'),
      branchId: id.optional(),
      offset: z.number().int().nonnegative().optional(),
      limit: z.number().int().min(1).max(50).optional()
    })
    .strict(),
  z.object({ kind: z.literal('step'), branchId: id, stepId: id }).strict(),
  z
    .object({
      kind: z.literal('step-content'),
      branchId: id,
      stepId: id,
      offset: z.number().int().nonnegative().optional(),
      length: z.number().int().min(1).max(32768).optional()
    })
    .strict(),
  z.object({ kind: z.literal('notebook'), runIds: z.array(id).min(1).max(8) }).strict(),
  z.object({ kind: z.literal('recording'), recordingId: id }).strict(),
  z
    .object({
      kind: z.literal('resource'),
      resourceId: id,
      offset: z.number().int().nonnegative().optional(),
      length: z.number().int().min(1).max(262144).optional()
    })
    .strict()
])
export type ResearchReplayRead = z.infer<typeof researchReplayReadSchema>
export type ResearchReplayRecording = {
  id: string
  kind: 'web-recording' | 'project-recording' | 'run-observation'
  target: RecordedObservationTarget
  name: string
}
export type ResearchReplayRecordingCoverage = {
  recordingId: string
  target: RecordedObservationTarget
  startedAt: number
  endedAt: number
  ranges: Array<{ startedAt: number; endedAt: number }>
}
export type ResearchReplayTiming = {
  recordedTimeOrigins: Readonly<Record<string, number>>
  coverage: Readonly<Record<string, ResearchReplayRecordingCoverage[]>>
  timelineCoverage: Readonly<Record<string, Array<{ startedAt: number; endedAt: number }>>>
  unalignedBranchIds: readonly string[]
}
export type ResearchReplayDocument = {
  observationBindings?: readonly ResearchReplayObservationBinding[]
  document: ReplayDocument
  /** The source owner computes this before collapsing technical steps; consumers must not derive it again. */
  timing: ResearchReplayTiming
  supportingResourceIds?: string[]
  recordings: ResearchReplayRecording[]
  recordingsTruncated: boolean
  unavailableRecordingIds: string[]
}
export type ResearchReplaySelection = {
  selectionId: string
  viewerId: string
  selectedAt: number
  source: ReplayDocument['source']
  position: ResearchReplayPosition
  step: ReplayStep
  excerpt: string
  evidence: ReplayStep['evidence']
  resource?: ReplayResource
  moment?: BrowserRecordingMoment
  observation?: RecordedRunObservationSelection
  truncated: boolean
  phase: 'input' | 'activity' | 'result'
  inspection?: 'saved-resource' | 'recorded-moment' | 'recorded-observation'
}
export type ResearchReplayAccess = {
  mode: 'research'
  viewerId: string
  target: ResearchReplayTarget
  expiresAt: number
  url: string
}
export type ResearchReplayNotebook = { runs: Record<string, ReplayNotebookRunDetails> }
export type ResearchReplayRecordingPayload = RecordedEvidencePayload
export const RESEARCH_REPLAY_METHODS = ['open', 'read', 'select', 'selection', 'revoke'] as const
export type ResearchReplayMethod = (typeof RESEARCH_REPLAY_METHODS)[number]
