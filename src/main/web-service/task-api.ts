import { AsyncLocalStorage } from 'node:async_hooks'
import { isDeepStrictEqual } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { DiscoveredInterpreter } from '@aipoch/environment/contracts'
import type { BootstrapRequest, BootstrapResult } from '../../shared/bootstrap'
import type { CliLauncherStatus } from '../../shared/cli'
import type { NotebookLanguage } from '../../shared/notebook-language-contract'
import { isEnvEnabled, type RuntimeEnablement } from '../../shared/notebook-runtime'

import type { AcpRuntimeEvent } from '../../shared/acp'
import {
  isAppOwnedNotebookCodeReview,
  isAppOwnedNotebookRuntimeReview,
  type AcpPermissionRequest
} from '../../shared/acp-permission-contract'
import type { ArtifactVersionDescriptor } from '../../shared/artifact-provenance'
import {
  resolveActiveConversationActivities,
  resolveActiveConversationMessages,
  type PersistedAgentFrame
} from '../../shared/conversation-graph'
import {
  resolveAgentUserChoiceQuestions,
  type PendingElicitationRequest,
  type TaskQuestionReceipt
} from '../../shared/elicitation'
import type {
  FinalizeRunArtifactsRequest,
  FinalizeRunArtifactsResult
} from '../../shared/artifacts'
import type {
  ManagedFileVersionInspectResult,
  ManagedFileVersionIpcResult
} from '../../shared/managed-file-versions'
import type { Project } from '../../shared/projects'
import type { ReviewRunResult, ReviewWithChecks } from '../../shared/reviewer'
import type {
  UpdateProjectSessionDefaultsRequest,
  UpdateSessionConfigurationRequest
} from '../../shared/session-configuration'
import { latestOutcomePrompt, type PersistedChatSession } from '../../shared/session-persistence'
import type { ActivePlanProjection, PlanResponseCommand } from '../../shared/session-plan/contract'
import { PlanCommandError } from '../../shared/session-plan/contract'
import type {
  TaskInteractionScope,
  TaskInteraction,
  TaskInteractionPolicy,
  TaskInteractionReference,
  TaskPermissionInteraction,
  TaskPermissionResponse,
  TaskNotebookStopInteraction,
  TaskPlanInteraction,
  SetTaskInteractionModeRequest,
  TaskQuestionInteraction,
  TaskQuestionResponse
} from '../../shared/task-interaction'
import type {
  AddCustomServerRequest,
  ConnectorDetailView,
  ConnectorsSnapshot,
  CreateDeviceCredentialRequest,
  CreateDeviceCredentialResult,
  CustomServerView,
  DeviceCredentialsSnapshot,
  ReadinessPreflight,
  SettingsSnapshot,
  SkillView,
  UpdateCustomServerRequest,
  UpdateDeviceCredentialRequest
} from '../../shared/settings'
import type {
  CreateTaskProjectRequest,
  StartTaskRunRequest,
  SubmitTaskRunRequest,
  TaskAgentRouting,
  TaskAgentRuntime,
  TaskDoctorReport,
  TaskNotebookContinuationRequest,
  TaskNotebookEnvironmentOperation,
  TaskNotebookEnvironmentRequest,
  TaskNotebookEnvironmentTarget,
  TaskNotebookRuntime,
  TaskPlanResponseRequest,
  TaskProject,
  TaskProjectSessionDefaults,
  TaskRun,
  TaskRunProgressEvent,
  TaskRunReview,
  TaskSubmission,
  TaskSessionConfiguration,
  TaskSessionSummary,
  UpdateTaskAgentRoutingRequest,
  UpdateTaskProjectRequest
} from '../../shared/task-api'
import { createApplicationCommandClient } from '../application-command-client'
import { taskPermissionOptions } from '../acp/permission-broker'
import { restorableTaskPermission } from '../acp/permission-wait-owner'
import { createLogger } from '@aipoch/diagnostics/node'
import type { ApplicationCommandByNameDispatcher } from '../application-command-composition-contract'
import type {
  DelegatedQuestionRequest,
  DelegatedWorkAttemptRecord
} from '../../shared/delegated-work-contract'
import { DurableDelegatedWorkError } from '../delegation/durable-delegated-work-error'
import {
  canRelayTaskInteraction,
  createTaskCallerContext,
  type CallerContext
} from '../caller-context'
import {
  NotebookEnvironmentOperationConflictError,
  type ManagedNotebookSetup
} from '../notebook/environment-lifecycle-workflows'
import type { NotebookRuntimeService } from '../notebook/runtime-service'
import type { RuntimeWorkflows } from '../notebook/runtime-workflows'
import { containsSecretBearingMaterial } from '../permission-grants/capability'
import type { TaskControlPorts } from '../tasks/task-control-ports'
import { TaskSubmissions, taskContinuationRequestId } from '../tasks/task-submissions'
import type { TaskRunJournal } from '../tasks/task-run-journal'
import {
  TaskRunner,
  TaskRunnerError,
  summarizeSession,
  type TaskAgentPort,
  type TaskComputePreferencePort,
  type TaskRunnerDependencies
} from '../tasks/task-runner'
import type {
  TaskContinuationIdentity,
  TaskContinuationTracker
} from '../../shared/task-continuation'
import { readTaskNotebookReadiness } from './task-notebook-readiness'
import { taskQuestionAnswer, taskQuestionRevision } from '../acp/elicitation-owner'

const TASK_CALLER_CONTEXT = createTaskCallerContext()
const log = createLogger('web-service:task-api')
const notebookStopPrefix = 'notebook-continuation:'
const childPermissionPrefix = 'child-permission:'
const childQuestionPrefix = 'child-question:'
const notebookContinuationRequest = z.strictObject({
  runId: z.string().trim().min(1),
  branchId: z.string().trim().min(1),
  refusalId: z.string().trim().min(1),
  source: z.literal('user_relay'),
  prompt: z.string().trim().min(1)
}) satisfies z.ZodType<TaskNotebookContinuationRequest>

const notebookLanguage = z.enum(['python', 'r'])
const notebookRuntimeMutation = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('register'),
    language: notebookLanguage,
    path: z.string().min(1).max(4096)
  }),
  z.strictObject({
    action: z.literal('enable'),
    language: notebookLanguage,
    runtimeId: z.string().min(1).max(4096)
  })
])

const taskNotebookRuntime = (
  env: DiscoveredInterpreter,
  enablement: RuntimeEnablement
): TaskNotebookRuntime => ({
  language: env.language,
  runtimeId: env.envId,
  source: env.provenance === 'user-own' ? 'external' : 'managed',
  provenance: env.provenance,
  interpreterPath: env.interpreterPath,
  label: env.label,
  ...(env.version ? { version: env.version } : {}),
  runnable: env.runnable,
  enabled: isEnvEnabled(env, enablement),
  ...(env.detail ? { detail: env.detail } : {})
})

const notebookStopExpired = (): TaskRunnerError =>
  new TaskRunnerError(
    'notebook_continuation_expired',
    'The Notebook stop is no longer current in this branch, or cannot be recovered after restart. Inspect the original Run and ask the user before starting any new work.'
  )

const permissionText = (value: string): string =>
  containsSecretBearingMaterial(value) ? '[Redacted]' : value.slice(0, 512)

const reviewRiskSchema = z.object({
  operation: z.string(),
  source: z.string(),
  line: z.number().int().positive()
})

function notebookPermissionPreview(request: AcpPermissionRequest):
  | {
      notebookReview: NonNullable<TaskPermissionInteraction['notebookReview']>
      input: Record<string, unknown>
    }
  | undefined {
  const fields = (source: Record<string, unknown>, keys: string[]): Record<string, string> =>
    Object.fromEntries(
      keys.flatMap((key) =>
        typeof source[key] === 'string' ? [[key, permissionText(source[key])]] : []
      )
    )
  if (isAppOwnedNotebookRuntimeReview(request)) {
    const target = request.rawInput.notebookRuntimeSelection
    if (
      (target.language !== 'r' && target.language !== 'python') ||
      typeof target.runtimeId !== 'string' ||
      !target.runtimeId
    )
      return undefined
    return {
      notebookReview: { kind: 'runtime', language: target.language },
      input: fields(target, [
        'runtimeId',
        'label',
        'interpreterPath',
        'previousRuntimeId',
        'previousLabel'
      ])
    }
  }
  if (isAppOwnedNotebookCodeReview(request)) {
    const { code, notebookCodeRisk: risk } = request.rawInput
    const language = z.enum(['python', 'r', 'repl', 'bash']).safeParse(risk.language)
    if (
      !language.success ||
      !Array.isArray(risk.risks) ||
      typeof risk.runId !== 'string' ||
      !risk.runId
    )
      return undefined
    const risks = risk.risks.slice(0, 16).flatMap((entry) => {
      const parsed = reviewRiskSchema.safeParse(entry)
      return parsed.success
        ? [{ ...fields(parsed.data, ['operation', 'source']), line: parsed.data.line }]
        : []
    })
    if (!risks.length) return undefined
    return {
      notebookReview: { kind: 'code', language: language.data },
      input: {
        ...fields(risk, ['runId', 'environment', 'runtimeId']),
        riskCount: risk.risks.length,
        risks,
        ...(typeof code === 'string' && code.length <= 8192 && !containsSecretBearingMaterial(code)
          ? { code }
          : { codeOmitted: true })
      }
    }
  }
  return undefined
}

function permissionPreview(
  request: AcpPermissionRequest,
  notebook?: ReturnType<typeof notebookPermissionPreview>
): NonNullable<TaskPermissionInteraction['request']> {
  const preview = notebook ? undefined : JSON.stringify(request.rawInput)
  return {
    title: permissionText(request.title),
    toolCallId: request.toolCallId,
    ...((request.mcpIdentity ?? request.providerToolName)
      ? { tool: permissionText((request.mcpIdentity ?? request.providerToolName)!) }
      : {}),
    ...(notebook
      ? { input: notebook.input }
      : preview && preview.length <= 8192 && !containsSecretBearingMaterial(preview)
        ? { input: request.rawInput }
        : {}),
    options: taskPermissionOptions(request).map((option) => ({
      ...option,
      name: permissionText(option.name)
    }))
  }
}

type TaskNotebookRuntimes = Pick<
  RuntimeWorkflows,
  | 'listLanguageEnvironments'
  | 'registerCheckedInterpreter'
  | 'getEnablement'
  | 'setEnvironmentEnabled'
>

type TaskApiPorts = {
  commands: ApplicationCommandByNameDispatcher
  agent: TaskAgentPort
  notebook?: Pick<NotebookRuntimeService, 'inspectTaskExecution'>
  notebookEnvironment?: ManagedNotebookSetup
  notebookRuntimes?: TaskNotebookRuntimes
  controls?: TaskControlPorts
  computePreferences?: TaskComputePreferencePort
  detectActiveSessions?: () => ReadonlyArray<{ projectId: string; sessionId: string }>
}

type TaskApiDependencies = {
  createId: () => string
  now: () => number
  subscribeEvents: (listener: (event: AcpRuntimeEvent) => void) => () => void
  runJournal: TaskRunJournal
  submissionRoot: string
}

type ArtifactBrowserSelection = {
  projectId?: string
  versionNumber?: number
}

type ScopedTaskQuestion = {
  taskRunId?: string
  interaction: TaskQuestionInteraction
  request: PendingElicitationRequest
  receipt?: TaskQuestionReceipt
  waitsForProvider: boolean
  readyToAnswer: boolean
}

type ScopedChildQuestion = {
  interaction: TaskQuestionInteraction
  record: DelegatedQuestionRequest
  request: PendingElicitationRequest
}

const rootQuestionScope = (
  session: PersistedChatSession
): { branchId: string; promptMessageId: string } | undefined => {
  const graph = session.conversationGraph
  if (!graph || graph.activeFrameId !== graph.rootFrameId) return undefined
  const branchId = graph.frames.find(({ id }) => id === graph.rootFrameId)?.activeBranchId
  const prompt = resolveActiveConversationMessages(graph).findLast(({ role }) => role === 'user')
  if (
    !branchId ||
    !prompt ||
    !graph.messages.some(
      ({ id, introducedOnBranchId }) => id === prompt.id && introducedOnBranchId === branchId
    )
  )
    return undefined
  return { branchId, promptMessageId: prompt.id }
}

const staleQuestion = (): TaskRunnerError =>
  new TaskRunnerError(
    'interaction_revision_conflict',
    'The question, prompt, or active Message Branch changed. Read the current interaction before answering.'
  )

const delegatedAttempt = (
  session: PersistedChatSession,
  frameId: string,
  attemptId: string
):
  | {
      attempt: DelegatedWorkAttemptRecord
      frame: PersistedAgentFrame
      promptMessageId: string
      rootBranchId: string
      active: boolean
      latest: boolean
    }
  | undefined => {
  const graph = session.conversationGraph
  const frame = graph?.frames.find(({ id }) => id === frameId)
  const root = graph?.frames.find(({ id }) => id === graph.rootFrameId)
  const attempts = session.runtimeContext?.delegatedWork?.records.find(
    ({ agentFrameId }) => agentFrameId === frameId
  )?.attempts
  const attempt = attempts?.find(({ id }) => id === attemptId)
  const promptMessageId = attempt?.initiatingTurnMessageId
  if (
    !graph ||
    !root ||
    frame?.kind !== 'delegate' ||
    frame.parentFrameId !== root.id ||
    frame.originBindingState !== 'validated' ||
    !attempt ||
    !promptMessageId
  )
    return
  const prompt = graph.messages.find(({ id }) => id === promptMessageId)
  if (!prompt || prompt.agentFrameId !== root.id) return
  return {
    attempt,
    frame,
    promptMessageId,
    active:
      root.activeBranchId === prompt.introducedOnBranchId &&
      resolveActiveConversationMessages({ ...graph, activeFrameId: root.id }).some(
        ({ id }) => id === prompt.id
      ),
    rootBranchId: prompt.introducedOnBranchId,
    latest: attempts?.at(-1)?.id === attemptId
  }
}

class HeadlessTaskApi {
  private readonly callerContexts = new AsyncLocalStorage<CallerContext>()
  private readonly commandClient = createApplicationCommandClient()
  private readonly runner: TaskRunner
  private readonly submissions?: TaskSubmissions
  private readonly pendingQuestionResponses = new Map<string, Promise<unknown>>()
  private readonly releaseContinuationTracker?: () => void

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
        create: (request) => this.invoke('projects:create', request) as Promise<Project>,
        update: (request) =>
          this.invoke(
            request.sessionDefaults === undefined
              ? 'projects:update'
              : 'projects:update-session-defaults',
            request
          ) as Promise<Project>
      },
      sessions: {
        findArtifact: async (artifactId) => {
          const candidates = this.ports.controls?.findArtifactSessions
          if (!candidates) throw new Error('Task artifact lookup is unavailable.')
          for (const candidate of await candidates(artifactId)) {
            const session = (await this.invoke('sessions:load-one', candidate)) as
              PersistedChatSession | undefined
            const artifact = session?.artifacts?.find((item) => item.id === artifactId)
            if (session && artifact) return { session, artifact }
          }
          return undefined
        },
        list: async () => {
          const result = (await this.invoke('sessions:load-all')) as {
            sessions: PersistedChatSession[]
          }
          return result.sessions
        },
        get: (request) =>
          this.invoke('sessions:load-one', request) as Promise<PersistedChatSession | undefined>,
        save: async (session) => {
          return this.invoke('sessions:save-session', session) as Promise<PersistedChatSession>
        },
        bindSession: (request) =>
          this.invoke('sessions:bind-task-session', request) as Promise<PersistedChatSession>,
        admitTurn: (request) =>
          this.invoke('sessions:admit-task-turn', request) as Promise<PersistedChatSession>,
        stageCompletion: (request) =>
          this.invoke('sessions:stage-task-completion', request) as Promise<PersistedChatSession>,
        settleCompletion: (request) =>
          this.invoke('sessions:settle-task-completion', request) as Promise<PersistedChatSession>,
        failRun: (request) =>
          this.invoke('sessions:fail-task-run', request) as Promise<PersistedChatSession>,
        updateConfiguration: (session, expectedRevision) =>
          this.invoke(
            'sessions:update-configuration',
            session,
            expectedRevision
          ) as Promise<PersistedChatSession>,
        setDelegationPolicy: async (projectId, sessionId, policy) => {
          await this.invoke('sessions:set-delegation-policy', projectId, sessionId, policy)
        }
      },
      settings: {
        get: () => this.invoke('settings:get-settings') as Promise<SettingsSnapshot>
      },
      agent: {
        ...(this.ports.agent.assertAttachedTracingReady
          ? {
              assertAttachedTracingReady: (sessionId: string) =>
                this.withCurrentCaller(() =>
                  this.ports.agent.assertAttachedTracingReady!(sessionId)
                )
            }
          : {}),
        withSessionAvailable: (projectId, sessionId, operation) =>
          this.withCurrentCaller(() =>
            this.ports.agent.withSessionAvailable(projectId, sessionId, operation)
          ),
        listAttachedSessionIds: () =>
          this.withCurrentCaller(() => this.ports.agent.listAttachedSessionIds()),
        getTaskPermissions: (sessionId, promptMessageId) =>
          this.ports.agent.getTaskPermissions?.(sessionId, promptMessageId) ?? [],
        createSession: (request) =>
          this.withCurrentCaller(() => this.ports.agent.createSession(request)),
        resumeSession: (request) =>
          this.withCurrentCaller(() => this.ports.agent.resumeSession(request)),
        setPermissionProfile: (sessionId, profile) =>
          this.withCurrentCaller(() => this.ports.agent.setPermissionProfile(sessionId, profile)),
        setMemoryEnabled: (sessionId, enabled) =>
          this.withCurrentCaller(() => this.ports.agent.setMemoryEnabled(sessionId, enabled)),
        prompt: (request, observer) =>
          this.withCurrentCaller(() => this.ports.agent.prompt(request, observer)),
        cancelPrompt: (sessionId) =>
          this.withCurrentCaller(() => this.ports.agent.cancelPrompt(sessionId))
      },
      artifacts: {
        resolveVersionDescriptors: (request) =>
          this.invoke('artifacts:resolve-version-descriptors', request) as Promise<
            ArtifactVersionDescriptor[]
          >,
        finalizeRun: (request: FinalizeRunArtifactsRequest) =>
          this.invoke('artifacts:finalize-run', request) as Promise<FinalizeRunArtifactsResult>
      },
      previewResources: {
        acquire: (request) => this.acquirePreviewResource(request)
      },
      runtimeEvents: { subscribe: subscribeEvents },
      specialists: {
        resolve: (reference) => this.resolveSpecialist(reference)
      },
      reviewer: {
        review: (session, turnMessageId, signal) => this.review(session, turnMessageId, signal)
      },
      computePreferences: this.ports.computePreferences ?? {
        withReservation: async (providerIds, operation) => {
          if (providerIds.length > 0) {
            throw new Error('Task Compute preference control is unavailable.')
          }
          return operation([])
        },
        set: async () => {
          throw new Error('Task Compute preference control is unavailable.')
        },
        validate: async (providerIds) => {
          if (providerIds.length > 0) {
            throw new Error('Task Compute preference control is unavailable.')
          }
          return []
        },
        listAvailable: async () => [],
        project: () => undefined
      },
      runWithLifecycleContext: (operation) =>
        this.callerContexts.run(TASK_CALLER_CONTEXT, operation),
      isSessionBusy: (projectId, sessionId) =>
        this.ports
          .detectActiveSessions?.()
          .some((session) => session.projectId === projectId && session.sessionId === sessionId) ===
        true,
      runJournal: dependencies.runJournal,
      createId: dependencies.createId ?? randomUUID,
      now: dependencies.now ?? Date.now
    } satisfies TaskRunnerDependencies)
    if (dependencies.submissionRoot && dependencies.runJournal) {
      const journal = dependencies.runJournal
      this.submissions = new TaskSubmissions(dependencies.submissionRoot, {
        loadRuns: () => journal.load(),
        startRun: (request, requestId) =>
          this.callerContexts.run(TASK_CALLER_CONTEXT, () =>
            this.runner.startRun(request, requestId)
          ),
        now: dependencies.now
      })
      this.releaseContinuationTracker = this.ports.agent.setContinuationTracker?.(
        this.trackContinuation
      )
    }
  }

  async initialize(): Promise<void> {
    // Recover receipt links before Run restoration prunes old terminal history.
    await this.submissions?.initialize()
    await this.runner.initialize()
  }

  async dispose(): Promise<void> {
    this.releaseContinuationTracker?.()
    try {
      await Promise.all([this.submissions?.dispose(), this.runner.dispose()])
    } finally {
      this.commandClient.dispose()
    }
  }

  private trackContinuation: TaskContinuationTracker = async (identity, send) => {
    await this.initialize()
    const settlement = identity.kind === 'delegation_settlement'
    if (settlement && this.submissions) {
      const existing = await this.submissions
        .get(taskContinuationRequestId(identity))
        .catch((error: unknown) => {
          if (!(error instanceof TaskRunnerError && error.code === 'submission_not_found'))
            throw error
        })
      if (existing)
        throw new TaskRunnerError(
          'submission_conflict',
          'This continuation was already recorded; the provider was not called again.'
        )
    }
    const scopedInteraction =
      identity.kind === 'plan' || identity.kind === 'question'
        ? this.runner.resolveInteractionRun(
            identity,
            identity.originalPromptMessageId,
            identity.originalRunId
          )
        : undefined
    const originRunId = scopedInteraction
      ? scopedInteraction.runId
      : this.runner.findRunIdForPrompt(identity.sessionId, identity.originalPromptMessageId)
    if (!originRunId || this.runner.getRun(originRunId).projectId !== identity.projectId) {
      if (scopedInteraction?.unresolved || identity.kind === 'permission')
        throw new TaskRunnerError(
          'interaction_not_found',
          'The original Task interaction Run is no longer available.'
        )
      return send(() => undefined)
    }
    if (!this.submissions)
      throw new TaskRunnerError(
        'submission_unavailable',
        'A durable Task continuation could not be recorded.'
      )
    // The Plan Owner may schedule this as the original turn is settling. Do not hold the
    // submission journal's write queue while waiting for that Run to release the Session.
    await this.runner.waitForRun(originRunId)
    const tracking: { active?: Awaited<ReturnType<TaskRunner['beginContinuation']>> } = {}
    let result
    try {
      const admission = await this.submissions.admitContinuation(identity, async (requestId) => {
        tracking.active = await this.callerContexts.run(TASK_CALLER_CONTEXT, () =>
          this.runner.beginContinuation(originRunId, identity.promptMessageId, requestId)
        )
        return tracking.active.run
      })
      if (!admission.admitted || !tracking.active)
        throw new TaskRunnerError(
          'submission_conflict',
          'This continuation was already recorded; the provider was not called again.'
        )
      if (settlement) {
        const session = await this.runner.findSession(identity.sessionId, identity.projectId)
        const graph = session.conversationGraph
        const root = graph?.frames.find(({ id }) => id === graph.rootFrameId)
        const origin =
          graph &&
          resolveActiveConversationMessages({
            ...graph,
            activeFrameId: graph.rootFrameId
          }).findLast(({ role }) => role === 'user')
        const run = this.runner.getRun(originRunId)
        if (
          session.packageOrigin ||
          session.archivedAt !== undefined ||
          !identity.branchId ||
          root?.activeBranchId !== identity.branchId ||
          origin?.introducedOnBranchId !== identity.branchId ||
          origin.id !== identity.originalPromptMessageId ||
          run.status === 'cancelled' ||
          run.cancelRequestedAt !== undefined
        )
          throw new TaskRunnerError(
            'interaction_revision_conflict',
            'The originating Task or Message Branch is no longer current.'
          )
      }
      const { onProviderDispatched, run } = tracking.active
      result = await this.callerContexts.run(TASK_CALLER_CONTEXT, () =>
        send(onProviderDispatched, run.id)
      )
    } catch (error) {
      await tracking.active?.settle({ error })
      throw error
    }
    await tracking.active.settle(result)
    return result
  }

  private async continuationReceipt(identity: TaskContinuationIdentity): Promise<{
    taskRunStatus: 'tracked' | 'pending' | 'unconfirmed'
    requestId?: string
    runId?: string
  }> {
    const requestId = taskContinuationRequestId(identity)
    try {
      const receipt = await this.submissions?.get(requestId)
      if (receipt?.status === 'accepted')
        return { taskRunStatus: 'tracked', requestId, runId: receipt.runId }
      if (receipt?.status === 'pending') return { taskRunStatus: 'pending', requestId }
      if (receipt) return { taskRunStatus: 'unconfirmed', requestId }
    } catch (error) {
      if (
        !(error instanceof TaskRunnerError) ||
        (error.code !== 'submission_not_found' && error.code !== 'submission_unavailable')
      )
        throw error
    }
    return { taskRunStatus: 'unconfirmed' }
  }

  runWithCallerContext<Result>(context: CallerContext, operation: () => Result): Result {
    return this.callerContexts.run(context, operation)
  }

  listProjects(): Promise<TaskProject[]> {
    return this.runner.listProjects()
  }

  async bootstrap(request: BootstrapRequest): Promise<BootstrapResult> {
    this.requireLocalConnectorCaller()
    return this.invoke('settings:bootstrap', request) as Promise<BootstrapResult>
  }

  async prepareNotebookEnvironment(language: NotebookLanguage): Promise<void> {
    if (
      this.currentCallerContext().location !== 'local' ||
      (language !== 'python' && language !== 'r')
    )
      throw new TaskRunnerError('invalid_request', 'Choose Python or R on a local connection.')
    try {
      await this.invoke('notebook-env:provision', language)
    } catch {
      throw new TaskRunnerError(
        'notebook_setup_failed',
        'Could not prepare the Notebook environment. Check its current status and the service log.'
      )
    }
  }

  supportsNotebookEnvironmentOperations(): boolean {
    return this.ports.notebookEnvironment !== undefined
  }

  supportsNotebookRuntimeSelection(): boolean {
    return this.ports.notebookRuntimes !== undefined
  }

  async listNotebookRuntimes(language: unknown): Promise<TaskNotebookRuntime[]> {
    const owner = this.taskNotebookRuntimes()
    const target = notebookLanguage.safeParse(language)
    if (!target.success)
      throw new TaskRunnerError('invalid_request', 'Supply a Notebook language: python or r.')
    const [environments, enablement] = await Promise.all([
      owner.listLanguageEnvironments(target.data),
      owner.getEnablement({ language: target.data })
    ])
    return environments.map((env) => taskNotebookRuntime(env, enablement))
  }

  async configureNotebookRuntime(input: unknown): Promise<TaskNotebookRuntime> {
    const owner = this.taskNotebookRuntimes()
    const parsed = notebookRuntimeMutation.safeParse(input)
    if (!parsed.success)
      throw new TaskRunnerError(
        'invalid_request',
        'Supply the language and an interpreter path to register, or an exact runtime ID to enable.'
      )
    const request = parsed.data
    const { language } = request
    if (request.action === 'register') {
      const registered = await owner.registerCheckedInterpreter(request)
      if (!registered)
        throw new TaskRunnerError(
          'notebook_runtime_unavailable',
          'The path does not point to an existing interpreter for the selected language.'
        )
      return taskNotebookRuntime(registered, await owner.getEnablement({ language }))
    }
    const env = (await owner.listLanguageEnvironments(language)).find(
      ({ envId, runnable }) => envId === request.runtimeId && runnable
    )
    if (!env)
      throw new TaskRunnerError(
        'notebook_runtime_unavailable',
        'Choose an exact runnable runtime ID from the requested language.'
      )
    const enablement = await owner.setEnvironmentEnabled({
      language,
      envId: env.envId,
      enabled: true
    })
    return taskNotebookRuntime(env, enablement)
  }

  private taskNotebookRuntimes(): TaskNotebookRuntimes {
    this.requireTaskRelay()
    if (!this.ports.notebookRuntimes)
      throw new TaskRunnerError(
        'notebook_setup_failed',
        'Notebook runtime selection is unavailable.'
      )
    return this.ports.notebookRuntimes
  }

  startNotebookEnvironmentOperation(
    request: TaskNotebookEnvironmentRequest
  ): TaskNotebookEnvironmentOperation {
    try {
      return this.managedNotebookSetup().start(request)
    } catch (error) {
      if (error instanceof NotebookEnvironmentOperationConflictError)
        throw new TaskRunnerError('notebook_environment_operation_conflict', error.message)
      throw error
    }
  }

  getNotebookEnvironmentOperation(
    target: TaskNotebookEnvironmentTarget
  ): TaskNotebookEnvironmentOperation {
    return this.managedNotebookSetup().get(target)
  }

  cancelNotebookEnvironmentOperation(
    target: TaskNotebookEnvironmentTarget
  ): TaskNotebookEnvironmentOperation {
    return this.managedNotebookSetup().cancel(target)
  }

  private managedNotebookSetup(): ManagedNotebookSetup {
    if (this.currentCallerContext().location !== 'local')
      throw new TaskRunnerError('invalid_request', 'Notebook setup requires a local connection.')
    if (!this.ports.notebookEnvironment)
      throw new TaskRunnerError('notebook_setup_failed', 'Notebook setup is unavailable.')
    return this.ports.notebookEnvironment
  }

  async installCli(): Promise<CliLauncherStatus> {
    this.requireLocalConnectorCaller()
    return this.invoke('cli:install') as Promise<CliLauncherStatus>
  }

  async listRuntimes(): Promise<TaskAgentRuntime[]> {
    const [preflight, settings] = await Promise.all([
      this.invoke('settings:get-preflight') as Promise<ReadinessPreflight>,
      this.invoke('settings:get-settings') as Promise<SettingsSnapshot>
    ])
    const readyByFramework = {
      'claude-code': preflight.claudeReady,
      opencode: preflight.opencodeReady,
      codex: preflight.codexReady,
      codebuddy: preflight.codebuddyReady,
      'open-science-agent': preflight.openScienceAgentReady === true,
      pi: preflight.piReady === true
    } as const
    const runtimeByFramework = {
      'claude-code': {
        configured: Boolean(settings.claude.resolvedPath),
        version: settings.claude.version,
        managed: settings.claudeManaged
      },
      opencode: {
        configured: Boolean(settings.opencode.resolvedPath),
        version: settings.opencode.version,
        managed: settings.opencodeManaged
      },
      codex: {
        configured: Boolean(settings.codex.resolvedPath),
        version: settings.codex.nativeVersion,
        managed: settings.codexManaged && settings.codex.nativeManaged === true
      },
      codebuddy: {
        configured: Boolean(settings.codebuddy.resolvedPath),
        version: settings.codebuddy.version,
        managed: settings.codebuddyManaged
      },
      'open-science-agent': {
        configured: preflight.openScienceAgentReady === true,
        version: '0.1.0',
        managed: true
      },
      pi: {
        configured: preflight.piReady === true,
        version: undefined,
        // Readiness alone does not say whether the runtime is app-managed or external.
        managed: undefined
      }
    } as const

    return settings.agentFrameworks.map(({ id: framework }) => {
      const runtime = runtimeByFramework[framework]
      const status = readyByFramework[framework]
        ? ('ready' as const)
        : runtime.configured
          ? ('not_ready' as const)
          : ('missing' as const)
      return {
        framework,
        status,
        ...(runtime.version ? { version: runtime.version } : {}),
        ...(runtime.configured && runtime.managed !== undefined
          ? { source: runtime.managed ? ('managed' as const) : ('external' as const) }
          : {})
      }
    })
  }

  async doctor(): Promise<TaskDoctorReport> {
    const [preflight, skills, bootstrap, notebook] = await Promise.all([
      this.invoke('settings:get-preflight') as Promise<ReadinessPreflight>,
      this.invoke('settings:list-skills') as Promise<SkillView[]>,
      this.invoke('settings:bootstrap', { action: 'status' }) as Promise<BootstrapResult>,
      readTaskNotebookReadiness((channel, ...args) => this.invoke(channel, ...args))
    ])
    const { runtimeReadiness, providerReadiness } = preflight
    const next: TaskDoctorReport['next'][number][] = []
    if (runtimeReadiness.status !== 'ready') {
      next.push({
        code: `runtime_${runtimeReadiness.status}`,
        ...(bootstrap.ok && bootstrap.next?.runtime ? { argv: bootstrap.next.runtime } : {})
      })
    }
    if (providerReadiness.status !== 'ready') {
      next.push({
        code: `provider_${providerReadiness.status}`,
        ...(bootstrap.ok && bootstrap.next?.provider ? { argv: bootstrap.next.provider } : {})
      })
    }
    return {
      ready: runtimeReadiness.status === 'ready' && providerReadiness.status === 'ready',
      checks: {
        daemon: { status: 'ready' },
        runtime: {
          status: runtimeReadiness.status,
          framework: preflight.agentFrameworkId,
          ...(bootstrap.ok && bootstrap.selectedFramework !== undefined
            ? { selectedFramework: bootstrap.selectedFramework }
            : {})
        },
        provider: {
          ...providerReadiness,
          ...(bootstrap.ok && bootstrap.keylessKiloAvailable !== undefined
            ? { keylessKiloAvailable: bootstrap.keylessKiloAvailable }
            : {})
        },
        ...(notebook ? { notebook } : {}),
        skills: {
          status: 'ready',
          enabled: skills
            .filter((skill) => skill.enabled && skill.available !== false)
            .map((skill) => skill.id)
            .sort()
        }
      },
      next
    }
  }

  createProject(request: CreateTaskProjectRequest): Promise<TaskProject> {
    return this.runner.createProject(request)
  }

  updateProject(projectId: string, request: UpdateTaskProjectRequest): Promise<TaskProject> {
    return this.runner.updateProject(projectId, request)
  }

  listSessions(projectId?: string): Promise<TaskSessionSummary[]> {
    return this.runner.listSessions(projectId)
  }

  async getSession(sessionId: string, projectId?: string): Promise<TaskSessionSummary> {
    const session = await this.runner.findSession(sessionId, projectId)
    return this.withNotebookExecution(summarizeSession(session), {
      projectId: session.projectId,
      sessionId,
      promptMessageId: session.activeRun?.promptMessageId ?? latestOutcomePrompt(session)?.id,
      includeSessionRefusal: true
    })
  }

  getSessionConfiguration(
    sessionId: string,
    projectId?: string
  ): Promise<TaskSessionConfiguration> {
    return this.runner.getSessionConfiguration(sessionId, projectId)
  }

  updateSessionConfiguration(
    sessionId: string,
    request: UpdateSessionConfigurationRequest
  ): Promise<TaskSessionConfiguration> {
    return this.runner.updateSessionConfiguration(sessionId, request)
  }

  getProjectSessionDefaults(projectId: string): Promise<TaskProjectSessionDefaults> {
    return this.runner.getProjectSessionDefaults(projectId)
  }

  updateProjectSessionDefaults(
    projectId: string,
    request: UpdateProjectSessionDefaultsRequest
  ): Promise<TaskProjectSessionDefaults> {
    return this.runner.updateProjectSessionDefaults(projectId, request)
  }

  async listConnectors(): Promise<ConnectorsSnapshot> {
    return this.invoke('settings:list-connectors') as Promise<ConnectorsSnapshot>
  }

  async getConnector(id: string): Promise<ConnectorDetailView | CustomServerView> {
    const snapshot = await this.listConnectors()
    const custom = snapshot.customServers.find((item) => item.id === id)
    if (custom) return custom
    if (!snapshot.connectors.some((item) => item.id === id)) {
      throw new TaskRunnerError('invalid_request', 'Unknown Connector ID.')
    }
    return this.invoke('settings:get-connector-detail', id) as Promise<ConnectorDetailView>
  }

  async setConnectorEnabled(id: string, enabled: boolean): Promise<ConnectorsSnapshot> {
    this.requireLocalConnectorCaller()
    if (typeof enabled !== 'boolean')
      throw new TaskRunnerError('invalid_request', 'enabled must be a boolean.')
    const snapshot = await this.listConnectors()
    const custom = snapshot.customServers.some((item) => item.id === id)
    if (!custom && !snapshot.connectors.some((item) => item.id === id)) {
      throw new TaskRunnerError('invalid_request', 'Unknown Connector ID.')
    }
    return this.connectorOperation(
      custom ? 'settings:set-custom-server-enabled' : 'settings:set-connector-enabled',
      { id, enabled }
    )
  }

  addConnector(request: AddCustomServerRequest): Promise<ConnectorsSnapshot> {
    return this.connectorOperation('settings:add-custom-server', request)
  }

  updateConnector(
    id: string,
    request: Omit<UpdateCustomServerRequest, 'id'>
  ): Promise<ConnectorsSnapshot> {
    return this.connectorOperation('settings:update-custom-server', { ...request, id })
  }

  removeConnector(id: string): Promise<ConnectorsSnapshot> {
    return this.connectorOperation('settings:remove-custom-server', { id })
  }

  testConnector(id: string): Promise<{ success: boolean; toolCount?: number; message: string }> {
    return this.connectorOperation('settings:test-custom-server', { id })
  }

  listCredentials(): Promise<DeviceCredentialsSnapshot> {
    return this.connectorOperation('settings:list-device-credentials')
  }

  createCredential(request: CreateDeviceCredentialRequest): Promise<CreateDeviceCredentialResult> {
    return this.connectorOperation('settings:create-device-credential', request)
  }

  updateCredential(
    id: string,
    request: Omit<UpdateDeviceCredentialRequest, 'id'>
  ): Promise<DeviceCredentialsSnapshot> {
    return this.connectorOperation('settings:update-device-credential', { ...request, id })
  }

  private requireLocalConnectorCaller(): void {
    if (this.currentCallerContext().location !== 'local') {
      throw new TaskRunnerError(
        'invalid_request',
        'Connector and credential changes require a local connection.'
      )
    }
  }

  private async connectorOperation<Result>(channel: string, request?: unknown): Promise<Result> {
    this.requireLocalConnectorCaller()
    try {
      return (await this.invoke(channel, ...(request === undefined ? [] : [request]))) as Result
    } catch (error) {
      // Provider errors can contain submitted credentials. Never forward their raw messages.
      const message =
        error instanceof Error &&
        [
          'Secure credential storage is unavailable. Unlock the system keychain and retry.',
          'Credential changes were saved, but Connectors could not refresh. Retry from Settings > Connectors.'
        ].includes(error.message)
          ? error.message
          : channel.includes('credential')
            ? 'Credential operation failed. Check the input and system credential storage.'
            : 'Connector operation failed. Check the ID, configuration, and credential bindings.'
      throw new TaskRunnerError('invalid_configuration', message)
    }
  }

  async getAgentRouting(): Promise<TaskAgentRouting> {
    return this.projectAgentRouting(
      (await this.invoke('settings:get-settings')) as SettingsSnapshot
    )
  }

  async updateAgentRouting(request: UpdateTaskAgentRoutingRequest): Promise<TaskAgentRouting> {
    try {
      const snapshot = (await this.invoke(
        'settings:set-agent-routing',
        request
      )) as SettingsSnapshot
      return this.projectAgentRouting(snapshot)
    } catch (error) {
      throw new TaskRunnerError(
        'invalid_configuration',
        error instanceof Error ? error.message : 'Agent routing update failed.'
      )
    }
  }

  async getSessionPlan(
    sessionId: string
  ): Promise<(ActivePlanProjection & { branchId?: string }) | null> {
    const session = await this.runner.findSession(sessionId)
    const interaction = await this.planInteraction(session)
    return interaction?.plan ? { ...interaction.plan, branchId: interaction.branchId } : null
  }

  private publicPlan({
    externalResponse,
    originatingTaskRunId,
    ...plan
  }: ActivePlanProjection): ActivePlanProjection {
    void externalResponse
    void originatingTaskRunId
    return plan
  }

  private requireTaskRelay(): void {
    if (!canRelayTaskInteraction(this.currentCallerContext())) {
      throw new TaskRunnerError(
        'task_relay_required',
        'Task interactions require a local authenticated Task connection.'
      )
    }
  }

  async setRunInteractionMode(
    runId: string,
    request: SetTaskInteractionModeRequest
  ): Promise<TaskInteractionPolicy> {
    this.requireTaskRelay()
    return this.runner.setRunInteractionMode(
      runId,
      request.expectedRevision,
      request.interactionMode
    )
  }

  private async permissionInteractions(
    session: PersistedChatSession,
    run?: TaskRun,
    interactionId?: string
  ): Promise<TaskPermissionInteraction[]> {
    const graph = session.conversationGraph
    const frame = graph?.frames.find(({ id }) => id === graph.activeFrameId)
    const durable = session.runtimeContext?.permission
    const taskId =
      run?.id ??
      (interactionId ? this.runner.findRunIdForPermission(session.id, interactionId) : undefined) ??
      (durable
        ? this.runner.findRunIdForPrompt(session.id, durable.originatingPromptMessageId)
        : undefined) ??
      this.runner.findLatestRunIdForSession(session.id)
    if (!taskId || session.packageOrigin) return []
    const task = run ?? this.runner.getRun(taskId)
    const promptMessageId = this.runner.getRunPromptMessageId(taskId)
    if (!promptMessageId) return []
    const branchId = frame?.activeBranchId
    const prompt = graph?.messages.find(({ id }) => id === promptMessageId)
    const onOriginalBranch = Boolean(
      frame && prompt?.agentFrameId === frame.id && prompt.introducedOnBranchId === branchId
    )
    const pending = new Map<
      string,
      {
        request: AcpPermissionRequest
        recovery: NonNullable<TaskPermissionInteraction['recovery']>
      }
    >()
    if (onOriginalBranch && task.status === 'running' && !task.cancelRequestedAt) {
      for (const request of this.ports.agent.getTaskPermissions?.(session.id, promptMessageId) ??
        []) {
        pending.set(`permission:${request.requestId}`, { request, recovery: 'original_run' })
      }
    } else if (
      task.status === 'failed' &&
      this.ports.agent.restoreTaskPermission &&
      this.runner.findRunIdForPrompt(session.id, promptMessageId) === taskId
    ) {
      const parked = restorableTaskPermission(session, promptMessageId)
      if (parked) {
        const { request } = parked.permission
        pending.set(`permission:${request.requestId}`, { request, recovery: 'new_continuation' })
      }
    }
    const witnessed = this.runner.getPermissionInteractions(taskId)
    const ids = interactionId ? [interactionId] : [...pending.keys()]
    const interactions: TaskPermissionInteraction[] = []
    for (const id of ids) {
      const record = witnessed.find((item) => item.id === id)
      const current = pending.get(id)
      if ((!record && !current) || (!interactionId && record?.response)) continue
      const notebook = current && notebookPermissionPreview(current.request)
      const notebookReview = record?.notebookReview ?? notebook?.notebookReview
      const preview =
        current && (!current.request.appOwned || notebook)
          ? permissionPreview(current.request, notebook)
          : undefined
      const state = record?.response
        ? record.response.status === 'released' || record.response.continuation
          ? 'responded'
          : 'unconfirmed'
        : preview?.options.length && (!record || record.branchId === branchId)
          ? 'pending'
          : 'expired'
      if (state === 'pending' && !record) {
        // Keep addressable witnesses for process-only requests observed through Task. A later
        // process can distinguish a known expired request from an ID outside this scope.
        await this.runner.recordPermissionInteraction(taskId, {
          id,
          branchId,
          revision: 0,
          notebookReview
        })
      }
      const response = record?.response
      const continuation = response?.continuation
      const delivery =
        continuation &&
        (await this.continuationReceipt({
          kind: 'permission',
          projectId: task.projectId,
          sessionId: task.sessionId,
          attemptId: continuation.id
        }))
      interactions.push({
        id,
        kind: 'permission',
        state,
        promptMessageId,
        runId: taskId,
        projectId: task.projectId,
        sessionId: task.sessionId,
        branchId: record?.branchId ?? branchId,
        revision: record?.revision ?? 0,
        interactionPolicy: task.interactionPolicy,
        ...(notebookReview ? { notebookReview } : {}),
        owner:
          state === 'pending'
            ? task.interactionPolicy?.mode === 'delegate'
              ? 'agent'
              : 'user'
            : 'service',
        actions:
          state === 'pending' && preview ? preview.options.map(({ optionId }) => optionId) : [],
        ...(preview && state === 'pending'
          ? {
              request: preview,
              recovery: current!.recovery,
              responseCapability: 'respond_permission'
            }
          : {}),
        ...(response
          ? {
              response: {
                ...response,
                ...(continuation && delivery
                  ? { continuation: { ...continuation, ...delivery } }
                  : {})
              }
            }
          : {}),
        ...(state === 'expired' || state === 'unconfirmed'
          ? {
              next: 'Inspect the original Run and Session before starting new work. Do not repeat the decision.'
            }
          : {})
      })
    }
    return interactions
  }

  private async childPermissionInteractions(
    session: PersistedChatSession,
    run?: TaskRun,
    interactionId?: string
  ): Promise<TaskPermissionInteraction[]> {
    const port = this.ports.agent.delegateInteractions
    if (!port || session.packageOrigin || session.archivedAt !== undefined) return []
    const key = { projectId: session.projectId, sessionId: session.id }
    const interactions: TaskPermissionInteraction[] = []
    for (const { request, branchId } of await port.permissions(key)) {
      const id = `${childPermissionPrefix}${request.requestId}`
      if (!request.delegated || (interactionId && id !== interactionId)) continue
      const { frameId, attemptId } = request.delegated
      const origin = delegatedAttempt(session, frameId, attemptId)
      if (
        !origin?.active ||
        !origin.latest ||
        origin.attempt.status !== 'running' ||
        origin.frame.activeBranchId !== branchId
      )
        continue
      const runId = this.runner.findRunIdForPrompt(
        session.id,
        origin.promptMessageId,
        origin.attempt.startedAt
      )
      if (!runId || (run && run.id !== runId)) continue
      const task = run ?? this.runner.getRun(runId)
      if (
        task.status === 'cancelled' ||
        task.cancelRequestedAt !== undefined ||
        this.runner
          .getPermissionInteractions(runId)
          .some((record) => record.id === id && record.response)
      )
        continue
      const preview = permissionPreview(request)
      if (!preview.options.length) continue
      const delegated = { frameId, attemptId, branchId, attemptStatus: origin.attempt.status }
      const revision = createHash('sha256')
        .update(JSON.stringify([delegated, preview]))
        .digest()
        .readUIntBE(0, 6)
      await this.runner.recordPermissionInteraction(runId, {
        id,
        branchId: origin.rootBranchId,
        revision,
        delegated
      })
      interactions.push({
        ...key,
        id,
        kind: 'permission',
        runId,
        promptMessageId: origin.promptMessageId,
        branchId: origin.rootBranchId,
        revision,
        delegated,
        interactionPolicy: task.interactionPolicy,
        state: 'pending',
        owner: task.interactionPolicy?.mode === 'delegate' ? 'agent' : 'user',
        actions: preview.options.map(({ optionId }) => optionId),
        responseCapability: 'respond_permission',
        request: preview,
        recovery: 'original_run'
      })
    }
    if (!interactionId || interactions.length) return interactions

    const runId = run?.id ?? this.runner.findRunIdForPermission(session.id, interactionId)
    if (!runId) return []
    const record = this.runner
      .getPermissionInteractions(runId)
      .find(({ id }) => id === interactionId)
    if (!record?.delegated) return []
    const { frameId, attemptId } = record.delegated
    const current = delegatedAttempt(session, frameId, attemptId)
    const state =
      record.response?.status === 'released'
        ? 'responded'
        : record.response
          ? 'unconfirmed'
          : 'expired'
    return [
      {
        ...key,
        ...record,
        kind: 'permission',
        state,
        runId,
        promptMessageId: this.runner.getRunPromptMessageId(runId),
        delegated: {
          ...record.delegated,
          attemptStatus: current?.attempt.status ?? record.delegated.attemptStatus
        },
        owner: 'service',
        actions: [],
        ...(state !== 'responded'
          ? {
              next: 'Inspect the original child Attempt. This permission has no live wait to resume. Do not repeat the previous decision.'
            }
          : {})
      }
    ]
  }

  private async interactionSession(scope: TaskInteractionScope): Promise<{
    session: PersistedChatSession
    run?: TaskRun
  }> {
    if ('runId' in scope) {
      const run = this.runner.getRun(scope.runId)
      return { session: await this.runner.findSession(run.sessionId, run.projectId), run }
    }
    return { session: await this.runner.findSession(scope.sessionId, scope.projectId) }
  }

  private async planInteraction(
    session: PersistedChatSession,
    run?: TaskRun,
    interactionId?: string
  ): Promise<TaskPlanInteraction | undefined> {
    const active = session.runtimeContext?.plan
    const graph = session.conversationGraph
    const messages = graph ? resolveActiveConversationMessages(graph) : session.messages
    const versionId = interactionId?.startsWith('plan:')
      ? interactionId.slice('plan:'.length)
      : undefined
    if (interactionId && !versionId) return undefined
    const historical =
      versionId && active?.artifactVersionId !== versionId
        ? session.planHistoryProjections?.find((plan) => plan.artifactVersionId === versionId)
        : undefined
    const record = historical ?? active
    if (!record || (versionId !== undefined && versionId !== record.artifactVersionId))
      return undefined
    const promptMessageId = record.originatingPromptMessageId
    if (!promptMessageId || !messages.some((message) => message.id === promptMessageId))
      return undefined
    const { runId, unresolved } = this.runner.resolveInteractionRun(
      { projectId: session.projectId, sessionId: session.id },
      promptMessageId,
      record.originatingTaskRunId
    )
    if (run && runId !== run.id) return undefined
    const ownerRun = runId ? this.runner.getRun(runId) : undefined
    const interactionPolicy = ownerRun?.interactionPolicy
    const branchId = graph?.frames.find(({ id }) => id === graph.activeFrameId)?.activeBranchId
    const plan =
      historical ??
      ((await this.invoke(
        'acp:get-plan-projection',
        session.projectId,
        session.id
      )) as ActivePlanProjection | null)
    if (!plan || plan.artifactVersionId !== record.artifactVersionId) return undefined
    const receipt = record.externalResponse
    const delivery =
      !historical && receipt && active?.delivery?.commandId === receipt.commandId
        ? active.delivery
        : undefined
    const expired = Boolean(
      unresolved ||
      session.packageOrigin ||
      historical ||
      !branchId ||
      ownerRun?.status === 'cancelled'
    )
    const state =
      receipt || plan.approval !== 'pending' ? 'responded' : expired ? 'expired' : 'pending'
    return {
      id: `plan:${plan.artifactVersionId}`,
      kind: 'plan',
      state,
      projectId: session.projectId,
      sessionId: session.id,
      ...(runId ? { runId } : {}),
      promptMessageId,
      ...(branchId ? { branchId } : {}),
      revision: plan.revision,
      owner:
        state === 'pending'
          ? interactionPolicy?.mode === 'delegate'
            ? 'agent'
            : 'user'
          : 'service',
      ...(interactionPolicy ? { interactionPolicy } : {}),
      actions: state === 'pending' ? ['approved', 'rejected', 'revise'] : [],
      ...(state === 'pending' ? { responseCapability: 'respond_plan' } : {}),
      ...(state === 'expired' ? { next: 'Read the current Session Plan before responding.' } : {}),
      plan: this.publicPlan(plan),
      ...(receipt
        ? {
            response: {
              source: receipt.source,
              action: receipt.action,
              reviewedRevision: receipt.reviewedRevision,
              continuation: {
                id: receipt.commandId,
                promptMessageId: receipt.promptMessageId,
                ...(await this.continuationReceipt({
                  kind: 'plan',
                  projectId: session.projectId,
                  sessionId: session.id,
                  attemptId: receipt.commandId
                })),
                status:
                  delivery?.state === 'delivering'
                    ? 'unconfirmed'
                    : (delivery?.state ?? (receipt.handedOff ? 'accepted' : 'unconfirmed'))
              }
            }
          }
        : {})
    }
  }

  async listInteractions(scope: TaskInteractionScope): Promise<TaskInteractionReference[]> {
    this.requireTaskRelay()
    const { session, run } = await this.interactionSession(scope)
    const interaction = await this.planInteraction(session, run)
    const permissions = [
      ...(await this.permissionInteractions(session, run)),
      ...(await this.childPermissionInteractions(session, run))
    ]
      .filter(({ state }) => state === 'pending')
      .map(({ request, response, recovery, ...reference }) => {
        void request
        void response
        void recovery
        return reference
      })
    const stop = await this.notebookStopInteraction(session, run)
    const references: TaskInteractionReference[] = [...(stop ? [stop] : []), ...permissions]
    if (interaction?.state === 'pending') {
      const { plan, ...reference } = interaction
      void plan
      references.push(reference)
    }
    for (const { interaction } of this.questionInteractions(session, run)) {
      if (interaction.state !== 'pending') continue
      const { question, ...reference } = interaction
      void question
      references.push(reference)
    }
    for (const { interaction } of this.childQuestions(session, run)) {
      if (interaction.state !== 'pending') continue
      const { question, ...reference } = interaction
      void question
      references.push(reference)
    }
    return references
  }

  async getInteraction(id: string, scope: TaskInteractionScope): Promise<TaskInteraction> {
    this.requireTaskRelay()
    const { session, run } = await this.interactionSession(scope)
    if (id.startsWith(childQuestionPrefix)) {
      const child = this.childQuestions(session, run, id)[0]
      if (!child)
        throw new TaskRunnerError(
          'interaction_not_found',
          'No matching child question in this scope.'
        )
      return child.interaction
    }
    const question = id.startsWith('question:')
      ? this.questionInteractions(session, run, id)[0]
      : undefined
    if (question) return this.withQuestionContinuation(question.interaction)
    if (id.startsWith(notebookStopPrefix)) {
      const stop = await this.notebookStopInteraction(session, run)
      if (stop?.id !== id) throw notebookStopExpired()
      return stop
    }
    const interaction = id.startsWith('permission:')
      ? (await this.permissionInteractions(session, run, id))[0]
      : id.startsWith(childPermissionPrefix)
        ? (await this.childPermissionInteractions(session, run, id))[0]
        : await this.planInteraction(session, run, id)
    if (!interaction) {
      throw new TaskRunnerError('interaction_not_found', 'No matching interaction in this scope.')
    }
    return interaction
  }

  async respondPermission(
    id: string,
    scope: TaskInteractionScope,
    response: TaskPermissionResponse
  ): Promise<{ changed: boolean; interaction: TaskPermissionInteraction }> {
    this.requireTaskRelay()
    const current = await this.getInteraction(id, scope)
    if (current.kind !== 'permission' || !current.runId || !current.promptMessageId) {
      throw new TaskRunnerError(
        'interaction_not_found',
        'No matching Task permission in this scope.'
      )
    }
    const { runId, promptMessageId, sessionId, projectId } = current
    if (
      current.revision !== response.expectedRevision ||
      current.branchId !== response.expectedBranchId
    ) {
      throw new TaskRunnerError(
        'interaction_revision_conflict',
        'Read the current permission and its branch before responding.'
      )
    }
    if (current.notebookReview?.language !== response.expectedLanguage)
      throw new TaskRunnerError(
        'interaction_revision_conflict',
        'For a Notebook review, copy notebookReview.language from this request as expectedLanguage.'
      )
    if (current.response) {
      if (
        current.response.source === response.source &&
        current.response.optionId === response.optionId
      )
        return { changed: false, interaction: current }
      throw new TaskRunnerError(
        'interaction_revision_conflict',
        'This permission already has a different response.'
      )
    }
    if (current.state !== 'pending' || !current.actions.includes(response.optionId))
      throw new TaskRunnerError(
        'interaction_revision_conflict',
        'Choose an option from the current permission request.'
      )
    const assertCurrent = (): void => {
      this.requireTaskRelay()
      this.runner.assertTaskInteractionDecision(
        runId,
        response.source,
        response.expectedModeRevision
      )
    }
    assertCurrent()
    const restored = current.recovery === 'new_continuation'
    const child = current.delegated
    const requestId = id.slice((child ? childPermissionPrefix : 'permission:').length)
    if (restored) {
      if (!this.submissions || !this.releaseContinuationTracker) {
        throw new TaskRunnerError(
          'submission_unavailable',
          'A durable Task permission continuation could not be recorded.'
        )
      }
      await this.runner.ensureSessionAttached(sessionId)
    }
    const changed = await this.ports.agent.withSessionAvailable(projectId, sessionId, async () => {
      const assertScope = async (): Promise<void> => {
        const latest = await this.runner.findSession(sessionId, projectId)
        const graph = latest.conversationGraph
        const frame = graph?.frames.find(({ id }) => id === graph.activeFrameId)
        const delegated = child && delegatedAttempt(latest, child.frameId, child.attemptId)
        if (
          latest.packageOrigin ||
          (child
            ? !delegated?.active ||
              !delegated.latest ||
              delegated.rootBranchId !== current.branchId ||
              delegated.promptMessageId !== promptMessageId ||
              delegated.frame.activeBranchId !== child.branchId ||
              delegated.attempt.status !== 'running'
            : !frame || frame.activeBranchId !== current.branchId)
        )
          throw new TaskRunnerError(
            'interaction_revision_conflict',
            'This permission is no longer on the active Message Branch.'
          )
      }
      const decision: import('../acp/permission-broker').TaskPermissionDecision = {
        source: response.source,
        assertCurrent,
        assertScope,
        commit: async (operation) => {
          // Revalidate after archive and owner preflight waits, before locking the policy revision.
          await assertScope()
          return this.runner.withPermissionDecision(runId, () => {
            assertCurrent()
            if (
              this.runner
                .getPermissionInteractions(runId)
                .some((item) => item.id === id && item.response)
            )
              return Promise.resolve(false)
            return operation()
          })
        },
        record: (status) =>
          this.runner.recordPermissionInteraction(runId, {
            id,
            branchId: current.branchId,
            revision: current.revision,
            ...(child ? { delegated: child } : {}),
            notebookReview: current.notebookReview,
            response: {
              source: response.source,
              optionId: response.optionId,
              status,
              ...(restored ? { continuation: { id: requestId, taskRunStatus: 'unconfirmed' } } : {})
            }
          })
      }
      if (child) {
        try {
          return (
            (await this.ports.agent.delegateInteractions?.respondPermission(
              { projectId, sessionId },
              {
                requestId,
                optionId: response.optionId,
                frameId: child.frameId,
                attemptId: child.attemptId,
                branchId: child.branchId
              },
              decision
            )) ?? false
          )
        } catch (error) {
          if (!(error instanceof DurableDelegatedWorkError)) throw error
          throw new TaskRunnerError(
            'interaction_revision_conflict',
            'The child Attempt is no longer awaiting this permission.'
          )
        }
      }
      return restored
        ? ((await this.ports.agent.restoreTaskPermission?.(
            { projectId, sessionId, requestId, optionId: response.optionId },
            {
              ...decision,
              branchId: response.expectedBranchId,
              promptMessageId
            }
          )) ?? false)
        : ((await this.ports.agent.respondTaskPermission?.(
            sessionId,
            promptMessageId,
            requestId,
            response.optionId,
            decision
          )) ?? false)
    })
    const interaction = (await this.getInteraction(id, { runId })) as TaskPermissionInteraction
    if (
      !changed &&
      (interaction.response?.source !== response.source ||
        interaction.response.optionId !== response.optionId)
    ) {
      throw new TaskRunnerError(
        'interaction_revision_conflict',
        'The permission is no longer awaiting this response. Query the original request.'
      )
    }
    return { changed, interaction }
  }

  private questionInteractions(
    session: PersistedChatSession,
    run?: TaskRun,
    interactionId?: string
  ): ScopedTaskQuestion[] {
    if (!this.ports.agent.questions || session.packageOrigin || session.archivedAt !== undefined)
      return []
    const context = rootQuestionScope(session)
    const graph = session.conversationGraph
    if (!graph || !context) return []
    const { branchId, promptMessageId: activePromptId } = context
    const byRequestId = new Map<string, ScopedTaskQuestion>()
    const add = (
      request: PendingElicitationRequest,
      promptMessageId: string,
      waitsForProvider: boolean,
      pending: boolean,
      receipt?: TaskQuestionReceipt,
      taskRunId?: string
    ): void => {
      const id = `question:${request.requestId}`
      if (interactionId && id !== interactionId) return
      const { runId, unresolved } = this.runner.resolveInteractionRun(
        { projectId: session.projectId, sessionId: session.id },
        promptMessageId,
        taskRunId
      )
      if (run && runId !== run.id) return
      const state = receipt
        ? 'responded'
        : !unresolved &&
            pending &&
            (!runId || this.runner.getRun(runId).status !== 'cancelled') &&
            activePromptId === promptMessageId
          ? 'pending'
          : 'expired'
      const readyToAnswer =
        waitsForProvider || (session.status === 'waiting-for-user' && !session.activeRun)
      byRequestId.set(request.requestId, {
        taskRunId,
        request,
        receipt,
        waitsForProvider,
        readyToAnswer,
        interaction: {
          kind: 'question',
          id,
          state,
          branchId,
          promptMessageId,
          projectId: session.projectId,
          sessionId: session.id,
          ...(runId ? { runId } : {}),
          revision: taskQuestionRevision(request, promptMessageId, branchId),
          owner: state === 'pending' ? 'user' : 'service',
          actions: state === 'pending' && readyToAnswer ? ['accept', 'decline'] : [],
          ...(state === 'pending' && readyToAnswer
            ? { responseCapability: 'answer_question' }
            : {}),
          ...(state === 'pending' && !readyToAnswer
            ? {
                next: 'The original Run is settling. Read this question again before submitting an answer.'
              }
            : {}),
          ...(state === 'expired'
            ? {
                next: 'This question cannot be answered in this Run. Check the current Session before asking the user again.'
              }
            : {}),
          question: {
            message: request.message,
            fields: request.fields,
            skipFieldIds: (resolveAgentUserChoiceQuestions(request.fields) ?? []).map(
              ({ choiceField }) => choiceField.id
            )
          },
          ...(receipt
            ? {
                response: {
                  source: receipt.source,
                  action: receipt.action,
                  reviewedRevision: receipt.reviewedRevision,
                  ...(receipt.continuationId
                    ? { continuation: { id: receipt.continuationId, status: 'unconfirmed' } }
                    : {})
                }
              }
            : {})
        }
      })
    }

    const visible = new Map(
      resolveActiveConversationActivities(graph).activities.map((activity) => [
        activity.id,
        activity
      ])
    )
    for (const activity of graph.activities) {
      const question = activity.elicitation
      const requestId = question?.durable?.requestId ?? question?.taskRequestId
      if (
        !question ||
        !requestId ||
        !visible.has(activity.id) ||
        activity.agentFrameId !== graph.rootFrameId ||
        activity.messageBranchId !== branchId
      )
        continue
      if (
        question.durable?.promptMessageId &&
        question.durable.promptMessageId !== activity.promptMessageId
      )
        continue
      const flat = (session.activities ?? []).filter(({ id }) => id === activity.id)
      if (flat.length !== 1 || !isDeepStrictEqual(flat[0].elicitation, question)) continue
      add(
        {
          requestId,
          sessionId: session.id,
          toolCallId: activity.id,
          message: question.message,
          fields: question.fields,
          durable: question.durable
        },
        activity.promptMessageId,
        false,
        Boolean(
          question.durable && question.state === 'pending' && session.status === 'waiting-for-user'
        ),
        question.taskResponse,
        question.taskRunId
      )
    }
    for (const {
      request,
      provenance,
      waitsForProvider,
      receipt
    } of this.ports.agent.questions.list(session.id)) {
      if (provenance.agentFrameId !== graph.rootFrameId || provenance.messageBranchId !== branchId)
        continue
      const durable = byRequestId.get(request.requestId)
      if (durable?.receipt) continue
      add(
        request,
        provenance.promptMessageId,
        waitsForProvider,
        true,
        receipt,
        provenance.taskRunId
      )
    }
    return [...byRequestId.values()]
  }

  private childQuestions(
    session: PersistedChatSession,
    run?: TaskRun,
    interactionId?: string
  ): ScopedChildQuestion[] {
    const graph = session.conversationGraph
    if (
      !this.ports.agent.delegateInteractions ||
      !graph ||
      session.packageOrigin ||
      session.archivedAt !== undefined
    )
      return []
    const questions = session.runtimeContext?.delegatedWork?.questionRequests ?? []
    const rootMessages = resolveActiveConversationMessages({
      ...graph,
      activeFrameId: graph.rootFrameId
    })
    return questions.flatMap((record) => {
      const {
        requestId,
        sourceFrameId: frameId,
        sourceAttemptId: attemptId,
        sourceMessageBranchId: childBranchId,
        rootBranchId: branchId
      } = record
      const id = `${childQuestionPrefix}${requestId}`
      if (interactionId && id !== interactionId) return []
      const origin = delegatedAttempt(session, frameId, attemptId)
      if (!origin || origin.rootBranchId !== branchId) return []
      const runId = this.runner.findRunIdForPrompt(
        session.id,
        origin.promptMessageId,
        origin.attempt.startedAt
      )
      if (!runId || (run && run.id !== runId)) return []
      const task = run ?? this.runner.getRun(runId)
      const { status: attemptStatus, cancellationReason } = origin.attempt
      const receipt = record.taskResponse
      const sameAttempt =
        origin.active &&
        origin.latest &&
        origin.frame.activeBranchId === childBranchId &&
        rootMessages.some(({ id }) => id === record.rootOriginMessageId) &&
        origin.attempt.runtimeSegmentIds.at(-1) === record.sourceRuntimeSegmentId
      const pending =
        record.status === 'pending' &&
        sameAttempt &&
        (attemptStatus === 'running' ||
          attemptStatus === 'completed' ||
          cancellationReason === 'runtime_interrupted') &&
        task.status !== 'cancelled' &&
        task.cancelRequestedAt === undefined
      const state = receipt ? 'responded' : pending ? 'pending' : 'expired'
      if (!interactionId && !pending) return []
      const ready = pending && attemptStatus !== 'running'
      const request: PendingElicitationRequest = {
        requestId,
        sessionId: session.id,
        toolCallId: `${frameId}:${attemptId}:${record.sourceRuntimeSegmentId}:${childBranchId}`,
        message: record.questions[0].question,
        fields: record.questions.flatMap((question, index) => [
          {
            id: `question_${index}`,
            label: question.header ?? `Question ${index + 1}`,
            description: question.question,
            kind: question.kind ?? 'single-select',
            options: question.options.map((option) => ({ ...option, value: option.label }))
          },
          { id: `question_${index}_custom`, label: 'Other', kind: 'text' }
        ])
      }
      const continuationId = receipt && record.continuationAttemptId
      const continuation = continuationId
        ? delegatedAttempt(session, frameId, continuationId)?.attempt
        : undefined
      const interaction: TaskQuestionInteraction = {
        projectId: session.projectId,
        sessionId: session.id,
        id,
        kind: 'question',
        state,
        runId,
        branchId,
        promptMessageId: origin.promptMessageId,
        revision: taskQuestionRevision(request, origin.promptMessageId, branchId),
        interactionPolicy: task.interactionPolicy,
        delegated: {
          frameId,
          attemptId,
          branchId: childBranchId,
          attemptStatus,
          ...(continuationId
            ? {
                continuation: {
                  attemptId: continuationId,
                  status: continuation?.status ?? 'unconfirmed'
                }
              }
            : {})
        },
        owner: pending ? 'user' : 'service',
        actions: ready ? ['accept'] : [],
        ...(ready ? { responseCapability: 'answer_question' } : {}),
        ...(pending
          ? { question: { message: request.message, fields: request.fields, skipFieldIds: [] } }
          : {}),
        ...(pending && !ready
          ? { next: 'The child Attempt is settling. Query this question again before answering.' }
          : {}),
        ...(state === 'expired'
          ? { next: 'Check the parent Run and current child Attempt before asking the user again.' }
          : {}),
        ...(receipt
          ? {
              response: {
                source: receipt.source,
                action: 'accept',
                reviewedRevision: receipt.reviewedRevision
              }
            }
          : {})
      }
      return [{ interaction, record, request }]
    })
  }

  supportsTaskQuestions(): boolean {
    return (
      this.ports.agent.questions !== undefined ||
      this.ports.agent.delegateInteractions !== undefined
    )
  }

  async answerQuestion(
    id: string,
    scope: TaskInteractionScope,
    response: TaskQuestionResponse
  ): Promise<{ changed: boolean; interaction: TaskQuestionInteraction }> {
    this.requireTaskRelay()
    const { session } = await this.interactionSession(scope)
    const key = JSON.stringify([session.projectId, session.id, id])
    const previous = this.pendingQuestionResponses.get(key)
    const next = (previous ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.commitQuestionAnswer(id, scope, response))
    this.pendingQuestionResponses.set(key, next)
    try {
      return await next
    } finally {
      if (this.pendingQuestionResponses.get(key) === next) this.pendingQuestionResponses.delete(key)
    }
  }

  private async commitQuestionAnswer(
    id: string,
    scope: TaskInteractionScope,
    response: TaskQuestionResponse
  ): Promise<{ changed: boolean; interaction: TaskQuestionInteraction }> {
    const { session, run } = await this.interactionSession(scope)
    if (id.startsWith(childQuestionPrefix))
      return this.commitChildQuestion(id, session, run, response)
    const question = this.questionInteractions(session, run, id)[0]
    if (!question || !this.ports.agent.questions)
      throw new TaskRunnerError('interaction_not_found', 'No matching question in this scope.')
    const { interaction, request, waitsForProvider, readyToAnswer } = question
    const { branchId, promptMessageId } = interaction
    if (
      !branchId ||
      !promptMessageId ||
      branchId !== response.expectedBranchId ||
      interaction.revision !== response.expectedRevision ||
      interaction.state === 'expired'
    )
      throw staleQuestion()
    const { receipt, answers } = (() => {
      try {
        return taskQuestionAnswer(request, response)
      } catch (error) {
        throw new TaskRunnerError(
          'invalid_request',
          error instanceof Error ? error.message : 'Invalid structured input response.'
        )
      }
    })()
    if (question.receipt) {
      if (
        question.receipt.checksum !== receipt.checksum ||
        question.receipt.action !== receipt.action ||
        question.receipt.source !== receipt.source ||
        question.receipt.reviewedRevision !== receipt.reviewedRevision
      ) {
        throw new TaskRunnerError(
          'question_already_answered',
          'The question already has a different recorded answer.'
        )
      }
      return { changed: false, interaction: await this.withQuestionContinuation(interaction) }
    }
    if (interaction.state !== 'pending') throw staleQuestion()
    if (!readyToAnswer)
      throw new TaskRunnerError(
        'session_busy',
        'The original Run is still settling. Read the question again before submitting an answer.'
      )
    if (
      response.source === 'known_context' &&
      (response.action === 'decline' || answers.some(({ status }) => status === 'skipped'))
    ) {
      throw new TaskRunnerError(
        'invalid_request',
        'Skip or decline only when relaying an explicit user decision. Otherwise leave the question pending.'
      )
    }
    if (!waitsForProvider) {
      receipt.continuationId = `askuser_${createHash('sha256')
        .update(
          JSON.stringify([
            session.projectId,
            session.id,
            request.requestId,
            branchId,
            promptMessageId
          ])
        )
        .digest('hex')}`
    }
    const assertQuestion = (current: PendingElicitationRequest | undefined): void => {
      this.requireTaskRelay()
      if (
        !current ||
        taskQuestionRevision(current, promptMessageId, branchId) !== response.expectedRevision
      )
        throw staleQuestion()
    }
    await this.ports.agent.withSessionAvailable(session.projectId, session.id, async () => {
      if (waitsForProvider) {
        const latest = await this.runner.findSession(session.id, session.projectId)
        const active = rootQuestionScope(latest)
        if (active?.branchId !== branchId || active?.promptMessageId !== promptMessageId)
          throw staleQuestion()
      } else {
        await this.runner.ensureSessionAttached(session.id)
      }
      await this.ports.agent.questions!.respond({
        projectId: session.projectId,
        originalRunId: interaction.runId,
        request,
        waitsForProvider,
        answers,
        action: response.action,
        receipt,
        assertLive: (current, provenance) => {
          assertQuestion(current)
          if (
            provenance?.messageBranchId !== branchId ||
            provenance?.promptMessageId !== promptMessageId ||
            provenance?.taskRunId !== question.taskRunId
          )
            throw staleQuestion()
        },
        assertCurrent: (latest, current) => {
          assertQuestion(current)
          const active = rootQuestionScope(latest)
          if (
            latest.packageOrigin ||
            active?.branchId !== branchId ||
            active?.promptMessageId !== promptMessageId ||
            current?.durable?.provenanceContext?.taskRunId !== question.taskRunId
          )
            throw staleQuestion()
          if (latest.activeRun)
            throw new TaskRunnerError(
              'session_busy',
              'Wait for the active Run to settle before responding to the question.'
            )
        }
      })
    })
    return {
      changed: true,
      interaction: (await this.getInteraction(id, scope)) as TaskQuestionInteraction
    }
  }

  private async commitChildQuestion(
    id: string,
    session: PersistedChatSession,
    run: TaskRun | undefined,
    response: TaskQuestionResponse
  ): Promise<{ changed: boolean; interaction: TaskQuestionInteraction }> {
    const scoped = this.childQuestions(session, run, id)[0]
    const port = this.ports.agent.delegateInteractions
    if (!scoped || !port)
      throw new TaskRunnerError(
        'interaction_not_found',
        'No matching child question in this scope.'
      )
    const { interaction, request, record } = scoped
    if (
      interaction.branchId !== response.expectedBranchId ||
      interaction.revision !== response.expectedRevision ||
      interaction.state === 'expired'
    )
      throw staleQuestion()
    const { receipt, answers } = (() => {
      try {
        if (response.action !== 'accept')
          throw new Error('The child question requires an answer for each question.')
        const normalized = taskQuestionAnswer(request, response)
        return {
          receipt: normalized.receipt,
          answers: record.questions.map((_question, questionIndex) => {
            const fieldId = `question_${questionIndex}`
            const value = normalized.answers.find(
              (answer) => answer.fieldId === fieldId || answer.fieldId === `${fieldId}_custom`
            )?.value
            if (typeof value !== 'string' && !Array.isArray(value))
              throw new Error('The child question requires an answer for each question.')
            return { questionIndex, value }
          })
        }
      } catch (error) {
        throw new TaskRunnerError(
          'invalid_request',
          error instanceof Error ? error.message : 'Invalid child question answer.'
        )
      }
    })()
    if (record.taskResponse) {
      if (
        record.taskResponse.source !== receipt.source ||
        record.taskResponse.checksum !== receipt.checksum ||
        record.taskResponse.reviewedRevision !== receipt.reviewedRevision
      )
        throw new TaskRunnerError(
          'question_already_answered',
          'The child question already has a different recorded answer.'
        )
      return { changed: false, interaction }
    }
    if (!interaction.actions.length)
      throw new TaskRunnerError(
        'session_busy',
        'Wait for the child Attempt to settle and read the original question again.'
      )
    const { projectId, sessionId } = interaction
    const runId = interaction.runId!
    try {
      await this.ports.agent.withSessionAvailable(projectId, sessionId, () =>
        port.answerQuestion(
          { projectId, sessionId },
          {
            requestId: record.requestId,
            answers,
            task: {
              frameId: record.sourceFrameId,
              attemptId: record.sourceAttemptId,
              branchId: record.sourceMessageBranchId,
              rootBranchId: record.rootBranchId,
              canonicalDigest: record.canonicalDigest,
              response: {
                source: receipt.source,
                reviewedRevision: receipt.reviewedRevision,
                checksum: receipt.checksum
              },
              assertCurrent: () => {
                this.requireTaskRelay()
                const current = this.runner.getRun(runId)
                if (current.status === 'cancelled' || current.cancelRequestedAt !== undefined)
                  throw staleQuestion()
              }
            }
          }
        )
      )
    } catch (error) {
      if (!(error instanceof DurableDelegatedWorkError)) throw error
      throw new TaskRunnerError(
        'interaction_revision_conflict',
        'The child Attempt could not accept this answer. Query the original question before responding again.'
      )
    }
    return {
      changed: true,
      interaction: (await this.getInteraction(id, { runId })) as TaskQuestionInteraction
    }
  }

  private async withQuestionContinuation(
    interaction: TaskQuestionInteraction
  ): Promise<TaskQuestionInteraction> {
    const continuation = interaction.response?.continuation
    if (!continuation || !this.submissions) return interaction
    const requestId = taskContinuationRequestId({
      kind: 'question',
      projectId: interaction.projectId,
      sessionId: interaction.sessionId,
      attemptId: continuation.id
    })
    try {
      const receipt = await this.submissions.get(requestId)
      return {
        ...interaction,
        response: {
          ...interaction.response!,
          continuation: {
            ...continuation,
            requestId: receipt.requestId,
            status: receipt.status,
            ...(receipt.runId ? { runId: receipt.runId } : {})
          }
        }
      }
    } catch (error) {
      if (
        !(error instanceof TaskRunnerError) ||
        (error.code !== 'submission_not_found' && error.code !== 'submission_unavailable')
      )
        throw error
      return interaction
    }
  }

  private async notebookStopInteraction(
    session: PersistedChatSession,
    run?: TaskRun
  ): Promise<TaskNotebookStopInteraction | undefined> {
    if (
      !this.submissions ||
      !this.ports.notebook ||
      session.packageOrigin ||
      session.archivedAt !== undefined
    )
      return
    const graph = session.conversationGraph
    const branchId = graph?.frames.find(({ id }) => id === graph.activeFrameId)?.activeBranchId
    if (!branchId || !graph) return
    const runPromptId = run ? this.runner.getRunPromptMessageId(run.id) : undefined
    if (run && !runPromptId) return
    const execution = run
      ? (await this.withRunExecution(run)).execution
      : await this.ports.notebook.inspectTaskExecution({
          projectId: session.projectId,
          sessionId: session.id,
          includeSessionRefusal: true
        })
    if (!execution) return
    const { refusalId, promptMessageId, refusalReason } = execution
    if (
      execution.status !== 'waiting_for_user' ||
      !refusalId ||
      !promptMessageId ||
      execution.messageBranchId !== branchId ||
      !resolveActiveConversationMessages(graph).some(({ id }) => id === promptMessageId)
    )
      return
    const runId = run?.id ?? this.runner.findRunIdForPrompt(session.id, promptMessageId)
    if (!runId) return
    return {
      id: `${notebookStopPrefix}${refusalId}`,
      kind: 'notebook-continuation',
      state: 'pending',
      projectId: session.projectId,
      sessionId: session.id,
      runId,
      branchId,
      promptMessageId,
      revision: 0, // The refusal ID is immutable and changes with each new stop.
      owner: 'user',
      actions: ['continue'],
      responseCapability: 'continue_notebook',
      refusalId,
      ...(refusalReason ? { reason: refusalReason } : {}),
      next: 'Resolve the reported cause and ask the user whether to continue this specific stop.'
    }
  }

  async respondSessionPlan(
    sessionId: string,
    request: TaskPlanResponseRequest
  ): Promise<{ changed: boolean; interaction: TaskPlanInteraction }> {
    this.requireTaskRelay()
    const session = await this.runner.findSession(sessionId, request.projectId)
    if (session.packageOrigin) {
      throw new TaskRunnerError('session_read_only', 'The imported Session is read-only.')
    }
    const interactionId = `plan:${request.artifactVersionId}`
    const interaction = await this.planInteraction(session, undefined, interactionId)
    if (!interaction)
      throw new PlanCommandError('stale-plan', 'This Plan is no longer active in the Session.')
    if (interaction.branchId !== request.expectedBranchId) {
      throw new PlanCommandError(
        'interaction-mismatch',
        'The Plan belongs to a different active Message Branch.'
      )
    }
    const action = request.decision ?? 'revise'
    const record =
      session.runtimeContext?.plan?.artifactVersionId === request.artifactVersionId
        ? session.runtimeContext.plan
        : session.planHistoryProjections?.find(
            (plan) => plan.artifactVersionId === request.artifactVersionId
          )
    if (interaction.state === 'responded') {
      const receipt = record?.externalResponse
      const feedbackChecksum = request.feedback
        ? createHash('sha256').update(request.feedback).digest('hex')
        : undefined
      if (
        receipt?.reviewedRevision === request.expectedRevision &&
        receipt.source === request.source &&
        receipt.action === action &&
        receipt.feedbackChecksum === feedbackChecksum
      ) {
        return { changed: false, interaction }
      }
      throw new PlanCommandError(
        'approval-already-decided',
        'This Plan already has a different response.'
      )
    }
    if (interaction.state !== 'pending' || interaction.revision !== request.expectedRevision) {
      throw new PlanCommandError(
        'revision-conflict',
        'Read the current Plan revision before responding.'
      )
    }
    const { projectId } = interaction
    const identity = {
      projectId,
      sessionId,
      artifactVersionId: request.artifactVersionId,
      expectedRevision: request.expectedRevision,
      source: request.source,
      expectedBranchId: request.expectedBranchId
    }
    const command: PlanResponseCommand = request.decision
      ? { ...identity, decision: request.decision }
      : { ...identity, feedback: request.feedback }
    const assertCurrent = (): void => {
      this.requireTaskRelay()
      this.runner.assertTaskInteractionDecision(
        interaction.runId,
        request.source,
        request.expectedModeRevision
      )
    }
    assertCurrent()
    await this.runner.ensureSessionAttached(sessionId)
    const result =
      request.source === 'delegated_agent'
        ? await this.respondDelegatedPlan(command, assertCurrent)
        : ((await this.invoke('acp:respond-plan', command)) as { changed?: boolean })
    return {
      changed: !('changed' in result) || result.changed !== false,
      interaction: (await this.getInteraction(interactionId, {
        projectId,
        sessionId
      })) as TaskPlanInteraction
    }
  }

  private respondDelegatedPlan(
    command: PlanResponseCommand,
    assertCurrent: () => void
  ): Promise<import('../session-plan/plan-service').PlanResponseResult> {
    const respond = this.ports.agent.respondDelegatedPlan
    if (!respond)
      throw new TaskRunnerError(
        'task_delegation_required',
        'The service cannot verify a delegated Plan response.'
      )
    return this.ports.agent.withSessionAvailable(command.projectId, command.sessionId, () =>
      respond(command, () => {
        try {
          assertCurrent()
          return true
        } catch {
          return false
        }
      })
    )
  }

  supportsSubmissions(): boolean {
    return this.submissions !== undefined
  }

  supportsNotebookContinuation(): boolean {
    return this.submissions !== undefined && this.ports.notebook !== undefined
  }

  async continueNotebook(requestId: string, request: unknown): Promise<TaskSubmission> {
    this.requireTaskRelay()
    if (!this.submissions || !this.ports.notebook)
      throw new TaskRunnerError('submission_unavailable', 'Notebook continuation is unavailable.')
    const parsed = notebookContinuationRequest.safeParse(request)
    if (!parsed.success) {
      throw new TaskRunnerError(
        'invalid_request',
        'Supply the original runId, branchId and refusalId, the user_relay source, and a continuation prompt.'
      )
    }
    return this.submissions.submitNotebookContinuation(requestId, parsed.data, (input) =>
      this.callerContexts.run(TASK_CALLER_CONTEXT, async () => {
        const { run, session } = await this.interactionSession({ runId: input.runId })
        const stop = await this.notebookStopInteraction(session, run)
        if (
          stop?.refusalId !== input.refusalId ||
          stop.branchId !== input.branchId ||
          !stop.promptMessageId
        )
          throw notebookStopExpired()
        return this.runner.startRun(
          { project: stop.projectId, sessionId: stop.sessionId, prompt: input.prompt },
          requestId,
          {
            originalRunId: input.runId,
            projectId: stop.projectId,
            refusalId: stop.refusalId,
            task: { branchId: input.branchId, promptMessageId: stop.promptMessageId }
          }
        )
      })
    )
  }

  submitRun(
    requestId: string,
    request: SubmitTaskRunRequest
  ): Promise<import('../../shared/task-api').TaskSubmission> {
    if (request?.interactionMode === 'delegate' || request?.notebookRuntime !== undefined)
      this.requireTaskRelay()
    if (!this.submissions)
      throw new TaskRunnerError('submission_unavailable', 'Durable submissions are unavailable.')
    return this.submissions.submit(requestId, request)
  }

  getSubmission(requestId: string): Promise<import('../../shared/task-api').TaskSubmission> {
    if (!this.submissions)
      throw new TaskRunnerError('submission_unavailable', 'Durable submissions are unavailable.')
    return this.submissions.get(requestId)
  }

  startRun(request: StartTaskRunRequest): Promise<TaskRun> {
    if (request?.interactionMode === 'delegate' || request?.notebookRuntime !== undefined)
      this.requireTaskRelay()
    return this.runner.startRun(request)
  }

  async getRun(runId: string): Promise<TaskRun> {
    const run = await this.withRunExecution(this.runner.getRun(runId))
    const promptMessageId = this.runner.getRunPromptMessageId(runId)
    if (
      canRelayTaskInteraction(this.currentCallerContext()) &&
      (run.attention?.kind === 'plan-approval' ||
        run.failureCode === 'process_restarted' ||
        run.execution?.refusalId ||
        this.supportsTaskQuestions() ||
        this.ports.agent.delegateInteractions ||
        (promptMessageId &&
          this.ports.agent.getTaskPermissions?.(run.sessionId, promptMessageId).length))
    ) {
      try {
        const interactions = await this.listInteractions({ runId })
        if (
          run.execution?.refusalId &&
          interactions.some(({ kind }) => kind === 'notebook-continuation')
        ) {
          run.execution.next = {
            action: 'continue_notebook',
            message:
              'Resolve the reported cause and ask the user whether to continue this stop. Use the original Run and the branch and refusal IDs in the interaction. Do not replay the stopped cell.'
          }
        }
        const execution = run.execution
        if (execution?.status === 'waiting_for_user' && !execution.refusalId) {
          const review = interactions.find(
            ({ notebookReview, branchId }) =>
              notebookReview &&
              branchId === execution.messageBranchId &&
              execution.reasonCode === `notebook_${notebookReview.kind}_review_required`
          )
          if (review) {
            execution.owner = review.owner === 'agent' ? 'agent' : 'user'
            if (execution.owner === 'agent') delete execution.requiresUser
            execution.next = {
              action: 'respond_permission',
              message:
                'Read the pending Notebook review with get_interaction, then relay the user decision or respond under current task delegation. Recheck this Run afterward.'
            }
          }
        }
        return {
          ...run,
          attention: interactions.length ? { kind: 'interactions', interactions } : undefined
        }
      } catch (error) {
        if (!(error instanceof TaskRunnerError && error.code === 'session_not_found')) throw error
        return { ...run, attention: undefined }
      }
    }
    return run
  }

  async waitForRun(runId: string): Promise<TaskRun> {
    return this.withRunExecution(await this.runner.waitForRun(runId))
  }

  private withRunExecution(run: TaskRun): Promise<TaskRun> | TaskRun {
    const promptMessageId = this.runner.getRunPromptMessageId(run.id)
    if (!promptMessageId) return run
    return this.withNotebookExecution(run, {
      projectId: run.projectId,
      sessionId: run.sessionId,
      promptMessageId,
      ...(this.runner.sharesContinuationPrompt(run, promptMessageId)
        ? { taskWindow: { startedAt: run.startedAt, completedAt: run.completedAt } }
        : {})
    })
  }

  private async withNotebookExecution<T extends TaskRun | TaskSessionSummary>(
    value: T,
    scope: Parameters<NotebookRuntimeService['inspectTaskExecution']>[0]
  ): Promise<T> {
    if (!this.ports.notebook) return value
    try {
      return { ...value, execution: await this.ports.notebook.inspectTaskExecution(scope) }
    } catch {
      const { projectId, sessionId, promptMessageId } = scope
      log.debug('Could not read Notebook execution evidence', {
        projectId,
        sessionId,
        promptMessageId
      })
      return {
        ...value,
        execution: {
          projectId,
          sessionId,
          status: 'unconfirmed',
          reasonCode: 'notebook_evidence_unavailable'
        }
      }
    }
  }

  cancelRun(runId: string): Promise<TaskRun> {
    return this.runner.cancelRun(runId)
  }

  subscribeProgress(listener: (event: TaskRunProgressEvent) => void): () => void {
    return this.runner.subscribeProgress(listener)
  }

  resolveActiveRun(
    sessionId: string,
    promptMessageId?: string
  ): ReturnType<TaskRunner['resolveActiveRun']> {
    return this.runner.resolveActiveRun(sessionId, promptMessageId)
  }

  listArtifacts(sessionId: string): ReturnType<TaskRunner['listArtifacts']> {
    return this.runner.listArtifacts(sessionId)
  }

  async acquireArtifact(
    artifactId: string,
    selection?: ArtifactBrowserSelection
  ): ReturnType<TaskRunner['acquireArtifact']> {
    if (!selection) return this.runner.acquireArtifact(artifactId)
    // Browser previews can include Versions absent from the Task completion projection.
    // Resolve metadata and bytes through the same Project/File/Version authority as the preview.
    const identity = {
      source: 'artifact' as const,
      fileId: artifactId,
      ...(selection.projectId ? { projectId: selection.projectId } : {}),
      ...(selection.versionNumber !== undefined ? { versionNumber: selection.versionNumber } : {})
    }
    const inspection = (await this.invoke(
      'managed-file-versions:inspect',
      identity
    )) as ManagedFileVersionIpcResult<ManagedFileVersionInspectResult>
    if (!inspection.ok) {
      throw new TaskRunnerError('artifact_not_found', inspection.error.message)
    }
    const version = inspection.value.selectedVersion
    if (
      !version ||
      version.fileId !== artifactId ||
      (selection.versionNumber !== undefined && version.versionNumber !== selection.versionNumber)
    ) {
      throw new TaskRunnerError('artifact_not_found', 'Artifact Version not found.')
    }
    const resource = await this.acquirePreviewResource({
      source: 'artifact',
      projectId: inspection.value.projectId,
      fileId: artifactId,
      versionId: version.id,
      ...(version.contentType ? { mimeType: version.contentType } : {})
    })
    return {
      release: resource.release,
      resourceId: resource.id,
      url: resource.url,
      name: version.displayName,
      mimeType: resource.mimeType,
      size: resource.size
    }
  }

  releaseRemoteClient(clientId: string): void {
    this.commandClient.releaseClient('task', clientId)
  }

  // Both downloads and inline previews retain the original caller generation for cleanup.
  private acquirePreviewResource(
    request: Parameters<TaskRunnerDependencies['previewResources']['acquire']>[0]
  ): ReturnType<TaskRunnerDependencies['previewResources']['acquire']> {
    return this.withCurrentCaller(async () => {
      const callerContext = this.currentCallerContext()
      const callerLease = this.commandClient.leaseFor(callerContext)
      const resource = (await this.ports.commands.invoke('preview-resources:acquire', {
        callerContext,
        callerLease,
        args: [request]
      })) as { id: string; url: string; size: number; mimeType?: string }
      let released = false
      return {
        ...resource,
        release: async () => {
          // Cleanup is limited to this resource on the original generation. If the
          // owner has already gone away, its abort listener has done the cleanup.
          if (released || !callerLease.isCurrent()) return
          released = true
          await this.ports.commands.invoke('preview-resources:release', {
            callerContext: {
              ...callerContext,
              isAuthorizationCurrent: callerLease.isCurrent
            },
            callerLease,
            args: [{ resourceId: resource.id }]
          })
        }
      }
    })
  }

  private invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    return this.withCurrentCaller(() =>
      this.commandClient.invoke(this.ports.commands, channel, this.currentCallerContext(), args)
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

  private projectAgentRouting(settings: SettingsSnapshot): TaskAgentRouting {
    const reviewer = settings.reviewerModel ?? { mode: 'inherit' as const }
    const subagent = settings.subagentModel ?? { mode: 'inherit' as const }
    return {
      configured: {
        framework: settings.agentFrameworkId,
        reviewer,
        subagent
      },
      effective: {
        reviewer:
          reviewer.mode === 'inherit'
            ? {
                source: 'application_main',
                ...(settings.activeProviderId ? { providerId: settings.activeProviderId } : {}),
                ...(settings.activeModel ? { model: settings.activeModel } : {})
              }
            : {
                source: 'fixed',
                providerId: reviewer.providerId,
                model: reviewer.model,
                reasoningEffort: reviewer.reasoningEffort
              },
        subagent:
          subagent.mode === 'inherit'
            ? { source: 'session_main' }
            : {
                source: 'fixed',
                providerId: subagent.providerId,
                model: subagent.model,
                reasoningEffort: subagent.reasoningEffort
              }
      }
    }
  }

  private resolveSpecialist(reference: string): Promise<{ id: string }> {
    const specialists = this.ports.controls?.specialists
    if (!specialists) return Promise.reject(new Error('Task Specialist controls are unavailable.'))
    return specialists.resolve(reference)
  }

  private async review(
    session: PersistedChatSession,
    turnMessageId: string,
    signal: AbortSignal
  ): Promise<TaskRunReview> {
    const reviewSession = { projectId: session.projectId, appSessionId: session.id }
    const throwIfAborted = async (): Promise<void> => {
      if (!signal.aborted) return
      // Cancellation is cleanup for an already-authorized Task Run. Use the fixed Task capability so
      // an expired remote request lease cannot strand the separate Reviewer runtime.
      await this.commandClient.invoke(this.ports.commands, 'reviewer:abort', TASK_CALLER_CONTEXT, [
        reviewSession
      ])
      throw new Error('Automatic review was cancelled.')
    }
    const waitForPoll = (): Promise<void> =>
      new Promise((resolve) => {
        const onAbort = (): void => {
          clearTimeout(timer)
          resolve()
        }
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', onAbort)
          resolve()
        }, 250)
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
      })

    await throwIfAborted()
    const started = (await this.invoke('reviewer:run', {
      sessionId: session.id,
      turnMessageId,
      projectId: session.projectId,
      mainSessionId: session.id,
      model: session.agentModel,
      origin: 'auto'
    })) as ReviewRunResult
    await throwIfAborted()
    if (!started.started) return started

    for (;;) {
      // Polling is lifecycle work for an admitted review. Keep it independent from the originating
      // request lease, which may expire while the separate Reviewer runtime is still working.
      const reviews = (await this.commandClient.invoke(
        this.ports.commands,
        'reviewer:get-for-session',
        TASK_CALLER_CONTEXT,
        [{ projectId: session.projectId, appSessionId: session.id }]
      )) as ReviewWithChecks[]
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
      await waitForPoll()
      await throwIfAborted()
    }
  }
}

export { HeadlessTaskApi, TaskRunnerError as TaskApiError, summarizeSession }
export type { TaskApiDependencies, TaskApiPorts, TaskNotebookRuntimes }
