import type { ReplayEvidenceReference, ReplayScene } from '../../../../../shared/replay'
import type {
  ReplayCapturedRecord,
  SessionDiscussionSnapshot
} from '../../../../../shared/session-replay'

export type SessionDiscussionCapture = {
  scope?: 'step' | 'session'
  notebookInspection?: { runId: string; timeMs: number }
  stepInspection?: { timeMs: number; mode: 'visible' | 'saved-history' }
  phase?: ReplayScene['phase']
  stepTitle?: string
  branchIndex?: number
  stepNumber?: number
  records?: ReplayCapturedRecord[]
  projectId: string
  sourceSessionId: string
  sourceTitle: string
  fingerprint: string
  branchId: string
  stepId: string
  stepOffsetMs: number
  recordedAt?: number
  evidence: ReplayEvidenceReference[]
  excerpt: string
}

/** View-only inspection hints never change the persisted discussion/package schema. */
export const toSessionDiscussionSnapshot = (
  context: SessionDiscussionCapture,
  id: string
): SessionDiscussionSnapshot => {
  const captured = structuredClone(context)
  delete captured.notebookInspection
  delete captured.stepInspection
  return { ...captured, id }
}
