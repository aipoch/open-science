import type {
  AcpAgentRuntimeUpdate,
  AcpModelCallUsage,
  AcpPermissionScope,
  AcpTurnTokenUsage
} from '../../shared/acp'
import type { PermissionProfileId } from '../../shared/permission-profiles'
import type { ResolvedSubagentModelSnapshot } from '../../shared/session-persistence'
import type { ResolvedAgentBackend } from '../agent-framework'
import type { JsonSchema } from './structured-output'

type DelegateExecutionErrorCode = 'capacity' | 'unsupported_framework'

class DelegateExecutionError extends Error {
  constructor(
    readonly code: DelegateExecutionErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'DelegateExecutionError'
  }
}

class DelegateMessagePreAcceptanceError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown
  ) {
    super(message)
    this.name = 'DelegateMessagePreAcceptanceError'
  }
}

class DelegateMessageParkedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DelegateMessageParkedError'
  }
}

type DelegateMessageAcceptanceEvidence = 'provider_prompt_accepted' | 'provider_prompt_completed'

type DelegateExecutionEvent =
  | Readonly<{ kind: 'message'; text: string }>
  | Readonly<{ kind: 'runtime'; update: AcpAgentRuntimeUpdate }>
  | Readonly<{
      kind: 'permission'
      awaiting: true
      requestId: string
      title: string
      options: readonly Readonly<{
        optionId: string
        name: string
        kind: string
        scope?: AcpPermissionScope
      }>[]
    }>
  | Readonly<{ kind: 'permission'; awaiting: false; requestId: string }>

type DelegatePermissionResponse = Readonly<{
  requestId: string
  optionId?: string
  cancelled?: boolean
}>

type DelegateExecutionOutcome =
  | Readonly<{
      status: 'completed'
      response: string
      turnUsage?: AcpTurnTokenUsage
      modelCallUsage?: readonly AcpModelCallUsage[]
      turnUsageUnavailable?: true
    }>
  | Readonly<{ status: 'cancelled' }>

type DelegateExecutionInput = Readonly<{
  session: Readonly<{ projectId: string; sessionId: string }>
  frameId: string
  attemptId: string
  runtimeSegmentId: string
  executionModel?: ResolvedSubagentModelSnapshot
  // Admission-only capability. It is never persisted; the durable owner releases it after this
  // Attempt settles, while the production runtime consumes only the lease-free backend view.
  executionBackend?: ResolvedAgentBackend
  task: string
  inputs: readonly string[]
  workspaceCwd?: string
  profile?: string
  continuation: boolean
  artifactCurrentRunFile?: string
  outputSchema?: JsonSchema
  turn?: DelegateChildTurnIdentity
}>

type DelegateExecutionBackendClaim = Readonly<{
  backend: ResolvedAgentBackend
  release(): Promise<void>
}>

type DelegateExecutionBackendLease = Readonly<{
  claim(): DelegateExecutionBackendClaim
  release(): Promise<void>
}>

type DelegatedExecutionModelAdmission = Readonly<{
  snapshot: ResolvedSubagentModelSnapshot
  backendLease?: DelegateExecutionBackendLease
}>

type DelegateChildTurnIdentity = Readonly<{
  promptMessageId: string
  messageBranchId: string
  runtimeSegmentId: string
  begin?(): Promise<void>
  complete?(
    response: string,
    turnUsage?: AcpTurnTokenUsage,
    turnUsageUnavailable?: true,
    modelCallUsage?: readonly AcpModelCallUsage[]
  ): Promise<void>
}>

type RunningDelegateExecution = Readonly<{
  accepted: Promise<DelegateMessageAcceptanceEvidence>
  completion: Promise<DelegateExecutionOutcome>
  subscribe(listener: (event: DelegateExecutionEvent) => void): () => void
  sendMessage(
    message: string,
    turn?: DelegateChildTurnIdentity
  ): Promise<DelegateMessageAcceptanceEvidence>
  setPermissionProfile(profile: PermissionProfileId): Promise<void>
  respondToPermission(response: DelegatePermissionResponse): Promise<void>
  cancel(): Promise<void>
}>

type DelegateCapacityReservation = Readonly<{
  slotIds: readonly string[]
  release(slotId: string): Promise<void>
  releaseAll(): Promise<void>
}>

type DelegateExecution = Readonly<{
  reserve(count: number): Promise<DelegateCapacityReservation>
  run(input: DelegateExecutionInput, slotId: string): RunningDelegateExecution
}>

export { DelegateExecutionError, DelegateMessageParkedError, DelegateMessagePreAcceptanceError }
export type {
  DelegateCapacityReservation,
  DelegateExecutionBackendClaim,
  DelegateExecutionBackendLease,
  DelegateExecution,
  DelegateExecutionErrorCode,
  DelegateExecutionEvent,
  DelegateExecutionInput,
  DelegateMessageAcceptanceEvidence,
  DelegateChildTurnIdentity,
  DelegateExecutionOutcome,
  DelegatedExecutionModelAdmission,
  DelegatePermissionResponse,
  RunningDelegateExecution
}
