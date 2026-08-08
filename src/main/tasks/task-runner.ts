import type { AcpRuntimeEvent } from '../../shared/acp'
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
import { ARTIFACT_OWNERSHIP_PERSISTENCE_RACE } from '../../shared/artifacts'
import { DEFAULT_PERMISSION_PROFILE } from '../../shared/permission-profiles'
import type { PermissionProfileId } from '../../shared/permission-profiles'
import type { Project } from '../../shared/projects'
import type { AgentFrameworkId } from '../../shared/settings'
import type {
  PersistedArtifact,
  PersistedChatMessage,
  PersistedChatSession,
  PersistedMessageImage,
  PersistedToolActivity
} from '../../shared/session-persistence'
import type {
  AcquiredTaskArtifact,
  StartTaskRunRequest,
  TaskApiErrorCode,
  TaskRun,
  TaskRunProgressEvent,
  TaskRunProgressPhase,
  TaskSessionSummary
} from '../../shared/task-api'

type CreateTaskProjectRequest = {
  name: string
  description?: string
}

type TaskProjectPort = {
  list(): Promise<Project[]>
  create(request: CreateTaskProjectRequest): Promise<Project>
}

type TaskSessionPort = {
  list(): Promise<PersistedChatSession[]>
  save(session: PersistedChatSession): Promise<void>
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
}

type TaskAgentCreateSessionRequest = {
  projectId: string
  permissionProfile: PermissionProfileId
}

type TaskAgentResumeSessionRequest = {
  sessionId: string
  providerSessionId?: string
  providerContinuityToken?: string
  cwd: string
  projectId: string
  permissionProfile: PermissionProfileId
  previousFrameworkId?: AgentFrameworkId
  previousBackendId?: string
}

type TaskAgentPromptRequest = {
  sessionId: string
  promptMessageId: string
  text: string
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

type TaskRunnerDependencies = {
  projects: TaskProjectPort
  sessions: TaskSessionPort
  previewResources: TaskPreviewResourcePort
  agent: TaskAgentPort
  artifacts: TaskArtifactPort
  runtimeEvents: TaskRuntimeEventPort
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
  status: run.status,
  startedAt: run.startedAt,
  cancelRequestedAt: run.cancelRequestedAt,
  cancelledAt: run.cancelledAt,
  completedAt: run.completedAt,
  output: run.output,
  error: run.error,
  artifacts: [...run.artifacts]
})

const createTitle = (prompt: string): string => {
  const normalized = prompt.trim().replace(/\s+/g, ' ')
  return normalized.length <= 60 ? normalized : `${normalized.slice(0, 57)}...`
}

const createUserMessage = (id: string, content: string, now: number): PersistedChatMessage => ({
  id,
  role: 'user',
  content,
  status: 'complete',
  eventIds: [],
  createdAt: now,
  updatedAt: now
})

const toPersistedArtifact = (artifact: ArtifactFile): PersistedArtifact => ({
  id: artifact.id,
  kind: 'managed-file',
  path: artifact.path,
  fileUrl: artifact.fileUrl,
  name: artifact.name,
  mimeType: artifact.mimeType,
  size: artifact.size,
  mtimeMs: artifact.mtimeMs
})

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
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
  output: [...session.messages].reverse().find((message) => message.role === 'agent')?.content,
  error: session.error,
  artifactCount: session.artifacts?.length ?? 0
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

class TaskRunner {
  private readonly runs = new Map<string, MutableTaskRun>()
  private readonly activeRunBySession = new Map<string, string>()
  private readonly progressListeners = new Set<(event: TaskRunProgressEvent) => void>()
  private readonly unsubscribeEvents: () => void

  constructor(private readonly dependencies: TaskRunnerDependencies) {
    this.unsubscribeEvents = dependencies.runtimeEvents.subscribe((event) =>
      this.captureEvent(event)
    )
  }

  dispose(): void {
    this.unsubscribeEvents()
    for (const run of this.runs.values()) this.stopHeartbeat(run)
    this.progressListeners.clear()
  }

  subscribeProgress(listener: (event: TaskRunProgressEvent) => void): () => void {
    this.progressListeners.add(listener)
    return () => this.progressListeners.delete(listener)
  }

  listProjects(): Promise<Project[]> {
    return this.dependencies.projects.list()
  }

  async createProject(request: CreateTaskProjectRequest): Promise<Project> {
    if (!request || typeof request.name !== 'string' || !request.name.trim()) {
      throw new TaskRunnerError('invalid_request', 'Project name is required.')
    }
    if (request.description !== undefined && typeof request.description !== 'string') {
      throw new TaskRunnerError('invalid_request', 'Project description must be a string.')
    }
    return this.dependencies.projects.create(request)
  }

  async listSessions(project?: string): Promise<TaskSessionSummary[]> {
    const sessions = await this.dependencies.sessions.list()
    if (!project) return sessions.map(summarizeSession)
    const resolved = await this.resolveProject(project)
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
    const prompt = typeof request.prompt === 'string' ? request.prompt.trim() : ''
    if (!prompt) throw new TaskRunnerError('invalid_request', 'Prompt is required.')

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
    const userMessageId = this.dependencies.createId()
    const runId = this.dependencies.createId()
    if (existing) this.reserveSession(existing.id, runId)
    let prepared: Awaited<ReturnType<TaskRunner['prepareSession']>>
    try {
      const prepare = (): ReturnType<TaskRunner['prepareSession']> =>
        this.prepareSession(project, existing, request, prompt, userMessageId)
      prepared = existing
        ? await this.dependencies.agent.withSessionAvailable(project.id, existing.id, prepare)
        : await prepare()
      this.reserveSession(prepared.session.id, runId)
    } catch (error) {
      if (existing) this.releaseSession(existing.id, runId)
      throw error
    }
    const session = prepared.session
    const run = {
      id: runId,
      sessionId: session.id,
      projectId: project.id,
      status: 'running' as const,
      startedAt: this.dependencies.now(),
      artifacts: [],
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
      request,
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
    let sessionInfo: TaskAgentSession

    if (existing) {
      const attachedSessionIds = await this.dependencies.agent.listAttachedSessionIds()
      if (attachedSessionIds.includes(existing.id)) {
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
          providerSessionId: existing.providerSessionId,
          providerContinuityToken: existing.providerContinuityToken
        })
      }
    } else {
      sessionInfo = await this.dependencies.agent.createSession({
        projectId: project.id,
        permissionProfile
      })
    }

    const userMessage = createUserMessage(userMessageId, prompt, now)
    const session: PersistedChatSession = existing
      ? {
          ...existing,
          cwd: sessionInfo.cwd ?? existing.cwd,
          status: 'running',
          permissionProfile,
          agentFrameworkId: sessionInfo.frameworkId ?? existing.agentFrameworkId,
          agentBackendId: sessionInfo.backendId ?? existing.agentBackendId,
          providerSessionId: sessionInfo.providerSessionId ?? existing.providerSessionId,
          providerContinuityToken: sessionInfo.providerContinuityToken,
          messages: [...existing.messages, userMessage],
          activeRun: { promptMessageId: userMessageId, startedAt: now },
          error: undefined,
          updatedAt: now
        }
      : {
          id: sessionInfo.sessionId,
          projectId: project.id,
          title: createTitle(prompt),
          cwd: sessionInfo.cwd ?? '',
          status: 'running',
          permissionProfile,
          agentFrameworkId: sessionInfo.frameworkId,
          agentBackendId: sessionInfo.backendId,
          providerSessionId: sessionInfo.providerSessionId,
          providerContinuityToken: sessionInfo.providerContinuityToken,
          messages: [userMessage],
          activeRun: { promptMessageId: userMessageId, startedAt: now },
          createdAt: now,
          updatedAt: now
        }

    // Starting a new authored turn consumes the old Resume authority. History replay remains durable
    // until the provider accepts this replacement turn, so a pre-acceptance rejection can retry it.
    if (existing) {
      delete session.resumeRecovery
    }

    await this.dependencies.sessions.save(session)
    const previousHistoryPreamble = existing
      ? createHistoryPreamble(selectTaskHistoryMessages(existing))
      : undefined
    const contextReset = Boolean(sessionInfo.contextReset || existing?.pendingHistoryReplay)
    return {
      session,
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
    const terminalCancellation = run.cancellation
    if (terminalCancellation) await terminalCancellation.dispatch.catch(() => undefined)
    const terminalCancellationAccepted = terminalCancellation?.accepted === true
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
        ? { turnUsage: terminalStopEvent.turnUsage }
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
      const persistedArtifacts = uniqueArtifacts.map(toPersistedArtifact)
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

  private async resolveProject(identifier: string): Promise<Project> {
    const normalized = typeof identifier === 'string' ? identifier.trim() : ''
    if (!normalized) throw new TaskRunnerError('invalid_request', 'Project is required.')
    const projects = await this.listProjects()
    const byId = projects.find((project) => project.id === normalized)
    if (byId) return byId
    const byName = projects.filter((project) => project.name === normalized)
    if (byName.length === 1) return byName[0]
    if (byName.length > 1) {
      throw new TaskRunnerError('project_ambiguous', `Project name is ambiguous: ${normalized}`)
    }
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
  CreateTaskProjectRequest,
  TaskAgentCreateSessionRequest,
  TaskAgentPort,
  TaskAgentPromptObserver,
  TaskAgentPromptRequest,
  TaskAgentResumeSessionRequest,
  TaskAgentSession,
  TaskArtifactPort,
  TaskProjectPort,
  TaskPreviewResourcePort,
  TaskRunnerDependencies,
  TaskRuntimeEventPort,
  TaskSessionPort
}
