import type { AgentUserChoicePrompt } from './elicitation'
import type { ResolvedReasoningEffort } from '@aipoch/providers'
import type { AgentFrameworkId } from './settings'

export type DelegatedWorkAttemptStatus = 'running' | 'completed' | 'cancelled' | 'error'

export type DelegatedWorkCancellationReason =
  'main_agent_stop' | 'session_stop' | 'runtime_interrupted'

export type DelegatedWorkResolvedAgent =
  | Readonly<{ kind: 'main' }>
  | Readonly<{
      kind: 'specialist'
      profileId: string
      revision: number
      displayName: string
    }>

export type ResolvedSubagentModelSnapshot = Readonly<{
  frameworkId: AgentFrameworkId
  providerId: string
  backendId: string
  // Stable persisted route identity used to resume accepted work; not a ModelProtocol value.
  modelRoute:
    | 'claude-anthropic'
    | 'opencode-anthropic'
    | 'opencode-openai'
    | 'codebuddy-openai'
    | 'codex-responses'
    | 'codex-responses-compatibility'
    | 'codex-bridge'
  model: string
  reasoningEffort: ResolvedReasoningEffort
}>

export type DelegatedWorkAttemptRecord = Readonly<{
  id: string
  // Durable identity of the root Message whose Conversation Turn admitted this Attempt.
  // Legacy terminal Attempts may omit it; new initial and continuation Attempts always write it.
  initiatingTurnMessageId?: string
  status: DelegatedWorkAttemptStatus
  resolvedAgent: DelegatedWorkResolvedAgent
  executionModel?: ResolvedSubagentModelSnapshot
  runtimeSegmentIds: readonly string[]
  startedAt: number
  endedAt?: number
  terminalMessageId?: string
  cancellationReason?: DelegatedWorkCancellationReason
  error?: Readonly<{ code: string; message: string }>
}>

export type DelegatedMessageCommand = Readonly<{
  messageId: string
  requestId: string
  sourcePrincipal: string
  canonicalDigest: string
  sourceFrameId: string
  sourceAttemptId?: string
  targetFrameId: string
  targetAttemptId?: string
  continuationAttemptId?: string
  rootPromptMessageId?: string
  rootOriginMessageId: string
  callerRootMessageId: string
  rootBranchId: string
  rootBranchRevision: string
  direction: 'to_child' | 'to_parent'
  disposition: 'message' | 'continued'
  text: string
  kind: 'info' | 'question'
  replyToMessageId?: string
  retryOfMessageId?: string
  laneSequence: number
  queuedAt: number
  receipt:
    | Readonly<{ status: 'queued'; dispatchStartedAt?: number; dispatchEpoch?: string }>
    | Readonly<{
        status: 'accepted'
        acceptedAt: number
        evidence: 'provider_prompt_accepted' | 'provider_prompt_completed'
      }>
    | Readonly<{
        status: 'failed'
        failedAt: number
        error: Readonly<{ code: string; message: string; retryable: boolean }>
      }>
    | Readonly<{
        status: 'uncertain'
        uncertainAt: number
        resolution: 'pending' | 'acknowledged'
      }>
}>

export type DelegatedWorkRecord = Readonly<{
  agentFrameId: string
  attempts: readonly DelegatedWorkAttemptRecord[]
}>

export type DelegatedQuestionAnswer = Readonly<{ questionIndex: number; value: string | string[] }>

export type DelegatedQuestionRequest = Readonly<{
  requestId: string
  canonicalDigest: string
  sourceFrameId: string
  sourceAttemptId: string
  sourceRuntimeSegmentId: string
  sourceMessageBranchId: string
  rootOriginMessageId: string
  rootBranchId: string
  sourceName: string
  questions: readonly AgentUserChoicePrompt[]
  sequence?: number
  askedAt: number
  status: 'pending' | 'confirmed' | 'cancelled' | 'failed'
  draftAnswers: readonly DelegatedQuestionAnswer[]
  draftQuestionIndex: number
  answers?: readonly DelegatedQuestionAnswer[]
  respondedAt?: number
  continuationAttemptId?: string
  failure?: Readonly<{ code: string; message: string }>
}>

export type SessionDelegatedWorkRuntimeContext = Readonly<{
  records: readonly DelegatedWorkRecord[]
  recordsQuarantine?: unknown
  messageCommands?: readonly DelegatedMessageCommand[]
  messageCommandsQuarantine?: unknown
  questionRequests?: readonly DelegatedQuestionRequest[]
  questionRequestsQuarantine?: unknown
}>

export type DelegatedCallerSource = Readonly<{
  rootMessageId: string
  toolInvocationId: string
}>
