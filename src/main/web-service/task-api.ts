import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

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
  StartTaskRunRequest,
  TaskRun,
  TaskSessionSummary
} from '../../shared/task-api'
import { createTaskCallerContext, type CallerContext } from '../caller-context'
import {
  TaskRunner,
  TaskRunnerError,
  summarizeSession,
  type CreateTaskProjectRequest,
  type TaskRunnerDependencies
} from '../tasks/task-runner'

const TASK_CALLER_CONTEXT = createTaskCallerContext()

type TaskRpc = {
  invoke(channel: string, callerContext: CallerContext, args: unknown[]): Promise<unknown>
}

type TaskApiDependencies = {
  createId: () => string
  now: () => number
  subscribeEvents: (listener: (event: AcpRuntimeEvent) => void) => () => void
}

class HeadlessTaskApi {
  private readonly callerContexts = new AsyncLocalStorage<CallerContext>()
  private readonly runner: TaskRunner

  constructor(
    private readonly rpc: TaskRpc,
    dependencies: Partial<TaskApiDependencies> = {}
  ) {
    const subscribeEvents = dependencies.subscribeEvents ?? (() => () => undefined)
    // Compatibility removal target: A6/T2 replace these façade channel mappings with direct owner
    // adapters while TaskRunner keeps the same narrow ports.
    this.runner = new TaskRunner({
      projects: {
        list: () => this.invoke('projects:list') as Promise<Project[]>,
        create: (request) => this.invoke('projects:create', request) as Promise<Project>
      },
      sessions: {
        list: async () => {
          const result = (await this.invoke('sessions:load-all')) as {
            sessions: PersistedChatSession[]
          }
          return result.sessions
        },
        save: async (session) => {
          await this.invoke('sessions:save-session', session)
        }
      },
      agent: {
        listAttachedSessionIds: async () => {
          const state = (await this.invoke('acp:get-state')) as { sessionIds?: string[] }
          return state.sessionIds ?? []
        },
        createSession: (request: AcpCreateSessionRequest) =>
          this.invoke('acp:create-session', request) as Promise<AcpCreateSessionResponse>,
        resumeSession: (request: AcpResumeSessionRequest) =>
          this.invoke('acp:resume-session', request) as Promise<AcpCreateSessionResponse>,
        setPermissionProfile: async (request: AcpSetPermissionProfileRequest) => {
          await this.invoke('acp:set-permission-profile', request)
        },
        sendPrompt: async (request: AcpPromptRequest) => {
          await this.invoke('acp:send-prompt', request)
        }
      },
      artifacts: {
        finalizeRun: (request: FinalizeRunArtifactsRequest) =>
          this.invoke('artifacts:finalize-run', request) as Promise<FinalizeRunArtifactsResult>
      },
      previewResources: {
        acquire: (request) =>
          this.invoke('preview-resources:acquire', request) as Promise<{
            id: string
            url: string
            size: number
            mimeType?: string
          }>,
        // Capability cleanup must remain available if request authorization is revoked while a
        // response stream drains. The fixed local automation context grants no new access.
        release: async (resourceId) => {
          await this.rpc.invoke('preview-resources:release', TASK_CALLER_CONTEXT, [{ resourceId }])
        }
      },
      runtimeEvents: { subscribe: subscribeEvents },
      createId: dependencies.createId ?? randomUUID,
      now: dependencies.now ?? Date.now
    } satisfies TaskRunnerDependencies)
  }

  dispose(): void {
    this.runner.dispose()
  }

  runWithCallerContext<Result>(context: CallerContext, operation: () => Result): Result {
    return this.callerContexts.run(context, operation)
  }

  listProjects(): Promise<Project[]> {
    return this.runner.listProjects()
  }

  createProject(request: CreateTaskProjectRequest): Promise<Project> {
    return this.runner.createProject(request)
  }

  listSessions(project?: string): Promise<TaskSessionSummary[]> {
    return this.runner.listSessions(project)
  }

  getSession(sessionId: string): Promise<TaskSessionSummary> {
    return this.runner.getSession(sessionId)
  }

  startRun(request: StartTaskRunRequest): Promise<TaskRun> {
    return this.runner.startRun(request)
  }

  getRun(runId: string): TaskRun {
    return this.runner.getRun(runId)
  }

  waitForRun(runId: string): Promise<TaskRun> {
    return this.runner.waitForRun(runId)
  }

  listArtifacts(sessionId: string): Promise<PersistedArtifact[]> {
    return this.runner.listArtifacts(sessionId)
  }

  acquireArtifact(artifactId: string): Promise<AcquiredTaskArtifact> {
    return this.runner.acquireArtifact(artifactId)
  }

  releaseArtifact(resourceId: string): Promise<void> {
    return this.runner.releaseArtifact(resourceId)
  }

  private invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    return this.rpc.invoke(channel, this.callerContexts.getStore() ?? TASK_CALLER_CONTEXT, args)
  }
}

export { HeadlessTaskApi, TaskRunnerError as TaskApiError, summarizeSession }
export type { TaskApiDependencies, TaskRpc }
