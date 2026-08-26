import { constants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

import type { AcpRuntimeEvent } from '../../shared/acp'
import { ComputeHostPreferenceValidationError } from '../../shared/compute'
import {
  getAcpRuntimeEventImage,
  getAcpRuntimeEventText,
  normalizeClaudeCodeRefusalText
} from '../../shared/acp'
import type {
  ArtifactFile,
  FinalizeRunArtifactsRequest,
  FinalizeRunArtifactsResult
} from '../../shared/artifacts'
import { ARTIFACT_OWNERSHIP_PERSISTENCE_RACE, artifactCreatedAtMs } from '../../shared/artifacts'
import { DEFAULT_PERMISSION_PROFILE } from '../../shared/permission-profiles'
import type { PermissionProfileId } from '../../shared/permission-profiles'
import {
  PROJECT_DESCRIPTION_MAX_LENGTH,
  PROJECT_NAME_MAX_LENGTH,
  type Project,
  type UpdateProjectRequest
} from '../../shared/projects'
import type { AgentFrameworkId, SessionAgentConfiguration } from '../../shared/settings'
import type {
  DelegationPolicy,
  PersistedArtifact,
  PersistedChatMessage,
  PersistedChatSession,
  PersistedMessageImage,
  PersistedToolActivity
} from '../../shared/session-persistence'
import type {
  AcquiredTaskArtifact,
  CreateTaskProjectRequest,
  StartTaskRunRequest,
  TaskApiErrorCode,
  TaskProject,
  TaskRun,
  TaskRunProgressEvent,
  TaskRunProgressPhase,
  TaskRunReview,
  TaskSessionSummary,
  UpdateTaskProjectRequest
} from '../../shared/task-api'

type TaskProjectPort = {
  list(): Promise<Project[]>
  create(request: CreateTaskProjectRequest): Promise<Project>
  update?(request: UpdateProjectRequest): Promise<Project>
}

type TaskSessionPort = {
  list(): Promise<PersistedChatSession[]>
  save(session: PersistedChatSession): Promise<PersistedChatSession>
  setDelegationPolicy(projectId: string, sessionId: string, policy: DelegationPolicy): Promise<void>
}

type TaskComputePreferencePort = {
  withReservation<Result>(
    providerIds: readonly string[],
    operation: (providerIds: string[]) => Promise<Result>
  ): Promise<Result>
  set(sessionId: string, providerIds: readonly string[]): Promise<PersistedChatSession>
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
  text: string
  turnIntent?: 'plan-first'
  skillIds?: string[]
  historyPreamble?: string
  contextReset?: boolean
  resumeFallback?: { historyPreamble?: string }
}

type TaskAgentPromptObserver = {
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
  createId: () => string
  now: () => number
}

type MutableTaskRun = TaskRun & {
  events: AcpRuntimeEvent[]
  completion: Promise<void>
  promptMessageId: string
  progressPhase: TaskRunProgressPhase
  providerAccepted: boolean
  firstVisibleOutput: boolean
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
}

class PartialTaskCompletionError extends Error {
  constructor(
    readonly completion: CompletedTaskSession,
    readonly failure: unknown
  ) {
    super(failure instanceof Error ? failure.message : String(failure))
    this.name = 'PartialTaskCompletionError'
  }
}

const MAX_RETAINED_RUNS = 200
const TASK_RUN_HEARTBEAT_INTERVAL_MS = 10_000
export const TASK_REVIEW_DISPOSAL_BUDGET_MS = 1000
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
  artifacts: [...run.artifacts],
  attention: run.attention,
  review: run.review,
  preferredComputeHostIds: [...run.preferredComputeHostIds]
})

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
  private disposed = false
  private disposal: Promise<void> | undefined

  constructor(private readonly dependencies: TaskRunnerDependencies) {
    this.unsubscribeEvents = dependencies.runtimeEvents.subscribe((event) =>
      this.captureEvent(event)
    )
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
    const settleReviews = Promise.allSettled(activeReviewCompletions).then(() => undefined)
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, TASK_REVIEW_DISPOSAL_BUDGET_MS)
      timer.unref?.()
    })
    this.disposal = Promise.race([settleReviews, deadline]).finally(() => {
      if (timer) clearTimeout(timer)
    })
    return this.disposal
  }

  subscribeProgress(listener: (event: TaskRunProgressEvent) => void): () => void {
    this.progressListeners.add(listener)
    return () => this.progressListeners.delete(listener)
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
    const prompt = typeof request.prompt === 'string' ? request.prompt.trim() : ''
    if (!prompt) throw new TaskRunnerError('invalid_request', 'Prompt is required.')
    const cwd =
      request.cwd === undefined ? undefined : await canonicalizeTaskWorkingDirectory(request.cwd)
    let normalizedRequest: StartTaskRunRequest = cwd === undefined ? request : { ...request, cwd }

    const project = await this.resolveProject(request.project)
    const sessions = await this.dependencies.sessions.list()
    const existing = request.sessionId
      ? sessions.find((session) => session.id === request.sessionId)
      : undefined
    if (request.sessionId && !existing) {
      throw new TaskRunnerError('session_not_found', `Session not found: ${request.sessionId}`)
    }
    if (existing && existing.projectId !== project.id) {
      throw new TaskRunnerError(
        'invalid_request',
        `Session ${existing.id} does not belong to project ${project.id}.`
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
    const userMessageId = this.dependencies.createId()
    const runId = this.dependencies.createId()
    if (existing) this.reserveSession(existing.id, runId)
    let prepared: Awaited<ReturnType<TaskRunner['prepareSession']>>
    try {
      const prepare = (
        requestForPreparation = normalizedRequest
      ): ReturnType<TaskRunner['prepareSession']> =>
        this.prepareSession(project, existing, requestForPreparation, prompt, userMessageId)
      if (existing) {
        prepared = await this.dependencies.agent.withSessionAvailable(
          project.id,
          existing.id,
          prepare
        )
      } else if (request.computeHostIds !== undefined) {
        prepared = await this.dependencies.computePreferences.withReservation(
          request.computeHostIds,
          async (computeHostIds) => {
            normalizedRequest = { ...normalizedRequest, computeHostIds }
            return prepare(normalizedRequest)
          }
        )
      } else {
        prepared = await prepare()
      }
      this.reserveSession(prepared.session.id, runId)
    } catch (error) {
      if (existing) this.releaseSession(existing.id, runId)
      if (error instanceof ComputeHostPreferenceValidationError) {
        throw new TaskRunnerError('invalid_request', error.message)
      }
      throw error
    }
    const session = prepared.session
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
      events: [],
      promptMessageId: session.activeRun!.promptMessageId,
      progressPhase: 'accepted' as const,
      providerAccepted: false,
      firstVisibleOutput: false,
      completion: Promise.resolve()
    } satisfies MutableTaskRun

    this.pruneRuns()
    this.runs.set(runId, run)
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
      prepared.resumeFallback
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
    run.cancellation = cancellation
    cancellation.dispatch = Promise.resolve()
      .then(() => this.dependencies.agent.cancelPrompt(run.sessionId))
      .then(() => {
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
        throw new TaskRunnerError(
          'specialist_not_found',
          error instanceof Error ? error.message : String(error)
        )
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
        if (request.permissionProfile && request.permissionProfile !== existing.permissionProfile) {
          await this.dependencies.agent.setPermissionProfile(existing.id, request.permissionProfile)
        }
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
      sessionInfo = await this.dependencies.agent.createSession({
        projectId: project.id,
        permissionProfile,
        ...(request.cwd ? { cwd: request.cwd } : {}),
        ...(specialistId ? { specialistId } : {})
      })
    }

    const userMessage = createUserMessage(userMessageId, prompt, now, request.turnIntent)
    const session: PersistedChatSession = existing
      ? {
          ...existing,
          cwd: sessionInfo.cwd ?? existing.cwd,
          status: 'running',
          permissionProfile,
          autoReviewEnabled,
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
          delegationPolicy,
          specialistId,
          agentFrameworkId: sessionInfo.frameworkId,
          agentBackendId: sessionInfo.backendId,
          providerSessionId: sessionInfo.providerSessionId,
          providerContinuityToken: sessionInfo.providerContinuityToken,
          agentConfiguration: sessionInfo.agentConfiguration,
          ...(request.computeHostIds !== undefined
            ? {
                enabledComputeHosts: request.computeHostIds,
                selectedComputeHosts: request.computeHostIds
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

    const committedSession = await this.dependencies.sessions.save(session)
    const previousHistoryPreamble = existing
      ? createHistoryPreamble(selectTaskHistoryMessages(existing))
      : undefined
    const contextReset = Boolean(sessionInfo.contextReset || existing?.pendingHistoryReplay)
    return {
      session: committedSession,
      historyPreamble: contextReset ? previousHistoryPreamble : undefined,
      contextReset,
      resumeFallback:
        request.skillIds?.length && previousHistoryPreamble
          ? { historyPreamble: previousHistoryPreamble }
          : undefined
    }
  }

  private async executeRun(
    run: MutableTaskRun,
    session: PersistedChatSession,
    request: StartTaskRunRequest,
    prompt: string,
    historyPreamble?: string,
    contextReset?: boolean,
    resumeFallback?: TaskAgentPromptRequest['resumeFallback']
  ): Promise<void> {
    let promptError: unknown
    let cancellationAtPromptFailure: MutableTaskRun['cancellation'] = undefined
    try {
      this.publishProgress(run, 'prompt-dispatched')
      await this.dependencies.agent.prompt(
        {
          sessionId: session.id,
          promptMessageId: session.activeRun!.promptMessageId,
          text: prompt,
          ...(request.turnIntent ? { turnIntent: request.turnIntent } : {}),
          ...(request.skillIds?.length ? { skillIds: request.skillIds } : {}),
          ...(historyPreamble ? { historyPreamble } : {}),
          ...(contextReset ? { contextReset: true } : {}),
          ...(resumeFallback ? { resumeFallback } : {})
        },
        {
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

    const acceptedSession =
      promptError === undefined ? consumePendingHistoryReplay(session) : session

    let completed: CompletedTaskSession | undefined
    let completionError: unknown
    try {
      completed = await this.completeSession(acceptedSession, run.events)
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
      return
    }

    try {
      await this.dependencies.sessions.save(completed!.session)
    } catch (error) {
      await this.failRun(run, acceptedSession, completed, error)
      return
    }
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
              errorMessage: error instanceof Error ? error.message : String(error)
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
    run.status = terminalCancellationAccepted ? 'cancelled' : 'completed'
    run.output = completed!.output
    run.artifacts = completed!.artifacts
    const completedAt = this.dependencies.now()
    run.completedAt = completedAt
    if (terminalCancellationAccepted) run.cancelledAt = completedAt
    this.stopHeartbeat(run)
    this.publishProgress(run, terminalCancellationAccepted ? 'cancelled' : 'completed')
  }

  private async failRun(
    run: MutableTaskRun,
    session: PersistedChatSession,
    completed: CompletedTaskSession | undefined,
    failure: unknown
  ): Promise<void> {
    const runtimeError = [...run.events]
      .reverse()
      .find((event) => event.kind === 'error' && event.text?.trim())
    const message =
      runtimeError?.text?.trim() || (failure instanceof Error ? failure.message : String(failure))
    const failed: PersistedChatSession = {
      ...(completed?.session ?? session),
      status: 'error',
      activeRun: undefined,
      error: message,
      ...(runtimeError?.providerError ? { errorReportable: false } : {}),
      updatedAt: this.dependencies.now()
    }
    run.status = 'failed'
    run.attention = undefined
    run.error = message
    run.output = completed?.output
    run.artifacts = completed?.artifacts ?? []
    run.completedAt = this.dependencies.now()
    this.stopHeartbeat(run)
    this.publishProgress(run, 'failed')
    await this.dependencies.sessions.save(failed).catch(() => undefined)
  }

  private async completeSession(
    session: PersistedChatSession,
    events: AcpRuntimeEvent[]
  ): Promise<CompletedTaskSession> {
    const now = this.dependencies.now()
    const assistantEvents = events.filter(
      (event) => event.kind === 'message' && event.role === 'assistant'
    )
    const terminalStopEvent = [...events].reverse().find((event) => event.kind === 'stop')
    const streamedOutput = assistantEvents
      .map((event) => getAcpRuntimeEventText(event) ?? '')
      .join('')
    const output =
      session.agentFrameworkId === 'claude-code'
        ? normalizeClaudeCodeRefusalText(streamedOutput)
        : streamedOutput
    const images = assistantEvents
      .map((event) => {
        const image = getAcpRuntimeEventImage(event)
        return image ? ({ id: event.id, ...image } satisfies PersistedMessageImage) : undefined
      })
      .filter((image): image is PersistedMessageImage => Boolean(image))
    const assistantMessageId = this.dependencies.createId()
    const assistantMessage: PersistedChatMessage = {
      id: assistantMessageId,
      role: 'agent',
      content: output,
      status: 'complete',
      responseToMessageId: session.activeRun?.promptMessageId,
      eventIds: assistantEvents.map((event) => event.id),
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
    const activities = this.createActivities(events, now)
    const finalizedArtifacts: ArtifactFile[] = []
    const buildCompletion = (): CompletedTaskSession => {
      const uniqueArtifacts = [
        ...new Map(finalizedArtifacts.map((artifact) => [artifact.id, artifact])).values()
      ]
      const persistedArtifacts = uniqueArtifacts.map((artifact) =>
        toPersistedArtifact(artifact, assistantMessage.createdAt)
      )
      const linkedAssistantMessage: PersistedChatMessage = {
        ...assistantMessage,
        artifactIds: uniqueArtifacts.length
          ? uniqueArtifacts.map((artifact) => artifact.id)
          : undefined
      }
      const hasAssistantMessage = Boolean(output || images.length || persistedArtifacts.length)

      return {
        output,
        artifacts: uniqueArtifacts,
        session: {
          ...session,
          status: 'idle',
          activeRun: undefined,
          messages: hasAssistantMessage
            ? [...session.messages, linkedAssistantMessage]
            : session.messages,
          activities: [...(session.activities ?? []), ...activities],
          artifacts: [...(session.artifacts ?? []), ...persistedArtifacts],
          filesRevision:
            persistedArtifacts.length > 0
              ? (session.filesRevision ?? 0) + 1
              : session.filesRevision,
          updatedAt: now
        }
      }
    }
    let ownershipSessionPersisted = false
    for (const event of events) {
      if (event.kind !== 'artifact' || !event.artifactClaimId) continue
      try {
        const request = {
          claimId: event.artifactClaimId,
          messageId: assistantMessageId
        }
        let result = await this.dependencies.artifacts.finalizeRun(request)
        if (!result.ok) {
          if (result.code !== ARTIFACT_OWNERSHIP_PERSISTENCE_RACE) {
            throw new Error(result.message)
          }
          if (!ownershipSessionPersisted) {
            await this.dependencies.sessions.save({
              ...session,
              messages: [...session.messages, assistantMessage],
              activities: [...(session.activities ?? []), ...activities],
              updatedAt: now
            })
            ownershipSessionPersisted = true
          }
          result = await this.dependencies.artifacts.finalizeRun(request)
          if (!result.ok) throw new Error(result.message)
        }
        finalizedArtifacts.push(...result.artifacts)
      } catch (error) {
        throw new PartialTaskCompletionError(buildCompletion(), error)
      }
    }
    return buildCompletion()
  }

  private createActivities(events: AcpRuntimeEvent[], now: number): PersistedToolActivity[] {
    const activities = new Map<string, PersistedToolActivity>()
    for (const event of events) {
      if (event.kind !== 'tool' || !event.toolCallId) continue
      const existing = activities.get(event.toolCallId)
      const isTerminal = existing?.status === 'completed' || existing?.status === 'failed'
      activities.set(event.toolCallId, {
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
        sortIndex: existing?.sortIndex ?? now + activities.size,
        eventIds: [...(existing?.eventIds ?? []), event.id],
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
    return [...activities.values()]
  }

  private captureEvent(event: AcpRuntimeEvent): void {
    if (!event.sessionId) return
    for (const run of this.runs.values()) {
      if (run.status !== 'running' || run.sessionId !== event.sessionId) continue
      if (event.promptMessageId !== undefined && event.promptMessageId !== run.promptMessageId) {
        continue
      }
      run.events.push(event)
      if (event.kind === 'plan' && event.planProjection) {
        run.attention =
          event.planProjection.lifecycle === 'awaiting_approval'
            ? { kind: 'plan-approval', plan: event.planProjection }
            : undefined
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

  private async resolveProject(projectId: string): Promise<Project> {
    const normalized = typeof projectId === 'string' ? projectId.trim() : ''
    if (!normalized) throw new TaskRunnerError('invalid_request', 'Project id is required.')
    const projects = await this.dependencies.projects.list()
    const project = projects.find((candidate) => candidate.id === normalized)
    if (project) return project
    throw new TaskRunnerError('project_not_found', `Project not found: ${normalized}`)
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
