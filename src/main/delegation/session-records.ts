import type { AgentFrameworkId } from '../../shared/settings'
import type { ArtifactFile } from '../../shared/artifacts'
import type { JsonValue, StructuredOutputEvidence } from './structured-output'
import type {
  DelegatedWorkAttemptRecord,
  DelegatedWorkCancellationReason,
  DelegatedMessageCommand,
  DelegatedQuestionRequest,
  DelegatedQuestionAnswer,
  DelegatedWorkRecord,
  DelegatedWorkResolvedAgent,
  DelegatedCallerSource,
  ResolvedSubagentModelSnapshot,
  PersistedActivityGroup,
  PersistedChatMessage,
  PersistedToolActivity
} from '../../shared/session-persistence'

type SessionKey = Readonly<{ projectId: string; sessionId: string }>

type CreateChildRecordInput = Readonly<{
  frameId: string
  branchId: string
  messageId: string
  attemptId: string
  task: string
  name: string
  inputs?: readonly string[]
  resolvedAgent: DelegatedWorkResolvedAgent
  executionModel?: ResolvedSubagentModelSnapshot
  startedAt: number
  callerSource: DelegatedCallerSource
  initiatingTurnMessageId: string
  structuredOutputEvidence?: StructuredOutputEvidence
}>

type CreateChildrenInput = Readonly<{
  expectedRevision: number
  parentFrameId: string
  originMessageId: string
  children: readonly CreateChildRecordInput[]
}>

type CreatedChild = Readonly<{
  frameId: string
  attemptId: string
  status: 'running'
}>

type CreatedNamedChild = CreatedChild & Readonly<{ name: string }>

type StartAttemptRuntimeInput = Readonly<{
  expectedRevision: number
  frameId: string
  attemptId: string
  runtimeSegmentId: string
  frameworkId: AgentFrameworkId
  backendId?: string
  agentName?: string
  model?: string
  startedAt: number
}>

type StartContinuationAttemptInput = Readonly<{
  expectedRevision: number
  frameId: string
  previousAttemptId: string
  attemptId: string
  messageId: string
  message: string
  resolvedAgent: DelegatedWorkResolvedAgent
  executionModel?: ResolvedSubagentModelSnapshot
  startedAt: number
  callerSource: DelegatedCallerSource
  initiatingTurnMessageId: string
  messageCommand: DelegatedMessageCommand
}>

type AdmitQuestionInput = Readonly<{
  expectedRevision: number
  request: Omit<DelegatedQuestionRequest, 'sequence'>
}>

type UpdateQuestionDraftInput = Readonly<{
  expectedRevision: number
  requestId: string
  draftAnswers: readonly DelegatedQuestionAnswer[]
  questionIndex: number
}>

type ConfirmQuestionInput = Readonly<{
  expectedRevision: number
  requestId: string
  frameId: string
  previousAttemptId: string
  attemptId: string
  messageId: string
  message: string
  answers: readonly DelegatedQuestionAnswer[]
  resolvedAgent: DelegatedWorkResolvedAgent
  executionModel: ResolvedSubagentModelSnapshot
  startedAt: number
  initiatingTurnMessageId: string
}>

type AttemptAgentEvent =
  | Readonly<{
      kind: 'message'
      message: PersistedChatMessage
      runtimeSegmentId: string
    }>
  | Readonly<{
      kind: 'activity'
      activity: PersistedToolActivity
      runtimeSegmentId: string
      promptMessageId: string
    }>
  | Readonly<{
      kind: 'activity-group'
      activityGroup: PersistedActivityGroup
      promptMessageId: string
    }>

type AttemptAgentEventInput = Readonly<{
  expectedRevision: number
  frameId: string
  attemptId: string
  event: AttemptAgentEvent | readonly AttemptAgentEvent[]
}>

type TransitionAttemptInput = Readonly<{
  expectedRevision: number
  frameId: string
  attemptId: string
  status: 'completed' | 'cancelled' | 'error'
  endedAt: number
  terminalMessageId?: string
  cancellationReason?: DelegatedWorkCancellationReason
  error?: Readonly<{ code: string; message: string }>
}>

type AdmitMessageCommandInput = Readonly<{
  expectedRevision: number
  command: DelegatedMessageCommand
}>
type StartMessageDispatchInput = Readonly<{
  expectedRevision: number
  messageId: string
  dispatchStartedAt: number
  dispatchEpoch: string
  rootBranchId: string
  rootBranchRevision: string
}>
type SettleMessageInput = Readonly<{
  expectedRevision: number
  messageId: string
  receipt: DelegatedMessageCommand['receipt']
}>

type StartPendingMessageTurnInput = Readonly<{
  expectedRevision: number
  frameId: string
  attemptId: string
  pendingMessageId: string
  promptMessageId: string
  runtimeSegmentId: string
  frameworkId: AgentFrameworkId
  startedAt: number
}>

type CompleteChildTurnInput = Readonly<{
  expectedRevision: number
  frameId: string
  attemptId: string
  runtimeSegmentId: string
  endedAt: number
}>

type AttachDelegatedMessageArtifactsInput = Readonly<{
  frameId: string
  attemptId: string
  messageId: string
  artifacts: readonly ArtifactFile[]
}>

type SubmitStructuredOutputInput = Readonly<{
  expectedRevision: number
  frameId: string
  attemptId: string
  schemaDigest: string
  value: JsonValue
  acceptedAt: number
}>

type ChildRecord = Readonly<{
  frameId: string
  parentFrameId: string
  title: string
  status: 'running' | 'completed' | 'cancelled' | 'error'
  record: DelegatedWorkRecord
}>

/** Internal persistence port. It is intentionally absent from Host, IPC, and Renderer contracts. */
type DelegatedWorkRecordCommands = Readonly<{
  createChildren(key: SessionKey, input: CreateChildrenInput): Promise<readonly CreatedNamedChild[]>
  startContinuationAttempt(
    key: SessionKey,
    input: StartContinuationAttemptInput
  ): Promise<CreatedChild>
  admitQuestion(key: SessionKey, input: AdmitQuestionInput): Promise<'admitted' | 'idempotent'>
  updateQuestionDraft(key: SessionKey, input: UpdateQuestionDraftInput): Promise<void>
  confirmQuestion(key: SessionKey, input: ConfirmQuestionInput): Promise<CreatedChild>
  cancelQuestions(
    key: SessionKey,
    input: Readonly<{ expectedRevision: number; frameId: string; endedAt: number; reason: string }>
  ): Promise<void>
  startAttemptRuntime(key: SessionKey, input: StartAttemptRuntimeInput): Promise<void>
  applyAgentEvent(key: SessionKey, input: AttemptAgentEventInput): Promise<void>
  transitionAttempt(key: SessionKey, input: TransitionAttemptInput): Promise<void>
  admitMessageCommand(
    key: SessionKey,
    input: AdmitMessageCommandInput
  ): Promise<'admitted' | 'idempotent'>
  startMessageDispatch(
    key: SessionKey,
    input: StartMessageDispatchInput
  ): Promise<'started' | 'terminal' | 'blocked'>
  settleMessage(key: SessionKey, input: SettleMessageInput): Promise<'settled' | 'terminal'>
  acknowledgeUncertainMessage(
    key: SessionKey,
    input: Readonly<{ expectedRevision: number; messageId: string }>
  ): Promise<'acknowledged' | 'terminal'>
  startPendingMessageTurn(key: SessionKey, input: StartPendingMessageTurnInput): Promise<void>
  completeChildTurn(key: SessionKey, input: CompleteChildTurnInput): Promise<void>
  submitStructuredOutput(
    key: SessionKey,
    input: SubmitStructuredOutputInput
  ): Promise<'accepted' | 'idempotent'>
  attachDelegatedMessageArtifacts(
    key: SessionKey,
    input: AttachDelegatedMessageArtifactsInput
  ): Promise<void>
  readChildren(key: SessionKey, parentFrameId: string): Promise<readonly ChildRecord[]>
}>

export type {
  AdmitMessageCommandInput,
  AdmitQuestionInput,
  AttachDelegatedMessageArtifactsInput,
  AttemptAgentEvent,
  AttemptAgentEventInput,
  ChildRecord,
  CompleteChildTurnInput,
  ConfirmQuestionInput,
  CreateChildRecordInput,
  CreateChildrenInput,
  CreatedChild,
  CreatedNamedChild,
  DelegatedWorkAttemptRecord,
  DelegatedWorkRecordCommands,
  SettleMessageInput,
  StartMessageDispatchInput,
  SessionKey,
  StartContinuationAttemptInput,
  StartAttemptRuntimeInput,
  StartPendingMessageTurnInput,
  SubmitStructuredOutputInput,
  TransitionAttemptInput,
  UpdateQuestionDraftInput
}
