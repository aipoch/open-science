// Stable cross-process session contract. Implementation owners live in session-persistence/.
export {
  decodeSessionEnvelope,
  SESSION_FILE_VERSION,
  SESSION_MANIFEST_VERSION,
  createEmptySessionManifest,
  normalizeSessionManifest
} from './session-persistence-envelope'
export type {
  PersistedSessionFile,
  PersistedSessionManifest,
  SessionFileDecodeResult,
  SessionFileReadOptions
} from './session-persistence-envelope'
export {
  ConversationGraphMaterializationError,
  materializeSessionConversationGraph
} from './session-conversation-graph-materialization'
export type { ConversationGraphMaterializationPhase } from './session-conversation-graph-materialization'
export * from './session-runtime-context'
export type { PersistedUploadedAttachment } from './uploads'
export type {
  PersistedSessionStatus,
  SessionWaitReason,
  PersistedActiveRun,
  PersistedPromptPreparation,
  PersistedSessionResumeRecovery,
  PersistedPendingHistoryReplay,
  DelegationPolicy,
  PersistedSessionBranchSource,
  PersistedSessionDetailsSource,
  SessionDetailsClaim,
  SessionDetailsAdmission,
  SessionDetailsUsageCapture,
  PersistedSessionDetailsGeneration,
  EditSessionDetailsRequest,
  PersistedRuntimeSessionAdmission,
  ResearchMembership,
  PersistedChatSession,
  SessionSummary,
  SessionUsageProjection,
  MaterializedPersistedChatSession,
  SessionConflictRebaseField,
  SaveSessionOptions
} from './session-persistence/session'
export {
  delegationPolicySchema,
  normalizeDelegationPolicy,
  SESSION_DETAILS_TITLE_MAX_LENGTH,
  SESSION_DETAILS_DESCRIPTION_MAX_LENGTH
} from './session-persistence/session'
export type {
  PersistedMessageRole,
  PersistedMessageStatus,
  MessageAttribution,
  PersistedArtifactKind,
  PersistedArtifact,
  PersistedMessageImage,
  SessionReference,
  LiteratureReference,
  LiteratureScopeReference,
  MessagePart,
  PersistedMessageAgentTarget,
  PersistedMessagePresentation,
  PersistedChatMessage,
  PersistedToolActivityStatus,
  PersistedToolActivityDisposition,
  PersistedToolCallLocation,
  PersistedToolActivity,
  PersistedActivityGroup
} from './session-persistence/message'
export {
  MAX_SESSION_REFERENCES_PER_MESSAGE,
  collectSessionReferences,
  retainRecentSessionEventIds,
  isHiddenControlMessage,
  isHumanUserMessage
} from './session-persistence/message'
export type {
  BindTaskSessionRequest,
  AdmitTaskSessionTurnRequest,
  StageTaskSessionCompletionRequest,
  SettleTaskSessionCompletionRequest,
  FailTaskSessionRunRequest,
  SessionLoadWarning,
  SessionLoadFailure,
  SessionLoadDiagnostics,
  LoadAllSessionsResult,
  ListSessionSummariesResult,
  LoadSessionRequest,
  RetryRuntimeTerminalCommitRequest,
  OpenSessionRecoveryFolderRequest,
  DeleteSessionRequest,
  SessionDeletionResult,
  UpdateSessionArchiveRequest,
  SaveSessionManifestRequest
} from './session-persistence/commands'
export {
  filterSessionPdfContextCandidatesRequestSchema,
  filterSessionPdfContextCandidatesResultSchema,
  linkSessionPdfContextRequestSchema,
  unlinkSessionPdfContextRequestSchema,
  deleteSessionRequestSchema,
  editSessionDetailsRequestSchema,
  SessionDeletionCommittedError,
  sessionDeletionResultSchema,
  updateSessionArchiveRequestSchema,
  saveSessionManifestRequestSchema,
  sessionApplicationCommandContracts
} from './session-persistence/commands'
export {
  MAX_PERSISTED_SESSION_BYTES,
  SESSION_SIZE_LIMIT_ERROR_CODE,
  SESSION_REVISION_CONFLICT_ERROR_CODE,
  SESSION_DETAILS_CONFLICT_ERROR_CODE,
  SessionSizeLimitError,
  isSessionSizeLimitError,
  SessionDetailsConflictError,
  isSessionDetailsConflictError,
  SessionRevisionConflictError,
  sessionRevision,
  isSessionRevisionConflictError,
  SessionConfigurationBusyError,
  isSessionConfigurationBusyError
} from './session-persistence/errors'
export {
  INTERRUPTED_SESSION_ERROR,
  INTERRUPTED_TURN_ERROR,
  normalizeSessionAfterRestore,
  rearmUnacceptedElicitationContinuations
} from './session-persistence/restore'
export {
  isReviewerCorrectionAttribution,
  isComputeJobCompletionAttribution,
  isAgentResultDeliveryAttribution,
  sanitizeMessageAttribution,
  sanitizeMessagePresentation,
  isComputeJobCompletionPresentation
} from './session-persistence/message-codec'
export { sanitizeToolActivity, sanitizeActivityGroup } from './session-persistence/tool-activity'
export {
  sanitizeMessageParts,
  sanitizeSessionReferences,
  sanitizeMessageImages,
  sanitizeSessionMessageImages,
  sanitizeSessionUploadedAttachments
} from './session-persistence/message-content'
export { sanitizePlanHistoryProjections } from './session-persistence/plan'
export { sanitizePersistedSideChat } from './session-persistence/side-chat'
export { sanitizeSessionPermissionRuntimeContext } from './session-persistence/permissions'
export {
  sanitizeSessionPdfContext,
  sanitizeMessagePdfContextSnapshot
} from './session-persistence/pdf-context'
export { sanitizeSessionRuntimeContext } from './session-persistence/runtime-context'
export {
  createSessionFile,
  decodeSessionFile,
  normalizeSessionFile,
  persistedChatSessionCodec
} from './session-persistence/file-codec'

export {
  isInLatestTurn,
  isInheritedForkTurn,
  isTurnAnchor,
  latestTurnAnchor,
  turnAnchorInterval
} from './session-persistence/turn-anchor'
export type { TurnOutcome } from './session-persistence/turn-outcome'
export {
  resolveTurnOutcome,
  latestOutcomePrompt,
  legacySessionStateForOutcome,
  setTurnOutcome
} from './session-persistence/turn-outcome'
export type {
  SessionAttention,
  SessionAttentionFacts,
  SessionAttentionTurn,
  SessionRecordProblem
} from './session-persistence/attention'
export {
  deriveSessionAttention,
  latestVisibleTurn,
  projectSessionAttention
} from './session-persistence/attention'

export { sanitizeSession } from './session-persistence/session-codec'
export { retryRuntimeTerminalCommitRequestSchema } from './session-persistence/commands'

export {
  isPreparedSessionRun,
  resolvePreparationNoticeBaseline
} from './session-persistence/prompt-preparation'

export { researchMembershipSchema } from './session-persistence/session'
