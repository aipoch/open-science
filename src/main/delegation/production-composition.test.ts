import { EventEmitter } from 'node:events'
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { installAppLifecycle, type AppLifecycleDeps } from '../app-lifecycle'
import { clearApplicationShutdownTrigger } from '../application-shutdown-trigger'
import {
  activateConversationBranch,
  createLinearConversationGraph,
  forkEditedConversationMessage,
  synchronizeActiveConversationMessages
} from '../../shared/conversation-graph'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { NotebookLocalRpcServer } from '../notebook/local-rpc-server'
import { fetchLocalRpc } from '../local-rpc-transport'
import { ArtifactTurnOwner } from '../acp/artifact-turn-owner'
import { createNotebookArtifactSourceScopeProvider } from '../notebook/artifact-source-scope'
import { ArtifactProvenanceRepository } from '../artifacts/provenance-repository'
import { ArtifactRepository } from '../artifacts/repository'
import { ArtifactRunRegistry } from '../artifacts/run-registry'
import { writeArtifactFileForCurrentRun } from '../artifacts/mcp-server'
import { DELEGATION_DISABLED_MESSAGE } from './durable-delegated-work-error'
import { DelegateMessageParkedError } from './execution-port'
import { createArtifactHandlers } from '../artifacts/ipc'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { createFrameNotebookLane } from '../notebook/lane-identity'
import { NotebookRunRepository } from '../notebook/repository'
import { NotebookRuntimeService } from '../notebook/runtime-service'
import {
  SessionPersistenceCoordinator,
  type SessionFileIndex,
  type SessionMutationRepository
} from '../session-persistence/coordinator'
import { createDeterministicDelegateExecution } from './deterministic-execution'
import {
  createProductionDelegatedWorkComposition,
  type ProductionDelegatedWorkOptions
} from './production-composition'
import type { AgentFrameworkId } from '../../shared/settings'
import type { AuthenticatedDelegateCaller } from './durable-delegated-work'
import type { ArtifactFile } from '../../shared/artifacts'
import type { ReviewWithChecks } from '../../shared/reviewer'
import type { DelegatedWorkRecordCommands } from './session-records'
import { projectRootArtifactVisibility } from '../../shared/artifact-visibility'
import { normalizeSessionFile } from '../../shared/session-persistence'
import { finalizeDelegatedArtifactPublication } from './delegated-artifact-publication'
import { createProductionDelegatedFrameworks } from './production-frameworks'
import type { AcpDelegateExecutionCallbacks, AcpDelegateRuntime } from './acp-execution'
import type { DelegateExecutionInput } from './execution-port'
import type { DelegationSettlementDispatch } from './delegation-settlement-wake-owner'
import { claudeCodeFramework } from '../agent-framework'
import { CODEX_ACP_VERSION, CODEX_VERSION } from '../settings/managed-codex'
import { preS6ReaderSave } from '../../shared/pre-s6-session-reader.fixture'
import type { AcpPromptRequest, AcpStateSnapshot } from '../../shared/acp'
import { AcpRuntimeCoordinator } from '../acp/runtime-coordinator'
import type { AcpRuntime, AcpRuntimeCallbacks } from '../acp/runtime'
import { createDelegationSettlementContinuationDispatch } from './settlement-continuation-dispatch'

let root: string | undefined
let server: NotebookLocalRpcServer | undefined
let disconnect: (() => Promise<void>) | undefined

const testExecutionModel = (
  frameworkId: AgentFrameworkId
): Awaited<ReturnType<ProductionDelegatedWorkOptions['resolveExecutionModel']>> => ({
  snapshot: {
    frameworkId,
    providerId: 'test-provider',
    backendId: `${frameworkId}:test-provider`,
    modelRoute:
      frameworkId === 'claude-code'
        ? 'claude-anthropic'
        : frameworkId === 'opencode'
          ? 'opencode-anthropic'
          : 'codex-responses',
    model: 'test-model',
    reasoningEffort: 'default'
  }
})

const fileIndex: SessionFileIndex = {
  syncSession: async () => [],
  softDeleteSession: async () => 'delete-session',
  restoreSession: async () => undefined,
  softDeleteProject: async () => 'delete-project',
  reconcileActiveSessions: async () => undefined,
  reconcileProjectSessions: async () => undefined,
  markReconciliationIncomplete: () => undefined
}

type CompositionHarness = Readonly<{
  composition: ReturnType<typeof createProductionDelegatedWorkComposition>
  execution: ReturnType<typeof createDeterministicDelegateExecution>
  selected: AgentFrameworkId[]
  session: PersistedChatSession
  durable(): PersistedChatSession
  replaceDurable(session: PersistedChatSession): void
  caller: AuthenticatedDelegateCaller
  commands: DelegatedWorkRecordCommands
  reopen(): ReturnType<typeof createProductionDelegatedWorkComposition>
}>

const createCompositionHarness = async (
  dataRoot: string,
  frameworkId: AgentFrameworkId,
  execution = createDeterministicDelegateExecution(),
  admissionError?: Error,
  owners: Pick<
    ProductionDelegatedWorkOptions,
    'artifactEvidence' | 'reviewEvidence' | 'parentMessages' | 'settlementContinuations'
  > = {},
  initialRootInvocations: readonly Readonly<{
    rootMessageId: string
    toolInvocationId: string
    createdAt: number
  }>[] = [],
  resolveExecutionModel?: ProductionDelegatedWorkOptions['resolveExecutionModel'],
  frameworksOverride?: ProductionDelegatedWorkOptions['frameworks'],
  resolveInputOverride?: ProductionDelegatedWorkOptions['resolveInput']
): Promise<CompositionHarness> => {
  const rootMessage = {
    id: `root-message-${frameworkId}`,
    role: 'user' as const,
    content: 'Coordinate.',
    status: 'complete' as const,
    eventIds: [],
    createdAt: 1,
    updatedAt: 1
  }
  const session: PersistedChatSession = {
    id: `session-${frameworkId}`,
    projectId: 'project-1',
    title: frameworkId,
    cwd: '/root',
    status: 'idle',
    agentFrameworkId: frameworkId,
    messages: [rootMessage],
    conversationGraph: createLinearConversationGraph({
      sessionId: `session-${frameworkId}`,
      messages: [rootMessage],
      frameworkId,
      createdAt: 1,
      updatedAt: 1
    }),
    filesRevision: 1,
    createdAt: 1,
    updatedAt: 2
  }
  if (initialRootInvocations.length > 0) {
    const graph = session.conversationGraph!
    const rootBranch = graph.branches.find(
      ({ agentFrameId }) => agentFrameId === graph.rootFrameId
    )!
    let parentMessageId = rootMessage.id
    for (const invocation of initialRootInvocations) {
      graph.messages.push({
        id: invocation.rootMessageId,
        role: 'user',
        content: invocation.toolInvocationId,
        status: 'complete',
        eventIds: [],
        agentFrameId: graph.rootFrameId,
        introducedOnBranchId: rootBranch.id,
        parentMessageId,
        revisionRootMessageId: invocation.rootMessageId,
        createdAt: invocation.createdAt,
        updatedAt: invocation.createdAt
      })
      parentMessageId = invocation.rootMessageId
    }
    rootBranch.headMessageId = parentMessageId
    graph.activities.push(
      ...[
        {
          rootMessageId: rootMessage.id,
          toolInvocationId: `call-${frameworkId}`,
          createdAt: 2
        },
        ...initialRootInvocations
      ].map((invocation, index) => ({
        id: invocation.toolInvocationId,
        kind: 'tool' as const,
        title: 'delegate',
        status: 'completed' as const,
        sortIndex: index + 1,
        eventIds: [],
        createdAt: invocation.createdAt,
        updatedAt: invocation.createdAt,
        agentFrameId: graph.rootFrameId,
        messageBranchId: rootBranch.id,
        promptMessageId: invocation.rootMessageId,
        runtimeSegmentId: graph.runtimeSegments[0].id
      }))
    )
  }
  let durable = structuredClone(session)
  const repository: SessionMutationRepository = {
    loadAllWithDiagnostics: async () => ({
      result: { sessions: [structuredClone(durable)], manifest: { version: 1 } },
      isComplete: true
    }),
    loadProjectWithDiagnostics: async () => ({
      sessions: [structuredClone(durable)],
      isComplete: true
    }),
    loadCommittedProjectWithDiagnostics: async () => ({ sessions: [], isComplete: true }),
    loadSessionWithDiagnostics: async () => ({
      status: 'found',
      session: structuredClone(durable)
    }),
    assertSessionIdentityOwnership: async () => undefined,
    saveSession: async (next) => {
      durable = structuredClone(next)
    },
    saveCommittedProjectSession: async () => undefined,
    deleteSession: async () => undefined,
    deleteProjectSessions: async () => undefined,
    getProjectSessionDeletionState: async () => 'absent',
    markCommittedProjectSessionsPrepared: async () => undefined,
    completeProjectSessionDeletion: async () => undefined,
    listLegacyProjectSessionTombstones: async () => [],
    saveManifest: async () => undefined
  }
  const coordinator = new SessionPersistenceCoordinator(repository, fileIndex)
  const selected: AgentFrameworkId[] = []
  const compositionOptions: ProductionDelegatedWorkOptions = {
    dataRoot,
    sessions: {
      commands: coordinator,
      readSession: async () => structuredClone(durable),
      findSessions: async (sessionId) =>
        durable.id === sessionId ? [structuredClone(durable)] : []
    },
    resolveInput:
      resolveInputOverride ??
      (async () => {
        throw new Error('no inputs')
      }),
    frameworks: frameworksOverride ?? {
      async forSession(current) {
        selected.push(current.agentFrameworkId!)
        return {
          frameworkId: current.agentFrameworkId!,
          execution,
          assertAvailable: async () => {
            if (admissionError) throw admissionError
          }
        }
      }
    },
    resolveExecutionModel: resolveExecutionModel ?? (async () => testExecutionModel(frameworkId)),
    ...owners
  }
  const composition = createProductionDelegatedWorkComposition(compositionOptions)
  return {
    composition,
    execution,
    selected,
    session,
    durable: () => durable,
    replaceDurable(session) {
      durable = structuredClone(session)
    },
    caller: {
      session: { projectId: session.projectId, sessionId: session.id },
      frameId: session.conversationGraph!.rootFrameId,
      role: 'main' as const,
      originMessageId: rootMessage.id,
      toolInvocationId: `call-${frameworkId}`
    },
    commands: coordinator,
    reopen: () => createProductionDelegatedWorkComposition(compositionOptions)
  }
}

type FrameworkRuntimeControl = Readonly<{
  input: DelegateExecutionInput
  prompts: string[]
  submitInvalid(): Promise<void>
  submitValid(): Promise<void>
  askUser(): Promise<void>
  complete(options?: Readonly<{ submit?: boolean; text?: string }>): Promise<void>
}>

const createFrameworkCompositionHarness = async (
  dataRoot: string,
  frameworkId: AgentFrameworkId
): Promise<CompositionHarness & { controls: Map<string, FrameworkRuntimeControl> }> => {
  const immutableInputPath = join(dataRoot, 'framework-input.txt')
  await writeFile(immutableInputPath, 'framework evidence\n', 'utf8')
  const service = new NotebookRuntimeService({
    configRoot: dataRoot,
    dataRoot,
    projectId: 'project-1',
    repository: new NotebookRunRepository(dataRoot),
    executorFactory: () => ({
      execute: async (request) => ({
        status: 'completed',
        stdout: '',
        stderr: '',
        traceback: '',
        cwdAfter: request.cwd,
        outputs: [],
        workingFiles: []
      }),
      shutdown: async () => ({ reaped: true })
    })
  })
  const context: {
    composition?: ReturnType<typeof createProductionDelegatedWorkComposition>
    harness?: CompositionHarness
  } = {}
  server = new NotebookLocalRpcServer(service, {
    transport: 'tcp',
    delegatedWorkService: {
      delegate: vi.fn(),
      submitOutput: (caller, value) => context.composition!.host.submitOutput(caller, value),
      requestUserInput: (caller, request, requestId) =>
        context.composition!.host.requestUserInput(caller, request, requestId)
    }
  })
  const controls = new Map<string, FrameworkRuntimeControl>()
  const inputs = new Map<string, DelegateExecutionInput>()
  const opencodeConfig = {
    permission: { task: 'deny', name: 'deny' },
    agent: {
      general: { disable: true },
      explore: { disable: true },
      scout: { disable: true }
    }
  }
  const capabilities = new Map<
    string,
    Awaited<ReturnType<NotebookLocalRpcServer['issueDelegatedNotebookConnection']>>
  >()
  const frameworks = createProductionDelegatedFrameworks({
    capacity: 2,
    async certify() {
      return {
        frameworkId,
        assertProviderAvailable: async () => undefined,
        ...(frameworkId === 'codex'
          ? {
              codexRuntime: {
                nativeVersion: CODEX_VERSION,
                adapterVersion: CODEX_ACP_VERSION
              },
              codexFramework: {
                spawn: () => ({ kill: vi.fn() }) as unknown as ChildProcessWithoutNullStreams
              }
            }
          : {}),
        ...(frameworkId === 'codebuddy'
          ? {
              codebuddyFramework: {
                spawn: () => ({ kill: vi.fn() }) as unknown as ChildProcessWithoutNullStreams
              }
            }
          : {}),
        prepare: async (input: DelegateExecutionInput) => {
          inputs.set(input.attemptId, input)
          const durable = context.harness!.durable()
          const graph = durable.conversationGraph!
          const childFrame = graph.frames.find(({ id }) => id === input.frameId)!
          const branch = graph.branches.find(({ id }) => id === childFrame.activeBranchId)!
          const prompt = graph.messages.find(({ id }) => id === branch.headMessageId)!
          const capability = await server!.issueDelegatedNotebookConnection({
            projectId: input.session.projectId,
            sessionId: input.session.sessionId,
            rootFrameId: graph.rootFrameId,
            agentFrameId: input.frameId,
            attemptId: input.attemptId,
            messageBranchId: branch.id,
            runtimeSegmentId: input.runtimeSegmentId,
            promptMessageId: prompt.id,
            workspaceCwd: input.workspaceCwd!,
            isAttemptWritable: () => true
          })
          capabilities.set(input.attemptId, capability)
          const base = {
            executionId: input.attemptId,
            provenance: {
              projectId: input.session.projectId,
              sessionId: input.session.sessionId,
              agentFrameId: input.frameId,
              messageBranchId: branch.id,
              runtimeSegmentId: input.runtimeSegmentId,
              promptMessageId: prompt.id
            },
            workspace: { cwd: input.workspaceCwd! },
            runtimeHome: join(dataRoot, 'runtime', input.attemptId),
            frameworkId,
            capability
          }
          return frameworkId === 'claude-code'
            ? {
                ...base,
                sessionSetup: claudeCodeFramework.buildSessionSetup({ systemPromptAppends: [] })
              }
            : frameworkId === 'opencode'
              ? {
                  ...base,
                  modelConfig: {
                    env: {
                      OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
                      OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeConfig)
                    },
                    configFiles: [
                      {
                        path: join(base.runtimeHome, 'opencode.json'),
                        content: JSON.stringify(opencodeConfig)
                      }
                    ]
                  }
                }
              : frameworkId === 'codex'
                ? {
                    ...base,
                    spawn: {
                      executablePath: '/fake-codex-acp',
                      args: [],
                      env: {
                        HOME: base.runtimeHome,
                        CODEX_HOME: base.runtimeHome,
                        CODEX_CONFIG: JSON.stringify({
                          features: { multi_agent: false, multi_agent_v2: false }
                        })
                      } as Record<string, string>
                    }
                  }
                : {
                    ...base,
                    spawn: {
                      executablePath: '/fake-codebuddy',
                      args: ['--tools', 'Read,Write,Edit,Glob,Grep,Bash'],
                      env: {
                        CODEBUDDY_DISABLE_FORK_SUBAGENT: '1',
                        CODEBUDDY_DISABLE_BACKGROUND_TASKS: '1',
                        CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS: '1'
                      } as Record<string, string>
                    }
                  }
        },
        createRuntime: (
          scope,
          callbacks: AcpDelegateExecutionCallbacks,
          agentProcess?: ChildProcessWithoutNullStreams
        ): AcpDelegateRuntime => {
          if (frameworkId === 'claude-code') {
            expect(scope).toHaveProperty('sessionSetup')
            expect(agentProcess).toBeUndefined()
          } else if (frameworkId === 'opencode') {
            expect(scope).toHaveProperty('modelConfig')
            expect(agentProcess).toBeUndefined()
          } else {
            expect(scope).toHaveProperty('spawn')
            expect(agentProcess).toBeDefined()
          }
          let resolvePrompt!: (value: { stopReason: 'end_turn' }) => void
          const prompt = new Promise<{ stopReason: 'end_turn' }>((resolve) => {
            resolvePrompt = resolve
          })
          const input = inputs.get(scope.executionId)!
          const prompts: string[] = []
          const capability = capabilities.get(scope.executionId)!
          const submit = (value: unknown): Promise<Response> =>
            fetchLocalRpc(
              capability,
              {
                method: 'POST',
                headers: {
                  authorization: `Bearer ${capability.token}`,
                  'content-type': 'application/json'
                },
                body: JSON.stringify({ method: 'delegatedOutputCall', params: { value } })
              },
              `${frameworkId} structured output contract`
            )
          controls.set(scope.executionId, {
            input,
            prompts,
            async submitInvalid() {
              expect((await submit({ count: 'three' })).ok).toBe(false)
            },
            async submitValid() {
              const accepted = await submit({ count: 3 })
              expect(accepted.status).toBe(200)
              await expect(accepted.json()).resolves.toEqual({ result: { accepted: true } })
            },
            async askUser() {
              const response = await fetchLocalRpc(
                capability,
                {
                  method: 'POST',
                  headers: {
                    authorization: `Bearer ${capability.token}`,
                    'content-type': 'application/json'
                  },
                  body: JSON.stringify({
                    method: 'requestUserInput',
                    params: {
                      sessionId: 'forged-session',
                      questions: [
                        {
                          question: 'Which framework scope?',
                          options: [{ label: 'Focused' }, { label: 'Broad' }]
                        }
                      ]
                    }
                  })
                },
                `${frameworkId} delegated question contract`
              )
              expect(response.status).toBe(200)
              await expect(response.json()).resolves.toEqual({ result: { action: 'pending' } })
            },
            async complete(options = {}) {
              if (options.submit !== false) {
                expect((await submit({ count: 'three' })).ok).toBe(false)
                const accepted = await submit({ count: 3 })
                expect(accepted.status).toBe(200)
                await expect(accepted.json()).resolves.toEqual({ result: { accepted: true } })
              }
              callbacks.onEvent({
                id: `event-${scope.executionId}`,
                timestamp: 1,
                kind: 'message',
                level: 'info',
                sessionId: `provider-${scope.executionId}`,
                role: 'assistant',
                text: options.text ?? 'Structured framework child completed.'
              })
              resolvePrompt({ stopReason: 'end_turn' })
            }
          })
          return {
            createSession: async () => ({ sessionId: `provider-${scope.executionId}` }),
            sendAppContinuation: async ({ text }) => {
              prompts.push(text)
              callbacks.onProviderPromptAccepted(`provider-${scope.executionId}`)
              return prompt
            },
            cancelPrompt: async () => undefined,
            setPermissionProfile: async () => undefined,
            respondToPermission: async () => undefined,
            deleteSession: async () => undefined,
            shutdownForQuit: async () => ({ reaped: true })
          }
        }
      }
    }
  })
  const harness = await createCompositionHarness(
    dataRoot,
    frameworkId,
    undefined,
    undefined,
    {},
    [
      {
        rootMessageId: 'root-message-framework-continuation',
        toolInvocationId: 'call-framework-continuation',
        createdAt: 3
      }
    ],
    undefined,
    frameworks,
    async (identity) => {
      if (identity !== 'upload-version:framework-input') throw new Error('unknown input')
      return { path: immutableInputPath, filename: 'framework-input.txt' }
    }
  )
  context.harness = harness
  context.composition = harness.composition
  return Object.assign(harness, { controls })
}

afterEach(async () => {
  vi.useRealTimers()
  await server?.close()
  server = undefined
  await disconnect?.()
  disconnect = undefined
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('production delegated-work composition', () => {
  it('wakes the root through application context when a background child settles', async () => {
    vi.useFakeTimers()
    root = await mkdtemp(join(tmpdir(), 'delegated-production-settlement-wake-'))
    const dispatch = vi.fn(async (request: DelegationSettlementDispatch) => {
      void request
    })
    const harness = await createCompositionHarness(
      root,
      'codex',
      createDeterministicDelegateExecution(),
      undefined,
      { settlementContinuations: { dispatch } }
    )
    const leaseId = await harness.composition.root.rootTurnStarted?.({
      sessionId: harness.session.id,
      originatingPromptId: harness.caller.originMessageId
    })
    const delegated = await harness.composition.host.delegate(
      harness.caller,
      { task: 'finish later', name: 'Background check' },
      { wait: false }
    )
    await expect.poll(() => harness.execution.controls()).toHaveLength(1)
    harness.execution.controls()[0].accept()
    await harness.composition.root.rootTurnEnded?.({
      sessionId: harness.session.id,
      originatingPromptId: harness.caller.originMessageId,
      clean: true,
      leaseId
    })

    harness.execution.controls()[0].complete('canonical final')
    await expect
      .poll(() => harness.composition.host.children(harness.caller))
      .toMatchObject([{ status: 'completed' }])
    await vi.advanceTimersByTimeAsync(100)

    expect(dispatch).toHaveBeenCalledOnce()
    const request = dispatch.mock.calls[0]?.[0]
    expect(request).toMatchObject({
      projectId: harness.session.projectId,
      sessionId: harness.session.id,
      originatingPromptId: harness.caller.originMessageId,
      runtimeSegmentId: 'runtime-segment-session-codex'
    })
    expect(request?.text).toContain(delegated.children[0].frameId)
    expect(request?.text).toContain(delegated.children[0].attemptId)
    expect(request?.text).not.toContain('canonical final')
    expect(request?.text).toContain('application-owned context, not a user message')
    vi.useRealTimers()
  })

  it('wakes when a detached child settles before the originating root turn ends', async () => {
    vi.useFakeTimers()
    root = await mkdtemp(join(tmpdir(), 'delegated-production-early-settlement-wake-'))
    const dispatch = vi.fn(async (request: DelegationSettlementDispatch) => {
      void request
    })
    const harness = await createCompositionHarness(
      root,
      'codex',
      createDeterministicDelegateExecution(),
      undefined,
      { settlementContinuations: { dispatch } }
    )
    const leaseId = await harness.composition.root.rootTurnStarted?.({
      sessionId: harness.session.id,
      originatingPromptId: harness.caller.originMessageId
    })
    const receipt = await harness.composition.host.delegate(
      harness.caller,
      { task: 'finish before root end', name: 'Fast background check' },
      { wait: false }
    )
    const detached = receipt.children[0]
    await expect.poll(() => harness.execution.controls()).toHaveLength(1)
    harness.execution.control(detached.attemptId).accept()
    harness.execution.control(detached.attemptId).complete('fast canonical final')
    await expect
      .poll(() => harness.composition.host.children(harness.caller))
      .toMatchObject([{ status: 'completed' }])

    await harness.composition.root.rootTurnEnded?.({
      sessionId: harness.session.id,
      originatingPromptId: harness.caller.originMessageId,
      clean: true,
      leaseId
    })
    await vi.advanceTimersByTimeAsync(100)

    expect(dispatch).toHaveBeenCalledOnce()
    expect(dispatch.mock.calls[0]?.[0]?.text).toContain(detached.attemptId)
    expect(dispatch.mock.calls[0]?.[0]?.text).toContain('status=completed')
    vi.useRealTimers()
  })

  it('does not wake for terminal child results already returned in the originating root turn', async () => {
    root = await mkdtemp(join(tmpdir(), 'delegated-production-observed-settlement-'))
    const dispatch = vi.fn(async (request: DelegationSettlementDispatch) => {
      void request
    })
    const harness = await createCompositionHarness(
      root,
      'codex',
      createDeterministicDelegateExecution(),
      undefined,
      { settlementContinuations: { dispatch } }
    )
    const leaseId = await harness.composition.root.rootTurnStarted?.({
      sessionId: harness.session.id,
      originatingPromptId: harness.caller.originMessageId
    })
    const receipt = await harness.composition.host.delegate(
      harness.caller,
      { task: 'collect before root end', name: 'Collected child' },
      { wait: false }
    )
    const collectedChild = receipt.children[0]
    const collecting = harness.composition.host.collect(
      { ...harness.caller, toolInvocationId: 'observe-terminal-child' },
      [collectedChild]
    )
    await expect.poll(() => harness.execution.controls()).toHaveLength(1)
    harness.execution.control(collectedChild.attemptId).accept()
    harness.execution.control(collectedChild.attemptId).complete('observed result')
    await expect(collecting).resolves.toMatchObject([{ status: 'completed' }])

    const waited = harness.composition.host.delegate(
      { ...harness.caller, toolInvocationId: 'wait-for-terminal-child' },
      { task: 'return normally', name: 'Waited child' },
      {}
    )
    await expect.poll(() => harness.execution.controls()).toHaveLength(2)
    const waitedControl = harness.execution.controls()[1]
    waitedControl.accept()
    waitedControl.complete('waited result')
    await expect(waited).resolves.toMatchObject({ kind: 'results' })

    vi.useFakeTimers()
    await harness.composition.root.rootTurnEnded?.({
      sessionId: harness.session.id,
      originatingPromptId: harness.caller.originMessageId,
      clean: true,
      leaseId
    })
    await vi.advanceTimersByTimeAsync(200)

    expect(dispatch).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })

  it('batches three staggered children without overlapping Session wake continuations', async () => {
    vi.useFakeTimers()
    root = await mkdtemp(join(tmpdir(), 'delegated-production-staggered-wake-'))
    const dispatch = vi.fn(async (request: DelegationSettlementDispatch) => {
      void request
    })
    const harness = await createCompositionHarness(
      root,
      'codex',
      createDeterministicDelegateExecution(),
      undefined,
      { settlementContinuations: { dispatch } }
    )
    const leaseId = await harness.composition.root.rootTurnStarted?.({
      sessionId: harness.session.id,
      originatingPromptId: harness.caller.originMessageId
    })
    const delegated = await harness.composition.host.delegate(
      harness.caller,
      [
        { task: 'alpha', name: 'Alpha' },
        { task: 'beta', name: 'Beta' },
        { task: 'gamma', name: 'Gamma' }
      ],
      { wait: false }
    )
    await expect.poll(() => harness.execution.controls()).toHaveLength(3)
    for (const { attemptId } of delegated.children) harness.execution.control(attemptId).accept()
    await harness.composition.root.rootTurnEnded?.({
      sessionId: harness.session.id,
      originatingPromptId: harness.caller.originMessageId,
      clean: true,
      leaseId
    })

    harness.execution.control(delegated.children[0].attemptId).complete('alpha result')
    harness.execution.control(delegated.children[1].attemptId).complete('beta result')
    await expect
      .poll(() => harness.composition.host.children(harness.caller))
      .toMatchObject([{ status: 'completed' }, { status: 'completed' }, { status: 'running' }])
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(100)

    expect(dispatch).toHaveBeenCalledOnce()
    const first = dispatch.mock.calls[0]?.[0]
    expect(first?.text).toContain(delegated.children[0].frameId)
    expect(first?.text).toContain(delegated.children[1].frameId)
    expect(first?.text).not.toContain(delegated.children[2].frameId)

    harness.execution.control(delegated.children[2].attemptId).complete('gamma result')
    await expect
      .poll(() => harness.composition.host.children(harness.caller))
      .toMatchObject([{ status: 'completed' }, { status: 'completed' }, { status: 'completed' }])
    await vi.advanceTimersByTimeAsync(200)
    expect(dispatch).toHaveBeenCalledOnce()

    await harness.composition.root.settlementPromptEnded?.(harness.session.id, first!.promptId)
    await vi.advanceTimersByTimeAsync(100)
    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(dispatch.mock.calls[1]?.[0]?.text).toContain(delegated.children[2].frameId)
    expect(dispatch.mock.calls[1]?.[0]?.text).toContain(
      'All watched Subagent Attempts have settled'
    )
    const second = dispatch.mock.calls[1]?.[0]
    await harness.composition.root.settlementPromptEnded?.(harness.session.id, second!.promptId)
    await vi.advanceTimersByTimeAsync(500)
    await harness.composition.root.settlementPromptEnded?.(harness.session.id, first!.promptId)
    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })

  it.each([
    ['codex', 'no-quit'],
    ['codex', 'conflict'],
    ['codex', 'renderer-failed'],
    ['codex', 'timeout'],
    ['codex', 'conflict-without-work'],
    ['claude-code', 'conflict'],
    ['opencode', 'conflict'],
    ['codebuddy', 'conflict']
  ] as const)(
    'continues new delegated work exactly once after a cancelled quit: %s / %s',
    async (frameworkId, finalSave) => {
      vi.useFakeTimers()
      clearApplicationShutdownTrigger()
      root = await mkdtemp(join(tmpdir(), 'delegated-quit-abort-'))
      const nextPromptId = 'root-message-after-quit'
      const harness = await createCompositionHarness(
        root,
        frameworkId,
        createDeterministicDelegateExecution(),
        undefined,
        { settlementContinuations: { dispatch: (request) => dispatch(request) } },
        [{ rootMessageId: nextPromptId, toolInvocationId: 'delegate-after-quit', createdAt: 3 }]
      )
      const durable = harness.durable()
      durable.conversationGraph!.messages.find(({ id }) => id === nextPromptId)!.runtimeSegmentId =
        durable.conversationGraph!.runtimeSegments[0].id
      harness.replaceDurable(durable)
      const snapshot: AcpStateSnapshot = {
        status: 'connected',
        cwd: '/workspace',
        sessionId: harness.session.id,
        sessionIds: [harness.session.id],
        events: [],
        pendingPermissions: [],
        permissionProfiles: {},
        permissionGrants: {},
        contextUsageBySession: {},
        promptInFlight: false,
        promptInFlightSessionIds: []
      }
      let callbacks!: AcpRuntimeCallbacks
      let turn = 0
      const receipts: Array<{ frameId: string; attemptId: string }> = []
      const finish = async (
        request: AcpPromptRequest,
        promptAttemptId: string | undefined,
        delegate: boolean
      ): Promise<{ stopReason: 'end_turn' }> => {
        const token = `turn-${++turn}`
        callbacks.onPromptStarted?.(request.sessionId, token, promptAttemptId)
        callbacks.onProviderPromptAccepted?.(request.sessionId, promptAttemptId)
        try {
          if (delegate) {
            const receipt = await harness.composition.host.delegate(
              {
                ...harness.caller,
                originMessageId: request.provenanceContext!.promptMessageId,
                toolInvocationId: `delegate-${token}`
              },
              { task: 'Check the result', name: token },
              { wait: false }
            )
            receipts.push(receipt.children[0])
          }
          return { stopReason: 'end_turn' }
        } finally {
          callbacks.onPromptEnded?.(request.sessionId, token)
        }
      }
      const sendAppContinuation = vi.fn((request: AcpPromptRequest, attempt?: string) =>
        finish(request, attempt, false)
      )
      const runtime = {
        getState: () => snapshot,
        getSnapshot: () => snapshot,
        getActivePromptSessions: () => [],
        getQuitBlockingPromptSessions: () => [],
        sendPrompt: (request: AcpPromptRequest, attempt?: string) => finish(request, attempt, true),
        sendAppContinuation,
        shutdown: () => undefined
      } as unknown as AcpRuntime
      const coordinator = new AcpRuntimeCoordinator(
        (runtimeCallbacks) => {
          callbacks = runtimeCallbacks
          return runtime
        },
        {},
        '',
        undefined,
        undefined,
        undefined,
        {},
        undefined,
        harness.composition.root
      )
      const dispatch = createDelegationSettlementContinuationDispatch({
        sendAppContinuationObserved: (request, accepted) =>
          coordinator.sendAppContinuationObserved(request, accepted),
        onPromptEnded: (sessionId, promptId) =>
          harness.composition.root.settlementPromptEnded?.(sessionId, promptId)
      })
      const prompt = (promptMessageId: string): Promise<unknown> =>
        coordinator.sendPrompt({
          sessionId: harness.session.id,
          text: 'Delegate a background check',
          provenanceContext: { promptMessageId }
        })
      try {
        if (finalSave !== 'no-quit') {
          if (finalSave !== 'conflict-without-work') {
            await prompt(harness.caller.originMessageId)
            await expect.poll(() => harness.execution.controls()).toHaveLength(1)
            harness.execution.control(receipts[0].attemptId).accept()
          }
          const app = Object.assign(new EventEmitter(), { exit: vi.fn() })
          const window = Object.assign(new EventEmitter(), {
            isDestroyed: () => false,
            isMinimized: () => false,
            isVisible: () => true,
            show: vi.fn(),
            restore: vi.fn(),
            focus: vi.fn()
          })
          const flushSessionPersistence = vi
            .fn()
            .mockResolvedValueOnce('completed')
            .mockResolvedValueOnce(finalSave === 'conflict-without-work' ? 'conflict' : finalSave)
          const prepareForQuit = vi.fn(() => coordinator.prepareForQuit())
          const abortQuitPreparation = vi.fn(() => coordinator.abortQuitPreparation())
          const shutdownBackends = vi.fn(async () => undefined)
          const confirmClose = vi.fn(async (variant: string) =>
            variant === 'persistence-failed' ? ('cancel' as const) : ('quit' as const)
          )
          const quit = (): void => {
            app.emit('before-quit', { preventDefault: vi.fn() })
          }
          installAppLifecycle({
            app: app as unknown as AppLifecycleDeps['app'],
            createMainWindow: () =>
              window as unknown as ReturnType<AppLifecycleDeps['createMainWindow']>,
            createTray: () => undefined,
            shutdownBackends,
            prepareForQuit,
            abortQuitPreparation,
            flushSessionPersistence,
            isMigrationInProgress: () => false,
            holdSettingsInstallAdmission: () => () => undefined,
            getActiveSettingsInstallId: () => undefined,
            quit,
            countWindows: () => 1,
            detectActiveSessions: () => [],
            hasActiveReviewerWork: () => false,
            createConfirmClose: () => confirmClose
          })
          quit()
          await expect.poll(() => window.focus).toHaveBeenCalledOnce()
          expect(flushSessionPersistence).toHaveBeenCalledTimes(2)
          expect(prepareForQuit).toHaveBeenCalledOnce()
          expect(abortQuitPreparation).toHaveBeenCalledOnce()
          expect(shutdownBackends).not.toHaveBeenCalled()
          expect(app.exit).not.toHaveBeenCalled()
          if (finalSave === 'timeout')
            expect(confirmClose).toHaveBeenCalledWith('persistence-failed', [])
          if (receipts[0]) {
            await expect(harness.composition.host.children(harness.caller)).resolves.toMatchObject([
              { attemptId: receipts[0].attemptId, status: 'cancelled' }
            ])
            // A late completion from the cancelled execution must not resurrect its notification.
            harness.execution.control(receipts[0].attemptId).complete('late old result')
          }
          await vi.advanceTimersByTimeAsync(200)
          expect(sendAppContinuation).not.toHaveBeenCalled()
        }
        await prompt(nextPromptId)
        await expect.poll(() => harness.execution.controls()).toHaveLength(receipts.length)
        const child = receipts.at(-1)!
        harness.execution.control(child.attemptId).accept()
        harness.execution.control(child.attemptId).complete('new result')
        await expect
          .poll(
            async () =>
              (await harness.composition.host.children(harness.caller)).find(
                ({ attemptId }) => attemptId === child.attemptId
              )?.status
          )
          .toBe('completed')
        await vi.advanceTimersByTimeAsync(100)
        expect(
          sendAppContinuation,
          'After staying in the app, a new completed child must automatically resume its root turn.'
        ).toHaveBeenCalledOnce()
        expect(sendAppContinuation.mock.calls[0][0].text).toContain(child.attemptId)
        expect(sendAppContinuation.mock.calls[0][0].provenanceContext?.promptMessageId).toBe(
          nextPromptId
        )
        await vi.advanceTimersByTimeAsync(500)
        expect(sendAppContinuation).toHaveBeenCalledOnce()
      } finally {
        await harness.composition.root.shutdown()
        clearApplicationShutdownTrigger()
      }
    }
  )

  it('runs same-turn collect and staggered settlement wakes through ACP admission and terminal callbacks', async () => {
    vi.useFakeTimers()
    root = await mkdtemp(join(tmpdir(), 'delegated-production-acp-settlement-chain-'))
    const productionDispatch: {
      current?: (request: DelegationSettlementDispatch) => Promise<void>
    } = {}
    const harness = await createCompositionHarness(
      root,
      'codex',
      createDeterministicDelegateExecution(),
      undefined,
      { settlementContinuations: { dispatch: (request) => productionDispatch.current!(request) } }
    )
    const snapshot: AcpStateSnapshot = {
      status: 'connected',
      cwd: '/workspace',
      sessionId: harness.session.id,
      sessionIds: [harness.session.id],
      events: [],
      pendingPermissions: [],
      permissionProfiles: {},
      permissionGrants: {},
      contextUsageBySession: {},
      promptInFlight: false,
      promptInFlightSessionIds: []
    }
    let callbacks!: AcpRuntimeCallbacks
    let turn = 0
    let modelTurnMode: 'same-turn' | 'background' | undefined
    let sameTurnHandle: Readonly<{ frameId: string; attemptId: string }> | undefined
    let sameTurnResult: Awaited<ReturnType<typeof harness.composition.host.collect>> | undefined
    let staggered: Awaited<ReturnType<typeof harness.composition.host.delegate>> | undefined
    const pendingContinuations: Array<{
      request: AcpPromptRequest
      resolve(response: { stopReason: 'end_turn' }): void
    }> = []
    const runTurn = (
      request: AcpPromptRequest,
      promptAttemptId: string | undefined,
      completion: Promise<{ stopReason: 'end_turn' }>
    ): Promise<{ stopReason: 'end_turn' }> => {
      const turnToken = `model-turn-${++turn}`
      callbacks.onPromptStarted?.(request.sessionId, turnToken, promptAttemptId)
      callbacks.onProviderPromptAccepted?.(request.sessionId, promptAttemptId)
      return completion.finally(() => callbacks.onPromptEnded?.(request.sessionId, turnToken))
    }
    const sendPrompt = vi.fn((request: AcpPromptRequest, promptAttemptId?: string) => {
      const completion = (async (): Promise<{ stopReason: 'end_turn' }> => {
        if (modelTurnMode === 'same-turn') {
          const receipt = await harness.composition.host.delegate(
            harness.caller,
            { task: 'Collect inside the model turn', name: 'Same-turn model child' },
            { wait: false }
          )
          sameTurnHandle = receipt.children[0]
          sameTurnResult = await harness.composition.host.collect(
            { ...harness.caller, toolInvocationId: 'model-same-turn-collect' },
            [sameTurnHandle]
          )
        } else if (modelTurnMode === 'background') {
          staggered = await harness.composition.host.delegate(
            { ...harness.caller, toolInvocationId: 'model-staggered-delegate' },
            [
              { task: 'alpha model', name: 'Alpha model' },
              { task: 'beta model', name: 'Beta model' },
              { task: 'gamma model', name: 'Gamma model' }
            ],
            { wait: false }
          )
        }
        return { stopReason: 'end_turn' }
      })()
      return runTurn(request, promptAttemptId, completion)
    })
    const sendAppContinuation = vi.fn((request: AcpPromptRequest, promptAttemptId?: string) => {
      let resolve!: (response: { stopReason: 'end_turn' }) => void
      const completion = new Promise<{ stopReason: 'end_turn' }>((done) => {
        resolve = done
      })
      pendingContinuations.push({ request, resolve })
      return runTurn(request, promptAttemptId, completion)
    })
    const runtime = {
      getSnapshot: () => snapshot,
      sendPrompt,
      sendAppContinuation
    } as unknown as AcpRuntime
    const coordinator = new AcpRuntimeCoordinator(
      (runtimeCallbacks) => {
        callbacks = runtimeCallbacks
        return runtime
      },
      {},
      '',
      undefined,
      undefined,
      undefined,
      {},
      undefined,
      harness.composition.root
    )
    const promptEnded: Array<Readonly<{ sessionId: string; promptId: string }>> = []
    productionDispatch.current = createDelegationSettlementContinuationDispatch({
      sendAppContinuationObserved: (request, onProviderPromptAccepted) =>
        coordinator.sendAppContinuationObserved(request, onProviderPromptAccepted),
      onPromptEnded: (sessionId, promptId) => {
        promptEnded.push({ sessionId, promptId })
        return harness.composition.root.settlementPromptEnded?.(sessionId, promptId)
      }
    })

    modelTurnMode = 'same-turn'
    const rootPrompt = coordinator.sendPrompt({
      sessionId: harness.session.id,
      text: 'Coordinate and collect',
      provenanceContext: { promptMessageId: harness.caller.originMessageId }
    })
    await expect.poll(() => sameTurnHandle).toBeDefined()
    await expect.poll(() => harness.execution.controls()).toHaveLength(1)
    harness.execution.control(sameTurnHandle!.attemptId).accept()
    harness.execution.control(sameTurnHandle!.attemptId).complete('same-turn model result')
    await vi.advanceTimersByTimeAsync(100)
    await rootPrompt
    expect(sameTurnResult).toMatchObject([
      { status: 'completed', response: 'same-turn model result' }
    ])
    sameTurnHandle = undefined

    modelTurnMode = 'background'
    await coordinator.sendPrompt({
      sessionId: harness.session.id,
      text: 'Start background model children',
      provenanceContext: { promptMessageId: harness.caller.originMessageId }
    })
    if (!staggered) throw new Error('Background model turn did not delegate children.')
    await expect.poll(() => harness.execution.controls()).toHaveLength(4)
    for (const child of staggered.children) harness.execution.control(child.attemptId).accept()
    let releaseAdmission!: () => void
    const admission = new Promise<void>((resolve) => {
      releaseAdmission = resolve
    })
    coordinator.setPromptDispatchAdmissionGuard(async (_sessionId, dispatch) => {
      await admission
      return dispatch()
    })

    harness.execution.control(staggered.children[0].attemptId).complete('alpha')
    harness.execution.control(staggered.children[1].attemptId).complete('beta')
    await expect
      .poll(() => harness.composition.host.children(harness.caller))
      .toMatchObject([
        { status: 'completed' },
        { status: 'completed' },
        { status: 'completed' },
        { status: 'running' }
      ])
    await vi.advanceTimersByTimeAsync(100)
    expect(sendAppContinuation).not.toHaveBeenCalled()

    releaseAdmission()
    await expect.poll(() => pendingContinuations).toHaveLength(1)
    const first = pendingContinuations[0]
    expect(first.request).toMatchObject({
      sessionId: harness.session.id,
      suppressUserMessage: true,
      provenanceContext: {
        promptMessageId: harness.caller.originMessageId,
        originMessageId: harness.caller.originMessageId,
        rootFrameId: harness.caller.frameId,
        agentFrameId: harness.caller.frameId,
        messageAncestry: [harness.caller.originMessageId],
        runtimeSegmentId: 'runtime-segment-session-codex'
      }
    })
    harness.execution.control(staggered.children[2].attemptId).complete('gamma')
    await expect
      .poll(() => harness.composition.host.children(harness.caller))
      .toMatchObject([
        { status: 'completed' },
        { status: 'completed' },
        { status: 'completed' },
        { status: 'completed' }
      ])
    await vi.advanceTimersByTimeAsync(200)
    expect(pendingContinuations).toHaveLength(1)

    first.resolve({ stopReason: 'end_turn' })
    await expect
      .poll(() => promptEnded)
      .toContainEqual({
        sessionId: harness.session.id,
        promptId: expect.stringMatching(/^delegation-settlement-/u)
      })
    await vi.advanceTimersByTimeAsync(100)
    await expect.poll(() => pendingContinuations).toHaveLength(2)
    pendingContinuations[1].resolve({ stopReason: 'end_turn' })
    await expect.poll(() => promptEnded).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(200)
    expect(pendingContinuations).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })

  it('collects a background child to completion within the originating root turn', async () => {
    root = await mkdtemp(join(tmpdir(), 'delegated-production-same-turn-collect-'))
    const harness = await createCompositionHarness(root, 'codex')
    const receipt = await harness.composition.host.delegate(
      harness.caller,
      { task: 'Return during this turn', name: 'Same-turn child' },
      { wait: false }
    )
    const child = receipt.children[0]
    const collecting = harness.composition.host.collect(
      { ...harness.caller, toolInvocationId: 'same-turn-collect' },
      [{ frameId: child.frameId, attemptId: child.attemptId }]
    )
    await expect.poll(() => harness.execution.controls()).toHaveLength(1)
    harness.execution.control(child.attemptId).accept()
    harness.execution.control(child.attemptId).complete('same-turn result')

    await expect(collecting).resolves.toMatchObject([
      {
        frameId: child.frameId,
        attemptId: child.attemptId,
        status: 'completed',
        response: 'same-turn result'
      }
    ])
  })

  it.each(['branch', 'project', 'stopAll', 'shutdown'] as const)(
    'cancels a pending settlement wake on %s invalidation',
    async (scope) => {
      vi.useFakeTimers()
      root = await mkdtemp(join(tmpdir(), `delegated-production-${scope}-wake-invalidation-`))
      const dispatch = vi.fn(async (request: DelegationSettlementDispatch) => {
        void request
      })
      const harness = await createCompositionHarness(
        root,
        'codex',
        createDeterministicDelegateExecution(),
        undefined,
        { settlementContinuations: { dispatch } }
      )
      const leaseId = await harness.composition.root.rootTurnStarted?.({
        sessionId: harness.session.id,
        originatingPromptId: harness.caller.originMessageId
      })
      const receipt = await harness.composition.host.delegate(
        harness.caller,
        { task: `Invalidate ${scope} wake`, name: `${scope} invalidation child` },
        { wait: false }
      )
      const child = receipt.children[0]
      await expect.poll(() => harness.execution.controls()).toHaveLength(1)
      harness.execution.control(child.attemptId).accept()
      await harness.composition.root.rootTurnEnded?.({
        sessionId: harness.session.id,
        originatingPromptId: harness.caller.originMessageId,
        clean: true,
        leaseId
      })
      harness.execution.control(child.attemptId).complete('terminal before invalidation')
      await expect
        .poll(() => harness.composition.host.children(harness.caller))
        .toMatchObject([{ status: 'completed' }])

      if (scope === 'branch') {
        await harness.composition.root.cancelTurn?.(
          harness.session.id,
          harness.caller.originMessageId
        )
      } else if (scope === 'project') {
        await harness.composition.root.deleteProject(harness.session.projectId)
      } else {
        await harness.composition.root[scope]()
      }
      await vi.advanceTimersByTimeAsync(200)

      expect(dispatch).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
      if (scope === 'stopAll' || scope === 'shutdown') {
        const nextLease = await harness.composition.root.rootTurnStarted?.({
          sessionId: harness.session.id,
          originatingPromptId: harness.caller.originMessageId
        })
        if (scope === 'shutdown') expect(nextLease).toBeUndefined()
        else expect(nextLease).toEqual(expect.any(String))
        await harness.composition.root.shutdown()
      }
      vi.useRealTimers()
    }
  )

  it('lets a legacy Session without delegated history establish its durable framework identity', async () => {
    root = await mkdtemp(join(tmpdir(), 'delegated-production-legacy-identity-'))
    const harness = await createCompositionHarness(root, 'claude-code')
    const legacy = structuredClone(harness.session)
    delete legacy.agentFrameworkId
    harness.replaceDurable(legacy)

    await expect(harness.composition.root.wakeMessages?.(legacy.id)).resolves.toBeUndefined()
    expect(harness.selected).toEqual([])

    harness.replaceDurable({ ...harness.durable(), agentFrameworkId: 'claude-code' })
    await expect(harness.composition.root.wakeMessages?.(legacy.id)).resolves.toBeUndefined()
    expect(harness.selected).toEqual(['claude-code'])
  })

  it('certifies a CodeBuddy Session when waking delegated work', async () => {
    root = await mkdtemp(join(tmpdir(), 'delegated-production-codebuddy-wake-'))
    const harness = await createCompositionHarness(root, 'codebuddy')

    await expect(
      harness.composition.root.wakeMessages?.(harness.session.id)
    ).resolves.toBeUndefined()
    expect(harness.selected).toEqual(['codebuddy'])
  })

  it('rejects a missing framework identity when delegated history already exists', async () => {
    root = await mkdtemp(join(tmpdir(), 'delegated-production-invalid-identity-'))
    const harness = await createCompositionHarness(root, 'opencode')
    const invalid = structuredClone(harness.session)
    delete invalid.agentFrameworkId
    invalid.runtimeContext = {
      version: 1,
      revision: 1,
      delegatedWork: { records: [] }
    }
    harness.replaceDurable(invalid)

    await expect(harness.composition.root.wakeMessages?.(invalid.id)).rejects.toThrow(
      'Delegated Work requires a durable Session framework identity.'
    )
  })

  it('blocks only new child admission when the Session delegation policy is deny', async () => {
    root = await mkdtemp(join(tmpdir(), 'delegated-production-policy-'))
    const harness = await createCompositionHarness(root, 'codex')
    try {
      harness.replaceDurable({ ...harness.durable(), delegationPolicy: 'deny' })

      await expect(
        harness.composition.host.delegate(
          harness.caller,
          { task: 'blocked child', name: 'blocked child' },
          { wait: false }
        )
      ).rejects.toMatchObject({
        code: 'admission_rejection',
        message: DELEGATION_DISABLED_MESSAGE
      })
      expect(harness.execution.reservationCounts()).toEqual([])
      expect(harness.durable().runtimeContext?.delegatedWork?.records ?? []).toEqual([])

      harness.replaceDurable({ ...harness.durable(), delegationPolicy: 'allow' })
      const admitted = await harness.composition.host.delegate(
        harness.caller,
        { task: 'existing child', name: 'existing child' },
        { wait: false }
      )
      expect(admitted).toMatchObject({
        kind: 'receipts',
        children: [{ name: 'existing child' }]
      })

      harness.replaceDurable({ ...harness.durable(), delegationPolicy: 'deny' })
      await expect(harness.composition.host.children(harness.caller)).resolves.toEqual([
        expect.objectContaining({ name: 'existing child' })
      ])
    } finally {
      await harness.composition.root.stopAll()
    }
  })

  it('waits for pending workspace preparation before stopAll resolves', async () => {
    root = await mkdtemp(join(tmpdir(), 'delegated-production-pending-preparation-'))
    const inputPath = join(root, 'input.txt')
    await writeFile(inputPath, 'immutable input\n', 'utf8')
    const inputResolutionStarted = Promise.withResolvers<void>()
    const releaseInputResolution = Promise.withResolvers<void>()
    let inputResolutionCount = 0
    const harness = await createCompositionHarness(
      root,
      'codex',
      undefined,
      undefined,
      {},
      [],
      undefined,
      undefined,
      async (identity) => {
        if (identity !== 'upload-version:stopping-input') throw new Error('unknown input')
        inputResolutionCount += 1
        if (inputResolutionCount === 1) return { path: inputPath, filename: 'input.txt' }
        inputResolutionStarted.resolve()
        await releaseInputResolution.promise
        return { path: inputPath, filename: 'input.txt' }
      }
    )
    const delegated = harness.composition.host.delegate(
      harness.caller,
      {
        task: 'pending workspace preparation',
        name: 'pending workspace preparation',
        inputs: ['upload-version:stopping-input']
      },
      { wait: true }
    )
    await inputResolutionStarted.promise

    let stopped = false
    const stopping = harness.composition.root.stopAll().then(() => {
      stopped = true
    })
    try {
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(stopped).toBe(false)
    } finally {
      releaseInputResolution.resolve()
      await stopping
      await delegated.catch(() => undefined)
      await harness.composition.root.deleteSession(harness.session.id)
    }
  })

  it('marks a policy rejection as delegation-disabled and clears it when Delegation is re-enabled', async () => {
    root = await mkdtemp(join(tmpdir(), 'delegated-production-policy-notice-'))
    const harness = await createCompositionHarness(root, 'codex')
    harness.replaceDurable({ ...harness.durable(), delegationPolicy: 'deny' })

    await expect(
      harness.composition.host.delegate(
        harness.caller,
        { task: 'blocked child', name: 'blocked child' },
        { wait: false }
      )
    ).rejects.toMatchObject({ code: 'admission_rejection' })
    expect(harness.composition.root.unavailableReasons?.()).toEqual({
      [harness.session.id]: { kind: 'delegation-disabled', reason: DELEGATION_DISABLED_MESSAGE }
    })

    const events: string[] = []
    const unsubscribe = harness.composition.root.subscribe((event) => events.push(event.kind))
    harness.composition.root.clearUnavailableReason?.(harness.session.id)
    unsubscribe()
    expect(harness.composition.root.unavailableReasons?.()).toEqual({})
    expect(events).toEqual(['unavailable-reason-cleared'])
    // Clearing again is a no-op: the cleared reason must not re-announce itself.
    harness.composition.root.clearUnavailableReason?.(harness.session.id)
    expect(harness.composition.root.unavailableReasons?.()).toEqual({})
  })

  it('projects and enforces the current authoritative policy through the Host SDK', async () => {
    root = await mkdtemp(join(tmpdir(), 'delegated-production-host-policy-'))
    const harness = await createCompositionHarness(root, 'codex')
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      delegatedWorkService: harness.composition.host
    })
    const graph = harness.durable().conversationGraph!
    const connection = await server.issueControlConnection(
      harness.session.id,
      harness.session.projectId,
      graph.rootFrameId
    )
    const endInvocation = connection.beginControlInvocation({
      turnId: 'turn-1',
      controlInvocationGeneration: 1,
      toolInvocationId: 'delegate-call',
      originatingUserMessageId: harness.caller.originMessageId
    })
    const call = (method: string, params: Record<string, unknown> = {}): Promise<Response> =>
      fetch(connection.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ method, params })
      })

    await expect(
      call('capabilitiesCall').then((response) => response.json())
    ).resolves.toMatchObject({
      result: { delegate: true, children: true, collect: true, stopChild: true }
    })

    harness.replaceDurable({ ...harness.durable(), delegationPolicy: 'deny' })
    await expect(
      call('capabilitiesCall').then((response) => response.json())
    ).resolves.toMatchObject({
      result: { delegate: false, children: true, collect: true, stopChild: true }
    })
    await expect(
      call('hostSdkHelp', { query: 'delegate' }).then((response) => response.json())
    ).resolves.toMatchObject({
      result: {
        id: 'host.delegate',
        availability: {
          status: 'unavailable',
          reason: DELEGATION_DISABLED_MESSAGE
        }
      }
    })
    await expect(
      call('delegatedWorkCall', {
        request: { task: 'must not start', name: 'must not start' },
        options: { wait: false }
      }).then(async (response) => ({ status: response.status, payload: await response.json() }))
    ).resolves.toEqual({
      status: 500,
      payload: {
        error: DELEGATION_DISABLED_MESSAGE
      }
    })
    expect(harness.execution.reservationCounts()).toEqual([])
    expect(harness.durable().runtimeContext?.delegatedWork?.records ?? []).toEqual([])

    endInvocation()
    connection.release()
  })

  it('rechecks authoritative delegation policy inside durable child admission', async () => {
    root = await mkdtemp(join(tmpdir(), 'delegated-production-policy-race-'))
    const harness = await createCompositionHarness(root, 'codex')
    let firstRead = true
    const racingComposition = createProductionDelegatedWorkComposition({
      dataRoot: root,
      sessions: {
        commands: harness.commands,
        readSession: async () => {
          const snapshot = structuredClone(harness.durable())
          if (firstRead) {
            firstRead = false
            harness.replaceDurable({ ...snapshot, delegationPolicy: 'deny' })
          }
          return snapshot
        }
      },
      resolveInput: async () => {
        throw new Error('no inputs')
      },
      frameworks: {
        async forSession(current) {
          return {
            frameworkId: current.agentFrameworkId!,
            execution: harness.execution,
            assertAvailable: async () => undefined
          }
        }
      },
      resolveExecutionModel: async () => testExecutionModel('codex')
    })

    await expect(
      racingComposition.host.delegate(
        harness.caller,
        { task: 'racing child', name: 'racing child' },
        { wait: false }
      )
    ).rejects.toMatchObject({
      code: 'admission_rejection',
      message: DELEGATION_DISABLED_MESSAGE
    })
    expect(harness.durable().runtimeContext?.delegatedWork?.records ?? []).toEqual([])
  })

  it('rejects a removed own context field before reservation, workspace, or durable mutation', async () => {
    root = await mkdtemp(join(tmpdir(), 'delegated-production-removed-context-'))
    const harness = await createCompositionHarness(root, 'codex')

    await expect(
      harness.composition.host.delegate(
        harness.caller,
        [
          { task: 'valid sibling', name: 'valid sibling' },
          { task: 'legacy child', name: 'legacy child', context: 'legacy detail' } as never
        ],
        { wait: false }
      )
    ).rejects.toMatchObject({
      code: 'admission_rejection',
      message: expect.stringMatching(/context.*removed.*task/i)
    })
    expect(harness.execution.reservationCounts()).toEqual([])
    expect(harness.durable().runtimeContext?.delegatedWork?.records ?? []).toEqual([])
    await expect(access(join(root, 'delegation', 'project-1'))).rejects.toThrow()
  })

  it('requires non-emoji names and persists caller-chosen unique names across production reopen', async () => {
    root = await mkdtemp(join(tmpdir(), 'delegated-production-naming-'))
    const harness = await createCompositionHarness(root, 'codex')
    const task = `Trace sources\n${'full prompt detail '.repeat(20)}`

    await expect(
      harness.composition.host.delegate(harness.caller, { task } as never, { wait: false })
    ).rejects.toMatchObject({ code: 'admission_rejection' })
    await expect(
      harness.composition.host.delegate(
        { ...harness.caller, toolInvocationId: 'call-codex-emoji' },
        { task, name: 'Trace sources 🧪' },
        { wait: false }
      )
    ).rejects.toMatchObject({ code: 'admission_rejection' })
    expect(harness.execution.reservationCounts()).toEqual([])
    const first = await harness.composition.host.delegate(
      { ...harness.caller, toolInvocationId: 'call-codex-named' },
      { task, name: 'Source audit' },
      { wait: false }
    )
    const second = await harness
      .reopen()
      .host.delegate(
        { ...harness.caller, toolInvocationId: 'call-codex-reopened' },
        { task, name: 'Source audit 2' },
        { wait: false }
      )

    expect(first).toMatchObject({ kind: 'receipts', children: [{ name: 'Source audit' }] })
    expect(second).toMatchObject({ kind: 'receipts', children: [{ name: 'Source audit 2' }] })
    await expect(harness.reopen().host.children(harness.caller)).resolves.toMatchObject([
      { name: 'Source audit' },
      { name: 'Source audit 2' }
    ])
    expect(
      harness
        .durable()
        .conversationGraph?.frames.filter(({ kind }) => kind === 'delegate')
        .map(({ delegateName }) => delegateName)
    ).toEqual(['Source audit', 'Source audit 2'])
  })

  it('records the admitted cross-provider model on every child Runtime Segment', async () => {
    root = await mkdtemp(join(tmpdir(), 'delegated-production-model-snapshot-'))
    const execution = createDeterministicDelegateExecution()
    execution.plan({ status: 'completed', response: 'first complete' })
    execution.plan({ status: 'completed', response: 'second complete' })
    const resolveExecutionModel = vi.fn(async () => ({
      snapshot: {
        frameworkId: 'opencode' as const,
        providerId: 'provider-b',
        backendId: 'opencode:provider-b',
        modelRoute: 'opencode-openai' as const,
        model: 'model-b',
        reasoningEffort: 'high' as const
      }
    }))
    const harness = await createCompositionHarness(
      root,
      'opencode',
      execution,
      undefined,
      {},
      [],
      resolveExecutionModel
    )

    await harness.composition.host.delegate(harness.caller, [
      { task: 'first', name: 'first' },
      { task: 'second', name: 'second' }
    ])

    expect(resolveExecutionModel).toHaveBeenCalledOnce()
    expect(harness.durable().conversationGraph?.runtimeSegments.slice(-2)).toEqual([
      expect.objectContaining({
        frameworkId: 'opencode',
        backendId: 'opencode:provider-b',
        model: 'model-b'
      }),
      expect.objectContaining({
        frameworkId: 'opencode',
        backendId: 'opencode:provider-b',
        model: 'model-b'
      })
    ])
  })

  it('reuses the first admitted route for continuation after Settings change and restart', async () => {
    root = await mkdtemp(join(tmpdir(), 'delegated-production-model-continuation-'))
    const initialModel = {
      frameworkId: 'opencode' as const,
      providerId: 'provider-a',
      backendId: 'opencode:provider-a',
      modelRoute: 'opencode-openai' as const,
      model: 'model-a',
      reasoningEffort: 'high' as const
    }
    const harness = await createCompositionHarness(
      root,
      'opencode',
      undefined,
      undefined,
      {},
      [],
      async () => ({ snapshot: initialModel })
    )
    const receipt = await harness.composition.host.delegate(
      harness.caller,
      { task: 'Preserve admitted route', name: 'Preserve admitted route' },
      { wait: false }
    )
    if (receipt.kind !== 'receipts') throw new Error('expected a running receipt')
    await expect.poll(() => harness.execution.controls()).toHaveLength(1)
    harness.execution.controls()[0].accept()
    harness.execution.controls()[0].complete('Initial result')
    await expect
      .poll(() => harness.durable().runtimeContext?.delegatedWork?.records[0]?.attempts[0]?.status)
      .toBe('completed')

    const restartedExecution = createDeterministicDelegateExecution()
    const changedSettingsResolver = vi.fn(async () => ({
      snapshot: {
        ...initialModel,
        providerId: 'provider-b',
        backendId: 'opencode:provider-b',
        model: 'model-b'
      }
    }))
    const restarted = createProductionDelegatedWorkComposition({
      dataRoot: root,
      sessions: {
        commands: harness.commands,
        readSession: async () => harness.durable()
      },
      resolveInput: async () => {
        throw new Error('no inputs')
      },
      frameworks: {
        async forSession(current) {
          return {
            frameworkId: current.agentFrameworkId!,
            execution: restartedExecution,
            assertAvailable: async () => undefined
          }
        }
      },
      resolveExecutionModel: changedSettingsResolver
    })
    const continued = await restarted.host.sendMessage(
      harness.caller,
      receipt.children[0].frameId,
      'Continue with the same route'
    )
    if (continued.disposition !== 'continued') throw new Error('expected continuation')
    await expect.poll(() => restartedExecution.controls()).toHaveLength(1)

    const attempts = harness.durable().runtimeContext?.delegatedWork?.records[0]?.attempts
    expect(attempts).toHaveLength(2)
    expect(attempts?.[1]?.executionModel).toEqual(initialModel)
    expect(restartedExecution.controls()[0].input.executionModel).toEqual(initialModel)
    expect(changedSettingsResolver).not.toHaveBeenCalled()
  })

  it('fails a validation-failed fixed model before workspace, reservation, or durable child creation', async () => {
    root = await mkdtemp(join(tmpdir(), 'delegated-production-model-unavailable-'))
    const execution = createDeterministicDelegateExecution()
    const harness = await createCompositionHarness(
      root,
      'opencode',
      execution,
      undefined,
      {},
      [],
      async () => {
        throw new Error('provider validation failed')
      }
    )

    await expect(
      harness.composition.host.delegate(harness.caller, {
        task: 'must not exist',
        name: 'must not exist'
      })
    ).rejects.toMatchObject({
      code: 'admission_rejection',
      userFacingUnavailableReason: expect.stringContaining('Settings → Model → Scenario models')
    })
    expect(execution.reservationCounts()).toEqual([])
    expect(harness.durable().runtimeContext?.delegatedWork?.records ?? []).toEqual([])
    await expect(access(join(root, 'delegation', 'project-1'))).rejects.toThrow()
  })

  it('rejects a missing originating runtime owner without capturing Active or creating children', async () => {
    root = await mkdtemp(join(tmpdir(), 'delegated-production-missing-runtime-owner-'))
    const execution = createDeterministicDelegateExecution()
    const harness = await createCompositionHarness(
      root,
      'opencode',
      execution,
      undefined,
      {},
      [],
      async () => {
        throw new Error('The originating Session runtime is unavailable.')
      }
    )

    await expect(
      harness.composition.host.delegate(harness.caller, {
        task: 'must not exist',
        name: 'must not exist'
      })
    ).rejects.toMatchObject({
      code: 'admission_rejection',
      userFacingUnavailableReason: expect.stringContaining('Settings → Model → Scenario models')
    })
    expect(execution.reservationCounts()).toEqual([])
    expect(harness.durable().runtimeContext?.delegatedWork?.records ?? []).toEqual([])
    await expect(access(join(root, 'delegation', 'project-1'))).rejects.toThrow()
  })

  it.each(['codex', 'claude-code', 'opencode'] as const)(
    'routes delegated user questions through the %s production execution adapter',
    async (frameworkId) => {
      root = await mkdtemp(join(tmpdir(), `delegated-framework-question-${frameworkId}-`))
      const harness = await createFrameworkCompositionHarness(root, frameworkId)
      const rootMessageCount = harness
        .durable()
        .conversationGraph!.messages.filter(
          (message) => message.agentFrameId === harness.caller.frameId
        ).length
      const dispatched = await harness.composition.host.delegate(
        harness.caller,
        { task: 'Ask for framework scope', name: `Question ${frameworkId}` },
        { wait: false }
      )
      if (dispatched.kind !== 'receipts') throw new Error('Question child was not dispatched.')
      await expect.poll(() => harness.controls.size).toBe(1)
      const source = [...harness.controls.values()][0]
      await source.askUser()
      await source.complete({ submit: false, text: 'Waiting for the user.' })
      await expect
        .poll(() => harness.durable().runtimeContext?.delegatedWork?.questionRequests?.[0]?.status)
        .toBe('pending')
      const question = harness.durable().runtimeContext!.delegatedWork!.questionRequests![0]

      await harness.composition.root.respondQuestion?.({
        projectId: harness.session.projectId,
        sessionId: harness.session.id,
        requestId: question.requestId,
        action: 'confirm',
        answers: [{ questionIndex: 0, value: 'Focused' }]
      })

      await expect.poll(() => harness.controls.size).toBe(2)
      const continuation = [...harness.controls.values()].find(
        (control) => control.input.attemptId !== source.input.attemptId
      )!
      expect(continuation.input.frameId).toBe(source.input.frameId)
      expect(continuation.input.task).toContain('Answer: Focused')
      await continuation.complete({ submit: false, text: 'Framework question continued.' })
      await expect
        .poll(() => harness.durable().runtimeContext?.delegatedWork?.questionRequests?.[0]?.status)
        .toBe('confirmed')
      expect(
        harness
          .durable()
          .conversationGraph?.messages.filter(
            (message) => message.agentFrameId === harness.caller.frameId
          )
      ).toHaveLength(rootMessageCount)
    }
  )

  it.each(['codex', 'claude-code', 'opencode'] as const)(
    'runs %s structured output through its production execution adapter and child RPC capability',
    async (frameworkId) => {
      root = await mkdtemp(join(tmpdir(), `delegated-framework-structured-${frameworkId}-`))
      const harness = await createFrameworkCompositionHarness(root, frameworkId)
      const pending = harness.composition.host.delegate(harness.caller, {
        task: 'Return a structured count',
        name: `Structured count ${frameworkId}`,
        inputs: ['upload-version:framework-input'],
        outputSchema: {
          type: 'object',
          required: ['count'],
          properties: { count: { type: 'number' } },
          additionalProperties: false
        }
      })
      await expect.poll(() => harness.controls.size).toBe(1)
      const control = [...harness.controls.values()][0]
      await expect.poll(() => control.prompts).toHaveLength(1)
      await expect(
        readFile(join(control.input.workspaceCwd!, 'inputs', '01-framework-input.txt'), 'utf8')
      ).resolves.toBe('framework evidence\n')
      const initialPrompt = control.prompts[0]
      expect(initialPrompt).toContain('Return a structured count')
      expect(initialPrompt).toContain('read-only ./inputs/')
      expect(initialPrompt).toContain('host.submitOutput(value)')
      expect(initialPrompt.indexOf('Return a structured count')).toBeLessThan(
        initialPrompt.indexOf('read-only ./inputs/')
      )
      expect(initialPrompt.indexOf('read-only ./inputs/')).toBeLessThan(
        initialPrompt.indexOf('host.submitOutput(value)')
      )
      expect(initialPrompt).not.toContain(control.input.workspaceCwd!)
      expect(initialPrompt).not.toContain('upload-version:framework-input')
      await control.complete()
      const result = await pending
      expect(result).toMatchObject({
        kind: 'results',
        children: [
          {
            status: 'completed',
            response: 'Structured framework child completed.',
            structuredOutput: { count: 3 },
            structuredOutputUnsatisfied: false
          }
        ]
      })
      if (result.kind !== 'results') throw new Error('Blocking framework journey did not finish.')
      const child = result.children[0]
      await expect(
        harness
          .reopen()
          .host.collect(harness.caller, [{ frameId: child.frameId, attemptId: child.attemptId }])
      ).resolves.toMatchObject([
        {
          status: 'completed',
          response: 'Structured framework child completed.',
          structuredOutput: { count: 3 }
        }
      ])
      await harness.composition.root.deleteSession(harness.session.id)
    }
  )

  it('keeps a pinned structured result historical across continuation, missing output, reopen, and rollback', async () => {
    root = await mkdtemp(join(tmpdir(), 'delegated-framework-structured-reopen-'))
    const harness = await createFrameworkCompositionHarness(root, 'opencode')
    const initialTask = 'Return a structured count asynchronously'
    const receipt = await harness.composition.host.delegate(
      harness.caller,
      {
        task: initialTask,
        name: initialTask,
        outputSchema: {
          type: 'object',
          required: ['count'],
          properties: { count: { type: 'number' } },
          additionalProperties: false
        }
      },
      { wait: false }
    )
    const child = receipt.children[0]
    const minimalRunning = {
      frameId: child.frameId,
      attemptId: child.attemptId,
      name: initialTask,
      agentName: 'Main Agent',
      status: 'running' as const
    }
    expect(receipt).toEqual({ kind: 'receipts', children: [minimalRunning] })
    const running = await harness.composition.host.collect(harness.caller, [child.frameId], {
      timeoutSeconds: 0
    })
    expect(running).toEqual([minimalRunning])
    await expect(
      harness.composition.host.children(harness.caller, [child.frameId])
    ).resolves.toEqual([{ ...minimalRunning, title: initialTask }])
    await expect.poll(() => harness.controls.has(child.attemptId)).toBe(true)
    const initialControl = harness.controls.get(child.attemptId)!
    await initialControl.submitInvalid()
    const afterInvalid = await harness.composition.host.collect(harness.caller, [child.frameId], {
      timeoutSeconds: 0
    })
    expect(afterInvalid).toEqual([minimalRunning])
    const childrenAfterInvalid = await harness.composition.host.children(harness.caller, [
      child.frameId
    ])
    expect(childrenAfterInvalid).toEqual([{ ...minimalRunning, title: initialTask }])

    await initialControl.submitValid()
    const afterAccepted = await harness.composition.host.collect(harness.caller, [child.frameId], {
      timeoutSeconds: 0
    })
    expect(afterAccepted).toEqual([minimalRunning])
    const childrenAfterAccepted = await harness.composition.host.children(harness.caller, [
      child.frameId
    ])
    expect(childrenAfterAccepted).toEqual([{ ...minimalRunning, title: initialTask }])
    await initialControl.complete({ submit: false, text: 'Initial value' })
    await expect(
      harness.composition.host.collect(harness.caller, [
        { frameId: child.frameId, attemptId: child.attemptId }
      ])
    ).resolves.toMatchObject([
      { status: 'completed', response: 'Initial value', structuredOutput: { count: 3 } }
    ])

    const continued = await harness.composition.host.sendMessage(
      {
        ...harness.caller,
        originMessageId: 'root-message-framework-continuation',
        toolInvocationId: 'call-framework-continuation'
      },
      child.frameId,
      'Continue without inheriting the schema',
      { kind: 'info' }
    )
    expect(continued.disposition).toBe('continued')
    if (continued.disposition !== 'continued') throw new Error('Expected a continued Attempt.')
    await expect.poll(() => harness.controls.has(continued.continuation_attempt_id)).toBe(true)
    const continuationRunning = await harness.composition.host.collect(
      harness.caller,
      [continued.target_frame_id],
      { timeoutSeconds: 0 }
    )
    expect(continuationRunning[0]).not.toHaveProperty('structuredOutput')
    expect(continuationRunning[0]).not.toHaveProperty('structuredOutputUnsatisfied')
    await harness.controls
      .get(continued.continuation_attempt_id)!
      .complete({ submit: false, text: 'Continuation without schema' })
    const continuationTerminal = await harness.composition.host.collect(harness.caller, [
      continued.target_frame_id
    ])
    expect(continuationTerminal[0]).toMatchObject({
      status: 'completed',
      response: 'Continuation without schema'
    })
    expect(continuationTerminal[0]).not.toHaveProperty('structuredOutput')
    expect(continuationTerminal[0]).not.toHaveProperty('structuredOutputUnsatisfied')

    await expect(
      harness
        .reopen()
        .host.collect(harness.caller, [{ frameId: child.frameId, attemptId: child.attemptId }])
    ).resolves.toMatchObject([
      { status: 'completed', response: 'Initial value', structuredOutput: { count: 3 } }
    ])

    const missing = await harness.composition.host.delegate(
      { ...harness.caller, toolInvocationId: 'missing-output-call' },
      {
        task: 'Omit a structured number',
        name: 'Omit a structured number',
        outputSchema: { type: 'number' }
      },
      { wait: false }
    )
    await expect.poll(() => harness.controls.has(missing.children[0].attemptId)).toBe(true)
    await harness.controls
      .get(missing.children[0].attemptId)!
      .complete({ submit: false, text: 'No value' })
    await expect(
      harness.composition.host.collect(harness.caller, [missing.children[0].frameId])
    ).resolves.toMatchObject([
      { status: 'completed', response: 'No value', structuredOutputUnsatisfied: true }
    ])

    harness.replaceDurable(preS6ReaderSave(harness.durable()))
    const rolledBack = await harness
      .reopen()
      .host.collect(harness.caller, [{ frameId: child.frameId, attemptId: child.attemptId }])
    expect(rolledBack).toEqual([
      expect.objectContaining({ status: 'completed', response: 'Initial value' })
    ])
    expect(rolledBack[0]).not.toHaveProperty('structuredOutput')
    expect(rolledBack[0]).not.toHaveProperty('structuredOutputUnsatisfied')
  })

  it.each(['codex', 'claude-code', 'opencode'] as const)(
    'projects submitted structured output through the %s production-composed Owner',
    async (frameworkId) => {
      root = await mkdtemp(join(tmpdir(), `delegated-structured-${frameworkId}-`))
      const harness = await createCompositionHarness(root, frameworkId)
      const pending = harness.composition.host.delegate(harness.caller, {
        task: 'Extract a count',
        name: `Extract count ${frameworkId}`,
        outputSchema: {
          type: 'object',
          required: ['count'],
          properties: { count: { type: 'number' } },
          additionalProperties: false
        }
      })
      await expect.poll(() => harness.execution.controls()).toHaveLength(1)
      const control = harness.execution.controls()[0]
      await expect(
        harness.composition.host.submitOutput(
          {
            ...harness.caller,
            role: 'delegate',
            frameId: control.input.frameId,
            attemptId: control.input.attemptId,
            toolInvocationId: 'child-invalid-submit'
          },
          { count: 'three' }
        )
      ).rejects.toMatchObject({ code: 'structured_output_validation_failed' })
      await expect(
        harness.composition.host.submitOutput(
          {
            ...harness.caller,
            role: 'delegate',
            frameId: control.input.frameId,
            attemptId: control.input.attemptId,
            toolInvocationId: 'child-submit'
          },
          { count: 3 }
        )
      ).resolves.toEqual({ accepted: true })
      control.complete('Found three records')
      await expect(pending).resolves.toMatchObject({
        kind: 'results',
        children: [
          {
            status: 'completed',
            response: 'Found three records',
            artifactsCreated: [],
            structuredOutput: { count: 3 },
            structuredOutputUnsatisfied: false
          }
        ]
      })
      const persistedPrompt = harness
        .durable()
        .conversationGraph?.messages.find(
          (message) => message.structuredOutputEvidence?.attemptId === control.input.attemptId
        )
      expect(persistedPrompt?.structuredOutputEvidence).toMatchObject({
        dialect: '2020-12',
        profile: 'ajv-8-draft-2020-12-v1',
        accepted: { value: { count: 3 } }
      })

      const dispatched = await harness.composition.host.delegate(
        { ...harness.caller, toolInvocationId: 'missing-output-dispatch' },
        { task: 'May omit', name: 'May omit', outputSchema: { type: 'number' } },
        { wait: false }
      )
      await expect(
        harness.composition.host.collect(harness.caller, [dispatched.children[0].frameId], {
          timeoutSeconds: 0
        })
      ).resolves.toEqual([expect.not.objectContaining({ structuredOutputUnsatisfied: true })])
      await expect.poll(() => harness.execution.controls()).toHaveLength(2)
      harness.execution.control(dispatched.children[0].attemptId).complete('No structured value')
      await expect(
        harness.composition.host.collect(harness.caller, [
          {
            frameId: dispatched.children[0].frameId,
            attemptId: dispatched.children[0].attemptId
          }
        ])
      ).resolves.toMatchObject([
        {
          status: 'completed',
          response: 'No structured value',
          structuredOutputUnsatisfied: true
        }
      ])
    }
  )

  it('fails an in-flight collect closed after a production Session branch switch without stopping the child', async () => {
    root = await mkdtemp(join(tmpdir(), 'delegated-production-branch-race-'))
    const harness = await createCompositionHarness(root, 'codex')
    const receipt = await harness.composition.host.delegate(
      harness.caller,
      {
        task: 'Keep running across observation expiry',
        name: 'Keep running across observation expiry'
      },
      { wait: false }
    )
    await expect.poll(() => harness.execution.controls()).toHaveLength(1)
    harness.execution.controls()[0].accept()

    const collecting = harness.composition.host.collect(
      harness.caller,
      [receipt.children[0].frameId],
      { timeoutSeconds: 1 }
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    const switched = structuredClone(harness.durable())
    const graph = switched.conversationGraph!
    const activeBranchId = graph.frames.find(({ id }) => id === graph.rootFrameId)!.activeBranchId
    const forked = forkEditedConversationMessage(
      graph,
      harness.caller.originMessageId,
      'alternate-root-branch',
      50
    )
    switched.conversationGraph = synchronizeActiveConversationMessages(
      forked,
      [
        {
          id: 'alternate-root-message',
          role: 'user',
          content: 'Alternate branch',
          status: 'complete',
          eventIds: [],
          createdAt: 50,
          updatedAt: 50
        }
      ],
      50
    )
    switched.messages = [
      {
        id: 'alternate-root-message',
        role: 'user',
        content: 'Alternate branch',
        status: 'complete',
        eventIds: [],
        createdAt: 50,
        updatedAt: 50
      }
    ]
    harness.replaceDurable(switched)

    await expect(collecting).rejects.toMatchObject({ code: 'authorization' })
    const alternateCaller = {
      ...harness.caller,
      originMessageId: 'alternate-root-message',
      toolInvocationId: 'alternate-branch-read'
    }
    await expect(harness.composition.host.children(alternateCaller)).resolves.toEqual([])
    await expect(
      harness.composition.root.stopActiveBranch?.(harness.session.id)
    ).resolves.toBeUndefined()
    expect(harness.durable().runtimeContext?.delegatedWork?.records[0].attempts[0].status).toBe(
      'running'
    )
    await expect(
      harness.composition.host.collect(alternateCaller, [receipt.children[0].frameId], {
        timeoutSeconds: 0
      })
    ).rejects.toMatchObject({ code: 'authorization' })
    expect(harness.execution.controls()[0].input.attemptId).toBe(receipt.children[0].attemptId)

    const restored = structuredClone(harness.durable())
    restored.conversationGraph = activateConversationBranch(
      restored.conversationGraph!,
      activeBranchId
    )
    restored.messages = structuredClone(harness.session.messages)
    harness.replaceDurable(restored)
    await expect(
      harness.composition.host.collect(harness.caller, [receipt.children[0].frameId], {
        timeoutSeconds: 0
      })
    ).resolves.toMatchObject([{ status: 'running' }])
  })

  it('runs authenticated Host delegation through durable Session records and a staged Frame cwd', async () => {
    root = await mkdtemp(join(tmpdir(), 'delegated-production-composition-'))
    const rootMessage = {
      id: 'root-message',
      role: 'user' as const,
      content: 'Coordinate evidence.',
      status: 'complete' as const,
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    }
    const session: PersistedChatSession = {
      id: 'session-1',
      projectId: 'project-1',
      title: 'Delegation',
      cwd: '/root-workspace',
      status: 'idle',
      agentFrameworkId: 'codex',
      messages: [rootMessage],
      conversationGraph: createLinearConversationGraph({
        sessionId: 'session-1',
        messages: [rootMessage],
        frameworkId: 'codex',
        createdAt: 1,
        updatedAt: 1
      }),
      filesRevision: 1,
      createdAt: 1,
      updatedAt: 2
    }
    let durable = structuredClone(session)
    const repository: SessionMutationRepository = {
      loadAllWithDiagnostics: async () => ({
        result: { sessions: [structuredClone(durable)], manifest: { version: 1 } },
        isComplete: true
      }),
      loadProjectWithDiagnostics: async () => ({
        sessions: [structuredClone(durable)],
        isComplete: true
      }),
      loadCommittedProjectWithDiagnostics: async () => ({ sessions: [], isComplete: true }),
      loadSessionWithDiagnostics: async () => ({
        status: 'found',
        session: structuredClone(durable)
      }),
      assertSessionIdentityOwnership: async () => undefined,
      saveSession: async (next) => {
        durable = structuredClone(next)
      },
      saveCommittedProjectSession: async () => undefined,
      deleteSession: async () => undefined,
      deleteProjectSessions: async () => undefined,
      getProjectSessionDeletionState: async () => 'absent',
      markCommittedProjectSessionsPrepared: async () => undefined,
      completeProjectSessionDeletion: async () => undefined,
      listLegacyProjectSessionTombstones: async () => [],
      saveManifest: async () => undefined
    }
    const coordinator = new SessionPersistenceCoordinator(repository, fileIndex)
    const upload = join(root, 'immutable-upload.csv')
    await writeFile(upload, 'sample,value\na,1\n')
    const execution = createDeterministicDelegateExecution()
    execution.plan({ status: 'completed', response: 'staged evidence inspected' })
    const selected: string[] = []
    const composition = createProductionDelegatedWorkComposition({
      dataRoot: root,
      sessions: {
        commands: coordinator,
        readSession: async () => structuredClone(durable)
      },
      resolveInput: async (identity) => {
        if (identity !== 'upload-version:version-1') throw new Error('unknown Version')
        return { path: upload, filename: 'evidence.csv' }
      },
      frameworks: {
        async forSession(durableSession) {
          selected.push(durableSession.agentFrameworkId ?? '')
          return {
            frameworkId: durableSession.agentFrameworkId!,
            execution,
            assertAvailable: async () => undefined
          }
        }
      },
      resolveExecutionModel: async () => testExecutionModel('codex')
    })
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      delegatedWorkService: composition.host
    })
    const graph = session.conversationGraph!
    const connection = await server.issueControlConnection(
      session.id,
      session.projectId,
      graph.rootFrameId
    )
    const endInvocation = connection.beginControlInvocation({
      turnId: 'turn-1',
      controlInvocationGeneration: 1,
      toolInvocationId: 'delegate-call',
      originatingUserMessageId: rootMessage.id
    })

    const response = await fetch(connection.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${connection.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        method: 'delegatedWorkCall',
        params: {
          delegation_call_id: '1',
          request: {
            task: 'Inspect staged evidence',
            name: 'Inspect staged evidence',
            inputs: ['upload-version:version-1']
          }
        }
      })
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      result: {
        kind: 'results',
        children: [{ status: 'completed', response: 'staged evidence inspected' }]
      }
    })
    expect(selected).toEqual(['codex'])
    const input = execution.controls()[0].input
    expect(input.workspaceCwd).toContain(
      join('delegation', 'project-1', 'session-1', 'frames', input.frameId)
    )
    await expect(
      readFile(join(input.workspaceCwd!, 'inputs', '01-evidence.csv'), 'utf8')
    ).resolves.toBe('sample,value\na,1\n')
    expect(durable.runtimeContext?.delegatedWork?.records[0].attempts[0].status).toBe('completed')
    expect(
      durable.conversationGraph?.activities.find(
        ({ id }) => id === 'delegate-call\u0000delegate\u00001'
      )
    ).toMatchObject({
      title: 'Delegate subagent',
      status: 'completed',
      agentFrameId: graph.rootFrameId,
      messageBranchId: graph.frames.find(({ id }) => id === graph.rootFrameId)?.activeBranchId,
      promptMessageId: rootMessage.id,
      runtimeSegmentId: graph.runtimeSegments[0].id
    })

    endInvocation()
    connection.release()
    await composition.root.deleteSession('session-1')
  })

  it('routes root permission responses by Attempt and cascades root Stop fail-closed', async () => {
    root = await mkdtemp(join(tmpdir(), 'delegated-production-permission-'))
    const harness = await createCompositionHarness(root, 'codex')
    const receipt = await harness.composition.host.delegate(
      harness.caller,
      { task: 'Wait for permission', name: 'Wait for permission' },
      { wait: false }
    )
    await expect.poll(() => harness.execution.controls()).toHaveLength(1)
    const control = harness.execution.controls()[0]
    control.accept()
    control.emit({
      kind: 'permission',
      awaiting: true,
      requestId: 'provider-permission-1',
      title: 'Read evidence',
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once', scope: 'once' },
        { optionId: 'allow', name: 'This session', kind: 'allow_always', scope: 'session' },
        { optionId: 'allow-project', name: 'This project', kind: 'allow_always', scope: 'project' },
        { optionId: 'allow-global', name: 'Global', kind: 'allow_always', scope: 'global' }
      ]
    })
    const projected = harness.composition.root.pendingPermissions()[0]
    expect(projected).toMatchObject({
      sessionId: harness.session.id,
      delegated: {
        frameId: receipt.children[0].frameId,
        attemptId: receipt.children[0].attemptId,
        riskScope: 'Global, project, session, or this call'
      },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once', scope: 'once' },
        { optionId: 'allow', name: 'This session', kind: 'allow_always', scope: 'session' },
        { optionId: 'allow-project', name: 'This project', kind: 'allow_always', scope: 'project' },
        { optionId: 'allow-global', name: 'Global', kind: 'allow_always', scope: 'global' }
      ]
    })
    await expect(
      harness.composition.root.respondToPermission({
        requestId: projected.requestId,
        optionId: 'allow'
      })
    ).resolves.toBe(true)
    expect(control.permissionResponses()).toEqual([
      { requestId: 'provider-permission-1', optionId: 'allow' }
    ])

    control.emit({
      kind: 'permission',
      awaiting: true,
      requestId: 'provider-permission-stop',
      title: 'Write evidence',
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]
    })
    const stale = harness.composition.root.pendingPermissions()[0]
    await harness.composition.root.stopAll()
    expect(harness.durable().runtimeContext?.delegatedWork?.records[0].attempts[0]).toMatchObject({
      status: 'cancelled',
      cancellationReason: 'session_stop'
    })
    expect(harness.composition.root.pendingPermissions()).toEqual([])
    await expect(
      harness.composition.root.respondToPermission({
        requestId: stale.requestId,
        optionId: 'allow'
      })
    ).rejects.toThrow('no longer active')
  })

  it('updates the Permission Profile of every live Attempt in the Session', async () => {
    root = await mkdtemp(join(tmpdir(), 'delegated-production-permission-profile-'))
    const harness = await createCompositionHarness(root, 'codex')
    await harness.composition.host.delegate(
      harness.caller,
      [
        { task: 'First child', name: 'First child' },
        { task: 'Second child', name: 'Second child' }
      ],
      { wait: false }
    )
    await expect.poll(() => harness.execution.controls()).toHaveLength(2)
    for (const control of harness.execution.controls()) control.accept()

    await harness.composition.root.setPermissionProfile(harness.session.id, 'ask')

    expect(harness.execution.controls().map((control) => control.permissionProfiles())).toEqual([
      ['ask'],
      ['ask']
    ])
    for (const control of harness.execution.controls()) control.complete('done')
  })

  it('stops a live Attempt that cannot apply the Session Permission Profile', async () => {
    root = await mkdtemp(join(tmpdir(), 'delegated-production-permission-profile-failure-'))
    const harness = await createCompositionHarness(root, 'codex')
    await harness.composition.host.delegate(
      harness.caller,
      [
        { task: 'Healthy child', name: 'Healthy child' },
        { task: 'Stale full-access child', name: 'Stale full-access child' }
      ],
      { wait: false }
    )
    await expect.poll(() => harness.execution.controls()).toHaveLength(2)
    for (const control of harness.execution.controls()) control.accept()
    harness.execution.controls()[1].rejectNextPermissionProfile()

    await expect(
      harness.composition.root.setPermissionProfile(harness.session.id, 'ask')
    ).rejects.toThrow('permission profile update failed')

    const healthy = harness.execution.controls()[0]
    const stale = harness.execution.controls()[1]
    expect(healthy.permissionProfiles()).toEqual(['ask'])
    expect(stale.permissionProfiles()).toEqual([])
    await expect
      .poll(() => {
        const records = harness.durable().runtimeContext?.delegatedWork?.records ?? []
        return {
          healthy: records
            .find((record) => record.agentFrameId === healthy.input.frameId)
            ?.attempts.at(-1),
          stale: records
            .find((record) => record.agentFrameId === stale.input.frameId)
            ?.attempts.at(-1)
        }
      })
      .toMatchObject({
        healthy: { status: 'running' },
        stale: { status: 'cancelled', cancellationReason: 'runtime_interrupted' }
      })
    healthy.complete('done')
  })

  it('publishes detached child terminal mutations after the running receipt', async () => {
    root = await mkdtemp(join(tmpdir(), 'delegated-production-detached-events-'))
    const harness = await createCompositionHarness(root, 'opencode')
    const revisions: number[] = []
    harness.composition.root.subscribe((event) => {
      if (event.kind === 'records-changed') revisions.push(revisions.length + 1)
    })

    const pendingReceipt = harness.composition.host.delegate(
      harness.caller,
      { task: 'Finish after detached receipt', name: 'Finish after detached receipt' },
      { wait: false }
    )
    await expect.poll(() => harness.execution.controls()).toHaveLength(1)
    const control = harness.execution.controls()[0]
    control.accept()
    const receipt = await pendingReceipt
    expect(receipt.children[0].status).toBe('running')
    const revisionsAtReceipt = revisions.length

    control.complete('detached terminal result')
    await expect
      .poll(() => harness.durable().runtimeContext?.delegatedWork?.records[0]?.attempts[0]?.status)
      .toBe('completed')
    expect(revisions.length).toBeGreaterThan(revisionsAtReceipt)
  })

  it('selects each advertised production framework from the durable Session identity', async () => {
    root = await mkdtemp(join(tmpdir(), 'delegated-production-frameworks-'))
    for (const frameworkId of ['claude-code', 'opencode', 'codex', 'codebuddy'] as const) {
      const execution = createDeterministicDelegateExecution()
      execution.plan({ status: 'completed', response: `${frameworkId} complete` })
      const harness = await createCompositionHarness(
        join(root, frameworkId),
        frameworkId,
        execution
      )
      await expect(
        harness.composition.host.delegate(harness.caller, {
          task: 'Run certified factory',
          name: 'Run certified factory'
        })
      ).resolves.toMatchObject({
        kind: 'results',
        children: [{ status: 'completed', response: `${frameworkId} complete` }]
      })
      expect(harness.selected).toEqual([frameworkId])
      await harness.composition.root.deleteSession(harness.session.id)
    }
  })

  it('rejects unsupported production configuration before durable child mutation', async () => {
    root = await mkdtemp(join(tmpdir(), 'delegated-production-admission-'))
    const execution = createDeterministicDelegateExecution()
    const harness = await createCompositionHarness(
      root,
      'opencode',
      execution,
      new Error('native delegation remains enabled')
    )

    await expect(
      harness.composition.host.delegate(harness.caller, {
        task: 'Must not start',
        name: 'Must not start'
      })
    ).rejects.toThrow('native delegation remains enabled')
    expect(harness.selected).toEqual(['opencode'])
    expect(execution.controls()).toEqual([])
    expect(harness.durable().runtimeContext?.delegatedWork).toBeUndefined()
    expect(harness.composition.root.unavailableReasons?.()).toEqual({
      [harness.session.id]: {
        kind: 'unavailable',
        reason:
          'Delegated work is unavailable for this Agent framework configuration. Open Settings and choose a certified configuration.'
      }
    })
  })

  it('does not project non-configuration delegation failures as Settings guidance', async () => {
    root = await mkdtemp(join(tmpdir(), 'delegated-production-non-config-'))
    const harness = await createCompositionHarness(root, 'opencode')
    const unauthorized = { ...harness.caller, frameId: 'frame-outside-root' }

    await expect(
      harness.composition.host.delegate(unauthorized, {
        task: 'Must not start',
        name: 'Must not start'
      })
    ).rejects.toMatchObject({ code: 'authorization' })
    expect(harness.composition.root.unavailableReasons?.()).toEqual({})
  })

  it('keeps rejected Artifact finalization invisible and leaves durable ownership unchanged', async () => {
    const rootMessage = {
      id: 'root-prompt',
      role: 'user' as const,
      content: 'delegate',
      status: 'complete' as const,
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    }
    const durable: PersistedChatSession = {
      id: 'session-atomic',
      projectId: 'project-1',
      title: 'atomic',
      cwd: '/workspace',
      status: 'idle',
      messages: [rootMessage],
      conversationGraph: createLinearConversationGraph({
        sessionId: 'session-atomic',
        messages: [rootMessage],
        createdAt: 1,
        updatedAt: 1
      }),
      filesRevision: 1,
      createdAt: 1,
      updatedAt: 5
    }
    const graph = durable.conversationGraph!
    const rootBranch = graph.branches[0]
    graph.activities.push({
      id: 'delegate-call',
      kind: 'tool',
      title: 'delegate',
      status: 'completed',
      sortIndex: 1,
      eventIds: [],
      createdAt: 2,
      updatedAt: 2,
      agentFrameId: graph.rootFrameId,
      messageBranchId: rootBranch.id,
      promptMessageId: rootMessage.id,
      runtimeSegmentId: graph.runtimeSegments[0].id
    })
    graph.frames.push({
      id: 'child-frame',
      parentFrameId: graph.rootFrameId,
      originMessageId: rootMessage.id,
      originBindingState: 'validated',
      kind: 'delegate',
      status: 'completed',
      activeBranchId: 'child-branch',
      createdAt: 2,
      completedAt: 5
    })
    graph.branches.push({
      id: 'child-branch',
      agentFrameId: 'child-frame',
      headMessageId: 'child-answer',
      createdAt: 2,
      updatedAt: 5
    })
    graph.runtimeSegments.push({
      id: 'child-runtime',
      agentFrameId: 'child-frame',
      frameworkId: 'codex',
      startedAt: 2,
      endedAt: 5
    })
    graph.messages.push(
      {
        id: 'child-prompt',
        role: 'user',
        content: 'work',
        status: 'complete',
        eventIds: [],
        delegatedCallerSource: {
          rootMessageId: rootMessage.id,
          toolInvocationId: 'delegate-call'
        },
        agentFrameId: 'child-frame',
        introducedOnBranchId: 'child-branch',
        revisionRootMessageId: 'child-prompt',
        runtimeSegmentId: 'child-runtime',
        createdAt: 2,
        updatedAt: 2
      },
      {
        id: 'child-answer',
        role: 'agent',
        content: 'done',
        status: 'complete',
        eventIds: [],
        responseToMessageId: 'child-prompt',
        agentFrameId: 'child-frame',
        introducedOnBranchId: 'child-branch',
        parentMessageId: 'child-prompt',
        runtimeSegmentId: 'child-runtime',
        createdAt: 5,
        updatedAt: 5
      }
    )
    const attach = vi.fn(
      async (
        _key: Parameters<DelegatedWorkRecordCommands['attachDelegatedMessageArtifacts']>[0],
        input: Parameters<DelegatedWorkRecordCommands['attachDelegatedMessageArtifacts']>[1]
      ) => {
        graph.messages.find(({ id }) => id === input.messageId)!.artifactIds = input.artifacts.map(
          ({ versionId, id }) => versionId ?? id
        )
        durable.artifacts = input.artifacts.map((artifact) => ({
          id: artifact.versionId ?? artifact.id,
          artifactId: artifact.artifactId,
          versionId: artifact.versionId,
          kind: 'managed-file' as const,
          path: artifact.path
        }))
      }
    )
    const artifact: ArtifactFile = {
      id: 'version-atomic',
      artifactId: 'artifact-atomic',
      versionId: 'version-atomic',
      projectId: 'project-1',
      sessionId: durable.id,
      runId: 'run-atomic',
      name: 'atomic.md',
      path: '/managed/atomic.md',
      fileUrl: 'file:///managed/atomic.md',
      size: 1,
      mtimeMs: 1
    }

    await expect(
      finalizeDelegatedArtifactPublication({
        publication: {
          appSessionId: durable.id,
          artifactStorageSessionId: durable.id,
          runId: 'run-atomic',
          promptMessageId: 'child-prompt',
          artifactClaimId: 'claim-atomic',
          artifacts: [artifact]
        },
        terminalMessageId: 'child-answer',
        scope: {
          session: { projectId: durable.projectId, sessionId: durable.id },
          executionId: 'attempt-atomic',
          attemptId: 'attempt-atomic',
          rootFrameId: graph.rootFrameId,
          agentFrameId: 'child-frame',
          messageBranchId: 'child-branch',
          runtimeSegmentId: 'child-runtime',
          promptMessageId: 'child-prompt',
          agentName: 'delegate'
        },
        commands: {
          attachDelegatedMessageArtifacts: attach
        } as unknown as DelegatedWorkRecordCommands,
        handlers: {
          finalizeRunArtifacts: async () => {
            throw new Error('finalization rejected')
          }
        }
      })
    ).rejects.toThrow('finalization rejected')
    expect(attach).not.toHaveBeenCalled()
    expect(graph.messages.find(({ id }) => id === 'child-answer')?.artifactIds).toBeUndefined()
    expect(durable.artifacts).toBeUndefined()
    expect(projectRootArtifactVisibility(durable, rootBranch.id)).toMatchObject({ placements: [] })
  })

  it('publishes a child frame Notebook file through the Artifact write boundary and projects its Version', async () => {
    root = await mkdtemp(join(tmpdir(), 'delegated-production-notebook-artifacts-'))
    const client = createProjectDbClient(root)
    disconnect = () => client.$disconnect()
    await migrateApplicationDatabase(client)
    const artifactRepository = new ArtifactRepository(root)
    const artifactMcpRepository = new ArtifactRepository(root)
    const artifactRunRegistry = new ArtifactRunRegistry()
    const notebookRepository = new NotebookRunRepository(root)
    const harnessRef: { current?: CompositionHarness } = {}
    const provenance = new ArtifactProvenanceRepository({
      storageRoot: root,
      getClient: async () => client,
      compatibilityRepository: artifactRepository,
      notebookRepository,
      loadSession: async () => harnessRef.current?.durable()
    })
    server = new NotebookLocalRpcServer({ execute: async () => ({}) } as never, {
      transport: 'tcp',
      artifactProvenance: {
        createVersion: (request, signal) => provenance.createVersion(request, signal),
        replayVersion: (request) => provenance.replayVersion(request),
        reserveWrite: (request) => provenance.reserveWrite(request),
        releaseWriteReservation: (request) => provenance.releaseWriteReservation(request),
        releaseRunWriteReservations: (request) => provenance.releaseRunWriteReservations(request),
        releaseAllWriteReservations: () => provenance.releaseAllWriteReservations()
      }
    })
    const connection = await server.ensureStarted()
    const turns = new ArtifactTurnOwner({
      dataRoot: root,
      repository: artifactRepository,
      runRegistry: artifactRunRegistry,
      notebookArtifactSourceScope: createNotebookArtifactSourceScopeProvider(root),
      issueRpcCapability: (binding) => server!.issueArtifactRunCapability(binding),
      revokeRpcCapability: (token) => server!.revokeArtifactRunCapability(token),
      provenance
    })
    const artifactHandlers = createArtifactHandlers(artifactRepository, artifactRunRegistry, {
      provenance
    })
    const harness = await createCompositionHarness(root, 'codex', undefined, undefined, {
      artifactEvidence: {
        turns,
        artifactStorageSessionId: ({ sessionId }) => sessionId,
        finalizePublication: (publication, terminalMessageId, scope) =>
          finalizeDelegatedArtifactPublication({
            publication,
            terminalMessageId,
            scope,
            commands: harnessRef.current!.commands,
            handlers: artifactHandlers
          }).then(() => undefined),
        project: (scope) =>
          scope.terminalMessageId
            ? artifactRepository.listMessageFiles({
                projectId: scope.session.projectId,
                sessionId: scope.session.sessionId,
                messageId: scope.terminalMessageId
              })
            : Promise.resolve([])
      }
    })
    harnessRef.current = harness

    const pending = harness.composition.host.delegate(harness.caller, {
      task: 'Create Notebook evidence',
      name: 'Notebook evidence'
    })
    await expect.poll(() => harness.execution.controls()).toHaveLength(1)
    const control = harness.execution.controls()[0]
    const childTurn = control.input.turn!
    const notebookSessionRoot = join(
      root,
      'notebooks',
      'project-1',
      'session-codex',
      'frames',
      control.input.frameId
    )
    const notebookDataDir = join(notebookSessionRoot, 'data')
    const lane = createFrameNotebookLane('project-1', 'session-codex', control.input.frameId)
    await notebookRepository.loadOrCreate({
      projectId: 'project-1',
      sessionId: 'session-codex',
      workspaceCwd: control.input.workspaceCwd!,
      lane
    })
    const sourcePath = join(notebookDataDir, 'evidence.txt')
    await mkdir(notebookDataDir, { recursive: true })
    await writeFile(sourcePath, 'child notebook evidence', 'utf8')
    const sourceStat = await stat(sourcePath)
    const rootFrameId = harness.durable().conversationGraph!.rootFrameId
    await notebookRepository.appendRun({
      projectId: 'project-1',
      sessionId: 'session-codex',
      lane,
      run: {
        runId: 'child-notebook-run-1',
        cellId: 'child-cell-1',
        source: 'agent',
        kernelKind: 'python',
        script: 'write_evidence()',
        status: 'completed',
        startedAt: sourceStat.mtimeMs - 100,
        endedAt: sourceStat.mtimeMs + 100,
        text: { stdout: '', stderr: '', traceback: '', plain: [] },
        outputs: [],
        artifacts: [],
        workingFiles: [
          {
            path: sourcePath,
            relativePath: 'data/evidence.txt',
            kind: 'other',
            size: sourceStat.size,
            mtimeMs: sourceStat.mtimeMs,
            createdByRunId: 'child-notebook-run-1'
          }
        ],
        rootFrameId,
        agentFrameId: control.input.frameId,
        messageBranchId: childTurn.messageBranchId,
        runtimeSegmentId: childTurn.runtimeSegmentId,
        promptMessageId: childTurn.promptMessageId
      }
    })
    const environment = {
      storageRoot: root,
      projectId: 'project-1',
      sessionId: 'session-codex',
      currentRunFile: control.input.artifactCurrentRunFile!,
      allowedImportRoots: [control.input.workspaceCwd!],
      rpcEndpoint: connection.endpoint
    }
    const outsidePath = join(root, 'outside-child-frame.txt')
    await writeFile(outsidePath, 'outside', 'utf8')
    await expect(
      writeArtifactFileForCurrentRun(artifactMcpRepository, environment, {
        filename: 'outside-child-frame.txt',
        source: { kind: 'localPath', path: outsidePath },
        producerRunId: 'child-notebook-run-1'
      })
    ).rejects.toThrow(/outside allowed artifact import roots/i)
    const siblingDataDir = join(
      root,
      'notebooks',
      'project-1',
      'session-codex',
      'frames',
      'sibling-frame',
      'data'
    )
    const siblingSourcePath = join(siblingDataDir, 'sibling.txt')
    await mkdir(siblingDataDir, { recursive: true })
    await writeFile(siblingSourcePath, 'sibling evidence', 'utf8')
    await expect(
      writeArtifactFileForCurrentRun(artifactMcpRepository, environment, {
        filename: 'sibling.txt',
        source: { kind: 'localPath', path: siblingSourcePath },
        producerRunId: 'child-notebook-run-1'
      })
    ).rejects.toThrow(/outside allowed artifact import roots/i)

    // Exercise the exported write boundary used by the registered tool. MCP protocol transport and
    // tool registration remain covered by the focused mcp-server contract tests.
    const version = await writeArtifactFileForCurrentRun(artifactMcpRepository, environment, {
      filename: 'evidence.txt',
      mimeType: 'text/plain',
      source: { kind: 'localPath', path: 'evidence.txt' },
      producerRunId: 'child-notebook-run-1'
    })
    expect(version).toMatchObject({
      name: 'evidence.txt',
      producerRunId: 'child-notebook-run-1'
    })

    control.accept()
    control.complete('Notebook evidence ready', {
      inputTokens: 1,
      cacheTokens: 0,
      outputTokens: 1,
      turnCount: 1
    })
    const result = await pending
    expect(result).toMatchObject({
      kind: 'results',
      children: [
        {
          status: 'completed',
          artifactsCreated: [
            {
              versionId: version.versionId,
              name: 'evidence.txt'
            }
          ]
        }
      ]
    })
  })

  it('keeps running and continued production Turns independently owned across a late reload', async () => {
    root = await mkdtemp(join(tmpdir(), 'delegated-production-artifacts-'))
    const laterCallers = [
      { rootMessageId: 'root-message-running', toolInvocationId: 'call-running', createdAt: 3 },
      {
        rootMessageId: 'root-message-continuation',
        toolInvocationId: 'call-continuation',
        createdAt: 5
      }
    ]
    const proofState: { harness?: CompositionHarness } = {}
    const ownership = new ArtifactProvenanceRepository({
      storageRoot: root,
      getClient: async () => {
        throw new Error('ownership validation must not open the project database')
      },
      loadSession: async () => proofState.harness?.durable()
    })
    const versionsByRun = new Map<string, ArtifactFile[]>()
    const finalized: Array<{
      attemptId: string
      terminalMessageId: string
      artifacts: readonly ArtifactFile[]
    }> = []
    const artifactRepository = new ArtifactRepository(root)
    const artifactRunRegistry = new ArtifactRunRegistry()
    const turns = new ArtifactTurnOwner({
      dataRoot: root,
      repository: artifactRepository,
      runRegistry: artifactRunRegistry,
      now: () => 10,
      provenance: {
        listRunVersions: async ({ artifactRunId }) => versionsByRun.get(artifactRunId) ?? [],
        writeAppGeneratedVersion: async (request) => {
          const pendingFile = await artifactRepository.writePendingFile({
            projectId: request.projectId,
            sessionId: request.artifactStorageSessionId,
            runId: request.artifactRunId,
            filename: request.filename,
            mimeType: request.contentType,
            kind: request.kind,
            source: { kind: 'inline', content: request.content, encoding: 'utf8' }
          })
          const file: ArtifactFile = {
            ...pendingFile,
            id: `version-${request.artifactRunId}`,
            artifactId: `artifact-${request.agentFrameId}`,
            versionId: `version-${request.artifactRunId}`,
            versionNumber: 1,
            checksum: request.content,
            createdAt: '2026-08-07T00:00:00.000Z',
            sessionId: request.appSessionId
          }
          versionsByRun.set(request.artifactRunId, [file])
          return file
        }
      }
    })
    const artifactHandlers = createArtifactHandlers(artifactRepository, artifactRunRegistry, {
      provenance: {
        finalizeRun: async (
          request: Parameters<ArtifactProvenanceRepository['finalizeRun']>[0]
        ) => {
          await ownership.validateFinalizationOwnership(request)
          return versionsByRun.get(request.artifactRunId) ?? []
        },
        activateFinalizedRun: async (
          request: Parameters<ArtifactProvenanceRepository['activateFinalizedRun']>[0]
        ) => {
          await ownership.validateFinalizationOwnership(request)
          return versionsByRun.get(request.artifactRunId) ?? []
        }
      } as unknown as ArtifactProvenanceRepository
    })
    const execution = createDeterministicDelegateExecution()
    const harness = await createCompositionHarness(
      root,
      'codex',
      execution,
      undefined,
      {
        artifactEvidence: {
          turns,
          artifactStorageSessionId: ({ sessionId }) => `artifact-${sessionId}`,
          finalizePublication: async (publication, terminalMessageId, scope) => {
            const artifacts = await finalizeDelegatedArtifactPublication({
              publication,
              terminalMessageId,
              scope,
              commands: proofState.harness!.commands,
              handlers: artifactHandlers
            })
            finalized.push({
              attemptId: scope.attemptId,
              terminalMessageId,
              artifacts
            })
          },
          project: async (scope) =>
            finalized
              .filter(
                ({ attemptId, terminalMessageId }) =>
                  attemptId === scope.attemptId && terminalMessageId === scope.terminalMessageId
              )
              .flatMap(({ artifacts }) => artifacts)
        }
      },
      laterCallers
    )
    proofState.harness = harness

    const rootGraph = harness.durable().conversationGraph!
    const rootBranch = rootGraph.branches.find(
      ({ agentFrameId }) => agentFrameId === rootGraph.rootFrameId
    )!

    const pending = harness.composition.host.delegate(harness.caller, {
      task: 'Create evidence',
      name: 'Create evidence'
    })
    await expect.poll(() => execution.controls()).toHaveLength(1)
    const control = execution.controls()[0]
    expect(control.input.artifactCurrentRunFile).toBe(
      join(
        root,
        'artifacts',
        'project-1',
        'artifact-session-codex',
        '.execution-handoffs',
        'artifact-run-10-1.json'
      )
    )
    const turn = turns.handleForExecution(control.input.attemptId)
    await turns.write(turn, { filename: 'evidence.md', content: 'exact child evidence' })
    control.accept()
    await harness.composition.host.sendMessage(
      {
        ...harness.caller,
        originMessageId: laterCallers[0].rootMessageId,
        toolInvocationId: laterCallers[0].toolInvocationId
      },
      control.input.frameId,
      'Create running evidence',
      { kind: 'info' }
    )
    await expect.poll(() => control.deliveredMessages()).toEqual(['Create running evidence'])
    await control.completeTurn('Evidence ready', {
      inputTokens: 10,
      cacheTokens: 2,
      outputTokens: 3,
      turnCount: 1
    })
    await expect(
      turns.write(turn, { filename: 'late.md', content: 'must reject after Turn seal' })
    ).rejects.toThrow()
    const runningPrompt = harness
      .durable()
      .conversationGraph!.messages.find(
        ({ delegatedCallerSource }) =>
          delegatedCallerSource?.toolInvocationId === laterCallers[0].toolInvocationId
      )!
    const runningTurn = turns.handleForExecution(`${control.input.attemptId}:${runningPrompt.id}`)
    await turns.write(runningTurn, {
      filename: 'running.md',
      content: 'running child evidence'
    })
    control.complete('Running evidence ready', {
      inputTokens: 20,
      cacheTokens: 4,
      outputTokens: 6,
      turnCount: 1
    })

    const result = await pending
    if (result.kind !== 'results') throw new Error('expected terminal delegated result')
    expect(result.children[0].error?.message).toBeUndefined()
    expect(result).toMatchObject({
      kind: 'results',
      children: [
        {
          status: 'completed',
          artifactsCreated: [
            {
              versionId: expect.stringMatching(/^version-artifact-run-/),
              name: 'running.md',
              checksum: 'running child evidence'
            }
          ]
        }
      ]
    })
    const child = result.children[0]
    await expect(
      harness.composition.host.readAgentFrame(harness.caller.session, child.frameId)
    ).resolves.toMatchObject({
      messages: [
        { role: 'user', content: 'Create evidence' },
        { role: 'assistant', content: 'Evidence ready', artifacts: [{ name: 'evidence.md' }] },
        { role: 'user', content: 'Create running evidence' },
        {
          role: 'assistant',
          content: 'Running evidence ready',
          artifacts: [{ versionId: result.children[0].artifactsCreated[0].versionId }]
        }
      ]
    })

    const continued = await harness.composition.host.sendMessage(
      {
        ...harness.caller,
        originMessageId: laterCallers[1].rootMessageId,
        toolInvocationId: laterCallers[1].toolInvocationId
      },
      child.frameId,
      'Create continuation evidence',
      { kind: 'info' }
    )
    expect(continued.disposition).toBe('continued')
    if (continued.disposition !== 'continued') throw new Error('expected terminal continuation')
    await expect.poll(() => execution.controls()).toHaveLength(2)
    const continuationControl = execution.control(continued.continuation_attempt_id)
    const continuationTurn = turns.handleForExecution(continued.continuation_attempt_id)
    await turns.write(continuationTurn, {
      filename: 'continuation.md',
      content: 'continued child evidence'
    })
    continuationControl.accept()
    continuationControl.complete('Continuation evidence ready')
    await expect
      .poll(
        () =>
          harness
            .durable()
            .runtimeContext?.delegatedWork?.records[0].attempts.find(
              ({ id }) => id === continued.continuation_attempt_id
            )?.status
      )
      .toBe('completed')

    const reloaded = normalizeSessionFile(harness.durable())!
    const childOwners = finalized.map((entry) => {
      const owner = reloaded.conversationGraph!.messages.find(
        ({ id }) => id === entry.terminalMessageId
      )
      if (!owner) throw new Error('reloaded child Artifact owner is missing')
      return owner
    })
    const rootOwner = reloaded.conversationGraph!.messages.find(
      ({ id }) => id === harness.caller.originMessageId
    )!
    expect(finalized).toHaveLength(3)
    expect(
      new Set(finalized.flatMap(({ artifacts }) => artifacts.map(({ versionId }) => versionId)))
        .size
    ).toBe(3)
    expect(childOwners.every((owner) => owner?.artifactIds?.length === 1)).toBe(true)
    expect(new Set(childOwners.map((owner) => owner?.id)).size).toBe(3)
    expect(new Set(childOwners.map((owner) => owner?.runtimeSegmentId).filter(Boolean)).size).toBe(
      3
    )
    expect(rootOwner.artifactIds).toBeUndefined()
    const placements = projectRootArtifactVisibility(reloaded, rootBranch.id).placements
    expect(
      placements.map(({ rootMessageId, toolInvocationId }) => [rootMessageId, toolInvocationId])
    ).toEqual([
      [harness.caller.originMessageId, harness.caller.toolInvocationId],
      [laterCallers[0].rootMessageId, laterCallers[0].toolInvocationId],
      [laterCallers[1].rootMessageId, laterCallers[1].toolInvocationId]
    ])
    for (const placement of placements) {
      const owner = childOwners.find(({ id }) => id === placement.ownerMessageId)!
      const descriptor = reloaded.artifacts!.find(({ id }) => id === placement.artifactVersionId)!
      const frame = await harness.composition.host.readAgentFrame(
        harness.caller.session,
        child.frameId
      )
      if (!frame) throw new Error('reloaded child Frame is missing')
      const frameArtifact = frame.messages
        .flatMap(({ artifacts }) => artifacts ?? [])
        .find(({ versionId }) => versionId === placement.artifactVersionId)!
      expect(owner.artifactIds).toContain(placement.artifactVersionId)
      expect(frameArtifact.path).toBe(descriptor.path)
    }
  })

  it('projects production Reviewer rows only for the exact completed child scope', async () => {
    root = await mkdtemp(join(tmpdir(), 'delegated-production-reviews-'))
    const reviewState: {
      harness?: CompositionHarness
      persistedReview?: ReviewWithChecks
    } = {}
    const harness = await createCompositionHarness(root, 'claude-code', undefined, undefined, {
      reviewEvidence: {
        loadSession: async () => reviewState.harness?.durable(),
        reviews: {
          run: async () => ({ started: true }),
          getForSession: async () =>
            reviewState.persistedReview ? [reviewState.persistedReview] : []
        }
      }
    })
    reviewState.harness = harness
    const pending = harness.composition.host.delegate(harness.caller, {
      task: 'Review this',
      name: 'Review this'
    })
    await expect.poll(() => harness.execution.controls()).toHaveLength(1)
    const control = harness.execution.controls()[0]
    control.accept()
    control.complete('Reviewed answer')
    const result = await pending
    if (result.kind !== 'results') throw new Error('expected terminal delegated result')
    const child = result.children[0]
    const durableChild = harness.durable().runtimeContext!.delegatedWork!.records[0]
    const branchId = harness
      .durable()
      .conversationGraph!.frames.find((frame) => frame.id === child.frameId)!.activeBranchId
    reviewState.persistedReview = {
      id: 'review-exact-child',
      projectId: harness.session.projectId,
      sessionId: harness.session.id,
      turnMessageId: child.terminalMessageId!,
      scope: {
        turnMessageId: child.terminalMessageId!,
        agentFrameId: child.frameId,
        messageBranchId: branchId,
        blocks: [],
        artifactVersionIds: []
      },
      lifecycle: 'complete',
      outcome: 'pass',
      model: 'reviewer-model',
      reviewerLog: [],
      createdAt: 10,
      updatedAt: 11,
      checks: []
    }

    await expect(
      harness.composition.host.readAgentFrame(harness.caller.session, child.frameId)
    ).resolves.toMatchObject({
      status: durableChild.attempts[0].status,
      messages: [{ role: 'user' }, { role: 'assistant', reviews: [reviewState.persistedReview] }]
    })
  })

  it('delivers a child message through the production parent owner before marking it delivered', async () => {
    root = await mkdtemp(join(tmpdir(), 'delegated-production-parent-message-'))
    const deliveries: unknown[] = []
    const harness = await createCompositionHarness(root, 'opencode', undefined, undefined, {
      parentMessages: {
        deliver: async (delivery) => {
          await delivery.startDispatch()
          deliveries.push(delivery)
          return 'provider_prompt_accepted'
        }
      }
    })
    const receipt = await harness.composition.host.delegate(
      harness.caller,
      { task: 'Ask the parent', name: 'Ask the parent' },
      { wait: false }
    )
    await expect.poll(() => harness.execution.controls()).toHaveLength(1)
    harness.execution.controls()[0].accept()
    const child = receipt.children[0]

    await harness.composition.host.sendMessage(
      {
        ...harness.caller,
        frameId: child.frameId,
        attemptId: child.attemptId,
        role: 'delegate',
        toolInvocationId: 'child-parent-message'
      },
      'parent',
      'Need the cohort definition',
      { kind: 'question' }
    )

    await expect
      .poll(() => deliveries)
      .toEqual([
        expect.objectContaining({
          session: harness.caller.session,
          sourceFrameId: child.frameId,
          sourceAttemptId: child.attemptId,
          targetFrameId: harness.caller.frameId,
          text: 'Need the cohort definition',
          kind: 'question'
        })
      ])
    expect(
      harness.durable().runtimeContext?.delegatedWork?.messageCommands?.[0].receipt.status
    ).toBe('accepted')
  })

  it('discovers a durable queued parent message when a cold composition is woken after restart', async () => {
    root = await mkdtemp(join(tmpdir(), 'delegated-production-parent-restart-wake-'))
    let branchActive = false
    const deliveries: string[] = []
    const harness = await createCompositionHarness(root, 'opencode', undefined, undefined, {
      parentMessages: {
        deliver: async (delivery) => {
          if (!branchActive) throw new DelegateMessageParkedError('root branch is parked')
          await delivery.startDispatch()
          deliveries.push(delivery.messageId)
          return 'provider_prompt_accepted'
        }
      }
    })
    const delegated = await harness.composition.host.delegate(
      harness.caller,
      { task: 'Ask after restart', name: 'Ask after restart' },
      { wait: false }
    )
    await expect.poll(() => harness.execution.controls()).toHaveLength(1)
    harness.execution.controls()[0].accept()
    const child = delegated.children[0]
    const queued = await harness.composition.host.sendMessage(
      {
        ...harness.caller,
        frameId: child.frameId,
        attemptId: child.attemptId,
        role: 'delegate',
        toolInvocationId: 'child-parent-restart-message'
      },
      'parent',
      'Wake after the root branch is restored'
    )
    await expect.poll(() => queued.status).toBe('queued')

    branchActive = true
    const restarted = harness.reopen()
    await restarted.root.wakeMessages?.(harness.session.id)

    await expect.poll(() => deliveries).toEqual([queued.message_id])
    await expect
      .poll(
        () =>
          harness
            .durable()
            .runtimeContext?.delegatedWork?.messageCommands?.find(
              ({ messageId }) => messageId === queued.message_id
            )?.receipt.status
      )
      .toBe('accepted')
  })

  it('deletes dormant Project workspaces after restart without relying on the in-memory work cache', async () => {
    root = await mkdtemp(join(tmpdir(), 'delegated-production-restart-delete-'))
    const harness = await createCompositionHarness(root, 'codex')
    const receipt = await harness.composition.host.delegate(
      harness.caller,
      { task: 'Create a stable Frame workspace', name: 'Create a stable Frame workspace' },
      { wait: false }
    )
    await expect.poll(() => harness.execution.controls()).toHaveLength(1)
    const control = harness.execution.controls()[0]
    control.accept()
    control.complete('Done')
    await expect
      .poll(() => harness.durable().runtimeContext?.delegatedWork?.records[0]?.attempts[0]?.status)
      .toBe('completed')
    const stableSessionWorkspace = join(
      root,
      'delegation',
      harness.session.projectId,
      harness.session.id
    )
    await expect(access(stableSessionWorkspace)).resolves.toBeUndefined()

    const restarted = createProductionDelegatedWorkComposition({
      dataRoot: root,
      sessions: {
        commands: harness.commands,
        readSession: async () => harness.durable()
      },
      resolveInput: async () => {
        throw new Error('no inputs')
      },
      frameworks: {
        async forSession(current) {
          return {
            frameworkId: current.agentFrameworkId!,
            execution: createDeterministicDelegateExecution(),
            assertAvailable: async () => undefined
          }
        }
      },
      resolveExecutionModel: async () => testExecutionModel('codex')
    } as ProductionDelegatedWorkOptions)

    expect(receipt.children[0]).toBeDefined()
    await restarted.root.deleteProject(harness.session.projectId)

    await expect(access(stableSessionWorkspace)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retains failed Project work ownership and permission routing for cleanup retry', async () => {
    root = await mkdtemp(join(tmpdir(), 'delegated-production-project-delete-retry-'))
    const handles = new Map<string, { executionId: string }>()
    let failDispose = true
    const harness = await createCompositionHarness(root, 'codex', undefined, undefined, {
      artifactEvidence: {
        turns: {
          async openExecution({ executionId }: { executionId: string }) {
            const handle = { executionId }
            handles.set(executionId, handle)
            return handle
          },
          async finalize() {
            return undefined
          },
          async dispose() {
            if (failDispose) {
              failDispose = false
              throw new Error('injected Project cleanup failure')
            }
          },
          handleForExecution(executionId: string) {
            const handle = handles.get(executionId)
            if (!handle) throw new Error(`No active Artifact turn for ${executionId}`)
            return handle
          },
          handoffFile: () => '/tmp/current-run.json',
          async publishHandoff() {
            return undefined
          }
        } as never,
        artifactStorageSessionId: ({ sessionId }) => sessionId,
        async finalizePublication() {
          return undefined
        },
        async project() {
          return []
        }
      }
    })
    await harness.composition.host.delegate(
      harness.caller,
      { task: 'Retain cleanup owner', name: 'Retain cleanup owner' },
      { wait: false }
    )
    await expect.poll(() => harness.execution.controls()).toHaveLength(1)
    const control = harness.execution.controls()[0]
    control.accept()
    control.emit({
      kind: 'permission',
      awaiting: true,
      requestId: 'provider-project-delete-retry',
      title: 'Write evidence',
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]
    })
    await expect.poll(() => harness.composition.root.pendingPermissions()).toHaveLength(1)

    await expect(harness.composition.root.deleteProject(harness.session.projectId)).rejects.toThrow(
      'Delegated Project cleanup failed'
    )

    expect(harness.durable().runtimeContext?.delegatedWork?.records[0].attempts[0].status).toBe(
      'running'
    )
    expect(harness.composition.root.pendingPermissions()).toHaveLength(1)

    await expect(
      harness.composition.root.deleteProject(harness.session.projectId)
    ).resolves.toBeUndefined()
    expect(harness.durable().runtimeContext?.delegatedWork?.records[0].attempts[0]).toMatchObject({
      status: 'cancelled',
      cancellationReason: 'session_stop'
    })
    expect(harness.composition.root.pendingPermissions()).toEqual([])
  })

  it('does not await pending work initialization owned by another Project', async () => {
    root = await mkdtemp(join(tmpdir(), 'delegated-production-project-isolation-'))
    const forSession = vi.fn(async () => new Promise<never>(() => undefined))
    const harness = await createCompositionHarness(
      root,
      'codex',
      undefined,
      undefined,
      {},
      [],
      undefined,
      { forSession } as never
    )
    const unrelatedSession = {
      ...structuredClone(harness.durable()),
      id: 'session-other-project',
      projectId: 'project-2'
    }
    harness.replaceDurable(unrelatedSession)

    void harness.composition.host.readAgentFrame(
      { projectId: unrelatedSession.projectId, sessionId: unrelatedSession.id },
      unrelatedSession.conversationGraph!.rootFrameId
    )
    await vi.waitFor(() => expect(forSession).toHaveBeenCalledOnce())

    await expect(harness.composition.root.deleteProject('project-1')).resolves.toBeUndefined()
  })

  it('keeps a Turn fence when cancellation precedes scoped-work creation', async () => {
    root = await mkdtemp(join(tmpdir(), 'delegated-production-prework-fence-'))
    const harness = await createCompositionHarness(root, 'codex')

    await harness.composition.root.cancelTurn?.(harness.session.id, harness.caller.originMessageId)
    await expect(
      harness.composition.host.delegate(
        harness.caller,
        { task: 'must not cross the fence', name: 'must not cross the fence' },
        { wait: false }
      )
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(harness.durable().runtimeContext?.delegatedWork).toBeUndefined()
    expect(harness.execution.reservationCounts()).toEqual([])
  })

  it('production-composes branch Stop partial failure without rolling back successful targets', async () => {
    root = await mkdtemp(join(tmpdir(), 'delegated-production-partial-stop-'))
    const handles = new Map<string, { executionId: string }>()
    let failedOnce = false
    const harness = await createCompositionHarness(root, 'codex', undefined, undefined, {
      artifactEvidence: {
        turns: {
          async openExecution({ executionId }: { executionId: string }) {
            const handle = { executionId }
            handles.set(executionId, handle)
            return handle
          },
          async finalize() {
            return undefined
          },
          async dispose(handle: { executionId: string }) {
            if (handle.executionId.includes('attempt') && !failedOnce) {
              failedOnce = true
              throw new Error('injected branch Stop cleanup failure')
            }
          },
          handleForExecution(executionId: string) {
            const handle = handles.get(executionId)
            if (!handle) throw new Error(`No active Artifact turn for ${executionId}`)
            return handle
          },
          handoffFile: () => '/tmp/current-run.json',
          async publishHandoff() {
            return undefined
          }
        } as never,
        artifactStorageSessionId: ({ sessionId }) => sessionId,
        async finalizePublication() {
          return undefined
        },
        async project() {
          return []
        }
      }
    })
    const receipt = await harness.composition.host.delegate(
      harness.caller,
      [
        { task: 'first Stop target', name: 'first Stop target' },
        { task: 'second Stop target', name: 'second Stop target' }
      ],
      { wait: false }
    )
    await expect.poll(() => harness.execution.controls()).toHaveLength(2)

    await expect(harness.composition.root.stopActiveBranch?.(harness.session.id)).rejects.toThrow(
      'could not be stopped'
    )
    const statusesAfterFailure = harness
      .durable()
      .runtimeContext!.delegatedWork!.records.map((record) => record.attempts.at(-1)!.status)
    expect(statusesAfterFailure.sort()).toEqual(['cancelled', 'running'])
    await expect(
      harness.composition.root.stopActiveBranch?.(harness.session.id)
    ).resolves.toBeUndefined()
    expect(
      harness
        .durable()
        .runtimeContext!.delegatedWork!.records.map((record) => record.attempts.at(-1)!.status)
    ).toEqual(['cancelled', 'cancelled'])
    expect(receipt.children).toHaveLength(2)
  })
})
