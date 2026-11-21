import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { BootstrapRequest, BootstrapResult } from '../../shared/bootstrap'
import type { CliLauncherStatus } from '../../shared/cli'
import type { NotebookLanguage } from '../../shared/notebook-language-contract'

import type { AcpRuntimeEvent } from '../../shared/acp'
import type { AcpPermissionRequest } from '../../shared/acp-permission-contract'
import type { ArtifactVersionDescriptor } from '../../shared/artifact-provenance'
import { resolveActiveConversationMessages } from '../../shared/conversation-graph'
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
  SetTaskInteractionModeRequest
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
  TaskAgentRouting,
  TaskAgentRuntime,
  TaskDoctorReport,
  TaskNotebookContinuationRequest,
  TaskNotebookEnvironmentOperation,
  TaskNotebookEnvironmentRequest,
  TaskNotebookEnvironmentTarget,
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
import { containsSecretBearingMaterial } from '../permission-grants/capability'
import type { TaskControlPorts } from '../tasks/task-control-ports'
import { TaskSubmissions } from '../tasks/task-submissions'
import type { TaskRunJournal } from '../tasks/task-run-journal'
import {
  TaskRunner,
  TaskRunnerError,
  summarizeSession,
  type TaskAgentPort,
  type TaskComputePreferencePort,
  type TaskRunnerDependencies
} from '../tasks/task-runner'
import { readTaskNotebookReadiness } from './task-notebook-readiness'

const TASK_CALLER_CONTEXT = createTaskCallerContext()
const log = createLogger('web-service:task-api')
const notebookStopPrefix = 'notebook-continuation:'
const notebookContinuationRequest = z.strictObject({
  runId: z.string().trim().min(1),
  branchId: z.string().trim().min(1),
  refusalId: z.string().trim().min(1),
  source: z.literal('user_relay'),
  prompt: z.string().trim().min(1)
}) satisfies z.ZodType<TaskNotebookContinuationRequest>

const notebookStopExpired = (): TaskRunnerError =>
  new TaskRunnerError(
    'notebook_continuation_expired',
    'The Notebook stop is no longer current in this branch, or cannot be recovered after restart. Inspect the original Run and ask the user before starting any new work.'
  )

function permissionPreview(
  request: AcpPermissionRequest
): NonNullable<TaskPermissionInteraction['request']> {
  const text = (value: string): string =>
    containsSecretBearingMaterial(value) ? '[Redacted]' : value.slice(0, 512)
  const preview = JSON.stringify(request.rawInput)
  return {
    title: text(request.title),
    toolCallId: request.toolCallId,
    ...((request.mcpIdentity ?? request.providerToolName)
      ? { tool: text((request.mcpIdentity ?? request.providerToolName)!) }
      : {}),
    ...(preview && preview.length <= 8192 && !containsSecretBearingMaterial(preview)
      ? { input: request.rawInput }
      : {}),
    options: taskPermissionOptions(request).map((option) => ({
      ...option,
      name: text(option.name)
    }))
  }
}

type TaskApiPorts = {
  commands: ApplicationCommandByNameDispatcher
  agent: TaskAgentPort
  notebook?: Pick<NotebookRuntimeService, 'inspectTaskExecution'>
  notebookEnvironment?: ManagedNotebookSetup
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

class HeadlessTaskApi {
  private readonly callerContexts = new AsyncLocalStorage<CallerContext>()
  private readonly commandClient = createApplicationCommandClient()
  private readonly runner: TaskRunner
  private readonly submissions?: TaskSubmissions

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
        list: async () => {
          const result = (await this.invoke('sessions:load-all')) as {
            sessions: PersistedChatSession[]
          }
          return result.sessions
        },
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
    }
  }

  async initialize(): Promise<void> {
    // Recover receipt links before Run restoration prunes old terminal history.
    await this.submissions?.initialize()
    await this.runner.initialize()
  }

  async dispose(): Promise<void> {
    try {
      await Promise.all([this.submissions?.dispose(), this.runner.dispose()])
    } finally {
      this.commandClient.dispose()
    }
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

  private publicPlan({ externalResponse, ...plan }: ActivePlanProjection): ActivePlanProjection {
    void externalResponse
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
      const preview = current && permissionPreview(current.request)
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
        await this.runner.recordPermissionInteraction(taskId, { id, branchId, revision: 0 })
      }
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
        ...(record?.response ? { response: record.response } : {}),
        ...(state === 'expired' || state === 'unconfirmed'
          ? {
              next: 'Inspect the original Run and Session before starting new work. Do not repeat the decision.'
            }
          : {})
      })
    }
    return interactions
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
    if (run && this.runner.getRunPromptMessageId(run.id) !== promptMessageId) return undefined
    const runId = run?.id ?? this.runner.findRunIdForPrompt(session.id, promptMessageId)
    const interactionPolicy = runId ? this.runner.getRun(runId).interactionPolicy : undefined
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
      session.packageOrigin || historical || !branchId || run?.status === 'cancelled'
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
                taskRunStatus: 'unconfirmed',
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
    const permissions = (await this.permissionInteractions(session, run))
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
    return references
  }

  async getInteraction(id: string, scope: TaskInteractionScope): Promise<TaskInteraction> {
    this.requireTaskRelay()
    const { session, run } = await this.interactionSession(scope)
    if (id.startsWith(notebookStopPrefix)) {
      const stop = await this.notebookStopInteraction(session, run)
      if (stop?.id !== id) throw notebookStopExpired()
      return stop
    }
    const interaction = id.startsWith('permission:')
      ? (await this.permissionInteractions(session, run, id))[0]
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
    const requestId = id.slice('permission:'.length)
    if (restored) await this.runner.ensureSessionAttached(sessionId)
    const changed = await this.ports.agent.withSessionAvailable(projectId, sessionId, async () => {
      const assertScope = async (): Promise<void> => {
        const latest = await this.runner.findSession(sessionId, projectId)
        const graph = latest.conversationGraph
        const frame = graph?.frames.find(({ id }) => id === graph.activeFrameId)
        if (!frame || frame.activeBranchId !== current.branchId || latest.packageOrigin)
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
            response: {
              source: response.source,
              optionId: response.optionId,
              status,
              ...(restored ? { continuation: { taskRunStatus: 'unconfirmed' } } : {})
            }
          })
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
    const execution = await this.ports.notebook.inspectTaskExecution({
      projectId: session.projectId,
      sessionId: session.id,
      promptMessageId: runPromptId,
      ...(run ? {} : { includeSessionRefusal: true })
    })
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
    request: StartTaskRunRequest
  ): Promise<import('../../shared/task-api').TaskSubmission> {
    if (request?.interactionMode === 'delegate') this.requireTaskRelay()
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
    if (request?.interactionMode === 'delegate') this.requireTaskRelay()
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
      promptMessageId
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
export type { TaskApiDependencies, TaskApiPorts }
