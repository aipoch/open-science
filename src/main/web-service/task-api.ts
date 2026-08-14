import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

import type { AcpRuntimeEvent } from '../../shared/acp'
import type {
  FinalizeRunArtifactsRequest,
  FinalizeRunArtifactsResult
} from '../../shared/artifacts'
import type { Project } from '../../shared/projects'
import type { ActivePlanProjection, PlanResponseCommand } from '../../shared/session-plan/contract'
import type { PersistedArtifact, PersistedChatSession } from '../../shared/session-persistence'
import type {
  AcquiredTaskArtifact,
  StartTaskRunRequest,
  TaskPlanResponseRequest,
  TaskRun,
  TaskRunProgressEvent,
  TaskRunReview,
  TaskSessionSummary
} from '../../shared/task-api'
import { createApplicationCommandClient } from '../application-command-client'
import type { ApplicationCommandByNameDispatcher } from '../application-command-composition'
import { createTaskCallerContext, type CallerContext } from '../caller-context'
import type { PlanResponseResult } from '../session-plan/plan-service'
import type { TaskControlPorts } from '../tasks/task-control-ports'
import {
  TaskRunner,
  TaskRunnerError,
  summarizeSession,
  type CreateTaskProjectRequest,
  type TaskAgentPort,
  type TaskRunnerDependencies
} from '../tasks/task-runner'

const TASK_CALLER_CONTEXT = createTaskCallerContext()

type TaskApiPorts = {
  commands: ApplicationCommandByNameDispatcher
  agent: TaskAgentPort
  controls?: TaskControlPorts
}

type TaskApiDependencies = {
  createId: () => string
  now: () => number
  subscribeEvents: (listener: (event: AcpRuntimeEvent) => void) => () => void
}

class HeadlessTaskApi {
  private readonly callerContexts = new AsyncLocalStorage<CallerContext>()
  private readonly commandClient = createApplicationCommandClient()
  private readonly runner: TaskRunner

  constructor(
    private readonly ports: TaskApiPorts,
    dependencies: Partial<TaskApiDependencies> = {}
  ) {
    const subscribeEvents = dependencies.subscribeEvents ?? (() => () => undefined)
    // Non-Agent compatibility channels remain temporary façade adapters. Agent execution crosses a
    // direct, narrow port so Task never impersonates an Electron caller for runtime operations.
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
        withSessionAvailable: (projectId, sessionId, operation) =>
          this.withCurrentCaller(() =>
            this.ports.agent.withSessionAvailable(projectId, sessionId, operation)
          ),
        listAttachedSessionIds: () =>
          this.withCurrentCaller(() => this.ports.agent.listAttachedSessionIds()),
        createSession: (request) =>
          this.withCurrentCaller(() => this.ports.agent.createSession(request)),
        resumeSession: (request) =>
          this.withCurrentCaller(() => this.ports.agent.resumeSession(request)),
        setPermissionProfile: (sessionId, profile) =>
          this.withCurrentCaller(() => this.ports.agent.setPermissionProfile(sessionId, profile)),
        prompt: (request, observer) =>
          this.withCurrentCaller(() => this.ports.agent.prompt(request, observer)),
        cancelPrompt: (sessionId) =>
          this.withCurrentCaller(() => this.ports.agent.cancelPrompt(sessionId))
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
          await this.commandClient.invoke(
            this.ports.commands,
            'preview-resources:release',
            TASK_CALLER_CONTEXT,
            [{ resourceId }]
          )
        }
      },
      runtimeEvents: { subscribe: subscribeEvents },
      specialists: {
        resolve: (reference) => this.resolveSpecialist(reference)
      },
      reviewer: { review: (session, turnMessageId) => this.review(session, turnMessageId) },
      createId: dependencies.createId ?? randomUUID,
      now: dependencies.now ?? Date.now
    } satisfies TaskRunnerDependencies)
  }

  dispose(): void {
    try {
      this.runner.dispose()
    } finally {
      this.commandClient.dispose()
    }
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

  async getSessionPlan(sessionId: string): Promise<ActivePlanProjection | null> {
    const session = await this.runner.getSession(sessionId)
    const plans = this.ports.controls?.plans
    if (!plans) throw new Error('Task Plan controls are unavailable.')
    return plans.getProjection(session.projectId, session.id)
  }

  async respondSessionPlan(
    sessionId: string,
    request: TaskPlanResponseRequest
  ): Promise<PlanResponseResult> {
    const session = await this.runner.getSession(sessionId)
    const plans = this.ports.controls?.plans
    if (!plans) throw new Error('Task Plan controls are unavailable.')
    const command: PlanResponseCommand =
      'feedback' in request && typeof request.feedback === 'string'
        ? { projectId: session.projectId, sessionId: session.id, feedback: request.feedback }
        : {
            projectId: session.projectId,
            sessionId: session.id,
            decision: request.decision,
            artifactVersionId: request.artifactVersionId,
            expectedRevision: request.expectedRevision
          }
    return plans.respond(command)
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

  cancelRun(runId: string): Promise<TaskRun> {
    return this.runner.cancelRun(runId)
  }

  subscribeProgress(listener: (event: TaskRunProgressEvent) => void): () => void {
    return this.runner.subscribeProgress(listener)
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
    return this.commandClient.invoke(
      this.ports.commands,
      channel,
      this.currentCallerContext(),
      args
    )
  }

  private currentCallerContext(): CallerContext {
    return this.callerContexts.getStore() ?? TASK_CALLER_CONTEXT
  }

  private withCurrentCaller<Result>(operation: () => Promise<Result>): Promise<Result> {
    if (!this.currentCallerContext().isAuthorizationCurrent()) {
      return Promise.reject(new Error('Caller authorization is no longer current.'))
    }
    return operation()
  }

  private resolveSpecialist(reference: string): Promise<{ id: string }> {
    const specialists = this.ports.controls?.specialists
    if (!specialists) return Promise.reject(new Error('Task Specialist controls are unavailable.'))
    return specialists.resolve(reference)
  }

  private async review(
    session: PersistedChatSession,
    turnMessageId: string
  ): Promise<TaskRunReview> {
    const reviewer = this.ports.controls?.reviewer
    if (!reviewer) {
      return {
        started: false,
        reason: 'run-failed',
        errorMessage: 'Task Reviewer controls are unavailable.'
      }
    }
    const started = await reviewer.triggerReview({
      sessionId: session.id,
      turnMessageId,
      projectId: session.projectId,
      mainSessionId: session.id,
      model: session.agentModel,
      origin: 'auto'
    })
    if (!started.started) return started

    for (;;) {
      const reviews = await reviewer.getForSession({
        projectId: session.projectId,
        appSessionId: session.id
      })
      const review = [...reviews]
        .reverse()
        .find((candidate) => candidate.turnMessageId === turnMessageId)
      if (review && review.lifecycle !== 'running') {
        return {
          started: true,
          id: review.id,
          lifecycle: review.lifecycle,
          outcome: review.outcome,
          errorMessage: review.errorMessage
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
}

export { HeadlessTaskApi, TaskRunnerError as TaskApiError, summarizeSession }
export type { TaskApiDependencies, TaskApiPorts }
