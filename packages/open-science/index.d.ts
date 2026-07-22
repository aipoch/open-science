export type PermissionProfile = 'ask' | 'auto' | 'full'
export type RunStatus = 'running' | 'completed' | 'failed'

export type Project = {
  id: string
  name: string
  description: string
  isExample: boolean
  createdAt: number
  updatedAt: number
}

export type Run = {
  id: string
  sessionId: string
  projectId: string
  status: RunStatus
  startedAt: number
  completedAt?: number
  output?: string
  error?: string
  artifacts: Artifact[]
}

export type Session = {
  id: string
  projectId: string
  title: string
  status: 'idle' | 'running' | 'waiting-permission' | 'error'
  permissionProfile?: PermissionProfile
  createdAt: number
  updatedAt: number
  output?: string
  error?: string
  artifactCount: number
}

export type Artifact = {
  id: string
  kind: 'workspace-file' | 'external-file' | 'managed-file'
  path: string
  name?: string
  mimeType?: string
  size?: number
  mtimeMs?: number
  sha256?: string
}

export class OpenScienceApiError extends Error {
  code: string
  status?: number
}

export class OpenScienceClient {
  constructor(options: {
    baseUrl: string
    token: string
    fetch?: typeof globalThis.fetch
    sleep?: (milliseconds: number) => Promise<void>
  })
  health(): Promise<unknown>
  listProjects(): Promise<Project[]>
  createProject(request: { name: string; description?: string }): Promise<Project>
  listSessions(project?: string): Promise<Session[]>
  getSession(sessionId: string): Promise<Session>
  startRun(request: {
    project: string
    prompt: string
    sessionId?: string
    permissionProfile?: PermissionProfile
    skillIds?: string[]
  }): Promise<Run>
  getRun(runId: string): Promise<Run>
  waitForRun(
    runId: string,
    options?: { pollIntervalMs?: number; signal?: AbortSignal; timeoutMs?: number }
  ): Promise<Run>
  listArtifacts(sessionId: string): Promise<Artifact[]>
  downloadArtifact(artifactId: string, options?: { signal?: AbortSignal }): Promise<Response>
  events(options?: {
    signal?: AbortSignal
    WebSocket?: typeof globalThis.WebSocket
  }): AsyncIterable<{
    type: 'run.event' | 'permission.requested'
    data: unknown
  }> & { ready: Promise<void> }
}

export function connectToOpenScience(options?: {
  configRoot?: string
  env?: Record<string, string | undefined>
  fetch?: typeof globalThis.fetch
}): Promise<OpenScienceClient>
