import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi, type Mock } from 'vitest'

import type { SpecialistView } from '../../shared/specialist'
import type { AcpStateSnapshot } from '../../shared/acp'
import { NotebookLocalRpcServer } from '../notebook/local-rpc-server'
import { NotebookRunRepository } from '../notebook/repository'
import {
  NotebookControlCompletionCapturedError,
  NotebookRuntimeService,
  type NotebookControlResult
} from '../notebook/runtime-service'
import { createCompletionGatedControlToolInterceptor } from './completion-gate'
import type { ApprovalGateway } from '../../shared/agents-contract'
import { AcpPermissionBroker } from '../acp/permission-broker'
import {
  AcpSpecialistApprovalGateway,
  createAcpBackedSpecialistBridge
} from './specialist-approval-gateway'
import {
  createCompletionGateAgentHarness,
  deferred,
  type CapturedHandoff
} from './completion-gate.test-harness'
import { createCodexCompletionGateRuntime } from '../acp/codex-completion-handoff'
import { createOpenCodeImmediateHandoffRuntime } from '../acp/opencode-immediate-handoff'
import { createClaudeCodeCompletionGateRuntime } from './claude-code-handoff'
import {
  CompletionHandoffLifecycle,
  InMemoryCompletionHandoffRepository
} from './completion-handoff-lifecycle'
import {
  CompletionGateCoordinator,
  CompletionGateRuntimeRegistry,
  type CompletionGateRuntime,
  type ToolCompletionEnvelope
} from './completion-gate'

type ExecuteControlHarness = {
  calls: string[]
  continuations: CapturedHandoff[]
  deliverToCurrentPrompt: ReturnType<typeof vi.fn>
  persistBinding: ReturnType<typeof vi.fn>
  lifecycle: CompletionHandoffLifecycle
  executeControl: Mock<(code: string, timeoutMs?: number) => Promise<NotebookControlResult>>
  close(): Promise<void>
}

const createExecuteControlHarness = async (
  options: {
    onApproval?: (
      current: SpecialistView | undefined,
      approvalIndex: number
    ) => SpecialistView | undefined
    connectorCall?: () => Promise<unknown>
    approvalGateway?: ApprovalGateway
    runtime?: CompletionGateRuntime
    coordinator?: CompletionGateCoordinator
    lifecycle?: CompletionHandoffLifecycle
    deliverToOldPrompt?: (envelope: ToolCompletionEnvelope) => Promise<void>
  } = {}
): Promise<ExecuteControlHarness> => {
  const root = await mkdtemp(join(tmpdir(), 'open-science-completion-gate-'))
  const gate = createCompletionGateAgentHarness({
    onApproval: options.onApproval,
    ...(options.approvalGateway ? { approvalGateway: options.approvalGateway } : {}),
    ...(options.runtime ? { runtime: options.runtime } : {}),
    ...(options.coordinator ? { coordinator: options.coordinator } : {}),
    ...(options.lifecycle ? { lifecycle: options.lifecycle } : {}),
    ...(options.deliverToOldPrompt ? { deliverToOldPrompt: options.deliverToOldPrompt } : {})
  })
  const service = new NotebookRuntimeService({
    configRoot: root,
    dataRoot: root,
    projectId: 'default-project',
    repository: new NotebookRunRepository(root),
    platform: 'linux'
  })
  const server = new NotebookLocalRpcServer(service, {
    agentsService: gate.agents,
    ...(options.connectorCall
      ? {
          connectorService: {
            call: async () => options.connectorCall!()
          }
        }
      : {})
  })
  service.setMcpRpcConnectionResolver((binding) =>
    server.issueControlConnection(
      binding.sessionId,
      binding.projectId,
      'root-frame-' + binding.sessionId
    )
  )
  service.setControlCompletionInterceptor(
    createCompletionGatedControlToolInterceptor(gate.coordinator, gate.deliverToOldPrompt)
  )
  const executeControl = vi.fn((code: string, timeoutMs?: number) =>
    service.executeControl({
      projectId: 'default-project',
      sessionId: 'trusted-session',
      workspaceCwd: root,
      code,
      timeoutMs
    })
  )

  return {
    calls: gate.calls,
    continuations: gate.continuations,
    deliverToCurrentPrompt: gate.deliverToOldPrompt,
    persistBinding: gate.persistBinding,
    lifecycle: gate.lifecycle,
    executeControl,
    close: async () => {
      await service.shutdownAll()
      await server.close()
      await rm(root, { recursive: true, force: true })
    }
  }
}

const capturedControlResult = (handoff: CapturedHandoff): NotebookControlResult => {
  if (handoff.envelope.kind !== 'returned') {
    throw new Error('Expected the real executeControl seam to return a normalized tool outcome.')
  }
  return handoff.envelope.value as NotebookControlResult
}

type HandoffFramework = 'codex' | 'opencode' | 'claude-code'

type ProviderRequest = {
  identity: 'old-specialist' | 'Approved Specialist'
  capabilities: string[]
  source: 'old-tool-result' | 'approved-continuation'
}

// This is an ACP-provider-shaped fake, not an order-log callback. Its only observable is the
// identity/capability projection at the moment a provider request is accepted.
class FakeAcpProvider {
  readonly requests: ProviderRequest[] = []
  readonly reconfigurations: Array<{ specialistId: string | undefined }> = []
  private identity: ProviderRequest['identity'] = 'old-specialist'
  private capabilities = ['old-capability']

  recordOldToolResultRequest(): void {
    this.record('old-tool-result')
  }

  reconfigure(specialistId: string | undefined): void {
    this.reconfigurations.push({ specialistId })
    this.identity = specialistId ? 'Approved Specialist' : 'old-specialist'
    this.capabilities = specialistId ? ['approved-capability'] : ['old-capability']
  }

  recordApprovedContinuation(): void {
    this.record('approved-continuation')
  }

  private record(source: ProviderRequest['source']): void {
    this.requests.push({ identity: this.identity, capabilities: [...this.capabilities], source })
  }
}

const fakeSnapshot = (): AcpStateSnapshot => ({
  status: 'connected',
  cwd: '/workspace',
  sessionIds: ['trusted-session'],
  events: [],
  pendingPermissions: [],
  permissionProfiles: {},
  permissionGrants: {},
  contextUsageBySession: {},
  promptInFlight: false,
  promptInFlightSessionIds: []
})

const concreteFrameworkRuntime = (
  framework: HandoffFramework,
  provider: FakeAcpProvider
): CompletionGateRuntime => {
  const sessionId = 'trusted-session'
  const runtime = {
    isSessionUsingFramework: (_sessionId: string, expected: HandoffFramework) =>
      expected === framework,
    getSessionFramework: () => framework,
    capturePromptForHandoff: () => ({
      prompt: { sessionId, text: 'original task' },
      originatingTurnToken: 'original-user-turn'
    }),
    cancelPrompt: async (): Promise<AcpStateSnapshot> => fakeSnapshot(),
    waitForPromptRelease: async (): Promise<void> => undefined,
    waitForPromptOwnershipRelease: async (): Promise<void> => undefined,
    switchSpecialist: async (_sessionId: string, specialistId: string | undefined) => {
      provider.reconfigure(specialistId)
      return { contextReset: true }
    },
    continueApprovedHandoff: async (): Promise<void> => provider.recordApprovedContinuation(),
    startContinuation: async (): Promise<void> => provider.recordApprovedContinuation()
  }
  if (framework === 'codex') {
    return createCodexCompletionGateRuntime({
      runtime,
      resolveApprovedSpecialistId: () => 'specialist-approved'
    })
  }
  if (framework === 'opencode') {
    return createOpenCodeImmediateHandoffRuntime({
      runtime,
      resolveSpecialistId: () => 'specialist-approved',
      reportHandoffFailure: async () => undefined
    })
  }
  return createClaudeCodeCompletionGateRuntime({
    sessionFramework: () => 'claude-code',
    cancelPrompt: runtime.cancelPrompt,
    waitForPromptOwnershipRelease: runtime.waitForPromptOwnershipRelease,
    resolveSpecialistId: () => 'specialist-approved',
    resolveSwitchReadBack: async (currentSessionId, targetName) => ({
      status: 'approved',
      operation: 'switch',
      binding: { sessionId: currentSessionId, specialistId: 'specialist-approved', targetName }
    }),
    prepareReplayContext: async () => undefined,
    discardReplayContext: async () => undefined,
    switchSpecialist: runtime.switchSpecialist,
    createContinuationRequest: async () => ({ sessionId, text: 'continue' }),
    sendAppContinuation: runtime.startContinuation
  })
}

// Hosted Windows full-suite shards can miss the default 1s waitFor before the broker emits.
const APPROVAL_PROMPT_WAIT_MS = 10_000

type CertificationOutcome = 'approved' | 'declined' | 'post-approval-race'
type CertificationResult = {
  provider: FakeAcpProvider
  lifecycleEvents: Awaited<ReturnType<CompletionHandoffLifecycle['getEvents']>>
}
const certificationOutcomes: CertificationOutcome[] = ['approved', 'declined', 'post-approval-race']

const createProductionExecuteControlHarness = async (
  framework: HandoffFramework,
  outcome: CertificationOutcome
): Promise<CertificationResult> => {
  const approved = outcome !== 'declined'
  const emitted: Array<Parameters<ConstructorParameters<typeof AcpPermissionBroker>[0]>[0]> = []
  const broker = new AcpPermissionBroker((request) => emitted.push(request))
  const approvalGateway = new AcpSpecialistApprovalGateway({
    bridge: createAcpBackedSpecialistBridge({
      request: async (payload, session) => {
        const granted = await broker.requestAppApproval({
          sessionId: session.sessionId ?? '',
          title: 'Switch to Approved Specialist?',
          rawInput: { specialistApproval: payload }
        })
        return granted ? { outcome: 'approved' } : { outcome: 'declined' }
      }
    })
  })
  const provider = new FakeAcpProvider()
  const registry = new CompletionGateRuntimeRegistry()
  registry.register(concreteFrameworkRuntime(framework, provider))
  const lifecycle = new CompletionHandoffLifecycle(
    new InMemoryCompletionHandoffRepository(),
    registry,
    () => 1,
    undefined,
    async () => ({ specialistId: 'specialist-approved', revision: 1 })
  )
  const coordinator = new CompletionGateCoordinator(registry, lifecycle)
  const connectorStarted = deferred()
  const finishConnector = deferred<unknown>()
  const harness = await createExecuteControlHarness({
    approvalGateway,
    coordinator,
    lifecycle,
    // If the old callback is reached it synchronously starts an old-identity provider request.
    // That makes accidental post-approval delivery observable at the same boundary production uses.
    deliverToOldPrompt: async () => provider.recordOldToolResultRequest(),
    ...(outcome === 'post-approval-race'
      ? {
          connectorCall: async () => {
            connectorStarted.resolve()
            return finishConnector.promise
          }
        }
      : {})
  })
  try {
    const execution = harness.executeControl(
      outcome === 'post-approval-race'
        ? "await host.agents.switch('Approved Specialist'); return host.mcp('test', 'race')"
        : "return await host.agents.switch('Approved Specialist')"
    )
    await vi.waitFor(() => expect(emitted).toHaveLength(1), { timeout: APPROVAL_PROMPT_WAIT_MS })
    await broker.respond({
      requestId: emitted[0].requestId,
      optionId: emitted[0].options.find(
        (option) => option.kind === (approved ? 'allow_once' : 'reject_once')
      )?.optionId
    })
    if (outcome === 'post-approval-race') {
      await connectorStarted.promise
      // The old callback would immediately create a request, so an empty provider is the race
      // assertion rather than a callback-order proxy.
      expect(provider.requests).toEqual([])
      finishConnector.resolve({ done: true })
      await expect(execution).rejects.toBeInstanceOf(NotebookControlCompletionCapturedError)
    } else if (approved) {
      await expect(execution).rejects.toBeInstanceOf(NotebookControlCompletionCapturedError)
    } else {
      await expect(execution).resolves.toMatchObject({ status: 'completed' })
    }
    return { provider, lifecycleEvents: await lifecycle.getEvents('trusted-session') }
  } finally {
    finishConnector.resolve({ done: true })
    await harness.close()
  }
}

describe('completion gate through the real host.agents SDK and executeControl seam', () => {
  it.each(
    (['codex', 'opencode', 'claude-code'] as const).flatMap((framework) =>
      certificationOutcomes.map((outcome) => [framework, outcome] as const)
    )
  )(
    'durably certifies the %s provider projection for an ACP %s handoff',
    async (framework, outcome) => {
      const approved = outcome !== 'declined'
      const certified = await createProductionExecuteControlHarness(framework, outcome)
      expect(certified.provider.requests).toEqual(
        approved
          ? [
              expect.objectContaining({
                identity: 'Approved Specialist',
                capabilities: ['approved-capability']
              })
            ]
          : [expect.objectContaining({ identity: 'old-specialist' })]
      )
      expect(certified.provider.reconfigurations).toEqual(
        approved ? [{ specialistId: 'specialist-approved' }] : []
      )
      expect(certified.lifecycleEvents).toEqual(
        approved
          ? [expect.objectContaining({ phase: 'continued', target: 'Approved Specialist' })]
          : []
      )
    }
  )

  it('projects a real pending approval through local RPC and clears it when the card declines', async () => {
    const emitted: Array<Parameters<ConstructorParameters<typeof AcpPermissionBroker>[0]>[0]> = []
    const broker = new AcpPermissionBroker((request) => emitted.push(request))
    const approvalGateway = new AcpSpecialistApprovalGateway({
      bridge: createAcpBackedSpecialistBridge({
        request: async (payload, session) => {
          const approved = await broker.requestAppApproval({
            sessionId: session.sessionId ?? '',
            title: 'Switch to Approved Specialist?',
            rawInput: { specialistApproval: payload }
          })
          return approved ? { outcome: 'approved' } : { outcome: 'declined' }
        }
      })
    })
    const registry = new CompletionGateRuntimeRegistry()
    registry.register(concreteFrameworkRuntime('codex', new FakeAcpProvider()))
    const lifecycle = new CompletionHandoffLifecycle(
      new InMemoryCompletionHandoffRepository(),
      registry
    )
    const harness = await createExecuteControlHarness({
      approvalGateway,
      lifecycle,
      coordinator: new CompletionGateCoordinator(registry, lifecycle)
    })
    try {
      const execution = harness.executeControl(
        "return await host.agents.switch('Approved Specialist')"
      )
      await vi.waitFor(() => expect(emitted).toHaveLength(1), { timeout: APPROVAL_PROMPT_WAIT_MS })
      await expect(lifecycle.getEvents('trusted-session')).resolves.toMatchObject([
        { phase: 'awaiting-approval', target: 'Approved Specialist' }
      ])
      await broker.respond({
        requestId: emitted[0].requestId,
        optionId: emitted[0].options.find((option) => option.kind === 'reject_once')?.optionId
      })
      await expect(execution).resolves.toMatchObject({ status: 'completed' })
      await expect(lifecycle.getEvents('trusted-session')).resolves.toEqual([])
    } finally {
      await harness.close()
    }
  })

  it('captures an immediate approved completion once after JavaScript returns from switch()', async () => {
    const harness = await createExecuteControlHarness()
    try {
      await expect(
        harness.executeControl("return await host.agents.switch('Approved Specialist')")
      ).rejects.toBeInstanceOf(NotebookControlCompletionCapturedError)

      expect(harness.executeControl).toHaveBeenCalledOnce()
      expect(harness.persistBinding).toHaveBeenCalledOnce()
      expect(harness.deliverToCurrentPrompt).not.toHaveBeenCalled()
      expect(harness.continuations).toHaveLength(1)
      expect(harness.continuations[0].targetName).toBe('Approved Specialist')
      expect(capturedControlResult(harness.continuations[0])).toMatchObject({
        status: 'completed'
      })
      expect(harness.calls).toEqual([
        'stop-old-prompt',
        'ownership-released',
        'reconfigure:Approved Specialist',
        'provider-request:Approved Specialist'
      ])
    } finally {
      await harness.close()
    }
  })

  it('captures a post-approval JavaScript error once for the new continuation', async () => {
    const harness = await createExecuteControlHarness()
    try {
      await expect(
        harness.executeControl(
          "await host.agents.switch('Approved Specialist'); throw new Error('failed after approval')"
        )
      ).rejects.toBeInstanceOf(NotebookControlCompletionCapturedError)

      expect(harness.executeControl).toHaveBeenCalledOnce()
      expect(harness.deliverToCurrentPrompt).not.toHaveBeenCalled()
      expect(harness.continuations).toHaveLength(1)
      expect(capturedControlResult(harness.continuations[0])).toMatchObject({
        status: 'failed',
        traceback: expect.stringContaining('failed after approval')
      })
      expect(harness.calls.filter((call) => call.startsWith('provider-request:'))).toEqual([
        'provider-request:Approved Specialist'
      ])
    } finally {
      await harness.close()
    }
  })

  it('does not hand off until approved JavaScript finishes its long-running outer work', async () => {
    const connectorStarted = deferred()
    const finishConnector = deferred<unknown>()
    const harness = await createExecuteControlHarness({
      connectorCall: async () => {
        connectorStarted.resolve()
        return finishConnector.promise
      }
    })
    try {
      const execution = harness.executeControl(
        "await host.agents.switch('Approved Specialist'); return host.mcp('test', 'wait')"
      )
      await connectorStarted.promise

      expect(harness.executeControl).toHaveBeenCalledOnce()
      expect(harness.persistBinding).toHaveBeenCalledOnce()
      expect(harness.calls).toEqual([])
      expect(harness.continuations).toEqual([])
      expect(harness.deliverToCurrentPrompt).not.toHaveBeenCalled()

      finishConnector.resolve({ finished: true })
      await expect(execution).rejects.toBeInstanceOf(NotebookControlCompletionCapturedError)

      expect(harness.continuations).toHaveLength(1)
      expect(capturedControlResult(harness.continuations[0])).toMatchObject({ status: 'completed' })
      expect(harness.calls.filter((call) => call.startsWith('provider-request:'))).toHaveLength(1)
    } finally {
      finishConnector.resolve({ finished: true })
      await harness.close()
    }
  })

  it('waits for an approved connector cancellation and captures its outcome only for the new continuation', async () => {
    const connectorStarted = deferred()
    const cancellation = new AbortController()
    const harness = await createExecuteControlHarness({
      connectorCall: async () => {
        connectorStarted.resolve()
        return new Promise((_resolve, reject) => {
          cancellation.signal.addEventListener('abort', () => reject(cancellation.signal.reason), {
            once: true
          })
        })
      }
    })
    try {
      const execution = harness.executeControl(
        "await host.agents.switch('Approved Specialist'); return host.mcp('test', 'cancel')"
      )
      await connectorStarted.promise

      expect(harness.calls).toEqual([])
      expect(harness.continuations).toEqual([])
      expect(harness.deliverToCurrentPrompt).not.toHaveBeenCalled()

      cancellation.abort(new Error('connector request cancelled'))
      await expect(execution).rejects.toBeInstanceOf(NotebookControlCompletionCapturedError)

      expect(harness.executeControl).toHaveBeenCalledOnce()
      expect(harness.deliverToCurrentPrompt).not.toHaveBeenCalled()
      expect(harness.continuations).toHaveLength(1)
      expect(capturedControlResult(harness.continuations[0])).toMatchObject({
        status: 'failed',
        traceback: expect.stringContaining('connector request cancelled')
      })
      expect(harness.calls.filter((call) => call.startsWith('provider-request:'))).toEqual([
        'provider-request:Approved Specialist'
      ])
    } finally {
      cancellation.abort(new Error('test cleanup'))
      await harness.close()
    }
  })

  it('preserves the outer executeControl timeout before handing the timeout outcome off once', async () => {
    const connectorStarted = deferred()
    const finishConnector = deferred<unknown>()
    const harness = await createExecuteControlHarness({
      connectorCall: async () => {
        connectorStarted.resolve()
        return finishConnector.promise
      }
    })
    try {
      const execution = harness.executeControl(
        "await host.agents.switch('Approved Specialist'); return host.mcp('test', 'wait')",
        200
      )
      await connectorStarted.promise

      expect(harness.calls).toEqual([])
      expect(harness.continuations).toEqual([])

      await expect(execution).rejects.toBeInstanceOf(NotebookControlCompletionCapturedError)
      finishConnector.resolve({ tooLate: true })

      expect(harness.executeControl).toHaveBeenCalledOnce()
      expect(harness.deliverToCurrentPrompt).not.toHaveBeenCalled()
      expect(harness.continuations).toHaveLength(1)
      expect(capturedControlResult(harness.continuations[0])).toMatchObject({ status: 'timeout' })
      expect(harness.calls.filter((call) => call.startsWith('provider-request:'))).toHaveLength(1)
    } finally {
      finishConnector.resolve({ tooLate: true })
      await harness.close()
    }
  })

  it('continues only once as the last approved target from one outer execution', async () => {
    const harness = await createExecuteControlHarness()
    try {
      await expect(
        harness.executeControl(
          "await host.agents.switch(null); return host.agents.switch('Approved Specialist')"
        )
      ).rejects.toBeInstanceOf(NotebookControlCompletionCapturedError)

      expect(harness.executeControl).toHaveBeenCalledOnce()
      expect(harness.persistBinding).toHaveBeenCalledTimes(2)
      expect(harness.deliverToCurrentPrompt).not.toHaveBeenCalled()
      expect(harness.continuations).toHaveLength(1)
      expect(harness.continuations[0].targetName).toBe('Approved Specialist')
      expect(harness.calls).toEqual([
        'stop-old-prompt',
        'ownership-released',
        'reconfigure:Approved Specialist',
        'provider-request:Approved Specialist'
      ])
    } finally {
      await harness.close()
    }
  })

  it('uses the same immediate executeControl handoff semantics when returning to Main Agent', async () => {
    const harness = await createExecuteControlHarness()
    try {
      await expect(
        harness.executeControl('return host.agents.switch(null)')
      ).rejects.toBeInstanceOf(NotebookControlCompletionCapturedError)

      expect(harness.executeControl).toHaveBeenCalledOnce()
      expect(harness.persistBinding).toHaveBeenCalledWith('trusted-session', undefined)
      expect(harness.deliverToCurrentPrompt).not.toHaveBeenCalled()
      expect(harness.continuations).toHaveLength(1)
      expect(harness.continuations[0].targetName).toBeNull()
      expect(harness.calls).toEqual([
        'stop-old-prompt',
        'ownership-released',
        'reconfigure:null',
        'provider-request:null'
      ])
    } finally {
      await harness.close()
    }
  })

  it.each([
    {
      drift: 'rename',
      mutate: (current: SpecialistView | undefined) =>
        current ? { ...current, name: 'Renamed Specialist' } : undefined
    },
    {
      drift: 'disable',
      mutate: (current: SpecialistView | undefined) =>
        current ? { ...current, enabled: false } : undefined
    },
    {
      drift: 'delete',
      mutate: () => undefined
    },
    {
      drift: 'revision',
      mutate: (current: SpecialistView | undefined) =>
        current ? { ...current, revision: current.revision + 1 } : undefined
    },
    {
      drift: 'identity replacement',
      mutate: (current: SpecialistView | undefined) =>
        current ? { ...current, id: 'replacement-specialist' } : undefined
    }
  ])(
    'fails closed on approval-time $drift drift before committing a handoff',
    async ({ mutate }) => {
      const harness = await createExecuteControlHarness({
        onApproval: (current) => mutate(current)
      })
      try {
        const result = await harness.executeControl(
          "return host.agents.switch('Approved Specialist')"
        )

        expect(harness.executeControl).toHaveBeenCalledOnce()
        expect(result).toMatchObject({
          status: 'failed',
          traceback: expect.stringContaining('host.agents.switch:')
        })
        expect(harness.persistBinding).not.toHaveBeenCalled()
        expect(harness.deliverToCurrentPrompt).toHaveBeenCalledOnce()
        expect(harness.continuations).toEqual([])
        expect(harness.calls).toEqual(['provider-request:old'])
      } finally {
        await harness.close()
      }
    }
  )
})
