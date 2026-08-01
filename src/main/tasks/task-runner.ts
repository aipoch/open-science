import type {
  AcpCreateSessionRequest,
  AcpCreateSessionResponse,
  AcpPromptRequest,
  AcpResumeSessionRequest,
  AcpRuntimeEvent,
  AcpSetPermissionProfileRequest
} from '../../shared/acp'
import type {
  FinalizeRunArtifactsRequest,
  FinalizeRunArtifactsResult
} from '../../shared/artifacts'
import type { Project } from '../../shared/projects'
import type { PersistedArtifact, PersistedChatSession } from '../../shared/session-persistence'
import type {
  AcquiredTaskArtifact,
  TaskApiErrorCode,
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

type TaskAgentPort = {
  listAttachedSessionIds(): Promise<string[]>
  createSession(request: AcpCreateSessionRequest): Promise<AcpCreateSessionResponse>
  resumeSession(request: AcpResumeSessionRequest): Promise<AcpCreateSessionResponse>
  setPermissionProfile(request: AcpSetPermissionProfileRequest): Promise<void>
  sendPrompt(request: AcpPromptRequest): Promise<void>
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
  constructor(private readonly dependencies: TaskRunnerDependencies) {}

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

export { TaskRunner, TaskRunnerError }
export type {
  CreateTaskProjectRequest,
  TaskAgentPort,
  TaskArtifactPort,
  TaskProjectPort,
  TaskPreviewResourcePort,
  TaskRunnerDependencies,
  TaskRuntimeEventPort,
  TaskSessionPort
}
