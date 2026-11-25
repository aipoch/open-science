import {
  rebaseTaskSessionBinding,
  rebaseTaskTurnOntoLatestSession
} from '../session-persistence/task-admission'
import { describe, expect, it, onTestFinished, vi, type MockedFunction } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AcpRuntimeEvent } from '../../shared/acp'
import {
  materializeSessionConversationGraph,
  normalizeSessionFile,
  type PersistedChatMessage,
  type PersistedChatSession
} from '../../shared/session-persistence'
import {
  forkEditedConversationMessage,
  getActiveConversationContext,
  synchronizeActiveConversationActivities
} from '../../shared/conversation-graph'
import { AcpAppContinuationOwner } from '../acp/app-continuation-owner'
import { AcpDurableContinuationContextOwner } from '../acp/durable-continuation-context-owner'
import { AcpElicitationOwner } from '../acp/elicitation-owner'
import { AcpPermissionBroker } from '../acp/permission-broker'
import { AcpQuestionContinuationWorkflow } from '../acp/question-continuation-workflow'
import { AcpSessionInteractionOwner } from '../acp/session-interaction-owner'
import type { TaskNotebookContinuationRequest, TaskNotebookExecution } from '../../shared/task-api'
import { PlanCommandError } from '../../shared/session-plan/contract'
import type { ApplicationCommandByNameDispatcher } from '../application-command-composition'
import { ApplicationEventHub } from '../application-events'
import { createTaskCallerContext, type CallerContext } from '../caller-context'
import {
  attachEnabledComputeHosts,
  EnabledComputeHostsRegistry
} from '../compute/enabled-hosts-registry'
import {
  sessionComputeHostAccess,
  transitionSessionComputeHostAccess,
  type SessionComputeHostAccessMutation
} from '../compute/session-compute-host-access'
import { SessionEnabledComputeHostsOwner } from '../compute/session-enabled-hosts-owner'
import type { TaskAgentPort, TaskSessionPort } from '../tasks/task-runner'
import type { TaskContinuationTracker } from '../../shared/task-continuation'
import { FileTaskRunJournal, type TaskRunJournalEntry } from '../tasks/task-run-journal'
import { NotebookRuntimeService } from '../notebook/runtime-service'
import { NotebookRunRepository } from '../notebook/repository'
import { createFrameNotebookLane } from '../notebook/lane-identity'
import { HeadlessTaskApi } from './task-api'
import { startWebHttpServer } from './http-server'

const project = {
  id: 'project-1',
  name: 'systematic-review',
  description: '',
  isExample: false,
  createdAt: 1,
  updatedAt: 1
}

const taskCallerContext = (): ReturnType<typeof expect.objectContaining> =>
  expect.objectContaining({
    clientId: 'headless-task-api',
    lifecycleClientId: 'web:headless-task-api',
    surface: 'task',
    principalKind: 'automation',
    actionOrigin: 'automation'
  })

const taskSettings = {
  claude: {},
  opencode: {},
  codebuddy: {},
  codex: {},
  claudeManaged: false,
  opencodeManaged: false,
  codebuddyManaged: false,
  codexManaged: false,
  providers: [],
  agentFrameworkId: 'claude-code',
  agentFrameworks: [] as { id: string; displayName: string }[],
  reasoningEffort: 'default',
  notificationsEnabled: true,
  conversationSkillImportEnabled: true,
  appIconVariant: 'light'
}

type TaskAgentMock = {
  [
    Method in Exclude<
      keyof TaskAgentPort,
      'withSessionAvailable' | 'setContinuationTracker' | 'questions' | 'delegateInteractions'
    >
  ]: MockedFunction<NonNullable<TaskAgentPort[Method]>>
} & Pick<
  TaskAgentPort,
  'withSessionAvailable' | 'setContinuationTracker' | 'questions' | 'delegateInteractions'
>

const createAgent = (overrides: Partial<TaskAgentMock> = {}): TaskAgentMock => ({
  assertAttachedTracingReady: vi.fn(async () => undefined),
  withSessionAvailable: async (_projectId, _sessionId, operation) => operation(),
  listAttachedSessionIds: vi.fn<TaskAgentPort['listAttachedSessionIds']>(async () => []),
  createSession: vi.fn<TaskAgentPort['createSession']>(async () => ({
    sessionId: 'session-created'
  })),
  resumeSession: vi.fn<TaskAgentPort['resumeSession']>(async (request) => ({
    sessionId: request.sessionId
  })),
  setPermissionProfile: vi.fn<TaskAgentPort['setPermissionProfile']>(async () => undefined),
  setMemoryEnabled: vi.fn<TaskAgentPort['setMemoryEnabled']>(async () => undefined),
  prompt: vi.fn<TaskAgentPort['prompt']>(async () => undefined),
  cancelPrompt: vi.fn<TaskAgentPort['cancelPrompt']>(async () => undefined),
  respondDelegatedPlan: vi.fn(),
  getTaskPermissions: vi.fn(() => []),
  respondTaskPermission: vi.fn(async () => false),
  restoreTaskPermission: vi.fn(async () => false),
  ...overrides
})

type TaskQuestionHarness = {
  scope: { projectId: string; sessionId: string }
  provenance: ReturnType<typeof getActiveConversationContext>
  interactions: AcpSessionInteractionOwner
  continuations: AcpAppContinuationOwner
  schedule: ReturnType<typeof vi.fn>
  providerSend: ReturnType<typeof vi.fn>
  newOwner: (requestId?: string) => AcpElicitationOwner
  addContinuationRun: () => void
  createApi: (
    owner: AcpElicitationOwner,
    restored: boolean,
    submissionRoot?: string
  ) => HeadlessTaskApi
  restart: () => void
  forkQuestionPrompt: () => void
}

const taskQuestionHarness = (status: 'running' | 'waiting-for-user'): TaskQuestionHarness => {
  const promptMessageId = 'question-prompt'
  let session: PersistedChatSession = materializeSessionConversationGraph({
    id: 'question-session',
    projectId: project.id,
    title: 'Question session',
    cwd: '/workspace',
    status,
    runtimeTranscriptOwner: 'main',
    createdAt: 1,
    updatedAt: 2,
    messages: [
      {
        id: promptMessageId,
        role: 'user',
        content: 'Compare the groups.',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1
      }
    ]
  })
  const scope = { projectId: session.projectId, sessionId: session.id }
  const provenance = getActiveConversationContext(session.conversationGraph!, promptMessageId)
  const journal: TaskRunJournalEntry[] = [
    {
      id: 'original-run',
      ...scope,
      promptMessageId,
      cwd: session.cwd,
      status: 'running',
      startedAt: 1,
      artifacts: [],
      preferredComputeHostIds: []
    }
  ]
  const interactions = new AcpSessionInteractionOwner()
  const continuations = new AcpAppContinuationOwner({ activityChanged: () => undefined })
  const schedule = vi.fn()
  const providerSend = vi.fn()
  const sessionOwner = new AcpDurableContinuationContextOwner({
    loadSessionForContinuation: async () => structuredClone(session),
    mutateRuntimeSession: async (_scope, mutate) => {
      session = mutate(structuredClone(session))
      return structuredClone(session)
    }
  })
  const newOwner = (requestId = 'root-question'): AcpElicitationOwner =>
    new AcpElicitationOwner({
      createRequestId: () => requestId,
      onProjection: (request, elicitation) => {
        session.activities = [
          ...(session.activities ?? []).filter(({ id }) => id !== request.toolCallId),
          {
            id: request.toolCallId,
            kind: 'tool',
            title: request.message,
            status: 'in_progress',
            promptMessageId,
            sortIndex: 0,
            eventIds: [],
            createdAt: 2,
            updatedAt: 2,
            elicitation
          }
        ]
        session.conversationGraph = synchronizeActiveConversationActivities(
          session.conversationGraph!,
          session.activities,
          []
        )
      }
    })
  const createApi = (
    elicitation: AcpElicitationOwner,
    restored: boolean,
    submissionRoot?: string
  ): HeadlessTaskApi => {
    let trackSend: TaskContinuationTracker | undefined
    const workflow = new AcpQuestionContinuationWorkflow({
      hasActiveSession: () => true,
      projectId: () => project.id,
      permissionPrompts: () => undefined,
      copyReferencedSessions: () => undefined,
      interactions,
      elicitation,
      context: sessionOwner,
      continuations,
      schedule,
      publication: { getSnapshot: vi.fn(), emitState: vi.fn(), pushEvent: vi.fn() }
    })
    return new HeadlessTaskApi(
      {
        commands: commandsFrom(async (channel) => {
          if (channel === 'sessions:load-all') return { sessions: [structuredClone(session)] }
          if (channel === 'sessions:load-one') return structuredClone(session)
          throw new Error(`Unexpected Task command: ${channel}`)
        }),
        agent: createAgent({
          setContinuationTracker: (tracker) => {
            trackSend = tracker
            return () => {
              trackSend = undefined
            }
          },
          listAttachedSessionIds: vi.fn(async () => [scope.sessionId]),
          questions: {
            list: (id) => elicitation.listTaskQuestions(id),
            respond: (input) =>
              workflow.respondToTask(
                input,
                async (request, attemptId, dispatched) => {
                  dispatched()
                  providerSend(request, attemptId)
                  return { stopReason: 'end_turn' }
                },
                trackSend
              )
          }
        })
      },
      restored
        ? {
            submissionRoot,
            runJournal: {
              load: async () => structuredClone(journal),
              replace: async (runs) => {
                journal.splice(0, journal.length, ...structuredClone(runs))
              }
            }
          }
        : {}
    )
  }
  return {
    scope,
    provenance,
    interactions,
    continuations,
    schedule,
    providerSend,
    newOwner,
    addContinuationRun: () => {
      journal.push({
        ...journal[0],
        id: 'continuation-run',
        continuedFromRunId: 'original-run',
        requestId: 'tracked-continuation',
        startedAt: 2,
        completedAt: 2,
        status: 'completed'
      })
    },
    createApi,
    restart: () => {
      session = normalizeSessionFile(JSON.parse(JSON.stringify(session)))!
    },
    forkQuestionPrompt: () => {
      session.conversationGraph = forkEditedConversationMessage(
        session.conversationGraph!,
        promptMessageId,
        'new-branch',
        3
      )
    }
  }
}

const commandsFrom = (
  invoke: (channel: string, callerContext: CallerContext, args: unknown[]) => Promise<unknown>,
  settings = taskSettings
): ApplicationCommandByNameDispatcher => {
  const sessions = new Map<string, PersistedChatSession>()
  return {
    commandNames: () => [],
    invoke: async (channel, invocation) => {
      const args = [...invocation.args]
      if (channel === 'settings:get-settings') return settings
      if (channel === 'settings:bootstrap' && (args[0] as { action: string }).action === 'status')
        return {
          ok: true,
          next: { runtime: ['runtime', 'install', 'codex', '--json'], provider: ['codex', 'login'] }
        }
      try {
        const result = await invoke(channel, invocation.callerContext, args)
        if (channel === 'sessions:load-all') {
          for (const session of (result as { sessions?: PersistedChatSession[] })?.sessions ?? []) {
            sessions.set(session.id, structuredClone(session))
          }
        } else if (channel === 'sessions:save-session') {
          const saved = (result ?? args[0]) as PersistedChatSession
          sessions.set(saved.id, structuredClone(saved))
        }
        if (result !== undefined) return result
      } catch (error) {
        if (
          !channel.startsWith('sessions:') ||
          ![
            'sessions:load-one',
            'sessions:bind-task-session',
            'sessions:admit-task-turn',
            'sessions:stage-task-completion',
            'sessions:settle-task-completion',
            'sessions:fail-task-run'
          ].includes(channel) ||
          !(error instanceof Error && error.message.startsWith('Unexpected Task command:'))
        ) {
          throw error
        }
      }

      if (channel === 'sessions:bind-task-session') {
        const request = args[0] as Parameters<TaskSessionPort['bindSession']>[0]
        const current = structuredClone(sessions.get(request.session.id)!)
        const candidate = rebaseTaskSessionBinding(current, request)
        const result = await invoke('sessions:save-session', invocation.callerContext, [candidate])
        const saved = (result ?? candidate) as PersistedChatSession
        sessions.set(saved.id, structuredClone(saved))
        return saved
      }
      if (channel === 'sessions:load-one') {
        const request = args[0] as { projectId?: string; sessionId: string }
        let current = sessions.get(request.sessionId)
        if (!current) {
          const result = (await invoke('sessions:load-all', invocation.callerContext, [])) as {
            sessions?: PersistedChatSession[]
          }
          for (const session of result?.sessions ?? [])
            sessions.set(session.id, structuredClone(session))
          current = sessions.get(request.sessionId)
        }
        if (!current || (request.projectId && current.projectId !== request.projectId))
          return undefined
        return structuredClone(current)
      }
      if (channel === 'sessions:admit-task-turn') {
        const request = args[0] as Parameters<TaskSessionPort['admitTurn']>[0]
        const current = structuredClone(sessions.get(request.session.id)!)
        const candidate = rebaseTaskTurnOntoLatestSession(
          current,
          request.session,
          request.contextReset
        )
        const result = await invoke('sessions:save-session', invocation.callerContext, [candidate])
        const saved = (result ?? candidate) as PersistedChatSession
        sessions.set(saved.id, structuredClone(saved))
        return saved
      }
      if (channel === 'sessions:stage-task-completion') {
        const request = args[0] as Parameters<TaskSessionPort['stageCompletion']>[0]
        const current = structuredClone(sessions.get(request.sessionId)!)
        if (request.message) current.messages.push(request.message)
        current.activities = [...(current.activities ?? []), ...request.activities]
        if (request.clearPendingHistoryReplay) delete current.pendingHistoryReplay
        current.updatedAt = request.updatedAt
        sessions.set(current.id, current)
        return current
      }
      if (channel === 'sessions:settle-task-completion') {
        const request = args[0] as Parameters<TaskSessionPort['settleCompletion']>[0]
        const current = structuredClone(sessions.get(request.sessionId)!)
        current.status = 'idle'
        delete current.activeRun
        current.taskRunCommitId = request.taskRunCommitId
        current.artifacts = [...(current.artifacts ?? []), ...request.artifacts]
        sessions.set(current.id, current)
        return current
      }
      if (channel === 'sessions:fail-task-run') {
        const request = args[0] as Parameters<TaskSessionPort['failRun']>[0]
        const current = structuredClone(sessions.get(request.sessionId)!)
        current.status = 'error'
        current.error = request.error
        delete current.activeRun
        current.taskRunCommitId = request.taskRunCommitId
        sessions.set(current.id, current)
        return current
      }
      return undefined
    }
  }
}

const createComputePreferenceHarness = (
  existingSession?: PersistedChatSession
): {
  api: HeadlessTaskApi
  agent: TaskAgentMock
  durableSessions: Map<string, PersistedChatSession>
  registry: EnabledComputeHostsRegistry
  saveSession: MockedFunction<(session: PersistedChatSession) => Promise<void>>
} => {
  const durableSessions = new Map<string, PersistedChatSession>()
  if (existingSession) durableSessions.set(existingSession.id, structuredClone(existingSession))

  const saveSession = vi.fn(async (value: PersistedChatSession) => {
    durableSessions.set(value.id, structuredClone(value))
  })
  const ownerRef: { current?: SessionEnabledComputeHostsOwner } = {}
  const invoke = vi.fn(async (channel: string, _callerContext: CallerContext, args: unknown[]) => {
    if (channel === 'projects:list') return [project]
    if (channel === 'sessions:load-all') {
      return {
        sessions: [...durableSessions.values()].map((session) => structuredClone(session)),
        manifest: { version: 1 }
      }
    }
    if (channel === 'sessions:save-session') {
      const session = args[0] as PersistedChatSession
      if (!durableSessions.has(session.id)) {
        return ownerRef.current!.createSession(session, async (candidate) => {
          await saveSession(candidate)
          return candidate
        })
      }
      await saveSession(session)
      return session
    }
    throw new Error(`Unexpected Task command: ${channel}`)
  })
  const registry = new EnabledComputeHostsRegistry()
  const owner = new SessionEnabledComputeHostsOwner({
    registry,
    hostExists: async (providerId) => ['ssh:kept', 'ssh:alpha', 'ssh:beta'].includes(providerId),
    listHostIds: async () => ['ssh:kept', 'ssh:alpha', 'ssh:beta'],
    sessionAuthority: {
      sessionProjectId: async (sessionId) => durableSessions.get(sessionId)?.projectId,
      setSessionEnabledComputeHosts: async (projectId, sessionId, providerIds) => {
        const session = durableSessions.get(sessionId)
        if (!session || session.projectId !== projectId) {
          throw new Error(`Session not found: ${sessionId}`)
        }
        const committed = { ...session, enabledComputeHosts: [...providerIds] }
        durableSessions.set(sessionId, structuredClone(committed))
        return committed
      },
      mutateSessionComputeHostAccess: async (
        projectId: string,
        sessionId: string,
        mutation: SessionComputeHostAccessMutation
      ) => {
        const session = durableSessions.get(sessionId)
        if (!session || session.projectId !== projectId) {
          throw new Error(`Session not found: ${sessionId}`)
        }
        const access = transitionSessionComputeHostAccess(
          sessionComputeHostAccess(session),
          mutation
        )
        const committed = {
          ...session,
          enabledComputeHosts: [...access.enabledProviderIds],
          selectedComputeHosts: [...access.selectedProviderIds]
        }
        durableSessions.set(sessionId, structuredClone(committed))
        return committed
      },
      pruneSessionEnabledComputeHosts: async () => ({ sessions: [], previousSelections: [] })
    },
    withDataRootWrite: (operation) => operation()
  })
  ownerRef.current = owner
  if (existingSession) owner.project(existingSession)

  const agent = createAgent({
    createSession: vi.fn(async () => ({ sessionId: 'session-created', cwd: '/workspace' }))
  })
  let nextId = 0
  const api = new HeadlessTaskApi(
    { commands: commandsFrom(invoke), agent, computePreferences: owner },
    { createId: () => `task-id-${++nextId}`, now: () => 10 }
  )
  return { api, agent, durableSessions, registry, saveSession }
}

describe('HeadlessTaskApi adapter', () => {
  it('relays Notebook reviews on the original Run with exact language and task authority', async () => {
    const root = await mkdtemp(join(tmpdir(), 'task-notebook-reviews-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const journal = new FileTaskRunJournal(root)
    const repository = new NotebookRunRepository(root)
    const notebook = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: project.id,
      repository
    })
    const broker = new AcpPermissionBroker(() => {})
    notebook.setExecutionApproval(
      (request) => broker.requestAppApproval(request),
      (sessionId) => broker.pendingNotebookReviews(sessionId)
    )
    const sessionScope = { projectId: project.id, sessionId: 'session-created' }
    let session: PersistedChatSession | undefined
    let holdResponse: { entered: () => void; release: Promise<void> } | undefined
    const agent = createAgent({
      withSessionAvailable: async (_projectId, _sessionId, operation) => {
        if (holdResponse) {
          holdResponse.entered()
          await holdResponse.release
        }
        return operation()
      },
      getTaskPermissions: vi.fn((sessionId, promptMessageId) =>
        broker.getTaskPermissions(sessionId, promptMessageId, {
          projectId: project.id,
          messageBranchId: getActiveConversationContext(
            session!.conversationGraph!,
            promptMessageId
          ).messageBranchId!
        })
      ),
      respondTaskPermission: vi.fn((sessionId, promptMessageId, id, option, decision) =>
        broker.respondTaskPermission(sessionId, promptMessageId, id, option, decision, {
          projectId: project.id,
          messageBranchId: getActiveConversationContext(
            session!.conversationGraph!,
            promptMessageId
          ).messageBranchId!
        })
      ),
      prompt: vi.fn(async ({ promptMessageId, provenanceContext }, observer) => {
        observer?.onProviderPromptAccepted?.()
        const messageBranchId = provenanceContext!.messageBranchId!
        notebook.createExecutionIntent({ ...sessionScope, promptMessageId, messageBranchId })
        const provenance = { projectId: project.id, promptMessageId, messageBranchId }
        const bound = await broker.requestAppApproval({
          sessionId: sessionScope.sessionId,
          title: 'Confirm Notebook kernel and environment',
          rawInput: {
            notebookRuntimeSelection: {
              ...provenance,
              language: 'r',
              runtimeId: 'r-research',
              label: 'Research R',
              interpreterPath: '/runtime/bin/Rscript',
              ignored: 'not part of the review'
            }
          }
        })
        if (!bound) return
        const lane = createFrameNotebookLane(
          project.id,
          sessionScope.sessionId,
          provenanceContext!.agentFrameId!
        )
        await repository.loadOrCreate({ ...sessionScope, lane, workspaceCwd: root })
        const record = {
          runId: 'r-review-cell',
          cellId: 'cell-1',
          source: 'agent' as const,
          kernelKind: 'r' as const,
          script: 'write.csv(results, "study.csv")',
          startedAt: 10,
          promptMessageId,
          messageBranchId,
          text: { stdout: '', stderr: '', traceback: '', plain: [] },
          outputs: [],
          workingFiles: []
        }
        await repository.appendRun({ ...sessionScope, lane, run: { ...record, status: 'queued' } })
        const approved = await broker.requestAppApproval({
          sessionId: sessionScope.sessionId,
          title: 'Review potentially destructive code',
          rawInput: {
            code: record.script,
            notebookCodeRisk: {
              ...provenance,
              language: 'r',
              runId: record.runId,
              runtimeId: 'r-research',
              risks: [{ operation: 'overwrite file', source: record.script, line: 1 }]
            }
          }
        })
        await repository.updateRun({
          ...sessionScope,
          lane,
          run: { ...record, status: approved ? 'completed' : 'failed', kernelDispatched: approved }
        })
      })
    })
    const commands = commandsFrom(async (channel, _caller, args) => {
      if (channel === 'projects:list') return [project]
      if (channel === 'sessions:load-all') return { sessions: session ? [session] : [] }
      if (channel === 'sessions:save-session') {
        session = materializeSessionConversationGraph(args[0] as PersistedChatSession)
        return session
      }
      throw new Error(`Unexpected Task command: ${channel}`)
    })
    const api = new HeadlessTaskApi({ commands, agent, notebook }, { runJournal: journal })
    const server = await startWebHttpServer({
      host: '127.0.0.1',
      port: 0,
      token: 'test-token',
      staticRoot: root,
      applicationCommands: {
        localWeb: commands,
        remoteWeb: { ...commands, rejectedCommandNames: () => [] }
      },
      applicationEvents: new ApplicationEventHub(),
      bootstrap: {
        appName: 'Open-Science',
        appVersion: 'test',
        configRoot: root,
        platform: 'test',
        versions: { node: 'test' }
      },
      tasks: api
    })
    const send = (
      id: string,
      runId: string,
      input: unknown,
      headers: Record<string, string> = { authorization: 'Bearer test-token' }
    ): Promise<Response> =>
      fetch(
        `http://127.0.0.1:${server.port}/api/v1/interactions/${encodeURIComponent(id)}/permission?runId=${runId}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(input)
        }
      )
    const caller = createTaskCallerContext({ authenticatedLocalBearer: true })
    try {
      await api.runWithCallerContext(caller, async () => {
        const started = await api.startRun({ project: project.id, prompt: 'Run the R study.' })
        const scope = { runId: started.id }
        await expect
          .poll(() => api.getRun(started.id))
          .toMatchObject({
            status: 'running',
            execution: {
              reasonCode: 'notebook_runtime_review_required',
              language: 'r',
              kernelDispatched: false,
              next: { action: 'respond_permission' }
            },
            attention: {
              kind: 'interactions',
              interactions: [{ notebookReview: { kind: 'runtime' } }]
            }
          })
        const [runtime] = await api.listInteractions(scope)
        const info = await api.getInteraction(runtime.id, scope)
        expect(info).toMatchObject({
          recovery: 'original_run',
          owner: 'user',
          notebookReview: { kind: 'runtime', language: 'r' },
          request: {
            input: {
              runtimeId: 'r-research',
              label: 'Research R',
              interpreterPath: '/runtime/bin/Rscript'
            }
          }
        })
        expect(info).not.toHaveProperty('request.input.ignored')
        const answer = {
          expectedRevision: runtime.revision,
          expectedBranchId: runtime.branchId!,
          expectedLanguage: 'r',
          optionId: runtime.actions[0],
          source: 'user_relay'
        } as const
        expect(
          (
            await send(runtime.id, started.id, answer, {
              cookie: 'open_science_web_token=test-token'
            })
          ).status
        ).toBe(403)
        const wrongLanguage = await send(runtime.id, started.id, {
          ...answer,
          expectedLanguage: 'python'
        })
        expect(wrongLanguage.status).toBe(409)
        expect(await wrongLanguage.json()).toMatchObject({
          error: { code: 'interaction_revision_conflict' }
        })
        await expect(
          api.respondPermission(runtime.id, scope, { ...answer, expectedBranchId: 'stale' })
        ).rejects.toMatchObject({ code: 'interaction_revision_conflict' })
        await api.setRunInteractionMode(started.id, {
          expectedRevision: 0,
          interactionMode: 'delegate'
        })
        const entered = Promise.withResolvers<void>()
        const finish = Promise.withResolvers<void>()
        holdResponse = { entered: entered.resolve, release: finish.promise }
        const delegated = api.respondPermission(runtime.id, scope, {
          ...answer,
          source: 'delegated_agent',
          expectedModeRevision: 1
        })
        const rejected = expect(delegated).rejects.toMatchObject({
          code: 'task_delegation_required'
        })
        await entered.promise
        try {
          await api.setRunInteractionMode(started.id, {
            expectedRevision: 1,
            interactionMode: 'relay'
          })
        } finally {
          holdResponse = undefined
          finish.resolve()
        }
        await rejected
        expect((await send(runtime.id, started.id, answer)).status).toBe(200)
        await expect(api.respondPermission(runtime.id, scope, answer)).resolves.toMatchObject({
          changed: false
        })
        await expect
          .poll(() => api.getRun(started.id))
          .toMatchObject({
            status: 'running',
            execution: { reasonCode: 'notebook_code_review_required', kernelDispatched: false },
            attention: {
              kind: 'interactions',
              interactions: [{ notebookReview: { kind: 'code' } }]
            }
          })
        const [code] = await api.listInteractions(scope)
        await expect(api.getInteraction(code.id, scope)).resolves.toMatchObject({
          notebookReview: { kind: 'code', language: 'r' },
          request: {
            input: { runId: 'r-review-cell', risks: [{ operation: 'overwrite file', line: 1 }] }
          }
        })
        const declined = await send(code.id, started.id, { ...answer, optionId: code.actions[1] })
        expect(declined.status).toBe(200)
        expect(await declined.json()).toMatchObject({
          data: { changed: true, interaction: { response: { status: 'released' } } }
        })
        await expect(api.waitForRun(started.id)).resolves.toMatchObject({
          id: started.id,
          execution: { status: 'failed', language: 'r', kernelDispatched: false }
        })
        const restarted = new HeadlessTaskApi(
          { commands, agent: createAgent() },
          { runJournal: journal }
        )
        try {
          await restarted.initialize()
          await restarted.runWithCallerContext(caller, () =>
            expect(restarted.getInteraction(code.id, scope)).resolves.toMatchObject({
              state: 'responded',
              notebookReview: { kind: 'code', language: 'r' },
              response: { optionId: code.actions[1], source: 'user_relay', status: 'released' }
            })
          )
        } finally {
          await restarted.dispose()
        }
      })
    } finally {
      broker.cancelAllPending()
      await server.close()
      await api.dispose()
      await notebook.dispose()
    }
  })

  it('does not report successful Notebook execution from a completed Run or a historical cell', async () => {
    const root = await mkdtemp(join(tmpdir(), 'task-notebook-observation-'))
    const repository = new NotebookRunRepository(root)
    const notebook = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: project.id,
      repository
    })
    const commands = commandsFrom(async (channel, _caller, args) => {
      if (channel === 'projects:list') return [project]
      if (channel === 'sessions:load-all') return { sessions: [] }
      if (channel === 'sessions:save-session') return args[0]
      throw new Error(`Unexpected Task command: ${channel}`)
    })
    const owner = { projectId: project.id, sessionId: 'session-created' }
    const lane = createFrameNotebookLane(
      owner.projectId,
      owner.sessionId,
      'root-frame-session-created'
    )
    const agent = createAgent({
      prompt: vi.fn(async ({ promptMessageId }) => {
        const evidence = {
          cellId: 'cell-1',
          source: 'agent' as const,
          kernelKind: 'python' as const,
          script: 'print(42)',
          text: { stdout: '', stderr: '', traceback: '', plain: [] },
          outputs: [],
          workingFiles: []
        }
        await repository.loadOrCreate({ ...owner, lane, workspaceCwd: root })
        await repository.appendRun({
          ...owner,
          lane,
          run: {
            ...evidence,
            runId: 'notebook-unrelated',
            status: 'completed',
            kernelDispatched: true,
            startedAt: 3,
            promptMessageId: 'user-other'
          }
        })
        await repository.appendRun({
          ...owner,
          lane,
          run: {
            ...evidence,
            runId: 'notebook-current',
            status: 'failed',
            kernelDispatched: false,
            startedAt: 2,
            promptMessageId,
            messageBranchId: 'branch-current'
          }
        })
      })
    })
    const api = new HeadlessTaskApi({ commands, agent, notebook })
    try {
      const run = await api.startRun({ project: project.id, prompt: 'Compute the result.' })
      const expected = {
        status: 'completed',
        execution: {
          status: 'failed',
          notebookRunId: 'notebook-current',
          kernelDispatched: false,
          reasonCode: 'notebook_pre_dispatch_failed',
          messageBranchId: 'branch-current',
          ...owner
        }
      }
      const finished = await api.waitForRun(run.id)
      expect(finished.error).toBeUndefined()
      expect(finished).toMatchObject(expected)
      await expect(api.getRun(run.id)).resolves.toMatchObject(expected)
    } finally {
      await api.dispose()
      await notebook.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('relays a current Notebook stop once and recovers its continuation after a service restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'task-notebook-continuation-'))
    const journal = new FileTaskRunJournal(root)
    const promptMessageId = 'stopped-prompt'
    let session = materializeSessionConversationGraph({
      id: 'stopped-session',
      projectId: project.id,
      cwd: root,
      title: 'Notebook continuation',
      status: 'idle',
      createdAt: 1,
      updatedAt: 2,
      messages: [
        {
          id: promptMessageId,
          role: 'user',
          content: 'Analyze the inputs.',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })
    const scope = { projectId: project.id, sessionId: session.id }
    const branchId = session.conversationGraph.frames[0]!.activeBranchId
    const originalRun = {
      id: 'stopped-run',
      ...scope,
      cwd: root,
      startedAt: 1,
      completedAt: 2,
      status: 'completed',
      interactionPolicy: { mode: 'delegate', revision: 1 },
      promptMessageId,
      artifacts: [],
      preferredComputeHostIds: []
    } as const
    const makeNotebook = (): NotebookRuntimeService =>
      new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: project.id
      })
    const notebook = makeNotebook()
    const intent = notebook.createExecutionIntent({
      ...scope,
      messageBranchId: branchId,
      promptMessageId
    })
    notebook.rememberExecutionIntent(scope, promptMessageId, intent)
    const refusalId = intent.block('pressured')
    const caller = createTaskCallerContext({ authenticatedLocalBearer: true })
    const agent = createAgent({
      prompt: vi.fn(async (request, observer) => {
        const context = await observer?.onPromptAdmitted?.()
        if (request.notebookContinuation) {
          intent.claimContinuation()
          notebook.createExecutionIntent({
            ...scope,
            messageBranchId: context?.messageBranchId,
            promptMessageId: request.promptMessageId,
            continuedFromRefusalId: request.notebookContinuation.refusalId
          })
        }
        observer?.onProviderPromptAccepted?.()
      })
    })
    const commands = commandsFrom(async (channel, _callerContext, args) => {
      if (channel === 'projects:list') return [project]
      if (channel === 'sessions:load-all') return { sessions: [session] }
      if (channel === 'sessions:save-session') {
        session = materializeSessionConversationGraph(args[0] as PersistedChatSession)
        return session
      }
      throw new Error(`Unexpected Task command: ${channel}`)
    })
    const makeApi = (notebook: NotebookRuntimeService): HeadlessTaskApi =>
      new HeadlessTaskApi(
        { commands, agent, notebook },
        { runJournal: journal, submissionRoot: root }
      )
    const api = makeApi(notebook)
    const startServer = (tasks: HeadlessTaskApi): ReturnType<typeof startWebHttpServer> =>
      startWebHttpServer({
        host: '127.0.0.1',
        port: 0,
        token: 'test-token',
        staticRoot: root,
        applicationCommands: {
          localWeb: commands,
          remoteWeb: { ...commands, rejectedCommandNames: () => [] }
        },
        applicationEvents: new ApplicationEventHub(),
        bootstrap: {
          appName: 'Open-Science',
          appVersion: 'test',
          configRoot: root,
          platform: 'test',
          versions: { node: 'test' }
        },
        tasks
      })
    const request: TaskNotebookContinuationRequest = {
      runId: originalRun.id,
      branchId,
      refusalId,
      source: 'user_relay',
      prompt: 'Continue this analysis.'
    }
    const server = await startServer(api)
    const send = (
      port: number,
      requestId: string,
      body: unknown,
      headers: Record<string, string> = {
        authorization: 'Bearer test-token'
      }
    ): Promise<Response> =>
      fetch(`http://127.0.0.1:${port}/api/v1/notebook-continuations/${requestId}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body)
      })
    try {
      await journal.replace([{ ...originalRun, artifacts: [], preferredComputeHostIds: [] }])
      await api.initialize()
      const base = `http://127.0.0.1:${server.port}`
      const cookie = { cookie: 'open_science_web_token=test-token' }
      const bootstrap = async (
        headers: Record<string, string>
      ): Promise<{ taskCapabilities: string[] }> =>
        fetch(`${base}/api/bootstrap`, { headers }).then((response) => response.json())
      expect((await bootstrap({ authorization: 'Bearer test-token' })).taskCapabilities).toContain(
        'notebook-continuation'
      )
      expect((await bootstrap(cookie)).taskCapabilities).not.toContain('notebook-continuation')
      expect((await send(server.port, 'browser', request, cookie)).status).toBe(403)
      expect(
        (await send(server.port, 'invalid-source', { ...request, source: 'delegated_agent' }))
          .status
      ).toBe(400)
      await expect(api.continueNotebook('wrong-caller', request)).rejects.toMatchObject({
        code: 'task_relay_required'
      })
      await api.runWithCallerContext(caller, async () => {
        const runScope = { runId: originalRun.id }
        const interactionId = `notebook-continuation:${refusalId}`
        await expect(api.listInteractions(runScope)).resolves.toMatchObject([
          {
            id: interactionId,
            kind: 'notebook-continuation',
            branchId,
            state: 'pending',
            responseCapability: 'continue_notebook'
          }
        ])
        await expect(api.getInteraction(interactionId, runScope)).resolves.toMatchObject({
          refusalId,
          reason: 'pressured'
        })
        await expect(api.getRun(originalRun.id)).resolves.toMatchObject({
          execution: { refusalId, next: { action: 'continue_notebook' } }
        })
        await expect(
          api.continueNotebook('wrong-branch', { ...request, branchId: 'old-branch' })
        ).resolves.toMatchObject({ status: 'pending' })
        await vi.waitFor(async () => {
          await expect(api.getSubmission('wrong-branch')).resolves.toMatchObject({
            status: 'failed',
            error: { code: 'notebook_continuation_expired' }
          })
        })
        expect(agent.prompt).not.toHaveBeenCalled()
        expect(intent.hasClaimedContinuation).toBe(false)

        const accepted = await send(server.port, 'continue-once', request)
        expect(accepted.status).toBe(202)
        expect(await accepted.json()).toMatchObject({ data: { status: 'pending' } })
        await vi.waitFor(async () => {
          await expect(api.getSubmission('continue-once')).resolves.toMatchObject({
            status: 'accepted'
          })
        })
        const receipt = await api.getSubmission('continue-once')
        expect(receipt).toMatchObject({
          notebookContinuation: { ...runScope, refusalId, branchId, source: 'user_relay' }
        })
        await expect(api.waitForRun(receipt.runId!)).resolves.toMatchObject({
          ...scope,
          status: 'completed',
          continuedFromRunId: originalRun.id,
          interactionPolicy: { mode: 'delegate', revision: 1 }
        })
        expect(intent.hasClaimedContinuation).toBe(true)
        await expect(
          api.setRunInteractionMode(originalRun.id, {
            interactionMode: 'relay',
            expectedRevision: 1
          })
        ).resolves.toEqual({ mode: 'relay', revision: 2 })
        await expect(api.getRun(receipt.runId!)).resolves.toMatchObject({
          interactionPolicy: { mode: 'relay', revision: 2 },
          execution: { continuedFromRefusalId: refusalId }
        })
        await expect(api.continueNotebook('continue-once', request)).resolves.toEqual(receipt)
        await expect(
          api.continueNotebook('continue-once', { ...request, prompt: 'Another prompt' })
        ).rejects.toMatchObject({ code: 'submission_conflict' })
        expect(agent.prompt).toHaveBeenCalledTimes(1)
        await expect(api.getRun(originalRun.id)).resolves.toMatchObject({
          status: originalRun.status,
          continuations: [
            { runId: receipt.runId, requestId: 'continue-once', status: 'completed' }
          ],
          execution: { status: 'failed', refusalId }
        })
        notebook.bindExecutionIntent(scope, intent)
        await expect(api.getInteraction(interactionId, runScope)).rejects.toMatchObject({
          code: 'notebook_continuation_expired'
        })
        await api.continueNotebook('retry-consumed', request)
        await vi.waitFor(async () => {
          await expect(api.getSubmission('retry-consumed')).resolves.toMatchObject({
            status: 'failed',
            error: { code: 'notebook_continuation_expired' }
          })
        })
        expect(agent.prompt).toHaveBeenCalledTimes(1)
      })
      await api.dispose()
      const restartedNotebook = makeNotebook()
      const restarted = makeApi(restartedNotebook)
      const restartedServer = await startServer(restarted)
      try {
        await restarted.initialize()
        await restarted.runWithCallerContext(caller, async () => {
          const receipt = await restarted.getSubmission('continue-once')
          expect(receipt).toMatchObject({ status: 'accepted', notebookContinuation: { refusalId } })
          await expect(restarted.getRun(receipt.runId!)).resolves.toMatchObject({
            continuedFromRunId: originalRun.id,
            interactionPolicy: { mode: 'relay', revision: 2 }
          })
          const repeated = await send(restartedServer.port, 'continue-once', request)
          expect(repeated.status).toBe(202)
          expect(await repeated.json()).toEqual({ data: receipt })
          await restarted.continueNotebook('retry-expired', request)
          await vi.waitFor(async () => {
            await expect(restarted.getSubmission('retry-expired')).resolves.toMatchObject({
              status: 'failed',
              error: { code: 'notebook_continuation_expired' }
            })
          })
          expect(agent.prompt).toHaveBeenCalledTimes(1)
        })
      } finally {
        await restartedServer.close()
        await restarted.dispose()
        await restartedNotebook.dispose()
      }
    } finally {
      await server.close()
      await api.dispose()
      await notebook.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('observes the current Session prompt even when it inherits an earlier Notebook intent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'task-session-notebook-'))
    const repository = new NotebookRunRepository(root)
    const notebook = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: project.id,
      repository
    })
    const owner = { projectId: project.id, sessionId: 'session-1' }
    const prompt = (id: string): PersistedChatMessage => ({
      id,
      role: 'user',
      content: id,
      status: 'complete',
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    })
    let session = materializeSessionConversationGraph({
      id: owner.sessionId,
      projectId: owner.projectId,
      title: 'Notebook research',
      cwd: root,
      status: 'idle',
      messages: [prompt('original')],
      createdAt: 1,
      updatedAt: 1
    })
    const frame = session.conversationGraph.frames[0]!
    const lane = createFrameNotebookLane(owner.projectId, owner.sessionId, frame.id)
    const scope = { ...owner, messageBranchId: frame.activeBranchId }
    const imported = materializeSessionConversationGraph({
      ...session,
      id: 'imported-session',
      conversationGraph: undefined,
      packageOrigin: {
        importId: 'import-1',
        sourceProjectId: owner.projectId,
        sourceSessionId: owner.sessionId,
        importedAt: 1,
        manifestChecksum: 'checksum',
        excludedFiles: []
      }
    })
    const appendCompletedRun = (promptMessageId: string): Promise<unknown> =>
      repository.appendRun({
        ...owner,
        lane,
        run: {
          runId: `notebook-${promptMessageId}`,
          cellId: 'cell-1',
          source: 'agent',
          kernelKind: 'python',
          script: 'print(42)',
          status: 'completed',
          kernelDispatched: true,
          startedAt: 1,
          messageBranchId: scope.messageBranchId,
          promptMessageId,
          text: { stdout: '', stderr: '', traceback: '', plain: [] },
          outputs: [],
          workingFiles: []
        }
      })
    const api = new HeadlessTaskApi({
      commands: commandsFrom(async (channel, _callerContext, args) => {
        if (channel === 'sessions:load-all') return { sessions: [session, imported] }
        if (channel === 'sessions:load-one') {
          const request = args[0] as { sessionId: string }
          return structuredClone(request.sessionId === imported.id ? imported : session)
        }
        throw new Error(`Unexpected Task command: ${channel}`)
      }),
      agent: createAgent(),
      notebook
    })
    const inspect = async (): Promise<TaskNotebookExecution | undefined> =>
      (await api.getSession(owner.sessionId, owner.projectId)).execution
    try {
      await repository.loadOrCreate({ ...owner, lane, workspaceCwd: root })
      const original = notebook.createExecutionIntent({ ...scope, promptMessageId: 'original' })
      await appendCompletedRun('original')
      await expect(inspect()).resolves.toMatchObject({
        status: 'completed',
        language: 'python',
        notebookRunId: 'notebook-original',
        kernelDispatched: true
      })

      notebook.rememberExecutionIntent(scope, 'follow-up', original)
      session = materializeSessionConversationGraph({
        ...session,
        status: 'running',
        activeRun: { promptMessageId: 'follow-up', startedAt: 2 },
        messages: [...session.messages, prompt('follow-up')]
      })
      const unconfirmed = {
        ...scope,
        promptMessageId: 'follow-up',
        status: 'unconfirmed',
        reasonCode: 'notebook_evidence_unavailable'
      }
      await expect(inspect()).resolves.toEqual(unconfirmed)
      session = { ...session, status: 'idle', activeRun: undefined }
      await expect(inspect()).resolves.toEqual(unconfirmed)

      const refusalId = original.block('memory-pressure')
      const waiting = {
        status: 'waiting_for_user',
        requiresUser: true,
        refusalId,
        next: { action: 'continue_notebook_in_app' }
      }
      await expect(inspect()).resolves.toMatchObject({ ...waiting, promptMessageId: 'follow-up' })
      session = materializeSessionConversationGraph({
        ...session,
        messages: [...session.messages, prompt('not-yet-bound')]
      })
      await expect(inspect()).resolves.toMatchObject({
        ...waiting,
        ...scope,
        promptMessageId: 'original'
      })
      await expect(api.getSession(imported.id)).resolves.toMatchObject({
        readOnly: true,
        packageOrigin: { importId: 'import-1' },
        execution: { status: 'unconfirmed', sessionId: imported.id }
      })

      notebook.createExecutionIntent({
        ...scope,
        promptMessageId: 'continued',
        continuedFromRefusalId: refusalId
      })
      session = materializeSessionConversationGraph({
        ...session,
        messages: [...session.messages, prompt('continued')]
      })
      await expect(inspect()).resolves.toEqual({
        ...unconfirmed,
        promptMessageId: 'continued',
        continuedFromRefusalId: refusalId
      })
      await appendCompletedRun('continued')
      await expect(inspect()).resolves.toMatchObject({
        promptMessageId: 'continued',
        continuedFromRefusalId: refusalId,
        status: 'completed',
        notebookRunId: 'notebook-continued',
        kernelDispatched: true
      })
    } finally {
      await api.dispose()
      await notebook.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('projects the registered Agent runtimes without exposing executable paths', async () => {
    const settings = {
      ...taskSettings,
      claude: { resolvedPath: '/private/claude', version: '2.1.0' },
      opencode: { resolvedPath: '/private/opencode', version: '1.0.200' },
      codex: { resolvedPath: '/private/codex-acp', version: '1.6.2', nativeVersion: '0.145.0' },
      claudeManaged: true,
      codexManaged: true,
      agentFrameworkId: 'codex',
      agentFrameworks: [
        { id: 'claude-code', displayName: 'Claude Code' },
        { id: 'opencode', displayName: 'OpenCode' },
        { id: 'codex', displayName: 'Codex' },
        { id: 'codebuddy', displayName: 'CodeBuddy' }
      ]
    }
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'settings:get-preflight') {
        return {
          claudeReady: true,
          opencodeReady: false,
          codebuddyReady: false,
          codexReady: true,
          agentFrameworkId: 'codex',
          agentReady: true,
          activeProviderReady: true,
          runtimeReadiness: { status: 'ready' },
          providerReadiness: { status: 'ready' }
        }
      }
      throw new Error(`Unexpected Task command: ${channel}`)
    })
    const api = new HeadlessTaskApi({
      commands: commandsFrom(invoke, settings),
      agent: createAgent()
    })

    await expect(api.listRuntimes()).resolves.toEqual([
      { framework: 'claude-code', status: 'ready', version: '2.1.0', source: 'managed' },
      { framework: 'opencode', status: 'not_ready', version: '1.0.200', source: 'external' },
      { framework: 'codex', status: 'ready', version: '0.145.0', source: 'external' },
      { framework: 'codebuddy', status: 'missing' }
    ])
    expect(JSON.stringify(await api.listRuntimes())).not.toContain('/private/')
  })

  it('projects read-only readiness checks and stable next-action codes', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'settings:get-preflight') {
        return {
          claudeReady: true,
          opencodeReady: true,
          codebuddyReady: true,
          codexReady: false,
          agentFrameworkId: 'codex',
          agentReady: false,
          activeProviderReady: false,
          runtimeReadiness: { status: 'missing' },
          providerReadiness: { status: 'missing' }
        }
      }
      if (channel === 'settings:list-skills') {
        return [
          {
            id: 'writing',
            name: 'writing',
            displayName: 'Writing',
            description: 'Write reports.',
            source: 'featured',
            updatedAt: '2026-01-01T00:00:00.000Z',
            enabled: true
          },
          {
            id: 'literature-review',
            name: 'literature-review',
            displayName: 'Literature Review',
            description: 'Review literature.',
            source: 'featured',
            updatedAt: '2026-01-01T00:00:00.000Z',
            enabled: true,
            available: true
          },
          {
            id: 'unavailable',
            name: 'unavailable',
            displayName: 'Unavailable',
            description: 'Unavailable skill.',
            source: 'personal',
            updatedAt: '2026-01-01T00:00:00.000Z',
            enabled: true,
            available: false,
            availability: 'identity-conflict'
          }
        ]
      }
      throw new Error(`Unexpected Task command: ${channel}`)
    })
    const api = new HeadlessTaskApi({ commands: commandsFrom(invoke), agent: createAgent() })

    await expect(api.doctor()).resolves.toEqual({
      ready: false,
      checks: {
        daemon: { status: 'ready' },
        runtime: { status: 'missing', framework: 'codex' },
        provider: { status: 'missing' },
        skills: { status: 'ready', enabled: ['literature-review', 'writing'] }
      },
      next: [
        { code: 'runtime_missing', argv: ['runtime', 'install', 'codex', '--json'] },
        { code: 'provider_missing', argv: ['codex', 'login'] }
      ]
    })
  })

  it('distinguishes configured but unusable runtime and provider state', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'settings:get-preflight') {
        return {
          claudeReady: false,
          opencodeReady: false,
          codebuddyReady: false,
          codexReady: false,
          agentFrameworkId: 'codex',
          agentReady: false,
          activeProviderReady: false,
          runtimeReadiness: { status: 'not_ready' },
          providerReadiness: { status: 'not_ready', reason: 'credential_invalid' }
        }
      }
      if (channel === 'settings:list-skills') return []
      throw new Error(`Unexpected Task command: ${channel}`)
    })
    const api = new HeadlessTaskApi({ commands: commandsFrom(invoke), agent: createAgent() })

    await expect(api.doctor()).resolves.toEqual({
      ready: false,
      checks: {
        daemon: { status: 'ready' },
        runtime: { status: 'not_ready', framework: 'codex' },
        provider: { status: 'not_ready', reason: 'credential_invalid' },
        skills: { status: 'ready', enabled: [] }
      },
      next: [
        { code: 'runtime_not_ready', argv: ['runtime', 'install', 'codex', '--json'] },
        { code: 'provider_not_ready', argv: ['codex', 'login'] }
      ]
    })
  })

  it('reports ongoing Notebook provisioning and memory pressure without starting work', async () => {
    let recovering = false
    const invoke = vi.fn(async (channel: string) => {
      switch (channel) {
        case 'settings:get-preflight':
          return {
            agentFrameworkId: 'codex',
            runtimeReadiness: { status: 'ready' },
            providerReadiness: { status: 'ready' }
          }
        case 'settings:list-skills':
          return []
        case 'notebook-env:status':
          return { pythonReady: false, rReady: false, provisioning: true }
        case 'settings:get-notebook-network-status':
          return { kind: 'ready', warnings: [] }
        case 'notebook:memory-policy-state':
          return {
            status: 'pressured',
            ...(recovering
              ? { reason: 'mac-memory-recovering', recoveryRemainingMs: 18_000 }
              : { reason: 'mac-memory-warning' }),
            source: 'darwin-sysctl-dispatch',
            executionScope: 'darwin:host',
            detail: 'internal memory diagnostics'
          }
        default:
          throw new Error(`Unexpected Task command: ${channel}`)
      }
    })
    const api = new HeadlessTaskApi({ commands: commandsFrom(invoke), agent: createAgent() })

    const report = await api.doctor()
    expect(report).toMatchObject({
      ready: true,
      checks: {
        notebook: {
          environment: { status: 'checking', reason: 'notebook_environment_preparing' },
          memoryPolicy: {
            status: 'blocked',
            reason: 'notebook_memory_pressure',
            source: 'darwin-sysctl-dispatch',
            executionScope: 'darwin:host'
          }
        }
      }
    })
    expect(JSON.stringify(report)).not.toContain('internal memory diagnostics')
    expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('notebook-env:provision')

    recovering = true
    await expect(api.doctor()).resolves.toMatchObject({
      checks: {
        notebook: {
          memoryPolicy: { status: 'checking', reason: 'notebook_memory_recovering' }
        }
      }
    })
  })

  it('returns available readiness evidence when an Owner cannot answer in time', async () => {
    vi.useFakeTimers()
    try {
      const commands = commandsFrom(async (channel) => {
        switch (channel) {
          case 'settings:get-preflight':
            return {
              agentFrameworkId: 'codex',
              runtimeReadiness: { status: 'ready' },
              providerReadiness: { status: 'ready' }
            }
          case 'settings:list-skills':
            return []
          case 'notebook-env:status':
            return new Promise(() => undefined)
          case 'notebook:memory-policy-state':
            return {
              status: 'unavailable',
              diagnostic: 'linux-cgroup-visibility',
              source: 'linux',
              executionScope: 'default'
            }
          default:
            throw new Error('Unavailable')
        }
      })
      const api = new HeadlessTaskApi({ commands, agent: createAgent() })
      const report = api.doctor()
      await vi.advanceTimersByTimeAsync(6_000)
      await expect(report).resolves.toMatchObject({
        ready: true,
        checks: {
          notebook: {
            environment: { status: 'unconfirmed', reason: 'notebook_evidence_unavailable' },
            memoryPolicy: {
              status: 'blocked',
              reason: 'notebook_linux_cgroup_unavailable',
              source: 'linux',
              executionScope: 'default'
            }
          }
        }
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('routes Project Session defaults through the Task-only persistence command', async () => {
    const invoke = vi.fn(
      async (channel: string, _callerContext: CallerContext, args: unknown[]) => {
        if (channel === 'projects:list') return [project]
        if (channel === 'projects:update-session-defaults') {
          return { ...project, ...(args[0] as object), updatedAt: 2 }
        }
        throw new Error(`Unexpected Task command: ${channel}`)
      }
    )
    const api = new HeadlessTaskApi({ commands: commandsFrom(invoke), agent: createAgent() })

    await api.updateProjectSessionDefaults(project.id, {
      expectedUpdatedAt: project.updatedAt,
      patch: { memoryEnabled: false }
    })

    expect(invoke).toHaveBeenCalledWith('projects:update-session-defaults', taskCallerContext(), [
      {
        id: project.id,
        expectedUpdatedAt: project.updatedAt,
        sessionDefaults: { memoryEnabled: false }
      }
    ])
  })

  it('routes Session configuration updates through the Task-only atomic command', async () => {
    const existing: PersistedChatSession = {
      id: 'session-config',
      projectId: project.id,
      title: 'Configurable Session',
      cwd: '/workspace',
      status: 'idle',
      revision: 4,
      messages: [],
      createdAt: 1,
      updatedAt: 1
    }
    let durable = existing
    const invoke = vi.fn(
      async (channel: string, _callerContext: CallerContext, args: unknown[]) => {
        if (channel === 'sessions:load-all') {
          return { sessions: [durable], manifest: { version: 1 } }
        }
        if (channel === 'sessions:load-one') return structuredClone(durable)
        if (channel === 'sessions:update-configuration') {
          durable = { ...(args[0] as PersistedChatSession), revision: 5 }
          return durable
        }
        throw new Error(`Unexpected Task command: ${channel}`)
      }
    )
    const api = new HeadlessTaskApi({ commands: commandsFrom(invoke), agent: createAgent() })

    await expect(
      api.updateSessionConfiguration(existing.id, {
        expectedRevision: 4,
        memoryEnabled: false,
        delegationPolicy: 'deny'
      })
    ).resolves.toMatchObject({
      revision: 5,
      persisted: { memoryEnabled: false, delegationPolicy: 'deny' }
    })
    expect(invoke).toHaveBeenCalledWith('sessions:update-configuration', taskCallerContext(), [
      expect.objectContaining({
        id: existing.id,
        memoryEnabled: false,
        delegationPolicy: 'deny'
      }),
      4
    ])
  })

  it('creates a new Session when persistence and Task share one Compute preference owner', async () => {
    const durableSessions = new Map<string, PersistedChatSession>()
    const registry = new EnabledComputeHostsRegistry()
    let newSessionSaveEntries = 0
    let durableCommitCalls = 0
    const ownerRef: { current?: SessionEnabledComputeHostsOwner } = {}
    const invoke = vi.fn(
      async (channel: string, _callerContext: CallerContext, args: unknown[]) => {
        if (channel === 'projects:list') return [project]
        if (channel === 'sessions:load-all') {
          return { sessions: [...durableSessions.values()], manifest: { version: 1 } }
        }
        if (channel === 'sessions:save-session') {
          const session = args[0] as PersistedChatSession
          if (!durableSessions.has(session.id)) newSessionSaveEntries += 1
          const durable = durableSessions.has(session.id)
            ? session
            : await ownerRef.current!.createSession(session, async (candidate) => {
                durableCommitCalls += 1
                durableSessions.set(candidate.id, structuredClone(candidate))
                return candidate
              })
          durableSessions.set(durable.id, structuredClone(durable))
          return durable
        }
        throw new Error(`Unexpected Task command: ${channel}`)
      }
    )
    const owner = new SessionEnabledComputeHostsOwner({
      registry,
      hostExists: async (providerId) => providerId === 'ssh:alpha',
      listHostIds: async () => ['ssh:alpha'],
      sessionAuthority: {
        sessionProjectId: async (sessionId) => durableSessions.get(sessionId)?.projectId,
        setSessionEnabledComputeHosts: async () => {
          throw new Error('Unexpected existing Session update.')
        },
        pruneSessionEnabledComputeHosts: async () => ({ sessions: [], previousSelections: [] })
      },
      withDataRootWrite: (operation) => operation()
    })
    ownerRef.current = owner
    const api = new HeadlessTaskApi(
      {
        commands: commandsFrom(invoke),
        agent: createAgent({
          createSession: vi.fn(async () => ({ sessionId: 'session-created', cwd: '/workspace' }))
        }),
        computePreferences: owner
      },
      { createId: () => 'task-id', now: () => 10 }
    )

    const outcome = await api.startRun({
      project: project.id,
      prompt: 'Research this.',
      computeHostIds: ['ssh:alpha']
    })

    expect(outcome).toMatchObject({ sessionId: 'session-created' })
    expect(newSessionSaveEntries).toBe(1)
    expect(durableCommitCalls).toBe(1)
    expect(durableSessions.get('session-created')?.enabledComputeHosts).toEqual(['ssh:alpha'])
    expect(durableSessions.get('session-created')?.selectedComputeHosts).toEqual(['ssh:alpha'])
    expect(registry.getEnabled('session-created')).toEqual(['ssh:alpha'])
    expect(registry.getSelected('session-created')).toEqual(['ssh:alpha'])
    await api.dispose()
  }, 1_000)

  it('keeps the selected Compute Host visible to five Sessions initialized concurrently', async () => {
    const concurrency = 5
    const durableSessions = new Map<string, PersistedChatSession>()
    const registry = new EnabledComputeHostsRegistry()
    const ownerRef: { current?: SessionEnabledComputeHostsOwner } = {}
    const creationIndexBySessionId = new Map<string, number>()

    const invoke = vi.fn(
      async (channel: string, _callerContext: CallerContext, args: unknown[]) => {
        if (channel === 'projects:list') return [project]
        if (channel === 'sessions:load-all') {
          return ownerRef.current!.hydrateFromSessionCatalog(async () => ({
            sessions: [...durableSessions.values()].map((session) => structuredClone(session)),
            manifest: { version: 1 as const },
            diagnostics: {
              isComplete: true,
              warnings: [],
              isProjectDeletionRecoveryComplete: true
            }
          }))
        }
        if (channel === 'sessions:save-session') {
          const session = args[0] as PersistedChatSession
          const sessionIndex = creationIndexBySessionId.get(session.id)
          if (sessionIndex === undefined) throw new Error(`Unknown Session: ${session.id}`)
          const committed = await ownerRef.current!.createSession(session, async (candidate) => {
            durableSessions.set(candidate.id, structuredClone(candidate))
            return candidate
          })
          return committed
        }
        throw new Error(`Unexpected Task command: ${channel}`)
      }
    )
    const owner = new SessionEnabledComputeHostsOwner({
      registry,
      hostExists: async (providerId) => providerId === 'ssh:alpha',
      listHostIds: async () => ['ssh:alpha'],
      sessionAuthority: {
        sessionProjectId: async (sessionId) => durableSessions.get(sessionId)?.projectId,
        setSessionEnabledComputeHosts: async () => {
          throw new Error('Unexpected existing Session update.')
        },
        mutateSessionComputeHostAccess: async () => {
          throw new Error('Unexpected existing Session mutation.')
        },
        pruneSessionEnabledComputeHosts: async () => ({ sessions: [], previousSelections: [] })
      },
      withDataRootWrite: (operation) => operation()
    })
    ownerRef.current = owner
    const compute = attachEnabledComputeHosts({}, registry)
    const allPromptsEntered = Promise.withResolvers<void>()
    let promptCount = 0
    const visibleHosts = new Map<string, string[]>()
    let nextSessionId = 0
    const agent = createAgent({
      createSession: vi.fn(async () => {
        const creationIndex = nextSessionId++
        const sessionId = `session-${creationIndex + 1}`
        creationIndexBySessionId.set(sessionId, creationIndex)
        return { sessionId, cwd: '/workspace' }
      }),
      prompt: vi.fn(async ({ sessionId }) => {
        promptCount += 1
        if (promptCount === concurrency) allPromptsEntered.resolve()
        await allPromptsEntered.promise
        visibleHosts.set(sessionId, compute.getSelectedComputeHosts(sessionId))
      })
    })
    let nextId = 0
    const api = new HeadlessTaskApi(
      { commands: commandsFrom(invoke), agent, computePreferences: owner },
      { createId: () => `task-id-${++nextId}`, now: () => 10 }
    )

    const started = await Promise.all(
      Array.from({ length: concurrency }, (_, index) =>
        api.startRun({
          project: project.id,
          prompt: `Research stream ${index + 1}.`,
          computeHostIds: ['ssh:alpha']
        })
      )
    )
    await Promise.all(started.map(({ id }) => api.waitForRun(id)))
    await api.dispose()

    expect({
      durable: started.map(({ sessionId }) => {
        const persisted = durableSessions.get(sessionId)
        return {
          enabledComputeHosts: persisted?.enabledComputeHosts,
          selectedComputeHosts: persisted?.selectedComputeHosts
        }
      }),
      runtime: started.map(({ sessionId }) => visibleHosts.get(sessionId))
    }).toEqual({
      durable: Array.from({ length: concurrency }, () => ({
        enabledComputeHosts: ['ssh:alpha'],
        selectedComputeHosts: ['ssh:alpha']
      })),
      runtime: Array.from({ length: concurrency }, () => ['ssh:alpha'])
    })
  })

  it('dispatches façade operations through the narrow Task command view', async () => {
    const commandInvoke = vi.fn(async () => [
      { ...project, agentContext: 'Do not expose this instruction.' }
    ])
    const api = new HeadlessTaskApi({
      commands: {
        commandNames: () => ['projects:list'],
        invoke: commandInvoke
      },
      agent: createAgent()
    })

    const projects = await api.listProjects()
    expect(projects).toEqual([{ ...project, hasAgentContext: true }])
    expect(JSON.stringify(projects)).not.toContain('Do not expose this instruction.')
    expect(commandInvoke).toHaveBeenCalledWith(
      'projects:list',
      expect.objectContaining({
        callerContext: taskCallerContext(),
        callerLease: expect.objectContaining({ leaseId: 'headless-task-api' }),
        args: []
      })
    )
  })

  it.each([
    { label: 'omits an unspecified preference', request: {}, expected: [] },
    {
      label: 'commits an explicit empty preference',
      request: { computeHostIds: [] },
      expected: []
    },
    {
      label: 'deduplicates a replacement in first-occurrence order',
      request: { computeHostIds: ['ssh:beta', 'ssh:alpha', 'ssh:beta'] },
      expected: ['ssh:beta', 'ssh:alpha']
    }
  ])(
    '$label for a new Session through the Compute preference authority',
    async ({ request, expected }) => {
      const h = createComputePreferenceHarness()

      const started = await h.api.startRun({
        project: project.id,
        prompt: 'Research this.',
        ...request
      })
      const completed = await h.api.waitForRun(started.id)

      expect(started.preferredComputeHostIds).toEqual(expected)
      expect(completed.preferredComputeHostIds).toEqual(expected)
      expect(h.durableSessions.get(started.sessionId)?.enabledComputeHosts).toEqual(
        'computeHostIds' in request ? expected : undefined
      )
      expect(h.durableSessions.get(started.sessionId)?.selectedComputeHosts).toEqual(
        'computeHostIds' in request ? expected : undefined
      )
      expect(h.registry.getEnabled(started.sessionId)).toEqual(expected)
      expect(h.registry.getSelected(started.sessionId)).toEqual(expected)
      await h.api.dispose()
    }
  )

  it.each([
    {
      label: 'preserves an omitted preference',
      request: {},
      expected: ['ssh:kept'],
      expectedEnabled: ['ssh:kept', 'ssh:available']
    },
    {
      label: 'clears an explicit empty preference',
      request: { computeHostIds: [] },
      expected: [],
      expectedEnabled: ['ssh:kept', 'ssh:available']
    },
    {
      label: 'replaces and deduplicates in first-occurrence order',
      request: { computeHostIds: ['ssh:beta', 'ssh:alpha', 'ssh:beta'] },
      expected: ['ssh:beta', 'ssh:alpha'],
      expectedEnabled: ['ssh:kept', 'ssh:available', 'ssh:beta', 'ssh:alpha']
    }
  ])(
    '$label for a continued Session through the Compute preference authority',
    async ({ request, expected, expectedEnabled }) => {
      const existing: PersistedChatSession = {
        id: 'session-existing',
        projectId: project.id,
        title: 'Existing research',
        cwd: '/workspace',
        status: 'idle',
        messages: [],
        enabledComputeHosts: ['ssh:kept', 'ssh:available'],
        selectedComputeHosts: ['ssh:kept'],
        createdAt: 1,
        updatedAt: 2
      }
      const h = createComputePreferenceHarness(existing)

      const started = await h.api.startRun({
        project: project.id,
        sessionId: existing.id,
        prompt: 'Continue this research.',
        ...request
      })
      const completed = await h.api.waitForRun(started.id)

      expect(h.durableSessions.get(existing.id)?.enabledComputeHosts).toEqual(expectedEnabled)
      expect(h.durableSessions.get(existing.id)?.selectedComputeHosts).toEqual(expected)
      expect(h.registry.getEnabled(existing.id)).toEqual(expectedEnabled)
      expect(h.registry.getSelected(existing.id)).toEqual(expected)
      expect(started.preferredComputeHostIds).toEqual(expected)
      expect(completed.preferredComputeHostIds).toEqual(expected)
      await h.api.dispose()
    }
  )

  it.each([
    {
      label: 'invalid',
      providerId: 'local:alpha',
      message: 'Invalid Compute Host provider id: local:alpha'
    },
    {
      label: 'unknown',
      providerId: 'ssh:missing',
      message: 'Compute Host not found: ssh:missing'
    }
  ])(
    'rejects an $label preference atomically before continuing a Session',
    async ({ providerId, message }) => {
      const existing: PersistedChatSession = {
        id: 'session-existing',
        projectId: project.id,
        title: 'Existing research',
        cwd: '/workspace',
        status: 'idle',
        messages: [],
        enabledComputeHosts: ['ssh:kept'],
        createdAt: 1,
        updatedAt: 2
      }
      const h = createComputePreferenceHarness(existing)
      const before = structuredClone(existing)

      await expect(
        h.api.startRun({
          project: project.id,
          sessionId: existing.id,
          prompt: 'Continue this research.',
          computeHostIds: [providerId]
        })
      ).rejects.toMatchObject({ code: 'invalid_request', message })

      expect(h.durableSessions.get(existing.id)).toEqual(before)
      expect(h.registry.getEnabled(existing.id)).toEqual(['ssh:kept'])
      expect(h.registry.getSelected(existing.id)).toEqual(['ssh:kept'])
      expect(h.saveSession).not.toHaveBeenCalled()
      expect(h.agent.resumeSession).not.toHaveBeenCalled()
      expect(h.agent.prompt).not.toHaveBeenCalled()
      await h.api.dispose()
    }
  )

  it('validates a live root question before releasing the original Provider wait once', async () => {
    const h = taskQuestionHarness('running')
    const owner = h.newOwner()
    const api = h.createApi(owner, false)
    const caller = createTaskCallerContext({ authenticatedLocalBearer: true })
    const interactionId = 'question:root-question'
    try {
      await h.interactions.run(
        { kind: 'prompt', sessionId: h.scope.sessionId, provenanceContext: h.provenance },
        async () => {
          const released = vi.fn()
          const result = owner
            .request(
              {
                mode: 'form',
                sessionId: 'provider-session',
                toolCallId: 'question-tool',
                message: 'Which measures?',
                requestedSchema: {
                  type: 'object',
                  properties: {
                    measures: {
                      type: 'array',
                      items: { enum: ['mean', 'median'], type: 'string' },
                      minItems: 1
                    }
                  },
                  required: ['measures']
                }
              },
              { sessionId: h.scope.sessionId },
              { promptMessageId: h.provenance.promptMessageId, provenanceContext: h.provenance }
            )
            .then(released)
          await expect(api.getInteraction(interactionId, h.scope)).rejects.toMatchObject({
            code: 'task_relay_required'
          })
          await api.runWithCallerContext(caller, async () => {
            await expect(api.listInteractions(h.scope)).resolves.toMatchObject([
              { id: interactionId, kind: 'question', state: 'pending' }
            ])
            const question = await api.getInteraction(interactionId, h.scope)
            expect(question).toMatchObject({
              question: { fields: [{ kind: 'multi-select', required: true }] }
            })
            const response = {
              action: 'accept',
              source: 'known_context',
              expectedRevision: question.revision,
              expectedBranchId: question.branchId!
            } as const
            await expect(
              api.answerQuestion(interactionId, h.scope, response)
            ).rejects.toMatchObject({ code: 'invalid_request' })
            await expect(
              api.answerQuestion(interactionId, h.scope, {
                ...response,
                answers: [{ fieldId: 'measures', value: ['invented'] }]
              })
            ).rejects.toMatchObject({ code: 'invalid_request' })
            await expect(
              api.answerQuestion(interactionId, h.scope, {
                ...response,
                expectedBranchId: 'other-branch',
                answers: [{ fieldId: 'measures', value: ['mean'] }]
              })
            ).rejects.toMatchObject({ code: 'interaction_revision_conflict' })
            expect(released).not.toHaveBeenCalled()
            const answer = {
              ...response,
              answers: [{ fieldId: 'measures', value: ['mean', 'median'] }]
            }
            const replies = await Promise.all([
              api.answerQuestion(interactionId, h.scope, answer),
              api.answerQuestion(interactionId, h.scope, answer)
            ])
            expect(replies.map(({ changed }) => changed)).toEqual([true, false])
            expect(replies[0].interaction.response?.continuation).toBeUndefined()
            await expect(
              api.answerQuestion(interactionId, h.scope, {
                ...response,
                answers: [{ fieldId: 'measures', value: ['median'] }]
              })
            ).rejects.toMatchObject({ code: 'question_already_answered' })
          })
          await result
          expect(released).toHaveBeenCalledExactlyOnceWith({
            action: 'accept',
            content: { measures: ['mean', 'median'] }
          })
          expect(h.schedule).not.toHaveBeenCalled()
        }
      )
    } finally {
      owner.dispose()
      await api.dispose()
    }
  })

  it('keeps questions with their actual Run when a continuation shares the prompt and timestamp', async () => {
    const h = taskQuestionHarness('waiting-for-user')
    const origin = { runId: 'original-run' }
    const continuation = { runId: 'continuation-run' }
    const originalOwner = h.newOwner()
    const currentOwner = h.newOwner('new-question')
    const makeQuestion = (owner: AcpElicitationOwner, runId: string, requestId: string): void => {
      const provenanceContext = { ...h.provenance, taskRunId: runId }
      expect(
        owner.requestDetached(
          {
            mode: 'form',
            sessionId: 'provider-session',
            toolCallId: requestId,
            message: 'Choose a group.',
            requestedSchema: {
              type: 'object',
              properties: { group: { type: 'string' } },
              required: ['group']
            }
          },
          { sessionId: h.scope.sessionId },
          {
            kind: 'agent-user-choice',
            requestId,
            promptMessageId: h.provenance.promptMessageId,
            provenanceContext
          }
        )
      ).toBeDefined()
    }
    makeQuestion(originalOwner, origin.runId, 'old-question')
    originalOwner.respond(
      { requestId: 'old-question', action: 'accept', answers: [{ fieldId: 'group', value: 'A' }] },
      {
        source: 'user_relay',
        action: 'accept',
        reviewedRevision: 1,
        checksum: 'a'.repeat(64)
      }
    )
    originalOwner.dispose()
    h.addContinuationRun()
    makeQuestion(currentOwner, continuation.runId, 'new-question')
    h.restart()
    const api = h.createApi(currentOwner, true)
    try {
      await api.initialize()
      await api.runWithCallerContext(
        createTaskCallerContext({ authenticatedLocalBearer: true }),
        async () => {
          const id = 'question:new-question'
          const current = await api.getInteraction(id, continuation)
          expect(current).toMatchObject({ runId: continuation.runId, state: 'pending' })
          await expect(api.listInteractions(origin)).resolves.toEqual([])
          await expect(api.getInteraction(id, origin)).rejects.toMatchObject({
            code: 'interaction_not_found'
          })
          await expect(api.getInteraction('question:old-question', origin)).resolves.toMatchObject({
            runId: origin.runId,
            state: 'responded'
          })
          await expect(
            api.getInteraction('question:old-question', continuation)
          ).rejects.toMatchObject({ code: 'interaction_not_found' })
          const response = {
            source: 'user_relay',
            action: 'accept',
            expectedRevision: current.revision,
            expectedBranchId: current.branchId!,
            answers: [{ fieldId: 'group', value: 'B' }]
          } as const
          const input = { ...response, answers: [...response.answers] }
          await expect(api.answerQuestion(id, origin, input)).rejects.toMatchObject({
            code: 'interaction_not_found'
          })
          await expect(api.answerQuestion(id, continuation, input)).resolves.toMatchObject({
            changed: true,
            interaction: { runId: continuation.runId, state: 'responded' }
          })
        }
      )
    } finally {
      currentOwner.dispose()
      await api.dispose()
    }
  })

  it('expires a pending form whose Provider wait disappeared on restart', async () => {
    const h = taskQuestionHarness('running')
    const owner = h.newOwner()
    const response = owner.request(
      {
        mode: 'form',
        sessionId: 'provider-session',
        toolCallId: 'question-tool',
        message: 'Name the group.',
        requestedSchema: {
          type: 'object',
          properties: { group: { type: 'string' } },
          required: ['group']
        }
      },
      { sessionId: h.scope.sessionId },
      { promptMessageId: h.provenance.promptMessageId, provenanceContext: h.provenance }
    )
    h.restart()
    owner.dispose()
    await expect(response).resolves.toEqual({ action: 'cancel' })
    const api = h.createApi(h.newOwner(), true)
    try {
      await api.initialize()
      await api.runWithCallerContext(
        createTaskCallerContext({ authenticatedLocalBearer: true }),
        async () => {
          await expect(api.listInteractions(h.scope)).resolves.toEqual([])
          await expect(
            api.getInteraction('question:root-question', h.scope)
          ).resolves.toMatchObject({
            state: 'expired',
            actions: [],
            next: expect.stringContaining('Check the current Session')
          })
        }
      )
    } finally {
      await api.dispose()
    }
  })

  it.each([false, true])(
    'recovers a detached question and its saved response without replay (dispatched: %s)',
    async (dispatched) => {
      const h = taskQuestionHarness('waiting-for-user')
      const owner = h.newOwner()
      expect(
        owner.requestDetached(
          {
            mode: 'form',
            sessionId: 'provider-session',
            toolCallId: 'question-tool',
            message: 'Pick a method and output.',
            requestedSchema: {
              type: 'object',
              properties: {
                question_0: { type: 'string', enum: ['Median', 'Mean'] },
                question_0_custom: { type: 'string' },
                question_1: { type: 'string', enum: ['Table', 'Chart'] },
                question_1_custom: { type: 'string' }
              }
            }
          },
          { sessionId: h.scope.sessionId },
          {
            kind: 'agent-user-choice',
            requestId: 'root-question',
            promptMessageId: h.provenance.promptMessageId,
            provenanceContext: h.provenance
          }
        )
      ).toBeDefined()
      owner.dispose()
      h.restart()
      const caller = createTaskCallerContext({ authenticatedLocalBearer: true })
      const profile = await mkdtemp(join(tmpdir(), 'question-task-continuation-'))
      const api = h.createApi(h.newOwner(), true, profile)
      const interactionId = 'question:root-question'
      const original = { runId: 'original-run' }
      let restarted: HeadlessTaskApi | undefined
      try {
        await api.initialize()
        const answer = await api.runWithCallerContext(caller, async () => {
          await expect(api.getRun(original.runId)).resolves.toMatchObject({
            status: 'failed',
            failureCode: 'process_restarted',
            attention: { kind: 'interactions', interactions: [{ id: interactionId }] }
          })
          const question = await api.getInteraction(interactionId, original)
          expect(question).toMatchObject({
            question: { skipFieldIds: ['question_0', 'question_1'] }
          })
          const response = {
            action: 'accept',
            source: 'user_relay',
            expectedRevision: question.revision,
            expectedBranchId: question.branchId!,
            answers: [
              { fieldId: 'question_0_custom', value: 'Mode' },
              { fieldId: 'question_1', status: 'skipped' }
            ]
          } as const
          const submission = { ...response, answers: [...response.answers] }
          await expect(
            api.answerQuestion(interactionId, original, { ...submission, source: 'known_context' })
          ).rejects.toMatchObject({ code: 'invalid_request' })
          await expect(
            api.answerQuestion(interactionId, original, submission)
          ).resolves.toMatchObject({
            changed: true,
            interaction: {
              state: 'responded',
              response: { continuation: { id: expect.stringMatching(/^askuser_/) } }
            }
          })
          expect(h.continuations.get(h.scope.sessionId)?.request).toMatchObject({
            suppressUserMessage: true,
            text: expect.stringContaining('Answer: Mode')
          })
          return submission
        })
        if (dispatched) {
          const continuation = h.continuations.takeAndActivate(h.scope.sessionId)!
          await continuation.send!(continuation.request, vi.fn())
          h.continuations.complete(h.scope.sessionId)
        }
        await api.dispose()
        expect(h.schedule).toHaveBeenCalledOnce()
        h.continuations.clear()
        h.restart()
        const apiAfterRestart = h.createApi(h.newOwner(), true, profile)
        restarted = apiAfterRestart
        await apiAfterRestart.initialize()
        await apiAfterRestart.runWithCallerContext(caller, async () => {
          await expect(apiAfterRestart.listInteractions(h.scope)).resolves.toEqual([])
          const interaction = await apiAfterRestart.getInteraction(interactionId, original)
          expect(interaction).toMatchObject({
            state: 'responded',
            response: {
              source: 'user_relay',
              continuation: { status: dispatched ? 'accepted' : 'unconfirmed' }
            }
          })
          if (dispatched && interaction.kind === 'question') {
            const { requestId, runId } = interaction.response!.continuation!
            expect(requestId).toMatch(/^continue-/)
            await expect(apiAfterRestart.getSubmission(requestId!)).resolves.toMatchObject({
              status: 'accepted',
              runId
            })
            await expect(apiAfterRestart.getRun(runId!)).resolves.toMatchObject({
              status: 'completed',
              continuedFromRunId: original.runId
            })
          }
          await expect(
            apiAfterRestart.answerQuestion(interactionId, original, answer)
          ).resolves.toMatchObject({ changed: false })
          await expect(apiAfterRestart.getRun(original.runId)).resolves.toMatchObject({
            status: 'failed',
            failureCode: 'process_restarted'
          })
        })
        expect(h.schedule).toHaveBeenCalledOnce()
        expect(h.providerSend).toHaveBeenCalledTimes(dispatched ? 1 : 0)
      } finally {
        await api.dispose()
        await restarted?.dispose()
        await rm(profile, { recursive: true, force: true })
      }
    }
  )

  it('refuses an old answer after the user branches from the original question prompt', async () => {
    const h = taskQuestionHarness('running')
    const owner = h.newOwner()
    const api = h.createApi(owner, false)
    try {
      await h.interactions.run(
        { kind: 'prompt', sessionId: h.scope.sessionId, provenanceContext: h.provenance },
        async () => {
          const released = vi.fn()
          const response = owner
            .request(
              {
                mode: 'form',
                sessionId: 'provider-session',
                toolCallId: 'question-tool',
                message: 'Name the group.',
                requestedSchema: {
                  type: 'object',
                  properties: { group: { type: 'string' } },
                  required: ['group']
                }
              },
              { sessionId: h.scope.sessionId },
              { promptMessageId: h.provenance.promptMessageId, provenanceContext: h.provenance }
            )
            .then(released)
          await api.runWithCallerContext(
            createTaskCallerContext({ authenticatedLocalBearer: true }),
            async () => {
              const id = 'question:root-question'
              const question = await api.getInteraction(id, h.scope)
              h.forkQuestionPrompt()
              await expect(
                api.answerQuestion(id, h.scope, {
                  action: 'accept',
                  source: 'user_relay',
                  expectedRevision: question.revision,
                  expectedBranchId: question.branchId!,
                  answers: [{ fieldId: 'group', value: 'Treatment' }]
                })
              ).rejects.toMatchObject({ code: 'interaction_not_found' })
              expect(released).not.toHaveBeenCalled()
            }
          )
          owner.dispose()
          await response
          expect(released).toHaveBeenCalledExactlyOnceWith({ action: 'cancel' })
        }
      )
    } finally {
      owner.dispose()
      await api.dispose()
    }
  })

  it('finds a restored Plan in the original scope and looks up the recorded decision after reconnect', async () => {
    const submissionRoot = await mkdtemp(join(tmpdir(), 'plan-task-continuation-'))
    const repository = new NotebookRunRepository(submissionRoot)
    const notebook = new NotebookRuntimeService({
      configRoot: submissionRoot,
      dataRoot: submissionRoot,
      projectId: project.id,
      repository
    })
    onTestFinished(async () => {
      await notebook.dispose()
      await rm(submissionRoot, { recursive: true, force: true })
    })
    let now = 100
    let trackContinuation: TaskContinuationTracker | undefined
    const enteredPlanOwner = Promise.withResolvers<void>()
    const finishPlanPreflight = Promise.withResolvers<void>()
    const send = vi.fn(async (onProviderDispatched: () => void, taskRunId?: string) => {
      onProviderDispatched()
      persisted.planHistoryProjections = [projection()]
      persisted.runtimeContext = {
        version: 1,
        revision: 5,
        plan: {
          ...plan,
          artifactVersionId: 'continuation-plan-version',
          originatingTaskRunId: taskRunId,
          materializedAt: now
        }
      }
      await appendNotebookRun('continuation-cell', ++now)
      now++
      return { stopReason: 'end_turn' }
    })
    const plan = {
      artifactId: 'plan-artifact',
      artifactVersionId: 'plan-version',
      artifactChecksum: 'checksum',
      originatingPromptMessageId: 'plan-prompt',
      materializedAt: 100,
      approval: 'pending' as const,
      stepStatuses: {}
    }
    const persisted: PersistedChatSession = materializeSessionConversationGraph({
      id: 'session-plan',
      projectId: project.id,
      title: 'Plan session',
      cwd: submissionRoot,
      status: 'waiting-plan-approval',
      runtimeContext: { version: 1, revision: 3, plan },
      messages: [
        {
          id: 'plan-prompt',
          role: 'user',
          content: 'Compare groups.',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 1
        }
      ],
      createdAt: 1,
      updatedAt: 2
    })
    const frame = persisted.conversationGraph!.frames[0]!
    const lane = createFrameNotebookLane(project.id, persisted.id, frame.id)
    const notebookScope = { projectId: project.id, sessionId: persisted.id, lane }
    const appendNotebookRun = (id: string, at: number): Promise<unknown> =>
      repository.appendRun({
        ...notebookScope,
        run: {
          runId: id,
          cellId: id,
          source: 'agent',
          kernelKind: 'python',
          script: 'print(42)',
          status: 'completed',
          kernelDispatched: true,
          startedAt: at,
          messageBranchId: frame.activeBranchId,
          promptMessageId: 'plan-prompt',
          text: { stdout: '', stderr: '', traceback: '', plain: [] },
          outputs: [],
          workingFiles: []
        }
      })
    await repository.loadOrCreate({ ...notebookScope, workspaceCwd: submissionRoot })
    await appendNotebookRun('original-cell', 5)
    const projection = (): NonNullable<PersistedChatSession['planHistoryProjections']>[number] => {
      const plan = persisted.runtimeContext!.plan!
      return {
        ...plan,
        document: {
          schema_version: 1,
          task_summary: 'Compare groups.',
          phases: [
            {
              name: 'Analysis',
              delegations: [
                {
                  name: 'Compare',
                  steps: [{ title: 'Check groups', description: 'Compare the group totals.' }]
                }
              ]
            }
          ],
          desired_outputs: [],
          feasibility: { confidence: 'high', rationale: 'The groups are available.' }
        },
        revision: persisted.runtimeContext!.revision,
        lifecycle: plan.approval === 'pending' ? 'awaiting_approval' : 'approved',
        stepStates: {},
        counts: { phases: 0, delegations: 0, steps: 0, completed: 0, inProgress: 0 }
      }
    }
    const commandInvoke = vi.fn(async (channel: string) => {
      if (channel === 'sessions:load-all') {
        return { sessions: [persisted], manifest: { version: 1 } }
      }
      if (channel === 'sessions:load-one') return structuredClone(persisted)
      if (channel === 'acp:get-plan-projection') return projection()
      if (channel === 'acp:respond-plan') {
        persisted.runtimeContext = {
          version: 1,
          revision: 4,
          plan: {
            ...plan,
            approval: 'approved',
            externalResponse: {
              source: 'user_relay',
              reviewedRevision: 3,
              action: 'approved',
              commandId: 'continuation-1',
              promptMessageId: 'plan-prompt',
              handedOff: true
            }
          }
        }
        await trackContinuation!(
          {
            kind: 'plan',
            projectId: project.id,
            sessionId: persisted.id,
            attemptId: 'continuation-1',
            originalPromptMessageId: 'plan-prompt',
            promptMessageId: 'plan-prompt'
          },
          send
        )
        return { changed: true }
      }
      throw new Error(`Unexpected Task command: ${channel}`)
    })
    let journal: TaskRunJournalEntry[] = [
      {
        id: 'plan-run',
        projectId: project.id,
        sessionId: persisted.id,
        promptMessageId: 'plan-prompt',
        cwd: persisted.cwd,
        status: 'running',
        startedAt: 1,
        artifacts: [],
        preferredComputeHostIds: []
      }
    ]
    const createApi = (): HeadlessTaskApi =>
      new HeadlessTaskApi(
        {
          commands: commandsFrom(commandInvoke),
          agent: createAgent({
            respondDelegatedPlan: vi.fn(async (_command, isCurrent) => {
              expect(isCurrent()).toBe(true)
              enteredPlanOwner.resolve()
              await finishPlanPreflight.promise
              expect(isCurrent()).toBe(false)
              throw new PlanCommandError('interaction-mismatch', 'Task delegation was withdrawn.')
            }),
            setContinuationTracker: (tracker) => {
              trackContinuation = tracker
              return () => {
                trackContinuation = undefined
              }
            }
          }),
          notebook
        },
        {
          now: () => now,
          submissionRoot,
          runJournal: {
            load: async () => structuredClone(journal),
            replace: async (runs) => {
              journal = structuredClone([...runs])
            }
          }
        }
      )
    const api = createApi()
    await api.initialize()
    const caller = createTaskCallerContext({ authenticatedLocalBearer: true })
    const scope = { projectId: project.id, sessionId: persisted.id }
    const request = {
      source: 'user_relay',
      decision: 'approved',
      artifactVersionId: plan.artifactVersionId,
      expectedRevision: 3,
      expectedBranchId: persisted.conversationGraph!.branches[0]!.id,
      projectId: project.id
    } as const
    await expect(api.respondSessionPlan(persisted.id, request)).rejects.toMatchObject({
      code: 'task_relay_required'
    })
    await api.runWithCallerContext(caller, async () => {
      await expect(api.listInteractions(scope)).resolves.toMatchObject([
        { id: 'plan:plan-version', state: 'pending', revision: 3, owner: 'user' }
      ])
      await expect(api.getRun('plan-run')).resolves.toMatchObject({
        status: 'failed',
        failureCode: 'process_restarted',
        attention: { kind: 'interactions', interactions: [{ id: 'plan:plan-version' }] }
      })
      await expect(
        api.respondSessionPlan(persisted.id, { ...request, expectedRevision: 2 })
      ).rejects.toMatchObject({ code: 'revision-conflict' })
      await expect(
        api.respondSessionPlan(persisted.id, { ...request, projectId: 'other' })
      ).rejects.toMatchObject({ code: 'session_project_mismatch' })
      await expect(
        api.respondSessionPlan(persisted.id, { ...request, expectedBranchId: 'old-branch' })
      ).rejects.toMatchObject({ code: 'interaction-mismatch' })
      const delegation = { ...request, source: 'delegated_agent', expectedModeRevision: 1 } as const
      await expect(api.respondSessionPlan(persisted.id, delegation)).rejects.toMatchObject({
        code: 'task_delegation_required'
      })
      await api.setRunInteractionMode('plan-run', {
        interactionMode: 'delegate',
        expectedRevision: 0
      })
      const pending = api.respondSessionPlan(persisted.id, delegation)
      const denied = expect(pending).rejects.toMatchObject({ code: 'interaction-mismatch' })
      await enteredPlanOwner.promise
      await api.setRunInteractionMode('plan-run', { interactionMode: 'relay', expectedRevision: 1 })
      finishPlanPreflight.resolve()
      await denied
      await expect(api.listInteractions(scope)).resolves.toMatchObject([
        { state: 'pending', owner: 'user' }
      ])
      await expect(api.respondSessionPlan(persisted.id, request)).resolves.toMatchObject({
        changed: true
      })
    })
    await api.dispose()
    Object.assign(persisted, normalizeSessionFile(JSON.parse(JSON.stringify(persisted))))
    const restarted = createApi()
    await restarted.initialize()
    await restarted.runWithCallerContext(caller, async () => {
      const interaction = await restarted.getInteraction('plan:plan-version', scope)
      if (interaction.kind !== 'plan') throw new Error('Expected the recorded Plan interaction.')
      expect(interaction).toMatchObject({
        state: 'responded',
        runId: 'plan-run',
        response: {
          source: 'user_relay',
          action: 'approved',
          continuation: { id: 'continuation-1', taskRunStatus: 'tracked' }
        }
      })
      const continuation = interaction.response!.continuation
      const current = { runId: continuation.runId! }
      const original = { runId: 'plan-run' }
      await expect(restarted.listInteractions(original)).resolves.toEqual([])
      await expect(restarted.listInteractions(current)).resolves.toMatchObject([
        { id: 'plan:continuation-plan-version', runId: current.runId, state: 'pending' }
      ])
      await expect(
        restarted.getInteraction('plan:continuation-plan-version', original)
      ).rejects.toMatchObject({ code: 'interaction_not_found' })
      await expect(restarted.getInteraction('plan:plan-version', current)).rejects.toMatchObject({
        code: 'interaction_not_found'
      })
      expect(continuation.runId).toBeTruthy()
      expect(continuation.requestId).toBeTruthy()
      await expect(restarted.getSubmission(continuation.requestId!)).resolves.toMatchObject({
        status: 'accepted',
        runId: continuation.runId
      })
      await expect(restarted.getRun(continuation.runId!)).resolves.toMatchObject({
        status: 'completed',
        continuedFromRunId: 'plan-run',
        execution: { status: 'completed', notebookRunId: 'continuation-cell' }
      })
      await expect(restarted.respondSessionPlan(persisted.id, request)).resolves.toMatchObject({
        changed: false
      })
      await expect(
        restarted.respondSessionPlan(persisted.id, { ...request, decision: 'rejected' })
      ).rejects.toMatchObject({ code: 'approval-already-decided' })
      await expect(restarted.getRun('plan-run')).resolves.toMatchObject({
        failureCode: 'process_restarted',
        execution: { status: 'completed', notebookRunId: 'original-cell' }
      })
    })
    expect(
      commandInvoke.mock.calls.filter(([channel]) => channel === 'acp:respond-plan')
    ).toHaveLength(1)
    expect(send).toHaveBeenCalledOnce()
    await restarted.dispose()
  })
  it('relays a parked permission after restart and expires a known process-only request', async () => {
    const submissionRoot = await mkdtemp(join(tmpdir(), 'permission-task-continuation-'))
    onTestFinished(() => rm(submissionRoot, { recursive: true, force: true }))
    const sessionId = 'session-parked-permission'
    const promptMessageId = 'permission-prompt'
    const scope = { runId: 'permission-run' }
    const persisted = materializeSessionConversationGraph({
      id: sessionId,
      projectId: project.id,
      title: 'Parked permission',
      cwd: '/workspace/permission',
      status: 'waiting-permission',
      createdAt: 1,
      updatedAt: 2,
      messages: [
        {
          id: promptMessageId,
          role: 'user',
          content: 'Read study table.',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 1
        }
      ],
      activities: [
        {
          id: 'parked-tool',
          promptMessageId,
          title: 'Read study table',
          status: 'pending',
          kind: 'tool',
          eventIds: [],
          sortIndex: 0,
          createdAt: 2,
          updatedAt: 2
        }
      ],
      runtimeContext: {
        version: 1,
        revision: 1,
        permission: {
          state: 'pending',
          originatingPromptMessageId: promptMessageId,
          fingerprint: 'a'.repeat(64),
          createdAt: 2,
          request: {
            requestId: 'parked',
            sessionId,
            toolCallId: 'parked-tool',
            title: 'Read study table',
            isMcp: true,
            mcpIdentity: 'science/read_table',
            rawInput: { path: 'study.csv' },
            options: [
              { optionId: 'once', name: 'Read once', kind: 'allow_once', scope: 'once' },
              { optionId: 'always', name: 'Always read', kind: 'allow_always', scope: 'session' },
              { optionId: 'deny', name: 'Decline', kind: 'reject_once' }
            ]
          }
        }
      }
    })
    const branchId = persisted.conversationGraph.branches[0]!.id
    let journal: TaskRunJournalEntry[] = [
      {
        id: scope.runId,
        projectId: project.id,
        sessionId,
        promptMessageId,
        cwd: persisted.cwd,
        status: 'running',
        startedAt: 1,
        artifacts: [],
        preferredComputeHostIds: [],
        interactionPolicy: { mode: 'delegate', revision: 2 },
        permissionInteractions: [
          {
            id: 'permission:ephemeral',
            branchId,
            revision: 0,
            notebookReview: { kind: 'runtime', language: 'python' }
          }
        ]
      }
    ]
    let trackContinuation: TaskContinuationTracker | undefined
    let launch: (() => Promise<{ stopReason: string }>) | undefined
    const send = vi.fn(async (onProviderDispatched: () => void) => {
      onProviderDispatched()
      return { stopReason: 'end_turn' }
    })
    const agent = createAgent({
      setContinuationTracker: (tracker) => {
        trackContinuation = tracker
        return () => {
          trackContinuation = undefined
        }
      },
      restoreTaskPermission: vi.fn(async ({ requestId, projectId, sessionId }, decision) => {
        const committed = await decision.commit(async () => {
          await decision.record('unconfirmed')
          return true
        })
        if (committed)
          launch = () =>
            trackContinuation!(
              {
                kind: 'permission',
                projectId,
                sessionId,
                attemptId: requestId,
                originalPromptMessageId: promptMessageId,
                promptMessageId
              },
              send
            )
        return committed
      })
    })
    const open = (): HeadlessTaskApi =>
      new HeadlessTaskApi(
        {
          commands: commandsFrom(async (channel) => {
            if (channel === 'sessions:load-all') return { sessions: [persisted] }
            throw new Error(`Unexpected Task command: ${channel}`)
          }),
          agent
        },
        {
          submissionRoot,
          runJournal: {
            load: async () => structuredClone(journal),
            replace: async (entries) => {
              journal = structuredClone([...entries])
            }
          }
        }
      )
    const id = 'permission:parked'
    const response = {
      source: 'delegated_agent',
      expectedModeRevision: 2,
      expectedRevision: 0,
      expectedBranchId: branchId,
      optionId: 'once'
    } as const
    const caller = createTaskCallerContext({ authenticatedLocalBearer: true })
    const api = open()
    await api.initialize()
    try {
      await api.runWithCallerContext(caller, async () => {
        await expect(api.getRun(scope.runId)).resolves.toMatchObject({
          status: 'failed',
          failureCode: 'process_restarted',
          attention: {
            kind: 'interactions',
            interactions: [{ id, state: 'pending', owner: 'agent', actions: ['once', 'deny'] }]
          }
        })
        await expect(api.getInteraction('permission:ephemeral', scope)).resolves.toMatchObject({
          state: 'expired',
          notebookReview: { kind: 'runtime', language: 'python' },
          actions: []
        })
        await expect(api.getInteraction(id, scope)).resolves.toMatchObject({
          state: 'pending',
          recovery: 'new_continuation',
          branchId,
          request: { toolCallId: 'parked-tool', input: { path: 'study.csv' } }
        })
        await expect(
          api.respondPermission(id, scope, { ...response, expectedBranchId: 'other' })
        ).rejects.toMatchObject({ code: 'interaction_revision_conflict' })
        await expect(
          api.respondPermission(id, scope, { ...response, optionId: 'always' })
        ).rejects.toMatchObject({ code: 'interaction_revision_conflict' })
        await expect(
          api.setRunInteractionMode(scope.runId, { interactionMode: 'relay', expectedRevision: 2 })
        ).resolves.toEqual({ mode: 'relay', revision: 3 })
        await expect(api.respondPermission(id, scope, response)).rejects.toMatchObject({
          code: 'task_delegation_required'
        })
        await expect(
          api.setRunInteractionMode(scope.runId, {
            interactionMode: 'delegate',
            expectedRevision: 3
          })
        ).resolves.toEqual({ mode: 'delegate', revision: 4 })
        await expect(
          api.respondPermission(id, scope, { ...response, expectedModeRevision: 4 })
        ).resolves.toMatchObject({
          changed: true,
          interaction: {
            response: {
              source: 'delegated_agent',
              optionId: 'once',
              continuation: { taskRunStatus: 'unconfirmed' }
            }
          }
        })
        await launch!()
      })
    } finally {
      await api.dispose()
    }
    const reopened = open()
    await reopened.initialize()
    try {
      await reopened.runWithCallerContext(caller, async () => {
        const sessionScope = { projectId: project.id, sessionId }
        await expect(reopened.listInteractions(sessionScope)).resolves.toEqual([])
        const interaction = await reopened.getInteraction(id, sessionScope)
        if (interaction.kind !== 'permission')
          throw new Error('Expected the recorded permission interaction.')
        const continuation = interaction.response?.continuation
        expect(continuation).toMatchObject({ id: 'parked', taskRunStatus: 'tracked' })
        await expect(reopened.getSubmission(continuation!.requestId!)).resolves.toMatchObject({
          status: 'accepted',
          runId: continuation!.runId
        })
        await expect(reopened.getRun(continuation!.runId!)).resolves.toMatchObject({
          status: 'completed',
          continuedFromRunId: scope.runId,
          interactionPolicy: { mode: 'delegate', revision: 4 }
        })
        await expect(
          reopened.respondPermission(id, sessionScope, { ...response, expectedModeRevision: 4 })
        ).resolves.toMatchObject({ changed: false })
        await expect(
          reopened.respondPermission(id, scope, {
            ...response,
            expectedModeRevision: 4,
            optionId: 'deny'
          })
        ).rejects.toMatchObject({ code: 'interaction_revision_conflict' })
        await expect(reopened.getRun(scope.runId)).resolves.toMatchObject({
          status: 'failed',
          failureCode: 'process_restarted'
        })
      })
      expect(agent.restoreTaskPermission).toHaveBeenCalledTimes(1)
      expect(send).toHaveBeenCalledTimes(1)
      expect(agent.prompt).not.toHaveBeenCalled()
    } finally {
      await reopened.dispose()
    }
  })

  it('exposes Task Run progress through one subscription seam', async () => {
    const invoke = vi.fn(
      async (channel: string, _callerContext: CallerContext, args: unknown[]) => {
        if (channel === 'projects:list') return [project]
        if (channel === 'sessions:load-all') return { sessions: [], manifest: { version: 1 } }
        if (channel === 'sessions:save-session') return args[0]
        throw new Error(`Unexpected Task command: ${channel}`)
      }
    )
    const ids = ['message-1', 'run-1', 'assistant-1']
    const agent = createAgent({
      prompt: vi.fn(async (_request, observer) => {
        observer?.onProviderPromptAccepted?.()
      })
    })
    const api = new HeadlessTaskApi(
      { commands: commandsFrom(invoke), agent },
      { createId: () => ids.shift() ?? 'generated-id', now: () => 1 }
    )
    const phases: string[] = []
    const unsubscribe = api.subscribeProgress((event) => phases.push(event.phase))

    const run = await api.startRun({ project: project.id, prompt: 'Research this.' })
    await api.waitForRun(run.id)

    expect(phases).toEqual([
      'accepted',
      'session-ready',
      'prompt-dispatched',
      'provider-accepted',
      'completed'
    ])
    unsubscribe()
    await api.dispose()
  })

  it('exposes durable lifecycle state without hiding archived Sessions', async () => {
    const archivedSession: PersistedChatSession = {
      id: 'session-archived',
      projectId: project.id,
      title: 'Archived research',
      cwd: '/workspace/archived',
      status: 'idle',
      pinned: true,
      archivedAt: 30,
      messages: [],
      createdAt: 1,
      updatedAt: 30
    }
    const activeSession: PersistedChatSession = {
      id: 'session-active',
      projectId: project.id,
      title: 'Active research',
      cwd: '/workspace/active',
      status: 'idle',
      messages: [],
      createdAt: 2,
      updatedAt: 20
    }
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'projects:list') return [project]
      if (channel === 'sessions:load-all') {
        return { sessions: [archivedSession, activeSession], manifest: { version: 1 } }
      }
      throw new Error(`Unexpected Task command: ${channel}`)
    })
    const api = new HeadlessTaskApi({ commands: commandsFrom(invoke), agent: createAgent() })

    try {
      await expect(api.listSessions(project.id)).resolves.toEqual([
        expect.objectContaining({ id: archivedSession.id, pinned: true, archivedAt: 30 }),
        expect.objectContaining({ id: activeSession.id, pinned: false, archivedAt: undefined })
      ])
      await expect(api.getSession(archivedSession.id)).resolves.toMatchObject({
        pinned: true,
        archivedAt: 30
      })
    } finally {
      await api.dispose()
    }
  })

  it.each([
    {
      name: 'Project',
      code: 'project_archived',
      projects: [{ ...project, archivedAt: 40 }],
      sessions: [] as PersistedChatSession[],
      request: { project: project.id, prompt: 'Research this.' },
      admissionMessage: 'Restore this archived Project before continuing.'
    },
    {
      name: 'Session',
      code: 'session_archived',
      projects: [project],
      sessions: [
        {
          id: 'session-archived',
          projectId: project.id,
          title: 'Archived research',
          cwd: '/workspace/archived',
          status: 'idle' as const,
          archivedAt: 40,
          messages: [],
          createdAt: 1,
          updatedAt: 40
        }
      ],
      request: {
        project: project.id,
        sessionId: 'session-archived',
        prompt: 'Continue this research.'
      },
      admissionMessage: 'Restore this archived Session before continuing.'
    }
  ])('reports archived $name admission as a stable Task conflict', async (fixture) => {
    const invoke = vi.fn(
      async (channel: string, _callerContext: CallerContext, args: unknown[]) => {
        if (channel === 'projects:list') return fixture.projects
        if (channel === 'sessions:load-all') {
          return { sessions: fixture.sessions, manifest: { version: 1 } }
        }
        if (channel === 'sessions:save-session') return args[0]
        throw new Error(`Unexpected Task command: ${channel}`)
      }
    )
    const api = new HeadlessTaskApi({
      commands: commandsFrom(invoke),
      agent: createAgent({
        withSessionAvailable: async () => {
          throw new Error(fixture.admissionMessage)
        }
      })
    })

    try {
      await expect(api.startRun(fixture.request)).rejects.toMatchObject({
        code: fixture.code,
        message: fixture.admissionMessage
      })
    } finally {
      await api.dispose()
    }
  })

  it('maps public query and artifact commands to the compatibility façade', async () => {
    const session: PersistedChatSession = {
      id: 'session-query',
      projectId: project.id,
      title: 'Query session',
      cwd: '/workspace/query',
      status: 'idle',
      messages: [],
      artifacts: [
        {
          id: 'artifact-query',
          kind: 'managed-file',
          path: '/artifacts/query.csv',
          name: 'query.csv',
          mimeType: 'text/csv',
          size: 12
        }
      ],
      createdAt: 1,
      updatedAt: 2
    }
    const invoke = vi.fn(async (channel: string, _callerContext: unknown, args: unknown[]) => {
      if (channel === 'projects:list') return [project]
      if (channel === 'projects:create') {
        return { ...project, ...(args[0] as object), id: 'project-created' }
      }
      if (channel === 'projects:update') {
        return { ...project, ...(args[0] as object), updatedAt: 3 }
      }
      if (channel === 'sessions:load-all') {
        return { sessions: [session], manifest: { version: 1 } }
      }
      if (channel === 'sessions:load-one') return session
      if (channel === 'artifacts:resolve-version-descriptors') return []
      if (channel === 'managed-file-versions:inspect') {
        const request = args[0] as { versionNumber?: number }
        return {
          ok: true,
          value: {
            projectId: project.id,
            selectedVersion: {
              id: 'artifact-query-version',
              fileId: 'artifact-query',
              versionNumber: request.versionNumber ?? 1,
              displayName: 'query.csv',
              contentType: 'text/csv'
            },
            versions: []
          }
        }
      }
      if (channel === 'preview-resources:acquire') {
        return {
          id: 'resource-query',
          url: 'open-science-preview://resource-query/query.csv',
          size: 12,
          mimeType: 'text/csv'
        }
      }
      if (channel === 'preview-resources:release') return undefined
      throw new Error(`Unexpected Task command: ${channel}`)
    })
    const findArtifactSessions = vi.fn(async () => [
      { projectId: project.id, sessionId: session.id }
    ])
    const api = new HeadlessTaskApi({
      commands: commandsFrom(invoke),
      agent: createAgent(),
      controls: {
        specialists: { resolve: async (id) => ({ id }) },
        findArtifactSessions
      }
    })

    await expect(
      api.createProject({ name: 'Created', agentContext: 'Always cite sources.' })
    ).resolves.toMatchObject({
      id: 'project-created',
      name: 'Created',
      hasAgentContext: true
    })
    await expect(
      api.updateProject(project.id, {
        expectedUpdatedAt: project.updatedAt,
        agentContext: 'Prefer Python.'
      })
    ).resolves.toMatchObject({ id: project.id, updatedAt: 3, hasAgentContext: true })
    await expect(api.listSessions(project.id)).resolves.toEqual([
      expect.objectContaining({ id: session.id, artifactCount: 1 })
    ])
    await expect(api.getSession(session.id, project.id)).resolves.toMatchObject({
      title: session.title
    })
    await expect(api.listArtifacts(session.id)).resolves.toEqual(session.artifacts)
    const acquired = await api.acquireArtifact('artifact-query')
    expect(findArtifactSessions).toHaveBeenCalledWith('artifact-query')
    expect(acquired).toMatchObject({
      resourceId: 'resource-query',
      name: 'query.csv'
    })
    for (const selection of [{ projectId: project.id }, { versionNumber: 2 }]) {
      const preview = await api.acquireArtifact('artifact-query', selection)
      expect(preview).toMatchObject({ resourceId: 'resource-query', name: 'query.csv' })
      await preview.release()
    }
    await acquired.release()

    expect(invoke).toHaveBeenCalledWith(
      'artifacts:resolve-version-descriptors',
      taskCallerContext(),
      [{ projectId: project.id, appSessionId: session.id, versionIds: ['artifact-query'] }]
    )
    expect(invoke).toHaveBeenCalledWith('sessions:load-one', taskCallerContext(), [
      { projectId: project.id, sessionId: session.id }
    ])
    expect(invoke).toHaveBeenCalledWith('sessions:load-one', taskCallerContext(), [
      { sessionId: session.id }
    ])
    expect(invoke).toHaveBeenCalledWith('preview-resources:acquire', taskCallerContext(), [
      {
        source: 'artifact',
        projectId: 'project-1',
        fileId: 'artifact-query',
        versionId: 'artifact-query-version',
        mimeType: 'text/csv'
      }
    ])
    expect(invoke).toHaveBeenCalledWith('managed-file-versions:inspect', taskCallerContext(), [
      {
        source: 'artifact',
        fileId: 'artifact-query',
        versionNumber: 2
      }
    ])
    expect(invoke).toHaveBeenCalledWith('preview-resources:release', taskCallerContext(), [
      { resourceId: 'resource-query' }
    ])
    expect(invoke).toHaveBeenCalledWith('projects:update', taskCallerContext(), [
      {
        id: project.id,
        expectedUpdatedAt: project.updatedAt,
        agentContext: 'Prefer Python.'
      }
    ])
  })

  it('uses the direct Agent port for an attached session and keeps artifact finalization on the façade', async () => {
    let emitEvent: ((event: AcpRuntimeEvent) => void) | undefined
    const existing: PersistedChatSession = {
      id: 'session-attached',
      projectId: project.id,
      title: 'Attached session',
      cwd: '/workspace/attached',
      status: 'idle',
      permissionProfile: 'ask',
      memoryEnabled: false,
      messages: [],
      createdAt: 1,
      updatedAt: 1
    }
    const invoke = vi.fn(async (channel: string, callerContext: CallerContext, args: unknown[]) => {
      void callerContext
      if (channel === 'projects:list') return [project]
      if (channel === 'sessions:load-all') return { sessions: [existing], manifest: { version: 1 } }
      if (channel === 'sessions:save-session') return args[0]
      if (channel === 'artifacts:finalize-run') return { ok: true, artifacts: [] }
      throw new Error(`Unexpected Task command: ${channel} ${JSON.stringify(args)}`)
    })
    const agent = createAgent({
      listAttachedSessionIds: vi.fn(async () => [existing.id]),
      prompt: vi.fn(async (_request, observer) => {
        await observer?.onPromptAdmitted?.()
        emitEvent?.({
          id: 'artifact-event',
          timestamp: 10,
          kind: 'artifact',
          level: 'info',
          sessionId: existing.id,
          runId: 'attached-run',
          artifactClaimId: 'artifact-claim',
          artifacts: []
        })
      })
    })
    const ids = ['attached-user', 'attached-run', 'attached-agent']
    const api = new HeadlessTaskApi(
      { commands: commandsFrom(invoke), agent },
      {
        createId: () => ids.shift() ?? 'generated-id',
        subscribeEvents: (listener) => {
          emitEvent = listener
          return () => undefined
        }
      }
    )

    const run = await api.startRun({
      project: project.id,
      sessionId: existing.id,
      prompt: 'Continue research.',
      permissionProfile: 'auto'
    })
    await api.waitForRun(run.id)

    expect(agent.listAttachedSessionIds).toHaveBeenCalledOnce()
    expect(agent.setPermissionProfile).toHaveBeenCalledWith(existing.id, 'auto')
    expect(agent.setMemoryEnabled).toHaveBeenCalledWith(existing.id, false)
    expect(agent.prompt).toHaveBeenCalledWith(
      {
        sessionId: existing.id,
        taskRunId: run.id,
        promptMessageId: 'attached-user',
        provenanceContext: {
          rootFrameId: 'root-frame-session-attached',
          agentFrameId: 'root-frame-session-attached',
          messageBranchId: 'message-branch-session-attached',
          messageBranchAncestry: ['message-branch-session-attached'],
          messageAncestry: ['attached-user'],
          runtimeSegmentId: 'runtime-segment-session-attached',
          promptMessageId: 'attached-user'
        },
        text: 'Continue research.'
      },
      {
        onPromptAdmitted: expect.any(Function),
        onProviderPromptAccepted: expect.any(Function)
      }
    )
    expect(invoke.mock.calls.every(([channel]) => !String(channel).startsWith('acp:'))).toBe(true)
    expect(invoke).toHaveBeenCalledWith('artifacts:finalize-run', taskCallerContext(), [
      { claimId: 'artifact-claim', messageId: 'attached-agent' }
    ])
    expect(invoke).toHaveBeenCalledWith('sessions:stage-task-completion', taskCallerContext(), [
      expect.objectContaining({
        sessionId: existing.id,
        promptMessageId: 'attached-user',
        message: expect.objectContaining({ id: 'attached-agent' })
      })
    ])
    expect(invoke).toHaveBeenCalledWith('sessions:settle-task-completion', taskCallerContext(), [
      expect.objectContaining({
        sessionId: existing.id,
        promptMessageId: 'attached-user',
        messageId: 'attached-agent'
      })
    ])
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(
      expect.arrayContaining([
        'sessions:stage-task-completion',
        'artifacts:finalize-run',
        'sessions:settle-task-completion'
      ])
    )
    const terminalChannels = invoke.mock.calls.map(([channel]) => channel)
    expect(terminalChannels.indexOf('sessions:stage-task-completion')).toBeLessThan(
      terminalChannels.indexOf('artifacts:finalize-run')
    )
    expect(terminalChannels.indexOf('artifacts:finalize-run')).toBeLessThan(
      terminalChannels.indexOf('sessions:settle-task-completion')
    )
  })

  it('keeps deferred Session admission alive after remote authorization expires', async () => {
    const existing: PersistedChatSession = {
      id: 'session-admission-context',
      projectId: project.id,
      title: 'Admission context',
      cwd: '/workspace/admission-context',
      status: 'idle',
      permissionProfile: 'ask',
      messages: [],
      createdAt: 1,
      updatedAt: 1
    }
    let authorizationCurrent = true
    const context = createTaskCallerContext({
      location: 'remote',
      isAuthorizationCurrent: () => authorizationCurrent
    })
    const invoke = vi.fn(async (channel: string, callerContext: CallerContext, args: unknown[]) => {
      if (!callerContext.isAuthorizationCurrent()) {
        throw new Error('Caller authorization is no longer current.')
      }
      if (channel === 'projects:list') return [project]
      if (channel === 'sessions:load-all') {
        return { sessions: [existing], manifest: { version: 1 } }
      }
      if (channel === 'sessions:save-session') return args[0]
      throw new Error(`Unexpected Task command: ${channel}`)
    })
    const agent = createAgent({
      listAttachedSessionIds: vi.fn(async () => [existing.id]),
      prompt: vi.fn(async (_request, observer) => {
        authorizationCurrent = false
        await observer?.onPromptAdmitted?.()
        observer?.onProviderPromptAccepted?.()
      })
    })
    const ids = ['admission-user', 'admission-run', 'admission-agent']
    const api = new HeadlessTaskApi(
      { commands: commandsFrom(invoke), agent },
      { createId: () => ids.shift() ?? 'generated-id' }
    )

    const run = await api.runWithCallerContext(context, () =>
      api.startRun({
        project: project.id,
        sessionId: existing.id,
        prompt: 'Continue after admission.'
      })
    )

    await expect(api.waitForRun(run.id)).resolves.toMatchObject({ status: 'completed' })
    expect(invoke).toHaveBeenCalledWith('sessions:save-session', taskCallerContext(), [
      expect.objectContaining({
        id: existing.id,
        status: 'running',
        activeRun: expect.objectContaining({ promptMessageId: 'admission-user' })
      })
    ])
    expect(authorizationCurrent).toBe(false)
    await api.dispose()
  })

  it('resumes a detached session through the direct Agent port with its durable binding', async () => {
    const existing: PersistedChatSession = {
      id: 'session-detached',
      projectId: project.id,
      title: 'Detached session',
      cwd: '/workspace/detached',
      status: 'idle',
      permissionProfile: 'ask',
      agentFrameworkId: 'codex',
      agentBackendId: 'codex:shared',
      messages: [],
      createdAt: 1,
      updatedAt: 1
    }
    const invoke = vi.fn(async (channel: string, callerContext: CallerContext, args: unknown[]) => {
      void callerContext
      if (channel === 'projects:list') return [project]
      if (channel === 'sessions:load-all') return { sessions: [existing], manifest: { version: 1 } }
      if (channel === 'sessions:save-session') return args[0]
      throw new Error(`Unexpected Task command: ${channel} ${JSON.stringify(args)}`)
    })
    const agent = createAgent({
      resumeSession: vi.fn(async () => ({ sessionId: existing.id, cwd: existing.cwd }))
    })
    const ids = ['detached-user', 'detached-run', 'detached-agent']
    const api = new HeadlessTaskApi(
      { commands: commandsFrom(invoke), agent },
      { createId: () => ids.shift() ?? 'generated-id' }
    )

    const run = await api.startRun({
      project: project.id,
      sessionId: existing.id,
      prompt: 'Resume research.'
    })
    await api.waitForRun(run.id)

    expect(agent.resumeSession).toHaveBeenCalledWith({
      sessionId: existing.id,
      cwd: existing.cwd,
      projectId: project.id,
      permissionProfile: 'ask',
      memoryEnabled: true,
      previousFrameworkId: 'codex',
      previousBackendId: 'codex:shared',
      previousModel: undefined,
      providerSessionId: undefined,
      providerContinuityToken: undefined
    })
    expect(invoke.mock.calls.every(([channel]) => !String(channel).startsWith('acp:'))).toBe(true)
  })

  it('uses the request caller before admission and the Task caller for admitted lifecycle work', async () => {
    let finishPrompt: (() => void) | undefined
    const promptGate = new Promise<void>((resolve) => {
      finishPrompt = resolve
    })
    const invoke = vi.fn(async (channel: string, callerContext: CallerContext, args: unknown[]) => {
      void callerContext
      void args
      if (channel === 'projects:list') return [project]
      if (channel === 'sessions:load-all') return { sessions: [], manifest: { version: 1 } }
      if (channel === 'sessions:save-session') return args[0]
      if (channel === 'preview-resources:release') return undefined
      throw new Error(`Unexpected Task command: ${channel}`)
    })
    const agent = createAgent({
      createSession: vi.fn(async () => ({
        sessionId: 'session-context',
        cwd: '/workspace/context'
      })),
      prompt: vi.fn(async () => promptGate)
    })
    const api = new HeadlessTaskApi({ commands: commandsFrom(invoke), agent })
    let authorizationCurrent = true
    const context = createTaskCallerContext({
      location: 'remote',
      isAuthorizationCurrent: () => authorizationCurrent
    })

    const run = await api.runWithCallerContext(context, () =>
      api.startRun({ project: project.id, prompt: 'Research with remote context.' })
    )
    authorizationCurrent = false
    finishPrompt?.()
    await api.waitForRun(run.id)

    expect(invoke).toHaveBeenCalledWith('projects:list', context, [])
    expect(invoke).toHaveBeenCalledWith('sessions:save-session', context, [
      expect.objectContaining({ status: 'running' })
    ])
    expect(invoke).toHaveBeenCalledWith('sessions:load-one', taskCallerContext(), [
      { projectId: project.id, sessionId: 'session-context' }
    ])
    expect(invoke.mock.calls.some(([channel]) => channel === 'sessions:load-all')).toBe(false)
    expect(invoke).toHaveBeenCalledWith('sessions:settle-task-completion', taskCallerContext(), [
      expect.objectContaining({ sessionId: 'session-context' })
    ])
    expect(agent.createSession).toHaveBeenCalledWith({
      projectId: project.id,
      permissionProfile: 'ask'
    })
    expect(agent.prompt).toHaveBeenCalledWith(
      {
        sessionId: 'session-context',
        promptMessageId: expect.any(String),
        provenanceContext: {
          rootFrameId: 'root-frame-session-context',
          agentFrameId: 'root-frame-session-context',
          messageBranchId: 'message-branch-session-context',
          messageBranchAncestry: ['message-branch-session-context'],
          messageAncestry: [expect.any(String)],
          runtimeSegmentId: 'runtime-segment-session-context',
          promptMessageId: expect.any(String)
        },
        taskRunId: run.id,
        text: 'Research with remote context.'
      },
      { onProviderPromptAccepted: expect.any(Function) }
    )
    expect(context.isAuthorizationCurrent()).toBe(false)
  })

  it('does not enter the direct Agent port after captured remote authorization expires', async () => {
    let authorizationCurrent = true
    const invoke = vi.fn(
      async (channel: string, _callerContext: CallerContext, args: unknown[]) => {
        if (channel === 'projects:list') {
          authorizationCurrent = false
          return [project]
        }
        if (channel === 'sessions:save-session') {
          return args[0]
        }
        throw new Error(`Unexpected Task command: ${channel}`)
      }
    )
    const agent = createAgent()
    const api = new HeadlessTaskApi({ commands: commandsFrom(invoke), agent })
    const context = createTaskCallerContext({
      location: 'remote',
      isAuthorizationCurrent: () => authorizationCurrent
    })

    await expect(
      api.runWithCallerContext(context, () =>
        api.startRun({ project: project.id, prompt: 'Research after revocation.' })
      )
    ).rejects.toThrow('Caller authorization is no longer current.')
    expect(agent.listAttachedSessionIds).not.toHaveBeenCalled()
    expect(agent.createSession).not.toHaveBeenCalled()
    expect(agent.prompt).not.toHaveBeenCalled()
  })

  it('forwards run cancellation through the direct Agent port under the request caller context', async () => {
    let finishPrompt: (() => void) | undefined
    const promptGate = new Promise<void>((resolve) => {
      finishPrompt = resolve
    })
    const invoke = vi.fn(
      async (channel: string, _callerContext: CallerContext, args: unknown[]) => {
        if (channel === 'projects:list') return [project]
        if (channel === 'sessions:load-all') return { sessions: [], manifest: { version: 1 } }
        if (channel === 'sessions:save-session') return args[0]
        throw new Error(`Unexpected Task command: ${channel}`)
      }
    )
    const agent = createAgent({
      createSession: vi.fn(async () => ({ sessionId: 'session-cancel-context' })),
      prompt: vi.fn(async () => promptGate),
      cancelPrompt: vi.fn(async () => finishPrompt?.())
    })
    const api = new HeadlessTaskApi({ commands: commandsFrom(invoke), agent })
    const context = createTaskCallerContext({ location: 'remote' })

    const run = await api.startRun({ project: project.id, prompt: 'Cancel remotely.' })
    const cancelled = await api.runWithCallerContext(context, () => api.cancelRun(run.id))

    expect(cancelled).toMatchObject({ status: 'cancelled' })
    expect(agent.cancelPrompt).toHaveBeenCalledWith('session-cancel-context')
  })

  it('aborts the Reviewer command when cancellation reaches an automatic review', async () => {
    let emitEvent: ((event: AcpRuntimeEvent) => void) | undefined
    const invoke = vi.fn(
      async (channel: string, _callerContext: CallerContext, args: unknown[]) => {
        if (channel === 'projects:list') return [project]
        if (channel === 'sessions:load-all') return { sessions: [], manifest: { version: 1 } }
        if (channel === 'sessions:save-session') return args[0]
        if (channel === 'reviewer:run') return { started: true }
        if (channel === 'reviewer:get-for-session') {
          return [{ id: 'review-1', turnMessageId: 'review-agent', lifecycle: 'running' }]
        }
        if (channel === 'reviewer:abort') return undefined
        throw new Error(`Unexpected Task command: ${channel}`)
      }
    )
    const agent = createAgent({
      createSession: vi.fn(async () => ({ sessionId: 'session-review-cancel' })),
      prompt: vi.fn(async () => {
        emitEvent?.({
          id: 'review-message-event',
          timestamp: 10,
          kind: 'message',
          level: 'info',
          sessionId: 'session-review-cancel',
          role: 'assistant',
          text: 'Review this output.'
        })
      })
    })
    const ids = ['review-user', 'review-run', 'review-agent']
    const api = new HeadlessTaskApi(
      { commands: commandsFrom(invoke), agent },
      {
        createId: () => ids.shift() ?? 'generated-id',
        subscribeEvents: (listener) => {
          emitEvent = listener
          return () => undefined
        }
      }
    )

    const run = await api.startRun({
      project: project.id,
      prompt: 'Produce and review.',
      autoReviewEnabled: true
    })
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('reviewer:get-for-session', expect.anything(), [
        { projectId: project.id, appSessionId: 'session-review-cancel' }
      ])
    )
    await expect(api.cancelRun(run.id)).resolves.toMatchObject({ status: 'cancelled' })

    expect(invoke).toHaveBeenCalledWith('reviewer:abort', expect.anything(), [
      { projectId: project.id, appSessionId: 'session-review-cancel' }
    ])
    await api.dispose()
  })

  it('keeps admitted automatic-review polling alive after remote authorization expires', async () => {
    let emitEvent: ((event: AcpRuntimeEvent) => void) | undefined
    let authorizationCurrent = true
    const context = createTaskCallerContext({
      location: 'remote',
      isAuthorizationCurrent: () => authorizationCurrent
    })
    const invoke = vi.fn(
      async (channel: string, callerContext: CallerContext, args: unknown[]): Promise<unknown> => {
        if (channel === 'projects:list') return [project]
        if (channel === 'sessions:load-all') {
          return { sessions: [], manifest: { version: 1 } }
        }
        if (channel === 'sessions:save-session') return args[0]
        if (channel === 'reviewer:run') {
          expect(callerContext).toEqual(taskCallerContext())
          authorizationCurrent = false
          return { started: true }
        }
        if (channel === 'reviewer:get-for-session') {
          expect(callerContext).toEqual(taskCallerContext())
          expect(callerContext.isAuthorizationCurrent()).toBe(true)
          return [{ id: 'review-expired', turnMessageId: 'expired-agent', lifecycle: 'completed' }]
        }
        throw new Error(`Unexpected Task command: ${channel}`)
      }
    )
    const agent = createAgent({
      createSession: vi.fn(async () => ({ sessionId: 'session-review-expired' })),
      prompt: vi.fn(async () => {
        emitEvent?.({
          id: 'expired-message-event',
          timestamp: 10,
          kind: 'message',
          level: 'info',
          sessionId: 'session-review-expired',
          role: 'assistant',
          text: 'Review after authorization expiry.'
        })
      })
    })
    const ids = ['expired-user', 'expired-run', 'expired-agent']
    const api = new HeadlessTaskApi(
      { commands: commandsFrom(invoke), agent },
      {
        createId: () => ids.shift() ?? 'generated-id',
        subscribeEvents: (listener) => {
          emitEvent = listener
          return () => undefined
        }
      }
    )

    const run = await api.runWithCallerContext(context, () =>
      api.startRun({
        project: project.id,
        prompt: 'Produce and review after authorization expiry.',
        autoReviewEnabled: true
      })
    )
    await expect(api.waitForRun(run.id)).resolves.toMatchObject({
      status: 'completed',
      review: { started: true, id: 'review-expired', lifecycle: 'completed' }
    })
    expect(authorizationCurrent).toBe(false)
    await api.dispose()
  })

  it('awaits Reviewer cleanup before completing Task API disposal', async () => {
    let emitEvent: ((event: AcpRuntimeEvent) => void) | undefined
    let markAbortStarted: (() => void) | undefined
    let releaseAbort: (() => void) | undefined
    const abortStarted = new Promise<void>((resolve) => {
      markAbortStarted = resolve
    })
    const abortGate = new Promise<void>((resolve) => {
      releaseAbort = resolve
    })
    const invoke = vi.fn(
      async (channel: string, _callerContext: CallerContext, args: unknown[]) => {
        if (channel === 'projects:list') return [project]
        if (channel === 'sessions:load-all') return { sessions: [], manifest: { version: 1 } }
        if (channel === 'sessions:save-session') return args[0]
        if (channel === 'reviewer:run') return { started: true }
        if (channel === 'reviewer:get-for-session') {
          return [{ id: 'review-1', turnMessageId: 'dispose-agent', lifecycle: 'running' }]
        }
        if (channel === 'reviewer:abort') {
          markAbortStarted?.()
          await abortGate
          return undefined
        }
        throw new Error(`Unexpected Task command: ${channel}`)
      }
    )
    const agent = createAgent({
      createSession: vi.fn(async () => ({ sessionId: 'session-review-dispose' })),
      prompt: vi.fn(async () => {
        emitEvent?.({
          id: 'dispose-message-event',
          timestamp: 10,
          kind: 'message',
          level: 'info',
          sessionId: 'session-review-dispose',
          role: 'assistant',
          text: 'Review before disposal.'
        })
      })
    })
    const ids = ['dispose-user', 'dispose-run', 'dispose-agent']
    const api = new HeadlessTaskApi(
      { commands: commandsFrom(invoke), agent },
      {
        createId: () => ids.shift() ?? 'generated-id',
        subscribeEvents: (listener) => {
          emitEvent = listener
          return () => undefined
        }
      }
    )

    await api.startRun({
      project: project.id,
      prompt: 'Produce and review before disposal.',
      autoReviewEnabled: true
    })
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('reviewer:get-for-session', expect.anything(), [
        { projectId: project.id, appSessionId: 'session-review-dispose' }
      ])
    )
    let disposed = false
    const disposal = api.dispose().then(() => {
      disposed = true
    })
    await abortStarted

    expect(disposed).toBe(false)
    releaseAbort?.()
    await disposal
    expect(disposed).toBe(true)
    expect(invoke).toHaveBeenCalledWith('reviewer:abort', expect.anything(), [
      { projectId: project.id, appSessionId: 'session-review-dispose' }
    ])
  })

  it('does not enter the direct Agent port for cancellation after authorization expires', async () => {
    let finishPrompt: (() => void) | undefined
    const promptGate = new Promise<void>((resolve) => {
      finishPrompt = resolve
    })
    const invoke = vi.fn(
      async (channel: string, _callerContext: CallerContext, args: unknown[]) => {
        if (channel === 'projects:list') return [project]
        if (channel === 'sessions:load-all') return { sessions: [], manifest: { version: 1 } }
        if (channel === 'sessions:save-session') return args[0]
        throw new Error(`Unexpected Task command: ${channel}`)
      }
    )
    const agent = createAgent({
      createSession: vi.fn(async () => ({ sessionId: 'session-revoked-cancel' })),
      prompt: vi.fn(async () => promptGate),
      cancelPrompt: vi.fn(async () => finishPrompt?.())
    })
    const api = new HeadlessTaskApi({ commands: commandsFrom(invoke), agent })
    let authorizationCurrent = false
    const context = createTaskCallerContext({
      location: 'remote',
      isAuthorizationCurrent: () => authorizationCurrent
    })
    const run = await api.startRun({ project: project.id, prompt: 'Keep running.' })

    await expect(api.runWithCallerContext(context, () => api.cancelRun(run.id))).rejects.toThrow(
      'Caller authorization is no longer current.'
    )
    expect(agent.cancelPrompt).not.toHaveBeenCalled()

    authorizationCurrent = true
    await api.runWithCallerContext(context, () => api.cancelRun(run.id))
  })
})

describe('Connector management through Task API', () => {
  const snapshot = {
    connectors: [{ id: 'bundled', enabled: true }],
    customServers: [{ id: 'custom', enabled: false, transport: 'stdio', command: 'node' }],
    ncbi: { hasApiKey: false }
  }
  it('shares Connector reads and mutations with Settings command owners', async () => {
    const invoke = vi.fn(async () => snapshot)
    const api = new HeadlessTaskApi({ commands: commandsFrom(invoke), agent: createAgent() })
    expect(await api.listConnectors()).toEqual(snapshot)
    expect(await api.getConnector('custom')).toEqual(snapshot.customServers[0])
    await api.setConnectorEnabled('custom', true)
    expect(invoke).toHaveBeenCalledWith('settings:set-custom-server-enabled', taskCallerContext(), [
      { id: 'custom', enabled: true }
    ])
    await api.setConnectorEnabled('bundled', false)
    expect(invoke).toHaveBeenCalledWith('settings:set-connector-enabled', taskCallerContext(), [
      { id: 'bundled', enabled: false }
    ])
    await api.updateConnector('custom', { transport: 'stdio', args: [] })
    expect(invoke).toHaveBeenCalledWith('settings:update-custom-server', taskCallerContext(), [
      { id: 'custom', transport: 'stdio', args: [] }
    ])
    await api.removeConnector('custom')
    expect(invoke).toHaveBeenCalledWith('settings:remove-custom-server', taskCallerContext(), [
      { id: 'custom' }
    ])
  })

  it('rejects remote mutation before accessing configuration', async () => {
    const invoke = vi.fn(async () => snapshot)
    const api = new HeadlessTaskApi({ commands: commandsFrom(invoke), agent: createAgent() })
    await expect(
      api.runWithCallerContext(createTaskCallerContext({ location: 'remote' }), () =>
        api.updateConnector('custom', { transport: 'stdio' })
      )
    ).rejects.toThrow('local')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('does not forward secret-bearing failure messages', async () => {
    const invoke = vi.fn(async () => {
      throw new Error('bad secret=do-not-print')
    })
    const api = new HeadlessTaskApi({ commands: commandsFrom(invoke), agent: createAgent() })
    await expect(
      api.createCredential({ kind: 'token', displayName: 'A', secret: 'do-not-print' })
    ).rejects.toThrow('Credential operation failed')
  })
})

it('preserves the safe saved-but-refresh-failed outcome for credential updates', async () => {
  const message =
    'Credential changes were saved, but Connectors could not refresh. Retry from Settings > Connectors.'
  const api = new HeadlessTaskApi({
    commands: commandsFrom(async () => {
      throw new Error(message)
    }),
    agent: createAgent()
  })
  await expect(api.updateCredential('credential', { secret: 'private' })).rejects.toThrow(message)
})
