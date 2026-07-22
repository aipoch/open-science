import { randomUUID } from 'node:crypto'

import {
  getAcpRuntimeEventImage,
  getAcpRuntimeEventText,
  type AcpCreateSessionResponse,
  type AcpRuntimeEvent
} from '../../shared/acp'
import type { ArtifactFile } from '../../shared/artifacts'
import { DEFAULT_PERMISSION_PROFILE } from '../../shared/permission-profiles'
import type { Project } from '../../shared/projects'
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
  TaskSessionSummary
} from '../../shared/task-api'

const TASK_API_CLIENT_ID = 'headless-task-api'
const MAX_RETAINED_RUNS = 200

type TaskRpc = {
  invoke(channel: string, clientId: string, args: unknown[]): Promise<unknown>
}

type TaskApiDependencies = {
  createId: () => string
  now: () => number
  subscribeEvents: (listener: (event: AcpRuntimeEvent) => void) => () => void
}

type MutableTaskRun = TaskRun & {
  events: AcpRuntimeEvent[]
  completion: Promise<void>
}

class TaskApiError extends Error {
  constructor(
    readonly code: TaskApiErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'TaskApiError'
  }
}

const cloneRun = (run: MutableTaskRun): TaskRun => ({
  id: run.id,
  sessionId: run.sessionId,
  projectId: run.projectId,
  status: run.status,
  startedAt: run.startedAt,
  completedAt: run.completedAt,
  output: run.output,
  error: run.error,
  artifacts: [...run.artifacts]
})

const createTitle = (prompt: string): string => {
  const normalized = prompt.trim().replace(/\s+/g, ' ')
  return normalized.length <= 60 ? normalized : `${normalized.slice(0, 57)}...`
}

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

const createUserMessage = (id: string, content: string, now: number): PersistedChatMessage => ({
  id,
  role: 'user',
  content,
  status: 'complete',
  eventIds: [],
  createdAt: now,
  updatedAt: now
})

const createHistoryPreamble = (session: PersistedChatSession): string | undefined => {
  if (session.messages.length === 0) return undefined
  const transcript = session.messages
    .filter((message) => message.content.trim())
    .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content}`)
    .join('\n\n')
  return transcript ? `Previous conversation:\n\n${transcript}` : undefined
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

class HeadlessTaskApi {
  private readonly dependencies: TaskApiDependencies
  private readonly runs = new Map<string, MutableTaskRun>()
  private readonly unsubscribeEvents: () => void

  constructor(
    private readonly rpc: TaskRpc,
    dependencies: Partial<TaskApiDependencies> = {}
  ) {
    this.dependencies = {
      createId: dependencies.createId ?? randomUUID,
      now: dependencies.now ?? Date.now,
      subscribeEvents: dependencies.subscribeEvents ?? (() => () => undefined)
    }
    this.unsubscribeEvents = this.dependencies.subscribeEvents((event) => this.captureEvent(event))
  }

  dispose(): void {
    this.unsubscribeEvents()
  }

  async listProjects(): Promise<Project[]> {
    return (await this.invoke('projects:list')) as Project[]
  }

  async createProject(request: { name: string; description?: string }): Promise<Project> {
    if (!request || typeof request.name !== 'string' || !request.name.trim()) {
      throw new TaskApiError('invalid_request', 'Project name is required.')
    }
    if (request.description !== undefined && typeof request.description !== 'string') {
      throw new TaskApiError('invalid_request', 'Project description must be a string.')
    }
    return (await this.invoke('projects:create', request)) as Project
  }

  async listSessions(project?: string): Promise<TaskSessionSummary[]> {
    const sessions = await this.loadSessions()
    if (!project) return sessions.map(summarizeSession)
    const resolved = await this.resolveProject(project)
    return sessions.filter((session) => session.projectId === resolved.id).map(summarizeSession)
  }

  async getSession(sessionId: string): Promise<TaskSessionSummary> {
    return summarizeSession(await this.findSession(sessionId))
  }

  async startRun(request: StartTaskRunRequest): Promise<TaskRun> {
    if (!request || typeof request !== 'object') {
      throw new TaskApiError('invalid_request', 'Run request must be an object.')
    }
    if (typeof request.project !== 'string' || !request.project.trim()) {
      throw new TaskApiError('invalid_request', 'Project is required.')
    }
    if (request.sessionId !== undefined && typeof request.sessionId !== 'string') {
      throw new TaskApiError('invalid_request', 'Session id must be a string.')
    }
    if (
      request.permissionProfile !== undefined &&
      !['ask', 'auto', 'full'].includes(request.permissionProfile)
    ) {
      throw new TaskApiError('invalid_request', 'Approval profile must be ask, auto, or full.')
    }
    if (
      request.skillIds !== undefined &&
      (!Array.isArray(request.skillIds) ||
        request.skillIds.some((skillId) => typeof skillId !== 'string' || !skillId.trim()))
    ) {
      throw new TaskApiError('invalid_request', 'Skill ids must be non-empty strings.')
    }
    const prompt = typeof request.prompt === 'string' ? request.prompt.trim() : ''
    if (!prompt) throw new TaskApiError('invalid_request', 'Prompt is required.')

    const project = await this.resolveProject(request.project)
    const sessions = await this.loadSessions()
    const existing = request.sessionId
      ? sessions.find((session) => session.id === request.sessionId)
      : undefined
    if (request.sessionId && !existing) {
      throw new TaskApiError('session_not_found', `Session not found: ${request.sessionId}`)
    }
    if (existing && existing.projectId !== project.id) {
      throw new TaskApiError(
        'invalid_request',
        `Session ${existing.id} does not belong to project ${project.id}.`
      )
    }

    const userMessageId = this.dependencies.createId()
    const prepared = await this.prepareSession(project, existing, request, prompt, userMessageId)
    const session = prepared.session
    const runId = this.dependencies.createId()
    const run = {
      id: runId,
      sessionId: session.id,
      projectId: project.id,
      status: 'running' as const,
      startedAt: this.dependencies.now(),
      artifacts: [],
      events: [],
      completion: Promise.resolve()
    } satisfies MutableTaskRun

    this.pruneRuns()
    this.runs.set(runId, run)
    run.completion = this.executeRun(run, session, request, prompt, prepared.historyPreamble)
    return cloneRun(run)
  }

  getRun(runId: string): TaskRun {
    const run = this.runs.get(runId)
    if (!run) throw new TaskApiError('run_not_found', `Run not found: ${runId}`)
    return cloneRun(run)
  }

  async waitForRun(runId: string): Promise<TaskRun> {
    const run = this.runs.get(runId)
    if (!run) throw new TaskApiError('run_not_found', `Run not found: ${runId}`)
    await run.completion
    return cloneRun(run)
  }

  async listArtifacts(sessionId: string): Promise<PersistedArtifact[]> {
    return [...((await this.findSession(sessionId)).artifacts ?? [])]
  }

  async acquireArtifact(artifactId: string): Promise<AcquiredTaskArtifact> {
    const sessions = await this.loadSessions()
    const artifact = sessions
      .flatMap((session) => session.artifacts ?? [])
      .find((candidate) => candidate.id === artifactId)
    if (!artifact) {
      throw new TaskApiError('artifact_not_found', `Artifact not found: ${artifactId}`)
    }
    const resource = (await this.invoke('preview-resources:acquire', {
      source: 'artifact',
      path: artifact.path,
      mimeType: artifact.mimeType
    })) as { id: string; url: string; size: number; mimeType?: string }
    return {
      resourceId: resource.id,
      url: resource.url,
      name: artifact.name ?? artifact.path.split(/[\\/]/).at(-1) ?? artifact.id,
      mimeType: resource.mimeType ?? artifact.mimeType,
      size: resource.size
    }
  }

  async releaseArtifact(resourceId: string): Promise<void> {
    await this.invoke('preview-resources:release', { resourceId })
  }

  private async prepareSession(
    project: Project,
    existing: PersistedChatSession | undefined,
    request: StartTaskRunRequest,
    prompt: string,
    userMessageId: string
  ): Promise<{ session: PersistedChatSession; historyPreamble?: string }> {
    const now = this.dependencies.now()
    const permissionProfile =
      request.permissionProfile ?? existing?.permissionProfile ?? DEFAULT_PERMISSION_PROFILE
    let sessionInfo: AcpCreateSessionResponse

    if (existing) {
      const state = (await this.invoke('acp:get-state')) as { sessionIds?: string[] }
      if (state.sessionIds?.includes(existing.id)) {
        if (request.permissionProfile && request.permissionProfile !== existing.permissionProfile) {
          await this.invoke('acp:set-permission-profile', {
            sessionId: existing.id,
            profile: request.permissionProfile
          })
        }
        sessionInfo = {
          sessionId: existing.id,
          cwd: existing.cwd,
          frameworkId: existing.agentFrameworkId,
          backendId: existing.agentBackendId
        }
      } else {
        sessionInfo = (await this.invoke('acp:resume-session', {
          sessionId: existing.id,
          cwd: existing.cwd,
          projectName: project.id,
          permissionProfile,
          previousFrameworkId: existing.agentFrameworkId,
          previousBackendId: existing.agentBackendId
        })) as AcpCreateSessionResponse
      }
    } else {
      sessionInfo = (await this.invoke('acp:create-session', {
        projectName: project.id,
        permissionProfile
      })) as AcpCreateSessionResponse
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
          messages: [userMessage],
          activeRun: { promptMessageId: userMessageId, startedAt: now },
          createdAt: now,
          updatedAt: now
        }

    await this.invoke('sessions:save-session', session)
    return {
      session,
      historyPreamble:
        existing && sessionInfo.contextReset ? createHistoryPreamble(existing) : undefined
    }
  }

  private async executeRun(
    run: MutableTaskRun,
    session: PersistedChatSession,
    request: StartTaskRunRequest,
    prompt: string,
    historyPreamble?: string
  ): Promise<void> {
    let promptError: unknown
    try {
      await this.invoke('acp:send-prompt', {
        sessionId: session.id,
        text: prompt,
        ...(request.skillIds?.length ? { forcedSkillIds: request.skillIds } : {}),
        ...(historyPreamble ? { historyPreamble } : {})
      })
    } catch (error) {
      promptError = error
    }

    let completed: Awaited<ReturnType<HeadlessTaskApi['completeSession']>> | undefined
    let completionError: unknown
    try {
      completed = await this.completeSession(session, run.events)
    } catch (error) {
      completionError = error
    }

    const failure = completionError ?? promptError
    if (failure) {
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
        updatedAt: this.dependencies.now()
      }
      await this.invoke('sessions:save-session', failed).catch(() => undefined)
      run.status = 'failed'
      run.error = message
      run.output = completed?.output
      run.artifacts = completed?.artifacts ?? []
      run.completedAt = this.dependencies.now()
      return
    }

    await this.invoke('sessions:save-session', completed!.session)
    run.status = 'completed'
    run.output = completed!.output
    run.artifacts = completed!.artifacts
    run.completedAt = this.dependencies.now()
  }

  private async completeSession(
    session: PersistedChatSession,
    events: AcpRuntimeEvent[]
  ): Promise<{ session: PersistedChatSession; output: string; artifacts: ArtifactFile[] }> {
    const now = this.dependencies.now()
    const assistantEvents = events.filter(
      (event) => event.kind === 'message' && event.role === 'assistant'
    )
    const output = assistantEvents.map((event) => getAcpRuntimeEventText(event) ?? '').join('')
    const assistantMessageId = this.dependencies.createId()
    const images = assistantEvents
      .map((event) => {
        const image = getAcpRuntimeEventImage(event)
        return image ? ({ id: event.id, ...image } satisfies PersistedMessageImage) : undefined
      })
      .filter((image): image is PersistedMessageImage => Boolean(image))
    const finalizedArtifacts: ArtifactFile[] = []
    for (const event of events) {
      if (event.kind !== 'artifact' || !event.artifactClaimId) continue
      const artifacts = (await this.invoke('artifacts:finalize-run', {
        claimId: event.artifactClaimId,
        messageId: assistantMessageId
      })) as ArtifactFile[]
      finalizedArtifacts.push(...artifacts)
    }
    const assistantMessage: PersistedChatMessage = {
      id: assistantMessageId,
      role: 'agent',
      content: output,
      status: 'complete',
      responseToMessageId: session.activeRun?.promptMessageId,
      eventIds: assistantEvents.map((event) => event.id),
      artifactIds: finalizedArtifacts.length
        ? finalizedArtifacts.map((artifact) => artifact.id)
        : undefined,
      images: images.length ? images : undefined,
      createdAt: now,
      updatedAt: now
    }
    const activities = this.createActivities(events, now)
    const uniqueArtifacts = [
      ...new Map(finalizedArtifacts.map((artifact) => [artifact.id, artifact])).values()
    ]
    const persistedArtifacts = uniqueArtifacts.map(toPersistedArtifact)
    const hasAssistantMessage = Boolean(output || images.length || persistedArtifacts.length)

    return {
      output,
      artifacts: uniqueArtifacts,
      session: {
        ...session,
        status: 'idle',
        activeRun: undefined,
        messages: hasAssistantMessage ? [...session.messages, assistantMessage] : session.messages,
        activities: [...(session.activities ?? []), ...activities],
        artifacts: [...(session.artifacts ?? []), ...persistedArtifacts],
        filesRevision:
          persistedArtifacts.length > 0 ? (session.filesRevision ?? 0) + 1 : session.filesRevision,
        updatedAt: now
      }
    }
  }

  private createActivities(events: AcpRuntimeEvent[], now: number): PersistedToolActivity[] {
    const activities = new Map<string, PersistedToolActivity>()
    for (const event of events) {
      if (event.kind !== 'tool' || !event.toolCallId) continue
      const existing = activities.get(event.toolCallId)
      activities.set(event.toolCallId, {
        id: event.toolCallId,
        kind: 'tool',
        title: event.title?.trim() || existing?.title || 'Tool call',
        status:
          event.status === 'failed'
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
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      })
    }
    return [...activities.values()]
  }

  private captureEvent(event: AcpRuntimeEvent): void {
    if (!event.sessionId) return
    for (const run of this.runs.values()) {
      if (run.status === 'running' && run.sessionId === event.sessionId) run.events.push(event)
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
    if (!normalized) throw new TaskApiError('invalid_request', 'Project is required.')
    const projects = await this.listProjects()
    const byId = projects.find((project) => project.id === normalized)
    if (byId) return byId
    const byName = projects.filter((project) => project.name === normalized)
    if (byName.length === 1) return byName[0]
    if (byName.length > 1) {
      throw new TaskApiError('project_ambiguous', `Project name is ambiguous: ${normalized}`)
    }
    throw new TaskApiError('project_not_found', `Project not found: ${normalized}`)
  }

  private async findSession(sessionId: string): Promise<PersistedChatSession> {
    const session = (await this.loadSessions()).find((candidate) => candidate.id === sessionId)
    if (!session) throw new TaskApiError('session_not_found', `Session not found: ${sessionId}`)
    return session
  }

  private async loadSessions(): Promise<PersistedChatSession[]> {
    const result = (await this.invoke('sessions:load-all')) as {
      sessions: PersistedChatSession[]
    }
    return result.sessions
  }

  private invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    return this.rpc.invoke(channel, TASK_API_CLIENT_ID, args)
  }
}

export { HeadlessTaskApi, TaskApiError, summarizeSession }
export type { TaskApiDependencies, TaskRpc }
