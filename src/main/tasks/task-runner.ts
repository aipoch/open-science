import { constants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import type { AcpRuntimeEvent, AgentTurnProvenanceContext } from '../../shared/acp'
import { ComputeHostPreferenceValidationError } from '../../shared/compute'
import {
  getAcpRuntimeEventImage,
  getAcpRuntimeEventText,
  MAX_ACP_MESSAGE_IMAGE_BYTES_PER_MESSAGE,
  MAX_ACP_MESSAGE_IMAGES_PER_MESSAGE,
  normalizeClaudeCodeRefusalText
} from '../../shared/acp'
import type {
  ArtifactFile,
  FinalizeRunArtifactsRequest,
  FinalizeRunArtifactsResult
} from '../../shared/artifacts'
import { artifactCreatedAtMs } from '../../shared/artifacts'
import { DEFAULT_PERMISSION_PROFILE } from '../../shared/permission-profiles'
import type { PermissionProfileId } from '../../shared/permission-profiles'
import {
  ensureConversationRuntimeSegment,
  getActiveConversationContext
} from '../../shared/conversation-graph'
import {
  PROJECT_DESCRIPTION_MAX_LENGTH,
  PROJECT_NAME_MAX_LENGTH,
  type Project,
  type UpdateProjectRequest
} from '../../shared/projects'
import { buildConfiguredModelCatalog } from '../../shared/configured-model-catalog'
import {
  projectSessionDefaultsSchema,
  sessionAgentConfigurationSchema,
  sessionAgentConfigurationPatchSchema,
  updateProjectSessionDefaultsRequestSchema,
  updateSessionConfigurationRequestSchema,
  type ProjectSessionDefaults,
  type ProjectSessionDefaultsPatch,
  type SessionAgentConfigurationPatch,
  type SessionComputeHosts,
  type UpdateProjectSessionDefaultsRequest,
  type UpdateSessionConfigurationRequest
} from '../../shared/session-configuration'
import {
  resolveSelectableConfiguration,
  resolveSessionAgentConfiguration
} from '../../shared/session-agent-configuration'
import type {
  AgentFrameworkId,
  SessionAgentConfiguration,
  SettingsSnapshot
} from '../../shared/settings'
import {
  isSessionConfigurationBusyError,
  materializeSessionConversationGraph,
  type DelegationPolicy,
  type FailTaskSessionRunRequest,
  type PersistedArtifact,
  type PersistedChatMessage,
  type PersistedChatSession,
  type PersistedMessageImage,
  type PersistedToolActivity,
  type SettleTaskSessionCompletionRequest,
  type StageTaskSessionCompletionRequest
} from '../../shared/session-persistence'
import type {
  AcquiredTaskArtifact,
  CreateTaskProjectRequest,
  StartTaskRunRequest,
  TaskApiErrorCode,
  TaskProject,
  TaskProjectSessionDefaults,
  TaskRun,
  TaskRunStatus,
  TaskRunIdentity,
  TaskRunProgressEvent,
  TaskRunProgressPhase,
  TaskRunReview,
  TaskSessionSummary,
  TaskSessionConfiguration,
  UpdateTaskProjectRequest
} from '../../shared/task-api'
import { ArchiveAvailabilityError, archiveAvailabilityMessage } from '../archive/availability-error'
import { toErrorMessage } from '../error-message'
import { createLogger } from '../logger'
import type { TaskRunJournal, TaskRunJournalEntry } from './task-run-journal'

const log = createLogger('task-runner')

type TaskProjectPort = {
  list(): Promise<Project[]>
  create(request: CreateTaskProjectRequest): Promise<Project>
  update?(request: UpdateProjectRequest): Promise<Project>
}

type TaskSessionPort = {
  list(): Promise<PersistedChatSession[]>
  save(session: PersistedChatSession): Promise<PersistedChatSession>
  stageCompletion(request: StageTaskSessionCompletionRequest): Promise<PersistedChatSession>
  settleCompletion(request: SettleTaskSessionCompletionRequest): Promise<PersistedChatSession>
  failRun(request: FailTaskSessionRunRequest): Promise<PersistedChatSession>
  updateConfiguration(
    session: PersistedChatSession,
    expectedRevision: number
  ): Promise<PersistedChatSession>
  setDelegationPolicy(projectId: string, sessionId: string, policy: DelegationPolicy): Promise<void>
}

type TaskComputePreferencePort = {
  withReservation<Result>(
    providerIds: readonly string[],
    operation: (providerIds: string[]) => Promise<Result>
  ): Promise<Result>
  set(sessionId: string, providerIds: readonly string[]): Promise<PersistedChatSession>
  validate?(providerIds: readonly string[]): Promise<string[]>
  listAvailable?(): Promise<readonly string[]>
  project?(session: PersistedChatSession): void
}

type TaskSettingsPort = {
  get(): Promise<SettingsSnapshot>
}

type TaskPreviewResourcePort = {
  acquire(request: {
    source: 'artifact'
    path: string
    mimeType?: string
  }): Promise<{ id: string; url: string; size: number; mimeType?: string }>
  release(resourceId: string): Promise<void>
}

type TaskAgentSession = {
  sessionId: string
  providerSessionId?: string
  providerContinuityToken?: string
  cwd?: string
  frameworkId?: AgentFrameworkId
  backendId?: string
  contextReset?: boolean
  agentConfiguration?: SessionAgentConfiguration
}

type TaskAgentCreateSessionRequest = {
  projectId: string
  permissionProfile: PermissionProfileId
  cwd?: string
  specialistId?: string
  memoryEnabled?: boolean
  agentConfiguration?: SessionAgentConfiguration
}

type TaskAgentResumeSessionRequest = {
  sessionId: string
  providerSessionId?: string
  providerContinuityToken?: string
  cwd: string
  projectId: string
  permissionProfile: PermissionProfileId
  memoryEnabled?: boolean
  previousFrameworkId?: AgentFrameworkId
  previousBackendId?: string
  previousModel?: string
  specialistId?: string
  specialistBindingPending?: true
  agentConfiguration?: SessionAgentConfiguration
}

type TaskAgentPromptRequest = {
  sessionId: string
  promptMessageId: string
  provenanceContext: AgentTurnProvenanceContext
  text: string
  turnIntent?: 'plan-first'
  skillIds?: string[]
  historyPreamble?: string
  contextReset?: boolean
  resumeFallback?: { historyPreamble?: string }
}

type TaskAgentPromptObserver = {
  onPromptAdmitted?: () => Promise<AgentTurnProvenanceContext | undefined>
  onProviderPromptAccepted?: () => void
}

type TaskAgentPort = {
  withSessionAvailable<Result>(
    projectId: string,
    sessionId: string,
    operation: () => Promise<Result>
  ): Promise<Result>
  listAttachedSessionIds(): Promise<string[]>
  createSession(request: TaskAgentCreateSessionRequest): Promise<TaskAgentSession>
  resumeSession(request: TaskAgentResumeSessionRequest): Promise<TaskAgentSession>
  setPermissionProfile(sessionId: string, profile: PermissionProfileId): Promise<void>
  setMemoryEnabled(sessionId: string, enabled: boolean): Promise<void>
  prompt(request: TaskAgentPromptRequest, observer?: TaskAgentPromptObserver): Promise<void>
  cancelPrompt(sessionId: string): Promise<void>
}

type TaskArtifactPort = {
  finalizeRun(request: FinalizeRunArtifactsRequest): Promise<FinalizeRunArtifactsResult>
}

type TaskRuntimeEventPort = {
  subscribe(listener: (event: AcpRuntimeEvent) => void): () => void
}

type TaskSpecialistPort = {
  resolve(reference: string): Promise<{ id: string }>
}

type TaskReviewerPort = {
  review(
    session: PersistedChatSession,
    turnMessageId: string,
    signal: AbortSignal
  ): Promise<TaskRunReview>
}

type TaskRunnerDependencies = {
  projects: TaskProjectPort
  sessions: TaskSessionPort
  previewResources: TaskPreviewResourcePort
  agent: TaskAgentPort
  artifacts: TaskArtifactPort
  runtimeEvents: TaskRuntimeEventPort
  specialists: TaskSpecialistPort
  reviewer: TaskReviewerPort
  computePreferences: TaskComputePreferencePort
  settings: TaskSettingsPort
  isSessionBusy?: (projectId: string, sessionId: string) => boolean
  runWithLifecycleContext<Result>(operation: () => Result): Result
  runJournal?: TaskRunJournal
  createId: () => string
  now: () => number
}

type PendingTaskRunActivity = Omit<PersistedToolActivity, 'sortIndex'>

type TaskRunEventAccumulator = {
  assistantOutput: string
  assistantEventIds: string[]
  images: PersistedMessageImage[]
  imageBytes: number
  terminalStop?: Pick<AcpRuntimeEvent, 'turnUsage' | 'modelCallUsage'>
  runtimeError?: Pick<AcpRuntimeEvent, 'text' | 'providerError'>
  activities: Map<string, PendingTaskRunActivity>
  artifactClaimIds: string[]
}

type MutableTaskRun = TaskRun & {
  eventAccumulator?: TaskRunEventAccumulator
  completion: Promise<void>
  promptMessageId: string
  progressPhase: TaskRunProgressPhase
  providerAccepted: boolean
  firstVisibleOutput: boolean
  terminalStatus?: Exclude<TaskRunStatus, 'running'>
  sessionCommitBarrier?: Promise<void>
  sessionCommit?: {
    status: Exclude<TaskRunStatus, 'running'>
    completedAt: number
    output?: string
    error?: string
    failureCode?: TaskRun['failureCode']
    artifacts: ArtifactFile[]
    attention?: TaskRun['attention']
  }
  heartbeatTimer?: ReturnType<typeof setTimeout>
  reviewAbortController?: AbortController
  cancellation?: {
    accepted: boolean
    dispatch: Promise<void>
  }
}

type CompletedTaskSession = {
  session: PersistedChatSession
  output: string
  artifacts: ArtifactFile[]
  persistedArtifacts: PersistedArtifact[]
  messageId?: string
}

class PartialTaskCompletionError extends Error {
  constructor(
    readonly completion: CompletedTaskSession,
    readonly failure: unknown
  ) {
    super(toErrorMessage(failure))
    this.name = 'PartialTaskCompletionError'
  }
}

const MAX_RETAINED_RUNS = 200
const PROCESS_RESTARTED_MESSAGE = 'Run interrupted because Open Science restarted.'
const TASK_RUN_HEARTBEAT_INTERVAL_MS = 10_000
export const TASK_RUN_DISPOSAL_BUDGET_MS = 1000
const VISIBLE_PROVIDER_EVENT_KINDS = new Set<AcpRuntimeEvent['kind']>([
  'message',
  'thought',
  'tool',
  'plan',
  'artifact'
])

const isVisibleProviderEvent = (event: AcpRuntimeEvent): boolean =>
  event.role !== 'user' &&
  VISIBLE_PROVIDER_EVENT_KINDS.has(event.kind) &&
  Boolean(event.text?.trim() || event.title?.trim() || getAcpRuntimeEventImage(event))

const createTaskRunEventAccumulator = (): TaskRunEventAccumulator => ({
  assistantOutput: '',
  assistantEventIds: [],
  images: [],
  imageBytes: 0,
  activities: new Map(),
  artifactClaimIds: []
})

const accumulateToolActivity = (
  accumulator: TaskRunEventAccumulator,
  event: AcpRuntimeEvent
): void => {
  if (event.kind !== 'tool' || !event.toolCallId) return
  const existing = accumulator.activities.get(event.toolCallId)
  const isTerminal = existing?.status === 'completed' || existing?.status === 'failed'
  const eventIds = existing?.eventIds ?? []
  eventIds.push(event.id)
  accumulator.activities.set(event.toolCallId, {
    id: event.toolCallId,
    kind: 'tool',
    title: event.title?.trim() || existing?.title || 'Tool call',
    status: isTerminal
      ? existing.status
      : event.status === 'failed'
        ? 'failed'
        : event.status === 'completed'
          ? 'completed'
          : 'in_progress',
    eventIds,
    providerToolName: event.providerToolName ?? existing?.providerToolName,
    toolKind: event.toolKind ?? existing?.toolKind,
    toolContent: event.toolContent ?? existing?.toolContent,
    toolLocations: event.toolLocations ?? existing?.toolLocations,
    rawInput: event.rawInput ?? existing?.rawInput,
    rawOutput: event.rawOutput ?? existing?.rawOutput,
    terminalOutput: event.terminalOutput ?? existing?.terminalOutput,
    terminalExitCode: event.terminalExitCode ?? existing?.terminalExitCode,
    createdAt: existing?.createdAt ?? event.timestamp,
    updatedAt: isTerminal ? existing.updatedAt : event.timestamp
  })
}

const accumulateTaskRunEvent = (
  accumulator: TaskRunEventAccumulator,
  event: AcpRuntimeEvent
): void => {
  if (event.kind === 'message' && event.role === 'assistant') {
    accumulator.assistantOutput += getAcpRuntimeEventText(event) ?? ''
    accumulator.assistantEventIds.push(event.id)
    const image = getAcpRuntimeEventImage(event)
    if (
      image &&
      accumulator.images.length < MAX_ACP_MESSAGE_IMAGES_PER_MESSAGE &&
      accumulator.imageBytes + image.byteLength <= MAX_ACP_MESSAGE_IMAGE_BYTES_PER_MESSAGE
    ) {
      accumulator.images.push({ id: event.id, ...image })
      accumulator.imageBytes += image.byteLength
    }
  }
  if (event.kind === 'stop') {
    accumulator.terminalStop = {
      turnUsage: event.turnUsage,
      modelCallUsage: event.modelCallUsage
    }
  }
  if (event.kind === 'error' && event.text?.trim()) {
    accumulator.runtimeError = { text: event.text, providerError: event.providerError }
  }
  if (event.kind === 'artifact' && event.artifactClaimId) {
    accumulator.artifactClaimIds.push(event.artifactClaimId)
  }
  accumulateToolActivity(accumulator, event)
}

const createTaskRunActivities = (
  accumulator: TaskRunEventAccumulator,
  now: number
): PersistedToolActivity[] =>
  [...accumulator.activities.values()].map((activity, index) => ({
    ...activity,
    eventIds: [...activity.eventIds],
    sortIndex: now + index
  }))

const cloneRun = (run: MutableTaskRun): TaskRun => ({
  id: run.id,
  sessionId: run.sessionId,
  projectId: run.projectId,
  cwd: run.cwd,
  status: run.status,
  startedAt: run.startedAt,
  cancelRequestedAt: run.cancelRequestedAt,
  cancelledAt: run.cancelledAt,
  completedAt: run.completedAt,
  output: run.output,
  error: run.error,
  failureCode: run.failureCode,
  artifacts: [...run.artifacts],
  attention: run.attention,
  review: run.review,
  preferredComputeHostIds: [...run.preferredComputeHostIds]
})

const cloneRunForJournal = (run: MutableTaskRun): TaskRunJournalEntry => {
  const sessionCommit = run.sessionCommit
  return {
    ...cloneRun(run),
    status: run.terminalStatus ?? run.status,
    promptMessageId: run.promptMessageId,
    ...(sessionCommit
      ? {
          sessionCommitStatus: sessionCommit.status,
          completedAt: sessionCommit.completedAt,
          ...(sessionCommit.status === 'cancelled'
            ? { cancelledAt: sessionCommit.completedAt }
            : {}),
          output: sessionCommit.output,
          error: sessionCommit.error,
          failureCode: sessionCommit.failureCode,
          artifacts: [...sessionCommit.artifacts],
          attention: sessionCommit.attention
        }
      : {})
  }
}

const sessionOwnsTaskRunPrompt = (
  session: PersistedChatSession,
  run: Pick<TaskRunJournalEntry, 'id' | 'sessionId' | 'projectId' | 'promptMessageId'>
): boolean =>
  run.promptMessageId !== undefined &&
  session.id === run.sessionId &&
  session.projectId === run.projectId &&
  (session.activeRun?.promptMessageId === run.promptMessageId ||
    (session.status === 'error' &&
      session.activeRun === undefined &&
      session.resumeRecovery?.cause === 'app-restart' &&
      session.resumeRecovery.promptMessageId === run.promptMessageId))

const createTitle = (prompt: string): string => {
  const normalized = prompt.trim().replace(/\s+/g, ' ')
  return normalized.length <= 60 ? normalized : `${normalized.slice(0, 57)}...`
}

const createUserMessage = (
  id: string,
  content: string,
  now: number,
  turnIntent?: 'plan-first'
): PersistedChatMessage => ({
  id,
  role: 'user',
  content,
  status: 'complete',
  eventIds: [],
  ...(turnIntent ? { turnIntent } : {}),
  createdAt: now,
  updatedAt: now
})

const rebaseTaskTurnOntoLatestSession = (
  latest: PersistedChatSession,
  prepared: PersistedChatSession,
  contextReset: boolean
): PersistedChatSession => {
  const activeRun = prepared.activeRun
  const promptMessageId = activeRun?.promptMessageId
  const userMessage = prepared.messages.find((message) => message.id === promptMessageId)
  if (!activeRun || !userMessage) {
    throw new Error('Task prompt admission is missing its prepared user message.')
  }

  let rebased: PersistedChatSession = {
    ...latest,
    cwd: prepared.cwd,
    status: 'running',
    permissionProfile: prepared.permissionProfile,
    autoReviewEnabled: prepared.autoReviewEnabled,
    delegationPolicy: prepared.delegationPolicy,
    specialistId: prepared.specialistId,
    agentFrameworkId: prepared.agentFrameworkId,
    agentBackendId: prepared.agentBackendId,
    providerSessionId: prepared.providerSessionId,
    providerContinuityToken: prepared.providerContinuityToken,
    agentConfiguration: prepared.agentConfiguration,
    messages: [...latest.messages.filter((message) => message.id !== userMessage.id), userMessage],
    activeRun,
    error: undefined,
    updatedAt: prepared.updatedAt
  }
  delete rebased.resumeRecovery

  const currentGraph = materializeSessionConversationGraph(latest).conversationGraph
  const graphWithRuntime = ensureConversationRuntimeSegment(currentGraph, {
    id: `runtime-segment-${promptMessageId}`,
    frameworkId: rebased.agentFrameworkId ?? 'claude-code',
    providerId: rebased.agentConfiguration?.providerId,
    backendId: rebased.agentBackendId,
    model: rebased.agentModel,
    startedAt: activeRun.startedAt,
    forceNew: contextReset
  })
  if (graphWithRuntime.runtimeSegments.length !== currentGraph.runtimeSegments.length) {
    rebased = materializeSessionConversationGraph({
      ...rebased,
      conversationGraph: graphWithRuntime
    })
  }
  return rebased
}

const toPersistedArtifact = (
  artifact: ArtifactFile,
  fallbackCreatedAt?: number
): PersistedArtifact => {
  const createdAt =
    artifactCreatedAtMs(artifact.createdAt) ??
    (fallbackCreatedAt !== undefined && Number.isFinite(fallbackCreatedAt) && fallbackCreatedAt >= 0
      ? fallbackCreatedAt
      : undefined)
  return {
    id: artifact.id,
    kind: 'managed-file',
    path: artifact.path,
    fileUrl: artifact.fileUrl,
    name: artifact.name,
    mimeType: artifact.mimeType,
    size: artifact.size,
    ...(createdAt === undefined ? {} : { createdAt }),
    mtimeMs: artifact.mtimeMs
  }
}

const selectTaskHistoryMessages = (session: PersistedChatSession): PersistedChatMessage[] => {
  const cutoffMessageIds = [
    session.pendingHistoryReplay?.kind === 'before-message'
      ? session.pendingHistoryReplay.messageId
      : undefined,
    session.resumeRecovery?.promptMessageId
  ].filter((messageId): messageId is string => Boolean(messageId))
  let cutoffIndex = session.messages.length

  for (const messageId of cutoffMessageIds) {
    const index = session.messages.findIndex((message) => message.id === messageId)
    // A stale recovery reference must not turn an interrupted prompt into replay history.
    if (index < 0) return []
    cutoffIndex = Math.min(cutoffIndex, index)
  }

  return session.messages.slice(0, cutoffIndex)
}

const createHistoryPreamble = (messages: PersistedChatMessage[]): string | undefined => {
  if (messages.length === 0) return undefined
  const transcript = messages
    .filter((message) => message.status !== 'error' && message.content.trim())
    .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content}`)
    .join('\n\n')
  return transcript ? `Previous conversation:\n\n${transcript}` : undefined
}

const consumePendingHistoryReplay = (session: PersistedChatSession): PersistedChatSession => {
  if (!session.pendingHistoryReplay) return session
  const accepted = { ...session }
  delete accepted.pendingHistoryReplay
  return accepted
}

const summarizeSession = (session: PersistedChatSession): TaskSessionSummary => ({
  id: session.id,
  projectId: session.projectId,
  title: session.title,
  status: session.status,
  permissionProfile: session.permissionProfile,
  autoReviewEnabled: session.autoReviewEnabled === true,
  specialistId: session.specialistId,
  delegationPolicy: session.delegationPolicy === 'deny' ? 'deny' : 'allow',
  pinned: session.pinned === true,
  archivedAt: session.archivedAt,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
  output: [...session.messages].reverse().find((message) => message.role === 'agent')?.content,
  error: session.error,
  artifactCount: session.artifacts?.length ?? 0
})

const projectTaskProjection = (project: Project): TaskProject => ({
  id: project.id,
  name: project.name,
  description: project.description,
  isExample: project.isExample,
  ...(project.pinned ? { pinned: true } : {}),
  ...(project.archivedAt ? { archivedAt: project.archivedAt } : {}),
  createdAt: project.createdAt,
  updatedAt: project.updatedAt,
  hasAgentContext: Boolean(project.agentContext?.trim())
})

const taskModelCatalog = (
  settings: SettingsSnapshot
): ReturnType<typeof buildConfiguredModelCatalog> => {
  const framework = settings.agentFrameworks.find(
    (candidate) => candidate.id === settings.agentFrameworkId
  )
  return buildConfiguredModelCatalog({
    providers: settings.providers,
    activeProviderId: settings.activeProviderId,
    claudeSubscriptionProviderId: settings.claudeSubscriptionProviderId,
    includeAllClaudeSubscriptions: true,
    frameworkId: settings.agentFrameworkId,
    frameworkEndpoints: framework?.supportedApiTypes ?? ['anthropic']
  })
}

const validateTaskAgentConfiguration = (
  configuration: SessionAgentConfiguration,
  settings: SettingsSnapshot
): SessionAgentConfiguration => {
  const resolved = resolveSelectableConfiguration(
    taskModelCatalog(settings),
    configuration.providerId,
    configuration.model,
    configuration.reasoningEffort
  )
  if (!resolved) {
    throw new TaskRunnerError(
      'invalid_configuration',
      'The provider, model, and reasoning effort are not available for the active Agent Framework.'
    )
  }
  return resolved
}

const effectiveTaskAgentConfiguration = (
  session: Pick<PersistedChatSession, 'agentBackendId' | 'agentModel' | 'agentConfiguration'>,
  settings: SettingsSnapshot
): SessionAgentConfiguration | undefined => {
  const resolution = resolveSessionAgentConfiguration({
    session,
    catalog: taskModelCatalog(settings),
    activeProviderId: settings.activeProviderId,
    activeModel: settings.activeModel,
    activeReasoningEffort: settings.reasoningEffort
  })
  return resolution.configuration
}

const mergeAgentConfigurationPatch = (
  current: SessionAgentConfiguration | undefined,
  patch: SessionAgentConfigurationPatch
): SessionAgentConfiguration => {
  if (
    patch.providerId !== undefined &&
    patch.providerId !== current?.providerId &&
    patch.model === undefined
  ) {
    throw new TaskRunnerError(
      'invalid_configuration',
      'A provider change requires an explicit model or provider-default model reset.'
    )
  }
  const providerId = patch.providerId ?? current?.providerId
  if (!providerId) {
    throw new TaskRunnerError(
      'invalid_configuration',
      'Provider is required when the Session has no effective agent configuration.'
    )
  }
  const model = patch.model === null ? undefined : (patch.model ?? current?.model)
  return {
    providerId,
    ...(model ? { model } : {}),
    reasoningEffort: patch.reasoningEffort ?? current?.reasoningEffort ?? 'default'
  }
}

const computeHostsFromSession = (session: PersistedChatSession): SessionComputeHosts => ({
  enabled: [...(session.enabledComputeHosts ?? [])],
  selected: [...(session.selectedComputeHosts ?? session.enabledComputeHosts ?? [])]
})

const applyProjectDefaultsPatch = (
  current: ProjectSessionDefaults,
  patch: ProjectSessionDefaultsPatch
): ProjectSessionDefaults => {
  const next: Record<string, unknown> = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key]
    else next[key] = value
  }
  return projectSessionDefaultsSchema.parse(next)
}

class TaskRunnerError extends Error {
  constructor(
    readonly code: TaskApiErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'TaskRunnerError'
  }
}

const isMissingPathError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'

const canonicalizeTaskWorkingDirectory = async (value: string): Promise<string> => {
  const cwd = value.trim()
  if (!cwd) {
    throw new TaskRunnerError(
      'invalid_request',
      'Working directory is required when cwd is supplied.'
    )
  }
  if (!isAbsolute(cwd)) {
    throw new TaskRunnerError('invalid_request', 'Working directory must be an absolute path.')
  }
  let canonicalCwd: string
  try {
    canonicalCwd = await realpath(cwd)
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new TaskRunnerError('invalid_request', `Working directory does not exist: ${cwd}`)
    }
    throw new TaskRunnerError('invalid_request', `Working directory is not accessible: ${cwd}`)
  }
  let metadata: Awaited<ReturnType<typeof stat>>
  try {
    metadata = await stat(canonicalCwd)
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new TaskRunnerError('invalid_request', `Working directory does not exist: ${cwd}`)
    }
    throw new TaskRunnerError('invalid_request', `Working directory is not accessible: ${cwd}`)
  }
  if (!metadata.isDirectory()) {
    throw new TaskRunnerError('invalid_request', `Working directory is not a directory: ${cwd}`)
  }
  try {
    await access(canonicalCwd, constants.R_OK | constants.W_OK)
  } catch {
    throw new TaskRunnerError(
      'invalid_request',
      `Working directory must be readable and writable: ${cwd}`
    )
  }
  return canonicalCwd
}

class TaskRunner {
  private readonly runs = new Map<string, MutableTaskRun>()
  private readonly activeRunBySession = new Map<string, string>()
  private readonly progressListeners = new Set<(event: TaskRunProgressEvent) => void>()
  private readonly unsubscribeEvents: () => void
  private initialization: Promise<void> | undefined
  private journalWriteTail = Promise.resolve()
  private disposed = false
  private disposal: Promise<void> | undefined

  constructor(private readonly dependencies: TaskRunnerDependencies) {
    this.unsubscribeEvents = dependencies.runtimeEvents.subscribe((event) =>
      this.captureEvent(event)
    )
  }

  initialize(): Promise<void> {
    if (!this.initialization) {
      const attempt = this.restoreRuns().catch((error) => {
        if (this.initialization === attempt) this.initialization = undefined
        throw error
      })
      this.initialization = attempt
    }
    return this.initialization
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.disposed = true
    this.unsubscribeEvents()
    const activeReviewCompletions: Promise<void>[] = []
    for (const run of this.runs.values()) {
      this.stopHeartbeat(run)
      if (!run.reviewAbortController) continue
      run.reviewAbortController.abort()
      activeReviewCompletions.push(run.completion)
    }
    this.progressListeners.clear()
    const settleBackgroundWork = Promise.allSettled([
      ...activeReviewCompletions,
      this.journalWriteTail
    ]).then(() => undefined)
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, TASK_RUN_DISPOSAL_BUDGET_MS)
      timer.unref?.()
    })
    this.disposal = Promise.race([settleBackgroundWork, deadline]).finally(() => {
      if (timer) clearTimeout(timer)
    })
    return this.disposal
  }

  subscribeProgress(listener: (event: TaskRunProgressEvent) => void): () => void {
    this.progressListeners.add(listener)
    return () => this.progressListeners.delete(listener)
  }

  resolveActiveRun(sessionId: string, promptMessageId?: string): TaskRunIdentity | undefined {
    const runId = this.activeRunBySession.get(sessionId)
    const run = runId ? this.runs.get(runId) : undefined
    if (!run || run.status !== 'running' || run.terminalStatus) return undefined
    if (promptMessageId !== undefined && promptMessageId !== run.promptMessageId) return undefined
    return { runId: run.id, sessionId: run.sessionId, projectId: run.projectId }
  }

  async listProjects(): Promise<TaskProject[]> {
    return (await this.dependencies.projects.list()).map(projectTaskProjection)
  }

  async createProject(request: CreateTaskProjectRequest): Promise<TaskProject> {
    if (!request || typeof request.name !== 'string' || !request.name.trim()) {
      throw new TaskRunnerError('invalid_request', 'Project name is required.')
    }
    if (request.name.length > PROJECT_NAME_MAX_LENGTH) {
      throw new TaskRunnerError(
        'invalid_request',
        `Project name must not exceed ${PROJECT_NAME_MAX_LENGTH} characters.`
      )
    }
    if (request.description !== undefined && typeof request.description !== 'string') {
      throw new TaskRunnerError('invalid_request', 'Project description must be a string.')
    }
    if ((request.description?.length ?? 0) > PROJECT_DESCRIPTION_MAX_LENGTH) {
      throw new TaskRunnerError(
        'invalid_request',
        `Project description must not exceed ${PROJECT_DESCRIPTION_MAX_LENGTH} characters.`
      )
    }
    if (request.agentContext !== undefined && typeof request.agentContext !== 'string') {
      throw new TaskRunnerError('invalid_request', 'Project Agent Context must be a string.')
    }
    if ((request.agentContext?.length ?? 0) > 16_000) {
      throw new TaskRunnerError(
        'invalid_request',
        'Project Agent Context must not exceed 16000 characters.'
      )
    }
    return projectTaskProjection(await this.dependencies.projects.create(request))
  }

  async updateProject(projectId: string, request: UpdateTaskProjectRequest): Promise<TaskProject> {
    const project = await this.resolveProject(projectId)
    if (!request || typeof request !== 'object') {
      throw new TaskRunnerError('invalid_request', 'Project update must be an object.')
    }
    if (
      request.name === undefined &&
      request.description === undefined &&
      request.agentContext === undefined
    ) {
      throw new TaskRunnerError('invalid_request', 'Project update requires at least one field.')
    }
    if (request.name !== undefined) {
      if (typeof request.name !== 'string' || !request.name.trim()) {
        throw new TaskRunnerError('invalid_request', 'Project name is required.')
      }
      if (request.name.length > PROJECT_NAME_MAX_LENGTH) {
        throw new TaskRunnerError(
          'invalid_request',
          `Project name must not exceed ${PROJECT_NAME_MAX_LENGTH} characters.`
        )
      }
    }
    if (request.description !== undefined && typeof request.description !== 'string') {
      throw new TaskRunnerError('invalid_request', 'Project description must be a string.')
    }
    if ((request.description?.length ?? 0) > PROJECT_DESCRIPTION_MAX_LENGTH) {
      throw new TaskRunnerError(
        'invalid_request',
        `Project description must not exceed ${PROJECT_DESCRIPTION_MAX_LENGTH} characters.`
      )
    }
    if (request.agentContext !== undefined && typeof request.agentContext !== 'string') {
      throw new TaskRunnerError('invalid_request', 'Project Agent Context must be a string.')
    }
    if ((request.agentContext?.length ?? 0) > 16_000) {
      throw new TaskRunnerError(
        'invalid_request',
        'Project Agent Context must not exceed 16000 characters.'
      )
    }
    if (!Number.isSafeInteger(request.expectedUpdatedAt) || request.expectedUpdatedAt <= 0) {
      throw new TaskRunnerError('invalid_request', 'Project update timestamp is invalid.')
    }
    if (!this.dependencies.projects.update) {
      throw new Error('Task Project update is unavailable.')
    }
    try {
      const updateRequest: UpdateProjectRequest = {
        id: project.id,
        expectedUpdatedAt: request.expectedUpdatedAt,
        ...(request.name !== undefined ? { name: request.name } : {}),
        ...(request.description !== undefined ? { description: request.description } : {}),
        ...(request.agentContext !== undefined ? { agentContext: request.agentContext } : {})
      }
      return projectTaskProjection(await this.dependencies.projects.update(updateRequest))
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === 'Project changed elsewhere.' || error.message === 'Project not found.')
      ) {
        throw new TaskRunnerError(
          'project_conflict',
          'Project changed elsewhere. Refresh it and try again.'
        )
      }
      throw error
    }
  }

  async listSessions(projectId?: string): Promise<TaskSessionSummary[]> {
    const sessions = await this.dependencies.sessions.list()
    if (!projectId) return sessions.map(summarizeSession)
    const resolved = await this.resolveProject(projectId)
    return sessions.filter((session) => session.projectId === resolved.id).map(summarizeSession)
  }

  async getSession(sessionId: string): Promise<TaskSessionSummary> {
    return summarizeSession(await this.findSession(sessionId))
  }

  async ensureSessionAttached(sessionId: string): Promise<PersistedChatSession> {
    const session = await this.findSession(sessionId)
    const attachedSessionIds = await this.dependencies.agent.listAttachedSessionIds()
    if (attachedSessionIds.includes(session.id)) return session

    await this.dependencies.agent.resumeSession({
      sessionId: session.id,
      cwd: session.cwd,
      projectId: session.projectId,
      permissionProfile: session.permissionProfile ?? DEFAULT_PERMISSION_PROFILE,
      previousFrameworkId: session.agentFrameworkId,
      previousBackendId: session.agentBackendId,
      previousModel: session.agentModel,
      providerSessionId: session.providerSessionId,
      providerContinuityToken: session.providerContinuityToken,
      memoryEnabled: session.memoryEnabled !== false,
      ...(session.specialistId ? { specialistId: session.specialistId } : {}),
      ...(session.specialistBindingPending === true ? { specialistBindingPending: true } : {}),
      ...(session.agentConfiguration ? { agentConfiguration: session.agentConfiguration } : {})
    })
    return session
  }

  async getSessionConfiguration(sessionId: string): Promise<TaskSessionConfiguration> {
    const [session, settings, availableComputeHosts] = await Promise.all([
      this.findSession(sessionId),
      this.dependencies.settings.get(),
      this.dependencies.computePreferences.listAvailable?.() ?? Promise.resolve([])
    ])
    const effectiveAgentConfiguration = effectiveTaskAgentConfiguration(session, settings)
    const availabilityAgentConfiguration = session.agentConfiguration ?? effectiveAgentConfiguration
    const computeHosts = computeHostsFromSession(session)
    return {
      sessionId: session.id,
      projectId: session.projectId,
      revision: session.revision ?? 0,
      cwd: session.cwd,
      ...(session.specialistId ? { specialistId: session.specialistId } : {}),
      persisted: {
        ...(session.agentConfiguration ? { agentConfiguration: session.agentConfiguration } : {}),
        ...(session.permissionProfile ? { permissionProfile: session.permissionProfile } : {}),
        ...(session.autoReviewEnabled !== undefined
          ? { autoReviewEnabled: session.autoReviewEnabled }
          : {}),
        ...(session.memoryEnabled !== undefined ? { memoryEnabled: session.memoryEnabled } : {}),
        ...(session.delegationPolicy ? { delegationPolicy: session.delegationPolicy } : {}),
        computeHosts
      },
      effective: {
        ...(effectiveAgentConfiguration ? { agentConfiguration: effectiveAgentConfiguration } : {}),
        permissionProfile: session.permissionProfile ?? DEFAULT_PERMISSION_PROFILE,
        autoReviewEnabled: session.autoReviewEnabled === true,
        memoryEnabled: session.memoryEnabled !== false,
        delegationPolicy: session.delegationPolicy ?? 'allow',
        computeHosts
      },
      availability: {
        ...(availabilityAgentConfiguration
          ? {
              agentConfiguration: this.agentConfigurationAvailability(
                availabilityAgentConfiguration,
                settings
              )
            }
          : {}),
        ...(session.specialistId
          ? { specialist: await this.specialistAvailability(session.specialistId) }
          : {}),
        computeHosts: this.computeAvailability(computeHosts, availableComputeHosts)
      }
    }
  }

  async updateSessionConfiguration(
    sessionId: string,
    request: UpdateSessionConfigurationRequest
  ): Promise<TaskSessionConfiguration> {
    const parsed = updateSessionConfigurationRequestSchema.safeParse(request)
    if (
      !request ||
      typeof request !== 'object' ||
      !Number.isSafeInteger(request.expectedRevision) ||
      request.expectedRevision < 0 ||
      !parsed.success ||
      Object.keys(parsed.data).length === 1
    ) {
      throw new TaskRunnerError('invalid_request', 'Invalid Session configuration update.')
    }
    const session = await this.findSession(sessionId)
    if ((session.revision ?? 0) !== request.expectedRevision) {
      throw new TaskRunnerError(
        'session_revision_conflict',
        `Session revision conflict: expected ${request.expectedRevision}, actual ${session.revision ?? 0}.`
      )
    }
    if (
      this.activeRunBySession.has(session.id) ||
      this.dependencies.isSessionBusy?.(session.projectId, session.id) === true ||
      (session.status !== 'idle' && session.status !== 'error')
    ) {
      throw new TaskRunnerError('session_busy', `Session has active work: ${session.id}`)
    }
    const settings = await this.dependencies.settings.get()
    const patch = parsed.data
    const agentConfiguration = patch.agentConfiguration
      ? validateTaskAgentConfiguration(
          mergeAgentConfigurationPatch(
            session.agentConfiguration ?? effectiveTaskAgentConfiguration(session, settings),
            patch.agentConfiguration
          ),
          settings
        )
      : session.agentConfiguration
    if (patch.computeHosts) {
      await this.validateComputeHosts([
        ...patch.computeHosts.enabled,
        ...patch.computeHosts.selected
      ])
    }
    const next: PersistedChatSession = {
      ...session,
      ...(patch.agentConfiguration ? { agentConfiguration } : {}),
      ...(patch.permissionProfile !== undefined
        ? { permissionProfile: patch.permissionProfile }
        : {}),
      ...(patch.autoReviewEnabled !== undefined
        ? { autoReviewEnabled: patch.autoReviewEnabled }
        : {}),
      ...(patch.memoryEnabled !== undefined ? { memoryEnabled: patch.memoryEnabled } : {}),
      ...(patch.delegationPolicy !== undefined ? { delegationPolicy: patch.delegationPolicy } : {}),
      ...(patch.computeHosts
        ? {
            enabledComputeHosts: [...new Set(patch.computeHosts.enabled)],
            selectedComputeHosts: [...new Set(patch.computeHosts.selected)]
          }
        : {}),
      updatedAt: Math.max(session.updatedAt + 1, this.dependencies.now())
    }
    try {
      const persisted = await this.dependencies.sessions.updateConfiguration(
        next,
        request.expectedRevision
      )
      this.dependencies.computePreferences.project?.(persisted)
    } catch (error) {
      if (isSessionConfigurationBusyError(error)) {
        throw new TaskRunnerError('session_busy', error.message)
      }
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'session-revision-conflict'
      ) {
        throw new TaskRunnerError(
          'session_revision_conflict',
          error instanceof Error ? error.message : 'Session revision conflict.'
        )
      }
      throw error
    }
    if (
      patch.memoryEnabled !== undefined &&
      (await this.dependencies.agent.listAttachedSessionIds()).includes(session.id)
    ) {
      try {
        await this.dependencies.agent.setMemoryEnabled(session.id, patch.memoryEnabled)
      } catch (error) {
        if ((await this.dependencies.agent.listAttachedSessionIds()).includes(session.id)) {
          throw error
        }
      }
    }
    return this.getSessionConfiguration(sessionId)
  }

  async getProjectSessionDefaults(projectId: string): Promise<TaskProjectSessionDefaults> {
    const project = await this.resolveProject(projectId)
    return this.projectSessionDefaultsProjection(project)
  }

  async updateProjectSessionDefaults(
    projectId: string,
    request: UpdateProjectSessionDefaultsRequest
  ): Promise<TaskProjectSessionDefaults> {
    const parsed = updateProjectSessionDefaultsRequestSchema.safeParse(request)
    if (!parsed.success || Object.keys(parsed.data.patch).length === 0) {
      throw new TaskRunnerError('invalid_request', 'Invalid Project Session defaults update.')
    }
    const project = await this.resolveProject(projectId)
    const patch: ProjectSessionDefaultsPatch = { ...parsed.data.patch }
    if (typeof patch.specialistId === 'string') {
      try {
        patch.specialistId = (await this.dependencies.specialists.resolve(patch.specialistId)).id
      } catch (error) {
        throw new TaskRunnerError('specialist_not_found', toErrorMessage(error))
      }
    }
    const settings = await this.dependencies.settings.get()
    if (patch.agentConfiguration) {
      patch.agentConfiguration = validateTaskAgentConfiguration(
        mergeAgentConfigurationPatch(
          project.sessionDefaults?.agentConfiguration ??
            effectiveTaskAgentConfiguration({}, settings),
          patch.agentConfiguration
        ),
        settings
      )
    }
    const defaults = applyProjectDefaultsPatch(project.sessionDefaults ?? {}, patch)
    if (defaults.computeHosts) {
      await this.validateComputeHosts([
        ...defaults.computeHosts.enabled,
        ...defaults.computeHosts.selected
      ])
    }
    try {
      const updated = await this.dependencies.projects.update?.({
        id: project.id,
        expectedUpdatedAt: parsed.data.expectedUpdatedAt,
        sessionDefaults: defaults
      })
      if (!updated) throw new Error('Task Project update is unavailable.')
      return this.projectSessionDefaultsProjection(updated)
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === 'Project changed elsewhere.' || error.message === 'Project not found.')
      ) {
        throw new TaskRunnerError(
          'project_conflict',
          'Project changed elsewhere. Refresh it and try again.'
        )
      }
      throw error
    }
  }

  async listArtifacts(sessionId: string): Promise<PersistedArtifact[]> {
    return [...((await this.findSession(sessionId)).artifacts ?? [])]
  }

  async acquireArtifact(artifactId: string): Promise<AcquiredTaskArtifact> {
    const sessions = await this.dependencies.sessions.list()
    const artifact = sessions
      .flatMap((session) => session.artifacts ?? [])
      .find((candidate) => candidate.id === artifactId)
    if (!artifact) {
      throw new TaskRunnerError('artifact_not_found', `Artifact not found: ${artifactId}`)
    }
    const resource = await this.dependencies.previewResources.acquire({
      source: 'artifact',
      path: artifact.path,
      mimeType: artifact.mimeType
    })
    return {
      resourceId: resource.id,
      url: resource.url,
      name: artifact.name ?? artifact.path.split(/[\\/]/).at(-1) ?? artifact.id,
      mimeType: resource.mimeType ?? artifact.mimeType,
      size: resource.size
    }
  }

  async releaseArtifact(resourceId: string): Promise<void> {
    await this.dependencies.previewResources.release(resourceId)
  }

  async startRun(request: StartTaskRunRequest): Promise<TaskRun> {
    await this.initialize()
    if (!request || typeof request !== 'object') {
      throw new TaskRunnerError('invalid_request', 'Run request must be an object.')
    }
    if (typeof request.project !== 'string' || !request.project.trim()) {
      throw new TaskRunnerError('invalid_request', 'Project is required.')
    }
    if (request.sessionId !== undefined && typeof request.sessionId !== 'string') {
      throw new TaskRunnerError('invalid_request', 'Session id must be a string.')
    }
    if (request.cwd !== undefined && typeof request.cwd !== 'string') {
      throw new TaskRunnerError('invalid_request', 'Working directory must be a string.')
    }
    if (
      request.permissionProfile !== undefined &&
      !['ask', 'auto', 'full'].includes(request.permissionProfile)
    ) {
      throw new TaskRunnerError('invalid_request', 'Approval profile must be ask, auto, or full.')
    }
    if (
      request.skillIds !== undefined &&
      (!Array.isArray(request.skillIds) ||
        request.skillIds.some((skillId) => typeof skillId !== 'string' || !skillId.trim()))
    ) {
      throw new TaskRunnerError('invalid_request', 'Skill ids must be non-empty strings.')
    }
    if (request.turnIntent !== undefined && request.turnIntent !== 'plan-first') {
      throw new TaskRunnerError('invalid_request', 'Turn intent must be plan-first.')
    }
    if (request.autoReviewEnabled !== undefined && typeof request.autoReviewEnabled !== 'boolean') {
      throw new TaskRunnerError('invalid_request', 'Auto review must be a boolean.')
    }
    if (
      request.specialist !== undefined &&
      (typeof request.specialist !== 'string' || !request.specialist.trim())
    ) {
      throw new TaskRunnerError('invalid_request', 'Specialist must be a non-empty id or name.')
    }
    if (
      request.delegationPolicy !== undefined &&
      request.delegationPolicy !== 'allow' &&
      request.delegationPolicy !== 'deny'
    ) {
      throw new TaskRunnerError('invalid_request', 'Delegation policy must be allow or deny.')
    }
    if (
      request.computeHostIds !== undefined &&
      (!Array.isArray(request.computeHostIds) ||
        request.computeHostIds.some(
          (providerId) => typeof providerId !== 'string' || !providerId.trim()
        ))
    ) {
      throw new TaskRunnerError('invalid_request', 'Compute Host ids must be non-empty strings.')
    }
    if (
      request.enabledComputeHostIds !== undefined &&
      (!Array.isArray(request.enabledComputeHostIds) ||
        request.enabledComputeHostIds.some(
          (providerId) => typeof providerId !== 'string' || !providerId.trim()
        ))
    ) {
      throw new TaskRunnerError(
        'invalid_request',
        'Enabled Compute Host ids must be non-empty strings.'
      )
    }
    if (
      request.agentConfiguration !== undefined &&
      !sessionAgentConfigurationPatchSchema.safeParse(request.agentConfiguration).success
    ) {
      throw new TaskRunnerError('invalid_request', 'Invalid Session agent configuration.')
    }
    if (request.memoryEnabled !== undefined && typeof request.memoryEnabled !== 'boolean') {
      throw new TaskRunnerError('invalid_request', 'Memory must be a boolean.')
    }
    const prompt = typeof request.prompt === 'string' ? request.prompt.trim() : ''
    if (!prompt) throw new TaskRunnerError('invalid_request', 'Prompt is required.')
    const cwd =
      request.cwd === undefined ? undefined : await canonicalizeTaskWorkingDirectory(request.cwd)
    let normalizedRequest: StartTaskRunRequest = cwd === undefined ? request : { ...request, cwd }

    const project = await this.resolveProject(request.project)
    if (project.archivedAt !== undefined) {
      throw new TaskRunnerError('project_archived', archiveAvailabilityMessage('project-archived'))
    }
    const sessions = await this.dependencies.sessions.list()
    const existing = request.sessionId
      ? sessions.find((session) => session.id === request.sessionId)
      : undefined
    if (request.sessionId && !existing) {
      throw new TaskRunnerError('session_not_found', `Session not found: ${request.sessionId}`)
    }
    if (existing?.archivedAt !== undefined) {
      throw new TaskRunnerError('session_archived', archiveAvailabilityMessage('session-archived'))
    }
    if (existing && existing.projectId !== project.id) {
      throw new TaskRunnerError(
        'invalid_request',
        `Session ${existing.id} does not belong to project ${project.id}.`
      )
    }
    if (
      existing &&
      (request.agentConfiguration !== undefined ||
        request.memoryEnabled !== undefined ||
        request.enabledComputeHostIds !== undefined)
    ) {
      throw new TaskRunnerError(
        'invalid_request',
        'Provider, model, reasoning effort, memory, and enabled Compute Hosts must be changed with session config update before resuming an existing Session.'
      )
    }
    if (existing && cwd !== undefined) {
      const existingCwd = await canonicalizeTaskWorkingDirectory(existing.cwd)
      if (cwd !== existingCwd) {
        throw new TaskRunnerError(
          'invalid_request',
          `Working directory does not match Session ${existing.id}.`
        )
      }
    }
    if (
      existing?.status === 'waiting-plan-approval' &&
      existing.runtimeContext?.plan?.approval === 'pending'
    ) {
      throw new TaskRunnerError(
        'session_busy',
        `Session is waiting for Plan approval: ${existing.id}`
      )
    }
    if (!existing) {
      const settings = await this.dependencies.settings.get()
      const defaults = project.sessionDefaults ?? {}
      const selectedComputeHosts = request.computeHostIds ?? defaults.computeHosts?.selected
      const configuredEnabledComputeHosts =
        request.enabledComputeHostIds === undefined
          ? defaults.computeHosts?.enabled
          : request.enabledComputeHostIds.length === 0
            ? []
            : [
                ...new Set([
                  ...(defaults.computeHosts?.enabled ?? []),
                  ...request.enabledComputeHostIds
                ])
              ]
      const enabledComputeHosts =
        configuredEnabledComputeHosts !== undefined || selectedComputeHosts !== undefined
          ? [
              ...new Set([
                ...(configuredEnabledComputeHosts ?? []),
                ...(selectedComputeHosts ?? [])
              ])
            ]
          : undefined
      const candidateAgentConfiguration = request.agentConfiguration
        ? mergeAgentConfigurationPatch(
            defaults.agentConfiguration ?? effectiveTaskAgentConfiguration({}, settings),
            request.agentConfiguration
          )
        : defaults.agentConfiguration
      normalizedRequest = {
        ...normalizedRequest,
        permissionProfile:
          request.permissionProfile ??
          defaults.permissionProfile ??
          settings.defaultPermissionProfile ??
          DEFAULT_PERMISSION_PROFILE,
        autoReviewEnabled: request.autoReviewEnabled ?? defaults.autoReviewEnabled ?? false,
        memoryEnabled: request.memoryEnabled ?? defaults.memoryEnabled ?? true,
        delegationPolicy: request.delegationPolicy ?? defaults.delegationPolicy ?? 'allow',
        ...(request.specialist !== undefined
          ? { specialist: request.specialist }
          : defaults.specialistId
            ? { specialist: defaults.specialistId }
            : {}),
        ...(candidateAgentConfiguration
          ? {
              agentConfiguration: validateTaskAgentConfiguration(
                candidateAgentConfiguration,
                settings
              )
            }
          : {}),
        ...(enabledComputeHosts !== undefined
          ? { enabledComputeHostIds: enabledComputeHosts }
          : {}),
        ...(selectedComputeHosts !== undefined ? { computeHostIds: selectedComputeHosts } : {})
      }
      if (normalizedRequest.enabledComputeHostIds !== undefined) {
        const enabled = new Set(normalizedRequest.enabledComputeHostIds)
        const invalidSelection = normalizedRequest.computeHostIds?.find(
          (providerId) => !enabled.has(providerId)
        )
        if (invalidSelection) {
          throw new TaskRunnerError(
            'invalid_configuration',
            `Selected Compute Host is not enabled: ${invalidSelection}`
          )
        }
        await this.validateComputeHosts(
          [...normalizedRequest.enabledComputeHostIds, ...(normalizedRequest.computeHostIds ?? [])],
          'invalid_request'
        )
      }
    }
    const userMessageId = this.dependencies.createId()
    const runId = this.dependencies.createId()
    if (existing) this.reserveSession(existing.id, runId)
    type PreparedSession = Awaited<ReturnType<TaskRunner['prepareSession']>>
    let accepted: { prepared: PreparedSession; session: PersistedChatSession; run: MutableTaskRun }
    try {
      const prepare = (
        requestForPreparation = normalizedRequest
      ): ReturnType<TaskRunner['prepareSession']> =>
        this.prepareSession(project, existing, requestForPreparation, prompt, userMessageId)
      const acceptPrepared = async (prepared: PreparedSession): Promise<typeof accepted> => {
        let session = prepared.session
        this.reserveSession(session.id, runId)
        const run = {
          id: runId,
          sessionId: session.id,
          projectId: project.id,
          cwd: session.cwd,
          status: 'running' as const,
          startedAt: this.dependencies.now(),
          artifacts: [],
          preferredComputeHostIds: [
            ...(session.selectedComputeHosts ?? session.enabledComputeHosts ?? [])
          ],
          eventAccumulator: createTaskRunEventAccumulator(),
          promptMessageId: session.activeRun!.promptMessageId,
          progressPhase: 'accepted' as const,
          providerAccepted: false,
          firstVisibleOutput: false,
          completion: Promise.resolve()
        } satisfies MutableTaskRun

        this.pruneRuns()
        this.runs.set(runId, run)
        try {
          await this.persistRuns()
        } catch (error) {
          this.runs.delete(runId)
          this.releaseSession(session.id, runId)
          await this.dependencies.sessions
            .save({
              ...session,
              status: 'error',
              activeRun: undefined,
              error: 'Task Run identity could not be persisted.',
              updatedAt: this.dependencies.now()
            })
            .catch(() => undefined)
          throw error
        }
        if (prepared.persistBeforeRunStart) {
          try {
            session = await this.dependencies.sessions.save(session)
          } catch (error) {
            await this.failUnpublishedRunAfterSessionSave(run, error)
            this.releaseSession(session.id, runId)
            throw error
          }
          run.cwd = session.cwd
          run.preferredComputeHostIds = [
            ...(session.selectedComputeHosts ?? session.enabledComputeHosts ?? [])
          ]
          try {
            await this.persistRuns()
          } catch (error) {
            await this.failUnpublishedRunAfterSessionSave(run, error)
            this.releaseSession(session.id, runId)
            throw error
          }
        }
        return { prepared, session, run }
      }
      if (existing) {
        accepted = await this.dependencies.agent.withSessionAvailable(
          project.id,
          existing.id,
          async () => acceptPrepared(await prepare())
        )
      } else if (normalizedRequest.computeHostIds !== undefined) {
        accepted = await this.dependencies.computePreferences.withReservation(
          normalizedRequest.computeHostIds,
          async (computeHostIds) => {
            normalizedRequest = { ...normalizedRequest, computeHostIds }
            return acceptPrepared(await prepare(normalizedRequest))
          }
        )
      } else {
        accepted = await acceptPrepared(await prepare())
      }
    } catch (error) {
      if (existing) this.releaseSession(existing.id, runId)
      if (error instanceof ComputeHostPreferenceValidationError) {
        throw new TaskRunnerError('invalid_request', error.message)
      }
      if (error instanceof ArchiveAvailabilityError) {
        throw new TaskRunnerError(
          error.code === 'project-archived' ? 'project_archived' : 'session_archived',
          error.message
        )
      }
      throw error
    }
    const { prepared, session, run } = accepted
    this.publishProgress(run, 'accepted')
    this.publishProgress(run, 'session-ready')
    this.scheduleHeartbeat(run)
    run.completion = this.executeRun(
      run,
      session,
      normalizedRequest,
      prompt,
      prepared.historyPreamble,
      prepared.contextReset,
      prepared.resumeFallback,
      prepared.persistOnPromptAdmission
    ).finally(() => this.releaseSession(session.id, runId))
    return cloneRun(run)
  }

  getRun(runId: string): TaskRun {
    const run = this.runs.get(runId)
    if (!run) throw new TaskRunnerError('run_not_found', `Run not found: ${runId}`)
    return cloneRun(run)
  }

  async waitForRun(runId: string): Promise<TaskRun> {
    const run = this.runs.get(runId)
    if (!run) throw new TaskRunnerError('run_not_found', `Run not found: ${runId}`)
    await run.completion
    return cloneRun(run)
  }

  async cancelRun(runId: string): Promise<TaskRun> {
    const run = this.runs.get(runId)
    if (!run) throw new TaskRunnerError('run_not_found', `Run not found: ${runId}`)
    if (run.status !== 'running') return cloneRun(run)
    if (run.terminalStatus) {
      await run.completion
      return cloneRun(run)
    }
    const existingCancellation = run.cancellation
    if (existingCancellation) {
      await existingCancellation.dispatch
      await run.completion
      return cloneRun(run)
    }

    run.cancelRequestedAt = this.dependencies.now()
    const cancellation = {
      accepted: false,
      dispatch: Promise.resolve()
    }
    const queuedJournalWrites = this.journalWriteTail
    run.cancellation = cancellation
    cancellation.dispatch = Promise.resolve()
      .then(async () => {
        await queuedJournalWrites
        const sessionCommitBarrier = run.sessionCommitBarrier
        if (sessionCommitBarrier) await sessionCommitBarrier
        await this.dependencies.agent.cancelPrompt(run.sessionId)
      })
      .then(async () => {
        if (run.sessionCommit && run.sessionCommit.status !== 'failed') {
          const cancelledAt = this.dependencies.now()
          await this.persistSessionCommit(run, {
            ...run.sessionCommit,
            status: 'cancelled',
            completedAt: cancelledAt,
            attention: undefined
          })
        }
        run.reviewAbortController?.abort()
        cancellation.accepted = true
      })
      .catch((error) => {
        if (run.status === 'running' && run.cancellation === cancellation) {
          run.cancellation = undefined
          run.cancelRequestedAt = undefined
        }
        throw error
      })

    await cancellation.dispatch
    await run.completion
    return cloneRun(run)
  }

  private async failUnpublishedRunAfterSessionSave(
    run: MutableTaskRun,
    failure: unknown
  ): Promise<void> {
    const message = toErrorMessage(failure)
    run.progressPhase = 'failed'
    run.error = message
    run.completedAt = this.dependencies.now()
    run.attention = undefined
    run.eventAccumulator = undefined
    try {
      await this.persistSessionCommit(
        run,
        {
          status: 'failed',
          completedAt: run.completedAt,
          error: message,
          artifacts: [...run.artifacts]
        },
        false
      )
    } catch (error) {
      log.error('Failed to stage a Task Run after its Session save reported an error.', {
        error: toErrorMessage(error),
        runId: run.id
      })
    }

    let session: PersistedChatSession | undefined
    try {
      session = (await this.dependencies.sessions.list()).find((candidate) =>
        sessionOwnsTaskRunPrompt(candidate, run)
      )
    } catch (error) {
      log.error('Failed to verify a Session after its save reported an error.', {
        error: toErrorMessage(error),
        runId: run.id
      })
      run.status = 'failed'
      await this.persistRunsBestEffort()
      return
    }
    if (!session) {
      run.sessionCommit = undefined
      run.status = 'failed'
      await this.persistRunsBestEffort()
      return
    }
    try {
      await this.dependencies.sessions.save({
        ...session,
        status: 'error',
        activeRun: undefined,
        taskRunCommitId: run.id,
        error: message,
        updatedAt: this.dependencies.now()
      })
    } catch (error) {
      log.error('Failed to reconcile a Session after its save reported an error.', {
        error: toErrorMessage(error),
        runId: run.id
      })
      run.status = 'failed'
      await this.persistRunsBestEffort()
      return
    }
    run.status = 'failed'
    await this.persistRunsBestEffort()
  }

  private reserveSession(sessionId: string, runId: string): void {
    const activeRunId = this.activeRunBySession.get(sessionId)
    if (activeRunId && activeRunId !== runId) {
      throw new TaskRunnerError('session_busy', `Session already has an active run: ${sessionId}`)
    }
    this.activeRunBySession.set(sessionId, runId)
  }

  private releaseSession(sessionId: string, runId: string): void {
    if (this.activeRunBySession.get(sessionId) === runId) {
      this.activeRunBySession.delete(sessionId)
    }
  }

  private async prepareSession(
    project: Project,
    existing: PersistedChatSession | undefined,
    request: StartTaskRunRequest,
    prompt: string,
    userMessageId: string
  ): Promise<{
    session: PersistedChatSession
    persistOnPromptAdmission: boolean
    persistBeforeRunStart: boolean
    historyPreamble?: string
    contextReset?: boolean
    resumeFallback?: TaskAgentPromptRequest['resumeFallback']
  }> {
    const now = this.dependencies.now()
    const permissionProfile =
      request.permissionProfile ?? existing?.permissionProfile ?? DEFAULT_PERMISSION_PROFILE
    const requestedSpecialist = request.specialist?.trim()
    let specialistId = existing?.specialistId
    if (requestedSpecialist) {
      let resolved: { id: string }
      try {
        resolved = await this.dependencies.specialists.resolve(requestedSpecialist)
      } catch (error) {
        throw new TaskRunnerError('specialist_not_found', toErrorMessage(error))
      }
      if (existing && existing.specialistId !== resolved.id) {
        throw new TaskRunnerError(
          'invalid_request',
          `Session ${existing.id} is bound to a different Specialist.`
        )
      }
      specialistId = resolved.id
    }
    const autoReviewEnabled = request.autoReviewEnabled ?? existing?.autoReviewEnabled ?? false
    const delegationPolicy: DelegationPolicy =
      request.delegationPolicy ?? existing?.delegationPolicy ?? 'allow'
    if (existing && request.computeHostIds !== undefined) {
      existing = await this.dependencies.computePreferences.set(existing.id, request.computeHostIds)
    }
    let sessionInfo: TaskAgentSession

    if (existing) {
      const attachedSessionIds = await this.dependencies.agent.listAttachedSessionIds()
      if (
        attachedSessionIds.includes(existing.id) &&
        !existing.agentConfiguration &&
        !existing.agentBackendId
      ) {
        await this.dependencies.agent.setPermissionProfile(existing.id, permissionProfile)
        await this.dependencies.agent.setMemoryEnabled(
          existing.id,
          existing.memoryEnabled !== false
        )
        sessionInfo = {
          sessionId: existing.id,
          cwd: existing.cwd,
          frameworkId: existing.agentFrameworkId,
          backendId: existing.agentBackendId,
          providerSessionId: existing.providerSessionId,
          providerContinuityToken: existing.providerContinuityToken
        }
      } else {
        sessionInfo = await this.dependencies.agent.resumeSession({
          sessionId: existing.id,
          cwd: existing.cwd,
          projectId: project.id,
          permissionProfile,
          previousFrameworkId: existing.agentFrameworkId,
          previousBackendId: existing.agentBackendId,
          previousModel: existing.agentModel,
          providerSessionId: existing.providerSessionId,
          providerContinuityToken: existing.providerContinuityToken,
          memoryEnabled: existing.memoryEnabled !== false,
          ...(specialistId ? { specialistId } : {}),
          ...(existing.specialistBindingPending === true ? { specialistBindingPending: true } : {}),
          ...(existing.agentConfiguration
            ? { agentConfiguration: existing.agentConfiguration }
            : {})
        })
      }
    } else {
      const parsedAgentConfiguration =
        request.agentConfiguration === undefined
          ? undefined
          : sessionAgentConfigurationSchema.safeParse(request.agentConfiguration)
      if (parsedAgentConfiguration && !parsedAgentConfiguration.success) {
        throw new TaskRunnerError(
          'invalid_configuration',
          'A new Session requires a complete agent configuration.'
        )
      }
      sessionInfo = await this.dependencies.agent.createSession({
        projectId: project.id,
        permissionProfile,
        ...(request.cwd ? { cwd: request.cwd } : {}),
        ...(specialistId ? { specialistId } : {}),
        ...(request.memoryEnabled === false ? { memoryEnabled: request.memoryEnabled } : {}),
        ...(parsedAgentConfiguration?.success
          ? { agentConfiguration: parsedAgentConfiguration.data }
          : {})
      })
    }

    if (existing) {
      const cwd = sessionInfo.cwd ?? existing.cwd
      const agentFrameworkId = sessionInfo.frameworkId ?? existing.agentFrameworkId
      const agentBackendId = sessionInfo.backendId ?? existing.agentBackendId
      const providerSessionId = sessionInfo.providerSessionId ?? existing.providerSessionId
      const providerContinuityToken = sessionInfo.providerContinuityToken
      const agentConfiguration = sessionInfo.agentConfiguration ?? existing.agentConfiguration
      const persistedPermissionProfile = request.permissionProfile ?? existing.permissionProfile
      const needsHistoryReplay = sessionInfo.contextReset === true && !existing.pendingHistoryReplay
      const setupChanged =
        cwd !== existing.cwd ||
        persistedPermissionProfile !== existing.permissionProfile ||
        agentFrameworkId !== existing.agentFrameworkId ||
        agentBackendId !== existing.agentBackendId ||
        providerSessionId !== existing.providerSessionId ||
        providerContinuityToken !== existing.providerContinuityToken ||
        !isDeepStrictEqual(agentConfiguration, existing.agentConfiguration) ||
        needsHistoryReplay
      if (setupChanged) {
        existing = await this.dependencies.sessions.save({
          ...existing,
          cwd,
          permissionProfile: persistedPermissionProfile,
          agentFrameworkId,
          agentBackendId,
          providerSessionId,
          providerContinuityToken,
          agentConfiguration,
          ...(needsHistoryReplay ? { pendingHistoryReplay: { kind: 'all' } } : {}),
          updatedAt: now
        })
      }
    }

    const userMessage = createUserMessage(userMessageId, prompt, now, request.turnIntent)
    const session: PersistedChatSession = existing
      ? {
          ...existing,
          cwd: sessionInfo.cwd ?? existing.cwd,
          status: 'running',
          permissionProfile,
          autoReviewEnabled,
          memoryEnabled: existing.memoryEnabled ?? true,
          delegationPolicy,
          specialistId,
          agentFrameworkId: sessionInfo.frameworkId ?? existing.agentFrameworkId,
          agentBackendId: sessionInfo.backendId ?? existing.agentBackendId,
          providerSessionId: sessionInfo.providerSessionId ?? existing.providerSessionId,
          providerContinuityToken: sessionInfo.providerContinuityToken,
          agentConfiguration: sessionInfo.agentConfiguration ?? existing.agentConfiguration,
          messages: [...existing.messages, userMessage],
          activeRun: { promptMessageId: userMessageId, startedAt: now },
          error: undefined,
          updatedAt: now
        }
      : {
          id: sessionInfo.sessionId,
          projectId: project.id,
          title: createTitle(prompt),
          cwd: request.cwd ?? sessionInfo.cwd ?? '',
          status: 'running',
          permissionProfile,
          autoReviewEnabled,
          memoryEnabled: request.memoryEnabled ?? true,
          delegationPolicy,
          specialistId,
          agentFrameworkId: sessionInfo.frameworkId,
          agentBackendId: sessionInfo.backendId,
          providerSessionId: sessionInfo.providerSessionId,
          providerContinuityToken: sessionInfo.providerContinuityToken,
          agentConfiguration: sessionInfo.agentConfiguration,
          ...(request.enabledComputeHostIds !== undefined || request.computeHostIds !== undefined
            ? {
                enabledComputeHosts: [
                  ...new Set(request.enabledComputeHostIds ?? request.computeHostIds ?? [])
                ],
                selectedComputeHosts: [...new Set(request.computeHostIds ?? [])]
              }
            : {}),
          messages: [userMessage],
          activeRun: { promptMessageId: userMessageId, startedAt: now },
          createdAt: now,
          updatedAt: now
        }

    if (existing && request.delegationPolicy !== undefined) {
      const setDelegationPolicy = this.dependencies.sessions.setDelegationPolicy
      if (!setDelegationPolicy) {
        throw new Error('Task delegation policy control is unavailable.')
      }
      await setDelegationPolicy(project.id, existing.id, request.delegationPolicy)
    }

    // Starting a new authored turn consumes the old Resume authority. History replay remains durable
    // until the provider accepts this replacement turn, so a pre-acceptance rejection can retry it.
    if (existing) {
      delete session.resumeRecovery
    }

    const contextReset = Boolean(sessionInfo.contextReset || existing?.pendingHistoryReplay)
    let sessionToCommit = session
    if (existing) {
      const currentGraph = materializeSessionConversationGraph(existing).conversationGraph
      const graphWithRuntime = ensureConversationRuntimeSegment(currentGraph, {
        id: `runtime-segment-${userMessageId}`,
        frameworkId: session.agentFrameworkId ?? 'claude-code',
        providerId: session.agentConfiguration?.providerId,
        backendId: session.agentBackendId,
        model: session.agentModel,
        startedAt: now,
        forceNew: contextReset
      })
      if (graphWithRuntime.runtimeSegments.length !== currentGraph.runtimeSegments.length) {
        sessionToCommit = materializeSessionConversationGraph({
          ...session,
          conversationGraph: graphWithRuntime
        })
      }
    }

    const persistOnPromptAdmission = existing !== undefined
    const previousHistoryPreamble = existing
      ? createHistoryPreamble(selectTaskHistoryMessages(existing))
      : undefined
    return {
      session: sessionToCommit,
      persistOnPromptAdmission,
      persistBeforeRunStart: existing === undefined,
      historyPreamble: contextReset ? previousHistoryPreamble : undefined,
      contextReset,
      resumeFallback:
        request.skillIds?.length && previousHistoryPreamble
          ? { historyPreamble: previousHistoryPreamble }
          : undefined
    }
  }

  private withLifecycleSessionAvailable<Result>(
    projectId: string,
    sessionId: string,
    operation: () => Promise<Result>
  ): Promise<Result> {
    return this.dependencies.runWithLifecycleContext(() =>
      this.dependencies.agent.withSessionAvailable(projectId, sessionId, operation)
    )
  }

  private async executeRun(
    run: MutableTaskRun,
    session: PersistedChatSession,
    request: StartTaskRunRequest,
    prompt: string,
    historyPreamble?: string,
    contextReset?: boolean,
    resumeFallback?: TaskAgentPromptRequest['resumeFallback'],
    persistOnPromptAdmission = false
  ): Promise<void> {
    let promptError: unknown
    let admissionPersistenceError: unknown
    let cancellationAtPromptFailure: MutableTaskRun['cancellation'] = undefined
    let admittedSession: PersistedChatSession | undefined = persistOnPromptAdmission
      ? undefined
      : session
    try {
      this.publishProgress(run, 'prompt-dispatched')
      const promptMessageId = session.activeRun!.promptMessageId
      const provenanceContext = getActiveConversationContext(
        materializeSessionConversationGraph(session).conversationGraph,
        promptMessageId
      )
      await this.dependencies.agent.prompt(
        {
          sessionId: session.id,
          promptMessageId,
          provenanceContext,
          text: prompt,
          ...(request.turnIntent ? { turnIntent: request.turnIntent } : {}),
          ...(request.skillIds?.length ? { skillIds: request.skillIds } : {}),
          ...(historyPreamble ? { historyPreamble } : {}),
          ...(contextReset ? { contextReset: true } : {}),
          ...(resumeFallback ? { resumeFallback } : {})
        },
        {
          ...(persistOnPromptAdmission
            ? {
                onPromptAdmitted: async () => {
                  return this.withLifecycleSessionAvailable(run.projectId, session.id, async () => {
                    const latestSession = (await this.dependencies.sessions.list()).find(
                      (candidate) => candidate.id === session.id
                    )
                    if (!latestSession || latestSession.projectId !== run.projectId) {
                      throw new Error(`Session not found for Task prompt admission: ${session.id}`)
                    }
                    const sessionToSave = rebaseTaskTurnOntoLatestSession(
                      latestSession,
                      session,
                      contextReset === true
                    )
                    // Once the durable save starts it may commit the Session before a derived
                    // projection rejects. Retain the admitted aggregate so failure cleanup can
                    // clear that partially committed active run.
                    admittedSession = sessionToSave
                    try {
                      const saved = await this.dependencies.sessions.save(sessionToSave)
                      admittedSession = saved
                      return getActiveConversationContext(
                        materializeSessionConversationGraph(saved).conversationGraph,
                        promptMessageId
                      )
                    } catch (error) {
                      admissionPersistenceError = error
                      throw error
                    }
                  })
                }
              }
            : {}),
          onProviderPromptAccepted: () => {
            if (run.status !== 'running' || run.providerAccepted) return
            run.providerAccepted = true
            this.publishProgress(run, 'provider-accepted')
          }
        }
      )
    } catch (error) {
      promptError = error
      cancellationAtPromptFailure = run.cancellation
    }

    if (admissionPersistenceError !== undefined) {
      await this.withLifecycleSessionAvailable(run.projectId, session.id, async () => {
        const latestSession = (await this.dependencies.sessions.list()).find(
          (candidate) => candidate.id === session.id && candidate.projectId === run.projectId
        )
        if (latestSession?.activeRun?.promptMessageId !== run.promptMessageId) return
        await this.failRun(run, latestSession, undefined, admissionPersistenceError)
      }).catch(() => undefined)
      if (run.status === 'running') {
        await this.failRun(run, session, undefined, admissionPersistenceError, false)
      }
      run.eventAccumulator = undefined
      return
    }

    if (!admittedSession) {
      const cancellation = run.cancellation
      if (cancellation) await cancellation.dispatch.catch(() => undefined)
      if (cancellationAtPromptFailure?.accepted === true) {
        run.attention = undefined
        const cancelledAt = this.dependencies.now()
        run.completedAt = cancelledAt
        run.cancelledAt = cancelledAt
        this.stopHeartbeat(run)
        await this.persistTerminalRun(run, 'cancelled').finally(() =>
          this.publishProgress(run, run.status === 'failed' ? 'failed' : 'cancelled')
        )
      } else {
        await this.failRun(
          run,
          session,
          undefined,
          promptError ?? new Error('Task Agent prompt completed without admission.'),
          false
        )
      }
      run.eventAccumulator = undefined
      return
    }

    const sessionAtAdmission = admittedSession
    return this.dependencies.runWithLifecycleContext(() =>
      this.finalizeAdmittedRun(run, sessionAtAdmission, promptError, cancellationAtPromptFailure)
    )
  }

  private async finalizeAdmittedRun(
    run: MutableTaskRun,
    admittedSession: PersistedChatSession,
    promptError: unknown,
    cancellationAtPromptFailure: MutableTaskRun['cancellation']
  ): Promise<void> {
    const acceptedSession =
      promptError === undefined ? consumePendingHistoryReplay(admittedSession) : admittedSession

    let completed: CompletedTaskSession | undefined
    let completionError: unknown
    try {
      completed = await this.completeSession(
        acceptedSession,
        run.eventAccumulator!,
        promptError === undefined
      )
    } catch (error) {
      if (error instanceof PartialTaskCompletionError) {
        completed = error.completion
        completionError = error.failure
      } else {
        completionError = error
      }
    }

    const cancellation = run.cancellation
    if (cancellation) await cancellation.dispatch.catch(() => undefined)
    const promptFailureWasCancelled = cancellationAtPromptFailure?.accepted === true
    const failure = completionError ?? (promptFailureWasCancelled ? undefined : promptError)
    if (failure) {
      await this.failRun(run, acceptedSession, completed, failure)
      run.eventAccumulator = undefined
      return
    }

    const sessionCommitCancellation = run.cancellation
    if (sessionCommitCancellation) {
      await sessionCommitCancellation.dispatch.catch(() => undefined)
    }
    const sessionCommitStatus =
      sessionCommitCancellation?.accepted === true ? 'cancelled' : 'completed'
    completed!.session = { ...completed!.session, taskRunCommitId: run.id }
    const sessionCommitAt = this.dependencies.now()
    const sessionCommit: NonNullable<MutableTaskRun['sessionCommit']> = {
      status: sessionCommitStatus,
      completedAt: sessionCommitAt,
      output: completed!.output,
      artifacts: completed!.artifacts,
      attention: sessionCommitStatus === 'completed' ? run.attention : undefined
    }
    this.stopHeartbeat(run)
    let releaseSessionCommitBarrier: (() => void) | undefined
    const sessionCommitBarrier = new Promise<void>((resolve) => {
      releaseSessionCommitBarrier = resolve
    })
    run.sessionCommitBarrier = sessionCommitBarrier
    try {
      await this.persistSessionCommit(run, sessionCommit)
    } catch (error) {
      const persistenceMessage = 'Task Run terminal state could not be persisted.'
      log.error(persistenceMessage, { error: toErrorMessage(error), runId: run.id })
      await this.failRun(run, acceptedSession, completed, new Error(persistenceMessage))
      run.eventAccumulator = undefined
      return
    } finally {
      if (run.sessionCommitBarrier === sessionCommitBarrier) {
        run.sessionCommitBarrier = undefined
      }
      releaseSessionCommitBarrier?.()
    }

    try {
      completed!.session = await this.dependencies.sessions.settleCompletion({
        projectId: completed!.session.projectId,
        sessionId: completed!.session.id,
        promptMessageId: run.promptMessageId,
        taskRunCommitId: run.id,
        messageId: completed!.messageId,
        artifacts: completed!.persistedArtifacts,
        updatedAt: this.dependencies.now()
      })
    } catch (error) {
      await this.failRun(run, acceptedSession, completed, error)
      run.eventAccumulator = undefined
      return
    }
    run.eventAccumulator = undefined
    if (!this.disposed && !run.cancellation && completed!.session.autoReviewEnabled === true) {
      const reviewedMessage = [...completed!.session.messages]
        .reverse()
        .find(
          (message) =>
            message.role === 'agent' && message.responseToMessageId === run.promptMessageId
        )
      if (reviewedMessage) {
        const reviewAbortController = new AbortController()
        run.reviewAbortController = reviewAbortController
        try {
          run.review = await this.dependencies.reviewer.review(
            completed!.session,
            reviewedMessage.id,
            reviewAbortController.signal
          )
        } catch (error) {
          if (!reviewAbortController.signal.aborted) {
            run.review = {
              started: false,
              reason: 'run-failed',
              errorMessage: toErrorMessage(error)
            }
          }
        } finally {
          if (run.reviewAbortController === reviewAbortController) {
            run.reviewAbortController = undefined
          }
        }
      }
    }
    const terminalCancellation = run.cancellation
    if (terminalCancellation) await terminalCancellation.dispatch.catch(() => undefined)
    const terminalCancellationAccepted = terminalCancellation?.accepted === true
    if (terminalCancellationAccepted) run.attention = undefined
    const terminalStatus = terminalCancellationAccepted ? 'cancelled' : 'completed'
    run.output = completed!.output
    run.artifacts = completed!.artifacts
    const completedAt = this.dependencies.now()
    run.completedAt = completedAt
    if (terminalCancellationAccepted) run.cancelledAt = completedAt
    this.stopHeartbeat(run)
    await this.persistTerminalRun(run, terminalStatus).finally(() =>
      this.publishProgress(run, run.status === 'failed' ? 'failed' : terminalStatus)
    )
  }

  private async failRun(
    run: MutableTaskRun,
    session: PersistedChatSession,
    completed: CompletedTaskSession | undefined,
    failure: unknown,
    persistSession = true
  ): Promise<void> {
    const runtimeError = run.eventAccumulator?.runtimeError
    const message = runtimeError?.text?.trim() || toErrorMessage(failure)
    const failedSessionRequest: FailTaskSessionRunRequest = {
      projectId: session.projectId,
      sessionId: session.id,
      promptMessageId: run.promptMessageId,
      taskRunCommitId: run.id,
      messageId: completed?.messageId,
      artifacts: completed?.persistedArtifacts ?? [],
      error: message,
      ...(runtimeError?.providerError ? { errorReportable: false } : {}),
      updatedAt: this.dependencies.now()
    }
    run.attention = undefined
    run.error = message
    run.output = completed?.output
    run.artifacts = completed?.artifacts ?? []
    run.completedAt = this.dependencies.now()
    this.stopHeartbeat(run)
    if (persistSession) {
      const failedCommit: NonNullable<MutableTaskRun['sessionCommit']> = {
        status: 'failed',
        completedAt: run.completedAt,
        output: run.output,
        error: run.error,
        failureCode: run.failureCode,
        artifacts: run.artifacts,
        attention: undefined
      }
      let releaseSessionCommitBarrier: (() => void) | undefined
      const sessionCommitBarrier = new Promise<void>((resolve) => {
        releaseSessionCommitBarrier = resolve
      })
      run.sessionCommitBarrier = sessionCommitBarrier
      try {
        await this.persistSessionCommit(run, failedCommit, false)
      } catch (error) {
        const persistenceMessage = 'Task Run terminal state could not be persisted.'
        run.error = `${run.error}\n\n${persistenceMessage}`
        log.error(persistenceMessage, { error: toErrorMessage(error), runId: run.id })
        try {
          await this.persistTerminalRun(run, 'failed').finally(() =>
            this.publishProgress(run, 'failed')
          )
        } finally {
          await this.dependencies.sessions.failRun(failedSessionRequest).catch(() => undefined)
        }
        return
      } finally {
        if (run.sessionCommitBarrier === sessionCommitBarrier) {
          run.sessionCommitBarrier = undefined
        }
        releaseSessionCommitBarrier?.()
      }
      await this.dependencies.sessions.failRun(failedSessionRequest).catch(() => undefined)
    }
    await this.persistTerminalRun(run, 'failed').finally(() => this.publishProgress(run, 'failed'))
  }

  private async completeSession(
    session: PersistedChatSession,
    accumulator: TaskRunEventAccumulator,
    clearPendingHistoryReplay: boolean
  ): Promise<CompletedTaskSession> {
    const now = this.dependencies.now()
    const output =
      session.agentFrameworkId === 'claude-code'
        ? normalizeClaudeCodeRefusalText(accumulator.assistantOutput)
        : accumulator.assistantOutput
    const images = accumulator.images.map((image) => ({ ...image }))
    const terminalStopEvent = accumulator.terminalStop
    const assistantMessageId = this.dependencies.createId()
    const assistantMessage: PersistedChatMessage = {
      id: assistantMessageId,
      role: 'agent',
      content: output,
      status: 'complete',
      responseToMessageId: session.activeRun?.promptMessageId,
      eventIds: [...accumulator.assistantEventIds],
      images: images.length ? images : undefined,
      ...(terminalStopEvent?.turnUsage
        ? {
            turnUsage: terminalStopEvent.turnUsage,
            ...(terminalStopEvent.modelCallUsage
              ? { modelCallUsage: terminalStopEvent.modelCallUsage }
              : {})
          }
        : terminalStopEvent
          ? { turnUsageUnavailable: true as const }
          : {}),
      createdAt: now,
      updatedAt: now
    }
    const activities = createTaskRunActivities(accumulator, now)
    const hasAssistantMessage = Boolean(
      output || images.length || accumulator.artifactClaimIds.length
    )
    const stagedSession = await this.dependencies.sessions.stageCompletion({
      projectId: session.projectId,
      sessionId: session.id,
      promptMessageId: session.activeRun!.promptMessageId,
      message: hasAssistantMessage ? assistantMessage : undefined,
      activities,
      ...(clearPendingHistoryReplay ? { clearPendingHistoryReplay: true } : {}),
      updatedAt: now
    })
    const finalizedArtifacts: ArtifactFile[] = []
    const buildCompletion = (): CompletedTaskSession => {
      const uniqueArtifacts = [
        ...new Map(finalizedArtifacts.map((artifact) => [artifact.id, artifact])).values()
      ]
      const persistedArtifacts = uniqueArtifacts.map((artifact) =>
        toPersistedArtifact(artifact, assistantMessage.createdAt)
      )
      return {
        output,
        artifacts: uniqueArtifacts,
        persistedArtifacts,
        messageId: hasAssistantMessage ? assistantMessageId : undefined,
        session: stagedSession
      }
    }
    for (const artifactClaimId of accumulator.artifactClaimIds) {
      try {
        const request = {
          claimId: artifactClaimId,
          messageId: assistantMessageId
        }
        const result = await this.dependencies.artifacts.finalizeRun(request)
        if (!result.ok) {
          throw new Error(result.message)
        }
        finalizedArtifacts.push(...result.artifacts)
      } catch (error) {
        throw new PartialTaskCompletionError(buildCompletion(), error)
      }
    }
    return buildCompletion()
  }

  private captureEvent(event: AcpRuntimeEvent): void {
    if (!event.sessionId) return
    for (const run of this.runs.values()) {
      if (run.status !== 'running' || run.terminalStatus || run.sessionId !== event.sessionId)
        continue
      if (event.promptMessageId !== undefined && event.promptMessageId !== run.promptMessageId) {
        continue
      }
      if (run.eventAccumulator) accumulateTaskRunEvent(run.eventAccumulator, event)
      if (event.kind === 'plan' && event.planProjection) {
        run.attention =
          event.planProjection.lifecycle === 'awaiting_approval'
            ? { kind: 'plan-approval', plan: event.planProjection }
            : undefined
        void this.persistRunsBestEffort()
      }
      if (
        run.providerAccepted &&
        !run.firstVisibleOutput &&
        event.promptMessageId === run.promptMessageId &&
        isVisibleProviderEvent(event)
      ) {
        run.firstVisibleOutput = true
        this.stopHeartbeat(run)
        this.publishProgress(run, 'first-visible-output')
      }
    }
  }

  private scheduleHeartbeat(run: MutableTaskRun): void {
    this.stopHeartbeat(run)
    run.heartbeatTimer = setTimeout(() => {
      run.heartbeatTimer = undefined
      if (run.status !== 'running' || run.firstVisibleOutput) return
      this.publishProgress(run, run.progressPhase, true)
      this.scheduleHeartbeat(run)
    }, TASK_RUN_HEARTBEAT_INTERVAL_MS)
    run.heartbeatTimer.unref?.()
  }

  private stopHeartbeat(run: MutableTaskRun): void {
    if (!run.heartbeatTimer) return
    clearTimeout(run.heartbeatTimer)
    run.heartbeatTimer = undefined
  }

  private publishProgress(
    run: MutableTaskRun,
    phase: TaskRunProgressPhase,
    heartbeat = false
  ): void {
    const timestamp = this.dependencies.now()
    if (!heartbeat) run.progressPhase = phase
    const event: TaskRunProgressEvent = Object.freeze({
      runId: run.id,
      sessionId: run.sessionId,
      projectId: run.projectId,
      phase,
      timestamp,
      elapsedMs: Math.max(0, timestamp - run.startedAt),
      heartbeat
    })
    for (const listener of this.progressListeners) {
      try {
        listener(event)
      } catch {
        // Public observability is best-effort and must never change Run execution or terminalization.
      }
    }
  }

  private pruneRuns(): void {
    if (this.runs.size < MAX_RETAINED_RUNS) return
    const completed = [...this.runs.values()]
      .filter((run) => run.status !== 'running')
      .sort((left, right) => left.startedAt - right.startedAt)
    for (const run of completed) {
      this.runs.delete(run.id)
      if (this.runs.size < MAX_RETAINED_RUNS) return
    }
  }

  private async restoreRuns(): Promise<void> {
    const journal = this.dependencies.runJournal
    if (!journal) return
    // A failed restoration may already have projected part of the journal into memory. Task API
    // requests remain behind initialize(), so a retry can rebuild that projection atomically from
    // the durable journal without exposing stale entries.
    this.runs.clear()
    this.activeRunBySession.clear()
    const loadedRuns = await journal.load()
    const storedRuns = loadedRuns.slice(-MAX_RETAINED_RUNS)
    const sessions = storedRuns.some(
      (run) => (run.status === 'running' || run.status === 'failed') && run.promptMessageId
    )
      ? await this.dependencies.sessions.list()
      : []
    const interrupted: MutableTaskRun[] = []
    const terminalSessionRepairs: MutableTaskRun[] = []
    let normalized = false
    for (const stored of storedRuns) {
      const snapshot = structuredClone(stored)
      let interruptedSession: PersistedChatSession | undefined
      let recoveryCommit: MutableTaskRun['sessionCommit']
      if (snapshot.status === 'running') {
        const committedSession = snapshot.promptMessageId
          ? sessions.find(
              (session) =>
                session.id === snapshot.sessionId &&
                session.activeRun?.promptMessageId !== snapshot.promptMessageId &&
                session.taskRunCommitId === snapshot.id &&
                session.status === (snapshot.sessionCommitStatus === 'failed' ? 'error' : 'idle')
            )
          : undefined
        if (snapshot.sessionCommitStatus && committedSession) {
          snapshot.status = snapshot.sessionCommitStatus
          if (snapshot.status !== 'completed') snapshot.attention = undefined
        } else {
          snapshot.failureCode = 'process_restarted'
          snapshot.error = PROCESS_RESTARTED_MESSAGE
          snapshot.completedAt = this.dependencies.now()
          snapshot.attention = undefined
          interruptedSession = sessions.find((session) =>
            sessionOwnsTaskRunPrompt(session, snapshot)
          )
          if (interruptedSession) {
            recoveryCommit = {
              status: 'failed',
              completedAt: snapshot.completedAt,
              output: snapshot.output,
              error: snapshot.error,
              failureCode: snapshot.failureCode,
              artifacts: [...snapshot.artifacts]
            }
          } else {
            snapshot.status = 'failed'
          }
        }
        normalized = true
      }
      const run: MutableTaskRun = {
        ...snapshot,
        ...(recoveryCommit ? { sessionCommit: recoveryCommit } : {}),
        completion: Promise.resolve(),
        promptMessageId: snapshot.promptMessageId ?? '',
        progressPhase: snapshot.status === 'running' ? 'failed' : snapshot.status,
        providerAccepted: false,
        firstVisibleOutput: true
      }
      this.runs.set(run.id, run)
      if (interruptedSession) interrupted.push(run)
      if (
        snapshot.status === 'failed' &&
        sessions.some(
          (session) =>
            session.taskRunCommitId !== snapshot.id && sessionOwnsTaskRunPrompt(session, snapshot)
        )
      ) {
        terminalSessionRepairs.push(run)
      }
    }
    if (
      !normalized &&
      loadedRuns.length === storedRuns.length &&
      terminalSessionRepairs.length === 0
    ) {
      return
    }

    // Stage interrupted failures before committing their Session projection. A restart during this
    // reconciliation can then retry the exact prompt, while a committed Session witness promotes the
    // staged failure on the next restore.
    if (normalized || loadedRuns.length !== storedRuns.length) await this.persistRuns()
    if (interrupted.length === 0 && terminalSessionRepairs.length === 0) return

    const currentSessions = await this.dependencies.sessions.list()
    for (const run of interrupted) {
      const current = currentSessions.find((session) => sessionOwnsTaskRunPrompt(session, run))
      if (!current) {
        run.sessionCommit = undefined
        run.status = 'failed'
        continue
      }
      await this.dependencies.sessions.save({
        ...current,
        status: 'error',
        activeRun: undefined,
        taskRunCommitId: run.id,
        error: current.error ?? PROCESS_RESTARTED_MESSAGE,
        updatedAt: this.dependencies.now()
      })
      run.status = 'failed'
    }
    for (const run of terminalSessionRepairs) {
      const current = currentSessions.find(
        (session) => session.taskRunCommitId !== run.id && sessionOwnsTaskRunPrompt(session, run)
      )
      if (!current) continue
      await this.dependencies.sessions.save({
        ...current,
        status: 'error',
        activeRun: undefined,
        taskRunCommitId: run.id,
        error: current.error ?? run.error ?? PROCESS_RESTARTED_MESSAGE,
        updatedAt: this.dependencies.now()
      })
    }
    if (interrupted.length > 0) await this.persistRuns()
  }

  private persistRuns(): Promise<void> {
    const journal = this.dependencies.runJournal
    if (!journal) return Promise.resolve()
    const write = this.journalWriteTail.then(() =>
      journal.replace([...this.runs.values()].map(cloneRunForJournal))
    )
    this.journalWriteTail = write.catch(() => undefined)
    return write
  }

  private async persistRunsBestEffort(): Promise<void> {
    try {
      await this.persistRuns()
    } catch (error) {
      log.error('Failed to persist Task Run state.', { error: toErrorMessage(error) })
    }
  }

  private persistSessionCommit(
    run: MutableTaskRun,
    commit: NonNullable<MutableTaskRun['sessionCommit']>,
    rollbackToPrevious = true
  ): Promise<void> {
    const journal = this.dependencies.runJournal
    const previous = run.sessionCommit
    if (!journal) {
      run.sessionCommit = commit
      return Promise.resolve()
    }
    const write = this.journalWriteTail.then(async () => {
      run.sessionCommit = commit
      try {
        await journal.replace([...this.runs.values()].map(cloneRunForJournal))
      } catch (error) {
        run.sessionCommit = rollbackToPrevious ? previous : undefined
        throw error
      }
    })
    this.journalWriteTail = write.catch(() => undefined)
    return write
  }

  private async persistTerminalRun(
    run: MutableTaskRun,
    status: Exclude<TaskRunStatus, 'running'>
  ): Promise<void> {
    run.terminalStatus = status
    try {
      await this.persistRuns()
      run.status = status
    } catch (error) {
      const persistenceMessage = 'Task Run terminal state could not be persisted.'
      run.status = 'failed'
      run.terminalStatus = 'failed'
      run.sessionCommit = undefined
      run.attention = undefined
      run.cancelledAt = undefined
      run.error = run.error ? `${run.error}\n\n${persistenceMessage}` : persistenceMessage
      log.error(persistenceMessage, { error: toErrorMessage(error), runId: run.id })
      await this.persistRuns()
    } finally {
      run.terminalStatus = undefined
    }
  }

  private async resolveProject(projectId: string): Promise<Project> {
    const normalized = typeof projectId === 'string' ? projectId.trim() : ''
    if (!normalized) throw new TaskRunnerError('invalid_request', 'Project id is required.')
    const projects = await this.dependencies.projects.list()
    const project = projects.find((candidate) => candidate.id === normalized)
    if (project) return project
    throw new TaskRunnerError('project_not_found', `Project not found: ${normalized}`)
  }

  private agentConfigurationAvailability(
    configuration: SessionAgentConfiguration,
    settings: SettingsSnapshot
  ): { available: boolean; reason?: string } {
    try {
      validateTaskAgentConfiguration(configuration, settings)
      return { available: true }
    } catch (error) {
      return { available: false, reason: toErrorMessage(error) }
    }
  }

  private async specialistAvailability(
    specialistId: string
  ): Promise<{ available: boolean; reason?: string }> {
    try {
      await this.dependencies.specialists.resolve(specialistId)
      return { available: true }
    } catch (error) {
      return { available: false, reason: toErrorMessage(error) }
    }
  }

  private computeAvailability(
    computeHosts: SessionComputeHosts,
    availableProviderIds: readonly string[]
  ): Record<string, { available: boolean; reason?: string }> {
    const available = new Set(availableProviderIds)
    return Object.fromEntries(
      [...new Set([...computeHosts.enabled, ...computeHosts.selected])].map((providerId) => [
        providerId,
        available.has(providerId)
          ? { available: true }
          : { available: false, reason: 'Compute Host is not registered.' }
      ])
    )
  }

  private async validateComputeHosts(
    providerIds: readonly string[],
    errorCode: 'invalid_request' | 'invalid_configuration' = 'invalid_configuration'
  ): Promise<string[]> {
    try {
      if (this.dependencies.computePreferences.validate) {
        return await this.dependencies.computePreferences.validate(providerIds)
      }
      return await this.dependencies.computePreferences.withReservation(
        providerIds,
        async (validated) => validated
      )
    } catch (error) {
      if (error instanceof ComputeHostPreferenceValidationError) {
        throw new TaskRunnerError(errorCode, error.message)
      }
      throw error
    }
  }

  private async projectSessionDefaultsProjection(
    project: Project
  ): Promise<TaskProjectSessionDefaults> {
    const defaults = project.sessionDefaults ?? {}
    const [settings, availableComputeHosts, specialist] = await Promise.all([
      this.dependencies.settings.get(),
      this.dependencies.computePreferences.listAvailable?.() ?? Promise.resolve([]),
      defaults.specialistId
        ? this.specialistAvailability(defaults.specialistId)
        : Promise.resolve(undefined)
    ])
    return {
      projectId: project.id,
      updatedAt: project.updatedAt,
      configured: defaults,
      availability: {
        ...(defaults.agentConfiguration
          ? {
              agentConfiguration: this.agentConfigurationAvailability(
                defaults.agentConfiguration,
                settings
              )
            }
          : {}),
        ...(specialist ? { specialist } : {}),
        computeHosts: this.computeAvailability(
          defaults.computeHosts ?? { enabled: [], selected: [] },
          availableComputeHosts
        )
      }
    }
  }

  private async findSession(sessionId: string): Promise<PersistedChatSession> {
    const session = (await this.dependencies.sessions.list()).find(
      (candidate) => candidate.id === sessionId
    )
    if (!session) throw new TaskRunnerError('session_not_found', `Session not found: ${sessionId}`)
    return session
  }
}

export { TaskRunner, TaskRunnerError, summarizeSession }
export type {
  TaskAgentCreateSessionRequest,
  TaskAgentPort,
  TaskAgentPromptObserver,
  TaskAgentPromptRequest,
  TaskAgentResumeSessionRequest,
  TaskAgentSession,
  TaskArtifactPort,
  TaskComputePreferencePort,
  TaskProjectPort,
  TaskPreviewResourcePort,
  TaskRunnerDependencies,
  TaskRuntimeEventPort,
  TaskSessionPort
}
