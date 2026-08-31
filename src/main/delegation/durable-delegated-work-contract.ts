import type { ArtifactFile } from '../../shared/artifacts'
import type { AcpAgentRuntimeUpdate, AcpPermissionScope } from '../../shared/acp'
import type { PermissionProfileId } from '../../shared/permission-profiles'
import type { ReviewWithChecks } from '../../shared/reviewer'
import type { SpecialistView } from '../../shared/specialist'
import type { AuthenticatedDelegateCaller } from './authenticated-delegate-caller'
import type { JsonSchema } from './structured-output'
import type { AgentUserChoiceRequest, AgentUserChoiceResult } from '../../shared/elicitation'
import type { DelegatedArtifactEvidence } from './delegated-turn-lifecycle'
import type {
  DelegateExecution,
  DelegateMessageAcceptanceEvidence,
  DelegatePermissionResponse,
  DelegatedExecutionModelAdmission
} from './execution-port'
import type {
  DelegatedWorkDurableRecords,
  DurableAttempt,
  DurableChildSummary,
  DurableCollectOptions,
  DurableCollectSelector,
  DurableDelegateObservation,
  DurableDelegateOutcome,
  DurableDelegateResult,
  DelegatedQuestionAnswer
} from './delegated-work-record-types'

type SessionKey = Readonly<{ projectId: string; sessionId: string }>

type DurableDelegateRequest = Readonly<{
  task: string
  name: string
  profile?: string
  inputs?: readonly string[]
  outputSchema?: JsonSchema
}>

type SpecialistDelegationProfile = Readonly<
  Pick<SpecialistView, 'id' | 'name' | 'displayName' | 'enabled' | 'setupPending' | 'revision'>
>

type ParentMessageDelivery = Readonly<{
  messageId: string
  session: SessionKey
  sourceFrameId: string
  sourceAttemptId: string
  targetFrameId: string
  originMessageId: string
  rootPromptMessageId: string
  rootBranchId: string
  rootBranchRevision: string
  text: string
  kind: 'info' | 'question'
  startDispatch(): Promise<'started' | 'terminal' | 'blocked'>
}>

type SessionSubagentSummary = Readonly<{
  runningCount: number
  children: readonly Readonly<{
    frameId: string
    title: string
    status: 'running' | 'awaiting_user' | 'completed' | 'cancelled' | 'error'
    awaitingPermission?: boolean
  }>[]
}>

type RootDelegatePermissionRequest = Readonly<{
  requestId: string
  frameId: string
  attemptId: string
  childTitle: string
  action: string
  riskScope: string
  options: readonly Readonly<{
    optionId: string
    name: string
    kind: string
    scope?: AcpPermissionScope
  }>[]
}>

type RootDelegatePermissionResponse = DelegatePermissionResponse &
  Readonly<{ frameId: string; attemptId: string }>

type RootDelegatePermissionEvent =
  | Readonly<{ kind: 'requested'; request: RootDelegatePermissionRequest }>
  | Readonly<{ kind: 'settled'; request: RootDelegatePermissionRequest }>

type MessageReceiptBase = Readonly<{
  request_id: string
  message_id: string
  source_frame_id: string
  target_frame_id: string
  reply_to_message_id?: string
  queued_at: number
  same_request_safe: true
}>

type MessageReceiptRoute =
  | Readonly<{
      direction: 'to_child'
      disposition: 'message'
      target_attempt_id: string
    }>
  | Readonly<{
      direction: 'to_child'
      disposition: 'continued'
      continuation_attempt_id: string
    }>
  | Readonly<{
      direction: 'to_parent'
      disposition: 'message'
      source_attempt_id: string
      root_prompt_message_id: string
    }>

type MessageReceiptState =
  | Readonly<{
      status: 'queued'
      dispatch_started_at?: number
      new_request_retry_safe: false
    }>
  | Readonly<{
      status: 'accepted'
      accepted_at: number
      evidence: 'provider_prompt_accepted' | 'provider_prompt_completed'
      new_request_retry_safe: false
    }>
  | Readonly<{
      status: 'failed'
      failed_at: number
      error: Readonly<{
        code: string
        message: string
        retryable: boolean
        delivery_may_have_occurred: false
      }>
      new_request_retry_safe: boolean
    }>
  | Readonly<{
      status: 'uncertain'
      uncertain_at: number
      delivery_may_have_occurred: true
      resolution: 'pending' | 'acknowledged'
      new_request_retry_safe: false
    }>

type DurableSendMessageOutcome = MessageReceiptBase & MessageReceiptRoute & MessageReceiptState

type DurableSendMessageOptions = Readonly<{
  kind?: 'info' | 'question'
  requestId?: string
  replyToMessageId?: string
}>

type ReadOnlyAgentFrameDetail = Readonly<{
  frameId: string
  title: string
  status: 'running' | 'completed' | 'cancelled' | 'error'
  resolvedAgent: DurableAttempt['resolvedAgent']
  messages: readonly Readonly<{
    role: 'user' | 'assistant'
    content: string
    artifacts?: readonly ArtifactFile[]
    reviews?: readonly ReviewWithChecks[]
  }>[]
}>

type DelegatedReviewProjectionScope = Readonly<{
  session: SessionKey
  attemptId: string
  agentFrameId: string
  messageBranchId: string
  terminalMessageId: string
  artifactVersionIds: readonly string[]
}>

type DelegatedReviewEvidence = Readonly<{
  project(scope: DelegatedReviewProjectionScope): Promise<readonly ReviewWithChecks[]>
}>

type StopOutcome = Readonly<{
  frameId: string
  status: 'cancelled' | 'already_terminal'
}>

type RecoveryOutcome = Readonly<{ interrupted: readonly DurableDelegateResult[] }>

type DurableDelegatedWork = Readonly<{
  delegate(
    caller: AuthenticatedDelegateCaller,
    requests: DurableDelegateRequest | readonly DurableDelegateRequest[],
    options?: Readonly<{ wait?: boolean; timeoutSeconds?: number }>
  ): Promise<DurableDelegateOutcome>
  children(
    caller: AuthenticatedDelegateCaller,
    frameIds?: readonly string[]
  ): Promise<readonly DurableChildSummary[]>
  collect(
    caller: AuthenticatedDelegateCaller,
    selectors: readonly DurableCollectSelector[],
    options?: DurableCollectOptions
  ): Promise<readonly DurableDelegateObservation[]>
  submitOutput(
    caller: AuthenticatedDelegateCaller,
    value: unknown
  ): Promise<Readonly<{ accepted: true }>>
  sendMessage(
    caller: AuthenticatedDelegateCaller,
    targetFrameId: string | 'parent',
    message: string,
    options?: DurableSendMessageOptions
  ): Promise<DurableSendMessageOutcome>
  messageReceipt(
    caller: AuthenticatedDelegateCaller,
    selector: string,
    options?: Readonly<{ timeoutSeconds?: number }>
  ): Promise<DurableSendMessageOutcome>
  resolveMessage(
    caller: AuthenticatedDelegateCaller,
    messageId: string,
    options: Readonly<{ action: 'acknowledge_uncertain' }>
  ): Promise<DurableSendMessageOutcome>
  requestUserInput(
    caller: AuthenticatedDelegateCaller,
    request: AgentUserChoiceRequest,
    requestId?: string
  ): Promise<AgentUserChoiceResult>
  updateQuestionDraft(
    session: SessionKey,
    input: Readonly<{
      requestId: string
      draftAnswers: readonly DelegatedQuestionAnswer[]
      questionIndex: number
    }>
  ): Promise<void>
  confirmQuestion(
    session: SessionKey,
    input: Readonly<{ requestId: string; answers: readonly DelegatedQuestionAnswer[] }>
  ): Promise<Readonly<{ requestId: string; continuationAttemptId: string }>>
  sessionSummary(session: SessionKey): Promise<SessionSubagentSummary>
  readAgentFrame(
    session: SessionKey,
    frameId: string
  ): Promise<ReadOnlyAgentFrameDetail | undefined>
  rootPermissionRequests(session: SessionKey): Promise<readonly RootDelegatePermissionRequest[]>
  respondToPermission(session: SessionKey, response: RootDelegatePermissionResponse): Promise<void>
  setPermissionProfile(session: SessionKey, profile: PermissionProfileId): Promise<void>
  stopChildren(
    caller: AuthenticatedDelegateCaller,
    frameIds: readonly string[]
  ): Promise<readonly StopOutcome[]>
  cancelTurn(session: SessionKey, initiatingTurnMessageId: string): Promise<readonly StopOutcome[]>
  stopActiveBranch(session: SessionKey): Promise<readonly StopOutcome[]>
  stopSession(session: SessionKey): Promise<readonly StopOutcome[]>
  recoverInterrupted(): Promise<RecoveryOutcome>
  wakeMessages(): Promise<void>
  deleteSession(session: SessionKey): Promise<void>
}>

type CreateDurableDelegatedWorkOptions = Readonly<{
  execution: DelegateExecution
  records: DelegatedWorkDurableRecords
  assertAvailable?: (caller: AuthenticatedDelegateCaller) => Promise<void> | void
  resolveExecutionModel: (
    caller: AuthenticatedDelegateCaller
  ) => Promise<DelegatedExecutionModelAdmission> | DelegatedExecutionModelAdmission
  resolveSpecialist?: (
    profileId: string
  ) => Promise<SpecialistDelegationProfile | undefined> | SpecialistDelegationProfile | undefined
  resolveSpecialistReference?: (
    profileReference: string
  ) => Promise<SpecialistDelegationProfile | undefined> | SpecialistDelegationProfile | undefined
  validateInput?: (identity: string) => Promise<boolean> | boolean
  workspace?: Readonly<{
    prepare(
      session: SessionKey,
      frameId: string,
      inputs: readonly string[]
    ): Promise<{ cwd: string }>
    deleteSession?(session: SessionKey): Promise<void>
  }>
  revokeAttemptWrites?: (scope: {
    session: SessionKey
    frameId: string
    attemptId: string
  }) => Promise<void> | void
  settleAttemptCleanup?: (scope: {
    session: SessionKey
    frameId: string
    attemptId: string
  }) => Promise<void> | void
  deliverToParent?: (delivery: ParentMessageDelivery) => Promise<DelegateMessageAcceptanceEvidence>
  artifactEvidence?: DelegatedArtifactEvidence
  reviewEvidence?: DelegatedReviewEvidence
  onRootPermissionEvent?(event: RootDelegatePermissionEvent): void
  onAgentRuntimeUpdate?(update: AcpAgentRuntimeUpdate): void
  now?: () => number
  createId?: (kind: 'frame' | 'attempt' | 'message' | 'runtime' | 'question') => string
  collectPollIntervalMs?: number
  collectMonotonicNow?: () => number
  assertTurnOpen?: (session: SessionKey, initiatingTurnMessageId: string) => Promise<void> | void
}>

export type {
  CreateDurableDelegatedWorkOptions,
  DelegatedReviewEvidence,
  DelegatedReviewProjectionScope,
  DurableDelegateRequest,
  DurableDelegatedWork,
  DurableSendMessageOutcome,
  DurableSendMessageOptions,
  ParentMessageDelivery,
  ReadOnlyAgentFrameDetail,
  RecoveryOutcome,
  RootDelegatePermissionEvent,
  RootDelegatePermissionRequest,
  RootDelegatePermissionResponse,
  SessionKey,
  SessionSubagentSummary,
  SpecialistDelegationProfile,
  StopOutcome
}
