import type { ApprovedSwitchReadback } from '../../shared/agents-contract'
import type { CompletionHandoffPhase, CompletionHandoffRetryFrom } from '../../shared/specialist'
import type {
  ToolCompletionEnvelope,
  TrustedToolCompletionContext
} from './completion-gate-contract'

export type CompletionHandoffStage = CompletionHandoffPhase

export type CompletionHandoffRetryStage = CompletionHandoffRetryFrom

export type CompletionHandoffProvenance = {
  originatingTurnId: string
  originatingUserMessageId?: string
  attachmentIds: string[]
  artifactIds: string[]
}

export type CompletionHandoffContinuation = {
  outcome: string
  switchReadback?: ApprovedSwitchReadback
}

export type DurableCompletionHandoff = {
  id: string
  context: TrustedToolCompletionContext
  targetName: string | null
  approvedSpecialistId?: string
  approvedSpecialistRevision?: number
  generation: number
  sequence: number
  commitOrder?: number
  observedAt: number
  provenance: CompletionHandoffProvenance
  stage: CompletionHandoffStage
  envelope?: ToolCompletionEnvelope
  retryFrom?: CompletionHandoffRetryStage
  cancelled: boolean
  failureMessage?: string
  continuation?: CompletionHandoffContinuation
}

export type ApproveCompletionHandoff = {
  context: TrustedToolCompletionContext
  targetName: string | null
  generation: number
  provenance?: Omit<CompletionHandoffProvenance, 'originatingTurnId'>
  continuation?: CompletionHandoffContinuation
}

export type CompletionHandoffPort = {
  approve(input: ApproveCompletionHandoff): Promise<DurableCompletionHandoff>
  capture(
    context: TrustedToolCompletionContext,
    envelope: ToolCompletionEnvelope
  ): Promise<DurableCompletionHandoff>
  cancel(context: TrustedToolCompletionContext): Promise<void>
  run(context: TrustedToolCompletionContext): Promise<DurableCompletionHandoff>
}
