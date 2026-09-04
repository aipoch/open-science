import type { ActiveSession, PromptResponse } from '@agentclientprotocol/sdk'
import { rmSync } from 'node:fs'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi, type Mock } from 'vitest'

import type { AcpPromptRequest } from '../../shared/acp'
import type { ActivePlanProjection } from '../../shared/session-plan/contract'
import { opencodeFramework } from '../agent-framework'
import type { ArtifactTurnHandle } from './artifact-turn-owner'
import type { AcpBackendGenerationView } from './backend-generation-owner'
import type { ContextWindowTurnHandle } from './context-usage-tracker'
import { AcpPromptOutcomeFinalizer } from './prompt-outcome-finalizer'
import type { ReadyPreparedPromptHandle } from './prompt-preparation-owner'
import { AcpPromptTurnWorkflow, type AcpPromptTurnWorkflowOptions } from './prompt-turn-workflow'
import { AcpProviderPromptSerializationOwner } from './provider-prompt-serialization-owner'
import { AcpSessionAggregate } from './session-aggregate'
import { AcpSessionInteractionOwner } from './session-interaction-owner'
import type { TurnSkillHandle } from './turn-skill-owner'

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void }
type Harness = {
  admitPlan: Mock<AcpPromptTurnWorkflowOptions['plan']['admit']>
  artifacts: {
    open: Mock<AcpPromptTurnWorkflowOptions['artifacts']['open']>
    promptMessageIdFor: Mock<AcpPromptTurnWorkflowOptions['artifacts']['promptMessageIdFor']>
    publish: Mock<AcpPromptTurnWorkflowOptions['artifacts']['publish']>
    dispose: Mock<AcpPromptTurnWorkflowOptions['artifacts']['dispose']>
  }
  authorize: Mock<AcpPromptTurnWorkflowOptions['skills']['authorize']>
  context: ContextWindowTurnHandle
  contextUsage: { reconcileUsed: Mock<(sessionId: string, used: number) => boolean> }
  emitSkillActivities: Mock<AcpPromptTurnWorkflowOptions['environment']['emitSkillActivities']>
  executor: Mock<AcpPromptTurnWorkflowOptions['executor']['execute']>
  finalization: {
    errorMessage: AcpPromptTurnWorkflowOptions['finalization']['errorMessage']
    errorKind: AcpPromptTurnWorkflowOptions['finalization']['errorKind']
    pushEvent: Mock<AcpPromptTurnWorkflowOptions['finalization']['pushEvent']>
    onPromptEnded: Mock<AcpPromptTurnWorkflowOptions['finalization']['onPromptEnded']>
    generationActivityChanged: Mock<
      AcpPromptTurnWorkflowOptions['finalization']['generationActivityChanged']
    >
    autoCompact: Mock<AcpPromptTurnWorkflowOptions['finalization']['autoCompact']>
    compactIfIdle: Mock<AcpPromptTurnWorkflowOptions['finalization']['compactIfIdle']>
    preemptCompaction: Mock<AcpPromptTurnWorkflowOptions['finalization']['preemptCompaction']>
  }
  finalizer: Mock<AcpPromptOutcomeFinalizer['finalize']>
  interactions: {
    current: Mock<AcpSessionInteractionOwner['current']>
    reservePrompt: Mock<AcpSessionInteractionOwner['reservePrompt']>
    activatePrompt: Mock<AcpSessionInteractionOwner['activatePrompt']>
    cancellationCheckpoint: Mock<AcpSessionInteractionOwner['cancellationCheckpoint']>
    captureTerminal: Mock<AcpSessionInteractionOwner['captureTerminal']>
    settle: Mock<AcpSessionInteractionOwner['settle']>
    updatePromptProvenance: Mock<AcpSessionInteractionOwner['updatePromptProvenance']>
    release: Mock<AcpSessionInteractionOwner['release']>
    supersede: Mock<AcpSessionInteractionOwner['supersede']>
  }
  journal: string[]
  onProviderPromptAccepted: Mock<
    NonNullable<AcpPromptTurnWorkflowOptions['environment']['onProviderPromptAccepted']>
  >
  owner: AcpSessionInteractionOwner
  planLifecycle: {
    providerAccepted: Mock<AcpPromptTurnWorkflowOptions['plan']['providerAccepted']>
    beforeRelease: Mock<AcpPromptTurnWorkflowOptions['plan']['beforeRelease']>
    afterRelease: Mock<AcpPromptTurnWorkflowOptions['plan']['afterRelease']>
  }
  permission: AcpPromptTurnWorkflowOptions['permission']
  preparation: Mock<AcpPromptTurnWorkflowOptions['preparation']['prepare']>
  preflightPlan: Mock<AcpPromptTurnWorkflowOptions['plan']['preflight']>
  prepared: ReadyPreparedPromptHandle
  pushUserMessage: Mock<AcpPromptTurnWorkflowOptions['environment']['pushUserMessage']>
  routeNotification: Mock<AcpPromptTurnWorkflowOptions['environment']['routeNotification']>
  resumeAfterReload: Mock<AcpPromptTurnWorkflowOptions['resumeAfterReload']>
  setSession: (replacement: ActiveSession) => void
  skill: TurnSkillHandle
  workflow: AcpPromptTurnWorkflow
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

const skillHandle = (kind: 'continue' | 'reload' = 'continue'): TurnSkillHandle => ({
  reloadDecision: { kind },
  prepareProvider: vi.fn(async ({ promptText }) => ({ text: promptText, codexSkillInputs: [] })),
  close: vi.fn()
})

const backend: AcpBackendGenerationView = {
  framework: opencodeFramework,
  session: { model: 'test-model', modelRequired: false },
  prompt: { systemPromptAppends: [] },
  context: { supportsImageInput: false },
  adapter: { nativeMcpEnabled: true, bridgeMcpAliasesEnabled: false }
}

const planProjection = (): ActivePlanProjection => ({
  artifactId: 'plan-1',
  artifactVersionId: 'plan-version-1',
  artifactChecksum: 'a'.repeat(64),
  revision: 2,
  approval: 'approved',
  lifecycle: 'approved',
  document: {
    schema_version: 1,
    task_summary: 'Analyze the result',
    phases: [
      {
        name: 'Analysis',
        delegations: [
          {
            name: 'Primary',
            steps: [{ title: 'Analyze', description: 'Analyze the result.' }]
          }
        ]
      }
    ],
    desired_outputs: ['Result'],
    feasibility: { confidence: 'high', rationale: 'Inputs are available.' }
  },
  stepStatuses: {},
  stepStates: { Analyze: { status: 'not_started' } },
  counts: { phases: 1, delegations: 1, steps: 1, completed: 0, inProgress: 0 }
})

const createHarness = (
  input: {
    admitPlan?: AcpPromptTurnWorkflowOptions['plan']['admit']
    authorize?: () => TurnSkillHandle | Promise<TurnSkillHandle>
    backend?: AcpBackendGenerationView
    beforePromptDispatch?: AcpPromptTurnWorkflowOptions['environment']['beforePromptDispatch']
    cancellationCheckpoint?: AcpPromptTurnWorkflowOptions['interactions']['cancellationCheckpoint']
    execute?: AcpPromptTurnWorkflowOptions['executor']['execute']
    finalize?: AcpPromptOutcomeFinalizer['finalize']
    onPromptStarted?: () => void
    preflightPlan?: AcpPromptTurnWorkflowOptions['plan']['preflight']
    preemptCompaction?: AcpPromptTurnWorkflowOptions['finalization']['preemptCompaction']
    prepare?: AcpPromptTurnWorkflowOptions['preparation']['prepare']
    providerReconnectPending?: () => boolean
    resolveComputeExecutionTargetIds?: (sessionId: string) => readonly string[]
    skillRuntimeAllowlist?: readonly string[]
    sideChatClaim?: NonNullable<
      NonNullable<AcpPromptTurnWorkflowOptions['environment']['sideChatRelays']>['claim']
    >
  } = {}
): Harness => {
  const journal: string[] = []
  const runtimeBackend = input.backend ?? backend
  const owner = new AcpSessionInteractionOwner()
  let session = { sessionId: 'provider-1' } as ActiveSession
  const aggregate = new AcpSessionAggregate('app-1')
  aggregate.attach({
    session,
    cwd: '/session',
    projectId: 'project-1',
    frameworkId: runtimeBackend.framework.id,
    permissionProfile: {
      selectedProfile: 'ask',
      effectiveProfile: 'ask',
      currentModeId: 'default',
      availableModeIds: ['default'],
      fullAccessAvailable: false
    }
  })
  aggregate.setSpecialistId('specialist-1')
  aggregate.setSpecialistPrefix('[Analyst]')
  aggregate.setSessionSetupPromptPrefix('Project Agent Context.')
  const lookup = vi.fn(() => ({
    appSessionId: 'app-1',
    generation: 1,
    aggregate,
    attachment: {
      appSessionId: 'app-1',
      providerSessionId: session.sessionId,
      generation: 1,
      session
    }
  }))
  const interactions: Harness['interactions'] = {
    current: vi.fn((sessionId: string) => owner.current(sessionId)),
    reservePrompt: vi.fn((request: Parameters<typeof owner.reservePrompt>[0]) => {
      journal.push('reserve')
      return owner.reservePrompt(request)
    }),
    activatePrompt: vi.fn((scope: Parameters<typeof owner.activatePrompt>[0]) => {
      journal.push('activate')
      return owner.activatePrompt(scope)
    }),
    cancellationCheckpoint: vi.fn(
      async (scope: Parameters<typeof owner.cancellationCheckpoint>[0]) => {
        journal.push('checkpoint')
        return input.cancellationCheckpoint?.(scope) ?? owner.cancellationCheckpoint(scope)
      }
    ),
    captureTerminal: vi.fn((...args: Parameters<typeof owner.captureTerminal>) =>
      owner.captureTerminal(...args)
    ),
    settle: vi.fn((...args: Parameters<typeof owner.settle>) => owner.settle(...args)),
    updatePromptProvenance: vi.fn((...args: Parameters<typeof owner.updatePromptProvenance>) =>
      owner.updatePromptProvenance(...args)
    ),
    release: vi.fn((scope: Parameters<typeof owner.release>[0]) => owner.release(scope)),
    supersede: vi.fn((scope: Parameters<typeof owner.supersede>[0]) => owner.supersede(scope))
  }
  const skill = skillHandle()
  const authorize: Harness['authorize'] = vi.fn(() => {
    journal.push('authorize')
    return input.authorize?.() ?? skill
  })
  const preflightPlan: Harness['preflightPlan'] = vi.fn((request, mode) => {
    journal.push('preflight')
    return input.preflightPlan?.(request, mode) ?? {}
  })
  const admitPlan: Harness['admitPlan'] = vi.fn(
    (...args: Parameters<AcpPromptTurnWorkflowOptions['plan']['admit']>) => {
      journal.push('admit')
      return input.admitPlan?.(...args) ?? {}
    }
  )
  const context = {
    complete: vi.fn(() => true),
    fail: vi.fn(),
    supersede: vi.fn()
  } as unknown as ContextWindowTurnHandle
  const prepared = {
    status: 'ready',
    content: 'provider content',
    skillActivityInputs: [{ name: 'Research', path: '/skills/research/SKILL.md' }],
    ...(input.skillRuntimeAllowlist ? { skillRuntimeAllowlist: input.skillRuntimeAllowlist } : {}),
    transferContextTurn: vi.fn(() => context),
    close: vi.fn()
  } satisfies ReadyPreparedPromptHandle
  const preparation: Harness['preparation'] = vi.fn(async (request) => {
    journal.push('prepare')
    return input.prepare?.(request) ?? prepared
  })
  const planLifecycle: Harness['planLifecycle'] = {
    providerAccepted: vi.fn(async () => {
      journal.push('plan:provider-accepted')
    }),
    beforeRelease: vi.fn(() => {
      journal.push('plan:before-release')
    }),
    afterRelease: vi.fn(async () => {
      journal.push('plan:after-release')
    })
  }
  const onProviderPromptAccepted: Harness['onProviderPromptAccepted'] = vi.fn(() => {
    journal.push('accepted')
  })
  const executor: Harness['executor'] = vi.fn(async (request) => {
    journal.push('execute')
    if (input.execute) return input.execute(request)
    request.onAccepted()
    const response: PromptResponse = { stopReason: 'end_turn' }
    request.captureStop()
    return { kind: 'stopped' as const, response, facts: {} }
  })
  const finalizer: Harness['finalizer'] = vi.fn(async (handles, outcome) => {
    journal.push('finalize')
    if (input.finalize) return input.finalize(handles, outcome)
    if (outcome.kind === 'failed') throw outcome.error
    if (outcome.kind === 'not-dispatched') return { stopReason: 'cancelled' }
    return outcome.response
  })
  const artifact = {} as ArtifactTurnHandle
  const artifacts: Harness['artifacts'] = {
    open: vi.fn(async () => {
      journal.push('artifact:open')
      return artifact
    }),
    promptMessageIdFor: vi.fn(() => 'fallback-message-1'),
    publish: vi.fn(async (_sessionId, _artifact, onPublished) => {
      journal.push('artifact:publish')
      onPublished()
    }),
    dispose: vi.fn(async () => {
      journal.push('artifact:dispose')
    })
  }
  const permission = { clearCorrelationsForSession: vi.fn() }
  const contextUsage = { reconcileUsed: vi.fn(() => true) }
  const finalization: Harness['finalization'] = {
    errorMessage: (error) => (error instanceof Error ? error.message : String(error)),
    errorKind: (error) => (error as { data?: { errorKind?: string } } | undefined)?.data?.errorKind,
    pushEvent: vi.fn(),
    onPromptEnded: vi.fn(),
    generationActivityChanged: vi.fn(),
    autoCompact: vi.fn(async () => undefined),
    compactIfIdle: vi.fn(async () => undefined),
    preemptCompaction: vi.fn((sessionId) => {
      journal.push('compaction:preempt')
      return input.preemptCompaction?.(sessionId)
    })
  }
  const pushUserMessage: Harness['pushUserMessage'] = vi.fn(() => {
    journal.push('event:message')
  })
  const routeNotification: Harness['routeNotification'] = vi.fn()
  const emitSkillActivities: Harness['emitSkillActivities'] = vi.fn(
    (_sessionId, _turn, _skills, status) => {
      journal.push(`skills:${status}`)
    }
  )
  const resumeAfterReload: Harness['resumeAfterReload'] = vi.fn(async () => ({
    contextReset: false
  }))
  const workflowOptions = {
    registry: {
      lookup,
      select: vi.fn(() => journal.push('select'))
    },
    interactions,
    skills: { authorize },
    preparation: { prepare: preparation },
    executor: { execute: executor },
    serialization: new AcpProviderPromptSerializationOwner(),
    contextUsage,
    providerReconnectPending: input.providerReconnectPending ?? (() => false),
    environment: {
      backend: () => runtimeBackend,
      tooling: () => ({ artifacts: true, notebook: true, skillImport: true }),
      bridgeSkillsAvailable: () => true,
      skillImportEnabled: () => true,
      contextEstimateInput: () => ({ frameworkId: 'opencode' }),
      selectedContextWindow: () => 128_000,
      ...(input.resolveComputeExecutionTargetIds
        ? { resolveComputeExecutionTargetIds: input.resolveComputeExecutionTargetIds }
        : {}),
      emitSkillActivities,
      onProviderPromptAccepted,
      ...(input.sideChatClaim ? { sideChatRelays: { claim: input.sideChatClaim } } : {}),
      routeNotification,
      diagnosticContext: () => ({}),
      pushUserMessage,
      ...(input.beforePromptDispatch ? { beforePromptDispatch: input.beforePromptDispatch } : {})
    },
    artifacts,
    plan: { preflight: preflightPlan, admit: admitPlan, ...planLifecycle },
    finalizer: { finalize: finalizer },
    permission,
    finalization,
    currentCwd: () => '/default',
    resolveProjectId: () => 'project-1',
    disconnectForReload: vi.fn(async () => journal.push('disconnect')),
    resumeAfterReload,
    recordAdmittedPrompt: vi.fn(() => journal.push('handoff')),
    onPromptStarted: vi.fn(() => {
      journal.push('start')
      input.onPromptStarted?.()
    }),
    emitState: vi.fn(() => journal.push('state'))
  } satisfies AcpPromptTurnWorkflowOptions
  const workflow = new AcpPromptTurnWorkflow(workflowOptions)
  return {
    admitPlan,
    artifacts,
    authorize,
    context,
    contextUsage,
    emitSkillActivities,
    executor,
    finalization,
    finalizer,
    interactions,
    journal,
    onProviderPromptAccepted,
    owner,
    planLifecycle,
    permission,
    preparation,
    preflightPlan,
    prepared,
    pushUserMessage,
    routeNotification,
    resumeAfterReload,
    setSession: (replacement: ActiveSession) => (session = replacement),
    skill,
    workflow
  }
}

const request = (sessionId = 's1'): AcpPromptRequest => ({
  sessionId,
  text: 'analyze',
  forcedSkillIds: ['research'],
  provenanceContext: { promptMessageId: 'message-1' }
})

describe('AcpPromptTurnWorkflow', () => {
  it('keeps a prepared resource snapshot through provider dispatch and removes it at terminal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'acp-workflow-snapshot-'))
    const snapshotPath = join(root, 'snapshot.txt')
    await writeFile(snapshotPath, 'verified bytes')
    const providerPrompt = vi.fn(async (content) => {
      await expect(access(snapshotPath)).resolves.toBeUndefined()
      expect(content).toEqual([
        expect.objectContaining({ type: 'resource_link', uri: pathToFileURL(snapshotPath).href })
      ])
    })
    const harness = createHarness({
      execute: async (input) => {
        expect(await input.beforeDispatch()).toBe('active')
        await input.session.prompt(input.content)
        await input.onAccepted()
        input.captureStop()
        return {
          kind: 'stopped',
          response: { stopReason: 'end_turn' },
          facts: {}
        }
      },
      finalize: (handles, outcome) => new AcpPromptOutcomeFinalizer().finalize(handles, outcome)
    })
    harness.setSession({
      sessionId: 'provider-2',
      prompt: providerPrompt,
      nextUpdate: vi.fn()
    } as unknown as ActiveSession)
    Object.assign(harness.prepared, {
      content: [
        {
          type: 'resource_link',
          uri: pathToFileURL(snapshotPath).href,
          name: 'notes.txt',
          mimeType: 'text/plain'
        }
      ]
    })
    vi.mocked(harness.prepared.close).mockImplementation(() =>
      rmSync(root, { recursive: true, force: true })
    )
    Object.assign(harness.context, { captureTerminal: vi.fn(() => undefined) })

    try {
      await expect(harness.workflow.run(request(), { kind: 'user' })).resolves.toEqual({
        stopReason: 'end_turn'
      })
      expect(providerPrompt).toHaveBeenCalledOnce()
      await expect(readFile(snapshotPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(harness.prepared.close).toHaveBeenCalledOnce()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('binds referenced Session ids to the prompt reservation', async () => {
    const harness = createHarness()

    await harness.workflow.run(
      {
        ...request(),
        referencedSessions: [{ type: 'session', sessionId: 'session-2', title: 'Prior result' }]
      },
      { kind: 'user' }
    )

    expect(harness.interactions.reservePrompt).toHaveBeenCalledWith(
      expect.objectContaining({ referencedSessionIds: ['session-2'] })
    )
  })

  it('admits and executes one user turn in owner order with its opaque handles', async () => {
    const harness = createHarness()

    const turn = harness.workflow.run(request(), {
      kind: 'user',
      promptAttemptId: 'attempt-1'
    })

    await vi.waitFor(() => expect(harness.interactions.activatePrompt).toHaveBeenCalledOnce())
    expect(harness.journal.slice(0, 10)).toEqual([
      'reserve',
      'compaction:preempt',
      'preflight',
      'authorize',
      'activate',
      'admit',
      'select',
      'handoff',
      'start',
      'state'
    ])
    await expect(turn).resolves.toEqual({ stopReason: 'end_turn' })
    expect(harness.journal).toEqual([
      'reserve',
      'compaction:preempt',
      'preflight',
      'authorize',
      'activate',
      'admit',
      'select',
      'handoff',
      'start',
      'state',
      'artifact:open',
      'checkpoint',
      'prepare',
      'event:message',
      'skills:in_progress',
      'execute',
      'plan:provider-accepted',
      'accepted',
      'skills:completed',
      'finalize'
    ])
    const [handles, outcome] = harness.finalizer.mock.calls[0]
    expect(handles).toMatchObject({
      sessionId: 's1',
      promptMessageId: 'message-1',
      interaction: expect.objectContaining({ promptMessageId: 'message-1' }),
      interactions: harness.interactions,
      permission: harness.permission,
      context: harness.context,
      prepared: harness.prepared,
      skill: harness.skill,
      model: 'test-model'
    })
    expect(outcome).toMatchObject({
      kind: 'stopped',
      response: { stopReason: 'end_turn' }
    })
    expect(harness.preparation).toHaveBeenCalledWith(
      expect.objectContaining({
        specialistPrefix: '[Analyst]',
        sessionSetupPromptPrefix: 'Project Agent Context.'
      })
    )

    const onPublished = vi.fn()
    await handles.emitArtifact(onPublished)
    await handles.disposeArtifact()
    handles.recordContextUsed(42)
    handles.onPromptEnded()
    handles.generationActivityChanged()
    await handles.autoCompactIfNeeded()
    handles.failPendingSkillActivities()

    expect(harness.artifacts.publish).toHaveBeenCalledWith('s1', expect.any(Object), onPublished)
    expect(harness.artifacts.dispose).toHaveBeenCalledWith(expect.any(Object))
    expect(harness.contextUsage.reconcileUsed).toHaveBeenCalledWith('s1', 42)
    expect(harness.finalization.onPromptEnded).toHaveBeenCalledWith(
      's1',
      handles.interaction.turnToken
    )
    expect(harness.finalization.generationActivityChanged).toHaveBeenCalledOnce()
    expect(harness.finalization.autoCompact).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ sessionId: 'provider-1' }),
      handles.interaction
    )
    expect(harness.emitSkillActivities.mock.calls.map((call) => call[3])).toEqual([
      'in_progress',
      'completed'
    ])
  })

  it('awaits the admitted callback after interaction activation and before prompt start', async () => {
    const harness = createHarness()
    const callbackEntered = deferred<void>()
    const releaseCallback = deferred<void>()
    const onPromptAdmitted = vi.fn(async (): Promise<AcpPromptRequest['provenanceContext']> => {
      harness.journal.push('persist')
      expect(harness.owner.current('s1')).toMatchObject({ kind: 'prompt' })
      callbackEntered.resolve()
      await releaseCallback.promise
      return undefined
    })

    const turn = harness.workflow.run(request(), { kind: 'user' }, onPromptAdmitted)
    await callbackEntered.promise

    expect(harness.journal).toEqual([
      'reserve',
      'compaction:preempt',
      'preflight',
      'authorize',
      'activate',
      'admit',
      'persist'
    ])
    expect(harness.executor).not.toHaveBeenCalled()

    releaseCallback.resolve()
    await expect(turn).resolves.toEqual({ stopReason: 'end_turn' })
    expect(harness.journal.indexOf('persist')).toBeLessThan(harness.journal.indexOf('start'))
    expect(harness.journal.indexOf('persist')).toBeLessThan(harness.journal.indexOf('execute'))
  })

  it('uses provenance returned by prompt admission for the provider turn', async () => {
    let activeInteractionProvenance: AcpPromptRequest['provenanceContext']
    const harness = createHarness({
      onPromptStarted: () => {
        const current = harness.owner.current('s1')
        activeInteractionProvenance =
          current?.kind === 'prompt' ? current.provenanceContext : undefined
      }
    })
    const admittedProvenance = {
      promptMessageId: 'message-1',
      rootFrameId: 'root-frame-2',
      agentFrameId: 'agent-frame-2',
      messageBranchId: 'branch-2',
      runtimeSegmentId: 'runtime-segment-2'
    }
    const onPromptAdmitted = async (): Promise<AcpPromptRequest['provenanceContext']> =>
      admittedProvenance

    await expect(
      harness.workflow.run(request(), { kind: 'user' }, onPromptAdmitted)
    ).resolves.toEqual({ stopReason: 'end_turn' })

    expect(harness.artifacts.open).toHaveBeenCalledWith(
      's1',
      expect.any(String),
      admittedProvenance
    )
    expect(activeInteractionProvenance).toEqual(admittedProvenance)
  })

  it('releases prompt ownership when the admitted callback rejects', async () => {
    const harness = createHarness()
    const failure = new Error('Session persistence failed')

    await expect(
      harness.workflow.run(request(), { kind: 'user' }, async () => {
        throw failure
      })
    ).rejects.toBe(failure)

    expect(harness.owner.current('s1')).toBeUndefined()
    expect(harness.executor).not.toHaveBeenCalled()
    expect(harness.journal).not.toContain('start')
  })

  it('activates a framework-owned current Session before provider dispatch', async () => {
    const frameworkBeforePromptDispatch = vi.fn(async () => undefined)
    const beforePromptDispatch = vi.fn<
      NonNullable<AcpPromptTurnWorkflowOptions['environment']['beforePromptDispatch']>
    >(async ({ framework, providerSessionId, cwd }) => {
      await framework.beforePromptDispatch?.({
        connection: {} as never,
        providerSessionId,
        cwd,
        mcpServers: []
      })
    })
    const framework = {
      ...opencodeFramework,
      id: 'codebuddy' as const,
      displayName: 'CodeBuddy',
      beforePromptDispatch: frameworkBeforePromptDispatch
    }
    const harness = createHarness({
      backend: { ...backend, framework },
      beforePromptDispatch,
      skillRuntimeAllowlist: ['mcp-pubmed'],
      execute: async (input) => {
        await expect(input.beforeDispatch()).resolves.toBe('active')
        const response: PromptResponse = { stopReason: 'end_turn' }
        input.onAccepted()
        input.captureStop()
        return { kind: 'stopped', response, facts: {} }
      }
    })

    await harness.workflow.run(request(), { kind: 'user' })

    expect(beforePromptDispatch).toHaveBeenCalledWith({
      appSessionId: 's1',
      framework,
      providerSessionId: 'provider-1',
      cwd: '/session',
      skillRuntimeAllowlist: ['mcp-pubmed']
    })
    expect(frameworkBeforePromptDispatch).toHaveBeenCalledWith({
      connection: {},
      providerSessionId: 'provider-1',
      cwd: '/session',
      mcpServers: []
    })
  })

  it('serializes provider prompt dispatch for frameworks with process-global Session state', async () => {
    const firstDispatch = deferred<void>()
    const framework = {
      ...opencodeFramework,
      serializesProviderPrompts: true
    }
    const harness = createHarness({
      backend: { ...backend, framework },
      execute: async (input) => {
        await input.beforeDispatch()
        const dispatchIndex = harness.executor.mock.calls.length
        harness.journal.push(`provider:${dispatchIndex}`)
        if (dispatchIndex === 1) await firstDispatch.promise
        const response: PromptResponse = { stopReason: 'end_turn' }
        input.onAccepted()
        input.captureStop()
        return { kind: 'stopped', response, facts: {} }
      }
    })

    const first = harness.workflow.run(request('s1'), { kind: 'user' })
    await vi.waitFor(() => expect(harness.journal).toContain('provider:1'))
    const second = harness.workflow.run(request('s2'), { kind: 'user' })

    await vi.waitFor(() => expect(harness.preparation).toHaveBeenCalledTimes(2))
    expect(harness.journal).not.toContain('provider:2')

    firstDispatch.resolve()

    await expect(first).resolves.toEqual({ stopReason: 'end_turn' })
    await expect(second).resolves.toEqual({ stopReason: 'end_turn' })
    expect(harness.journal.indexOf('provider:1')).toBeLessThan(
      harness.journal.indexOf('provider:2')
    )
  })

  it('rejects delayed context usage after a successor or provider reconnect takes ownership', async () => {
    const successor = createHarness()
    await successor.workflow.run(request(), { kind: 'user' })
    const successorHandles = successor.finalizer.mock.calls[0][0]
    successor.interactions.current.mockReturnValue({} as never)

    successorHandles.recordContextUsed(41)

    expect(successor.contextUsage.reconcileUsed).not.toHaveBeenCalled()

    const reconnect = createHarness({ providerReconnectPending: () => true })
    await reconnect.workflow.run(request(), { kind: 'user' })
    reconnect.finalizer.mock.calls[0][0].recordContextUsed(42)

    expect(reconnect.contextUsage.reconcileUsed).not.toHaveBeenCalled()
  })

  it('propagates app-continuation identity without publishing its synthetic text', async () => {
    const harness = createHarness()
    const continuation = request()
    continuation.continuation = {
      kind: 'specialist-handoff',
      originatingTurnToken: 'origin-turn',
      targetName: 'Reviewer',
      completion: { kind: 'returned', value: 'done' }
    }

    await harness.workflow.run(continuation, {
      kind: 'app-continuation',
      promptAttemptId: 'attempt-2'
    })

    const handles = harness.finalizer.mock.calls[0][0]
    handles.emitUserMessage()
    expect(handles.interaction.turnToken).toBe('origin-turn')
    expect(harness.pushUserMessage).not.toHaveBeenCalled()
    expect(harness.onProviderPromptAccepted).toHaveBeenCalledWith('s1', 'attempt-2')
  })

  it('publishes an attributed application turn and routes its provider response', async () => {
    const claim = vi.fn(() => ({
      historyPreamble: 'Queued human side chat.',
      commit: vi.fn(),
      restore: vi.fn()
    }))
    const harness = createHarness({
      sideChatClaim: claim,
      execute: async (input) => {
        input.onAccepted()
        input.routeNotification({
          sessionId: 'provider-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Internal reviewer turn' }
          }
        })
        const response: PromptResponse = { stopReason: 'end_turn' }
        input.captureStop()
        return { kind: 'stopped', response, facts: {} }
      }
    })
    const attribution = {
      kind: 'application',
      feature: 'reviewer',
      purpose: 'correction',
      causeReviewId: 'review-1'
    } as const

    await harness.workflow.run(request(), { kind: 'application', attribution })
    harness.finalizer.mock.calls[0][0].emitUserMessage()

    expect(harness.pushUserMessage).toHaveBeenCalledWith({
      sessionId: 's1',
      promptMessageId: 'message-1',
      text: 'analyze',
      attribution
    })
    expect(claim).not.toHaveBeenCalled()
    expect(harness.routeNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Internal reviewer turn' }
        })
      }),
      's1'
    )
  })

  it('cannot let delayed admission clear a newer active interaction', async () => {
    const authorization = deferred<TurnSkillHandle>()
    const staleSkill = skillHandle()
    const harness = createHarness({ authorize: () => authorization.promise })
    const onPromptAdmitted = vi.fn(async () => undefined)
    const stale = harness.workflow.run(request(), { kind: 'user' }, onPromptAdmitted)
    await vi.waitFor(() => expect(harness.authorize).toHaveBeenCalledOnce())
    const staleReservation = harness.interactions.reservePrompt.mock.results[0].value
    const replacement = harness.owner.activatePrompt(
      harness.owner.reservePrompt({ sessionId: 's1', kind: 'prompt' })
    )

    authorization.resolve(staleSkill)

    await expect(stale).rejects.toThrow('already running')
    expect(staleSkill.close).toHaveBeenCalledWith('failed')
    expect(harness.interactions.release).toHaveBeenCalledWith(staleReservation)
    expect(harness.owner.current('s1')).toBe(replacement)
    expect(onPromptAdmitted).not.toHaveBeenCalled()
    expect(harness.preparation).not.toHaveBeenCalled()
    expect(harness.finalizer).not.toHaveBeenCalled()
  })

  it('refreshes reservation, session, and replay context after a Skill reload', async () => {
    const reloadedSkill = skillHandle('reload')
    const harness = createHarness({ authorize: () => reloadedSkill })
    const reloaded = { sessionId: 'provider-2' } as ActiveSession
    harness.resumeAfterReload.mockImplementation(async () => {
      harness.setSession(reloaded)
      return { contextReset: true }
    })
    const turn = request()
    turn.memoryEnabled = false
    turn.resumeFallback = { historyPreamble: 'restored transcript' }

    await harness.workflow.run(turn, { kind: 'user' })

    expect(harness.interactions.reservePrompt).toHaveBeenCalledTimes(2)
    expect(harness.resumeAfterReload).toHaveBeenCalledWith({
      sessionId: 's1',
      cwd: '/session',
      projectId: 'project-1',
      permissionProfile: 'ask',
      memoryEnabled: false
    })
    expect(turn).toMatchObject({ contextReset: true, historyPreamble: 'restored transcript' })
    expect(harness.executor.mock.calls[0][0].session).toBe(reloaded)
  })

  it('reserves before Plan preflight and admits only an activated interaction', async () => {
    const harness = createHarness()

    await harness.workflow.run(request(), { kind: 'user' })

    expect(harness.journal.indexOf('reserve')).toBeLessThan(harness.journal.indexOf('preflight'))
    expect(harness.journal.indexOf('activate')).toBeLessThan(harness.journal.indexOf('admit'))
    expect(harness.admitPlan.mock.calls[0][1]).toBe(
      harness.interactions.activatePrompt.mock.results[0].value
    )

    const rejected = createHarness({
      preflightPlan: async () => {
        throw new Error('stale Plan')
      }
    })
    await expect(rejected.workflow.run(request(), { kind: 'user' })).rejects.toThrow('stale Plan')
    expect(rejected.interactions.reservePrompt).toHaveBeenCalledOnce()
    expect(rejected.interactions.release).toHaveBeenCalledWith(
      rejected.interactions.reservePrompt.mock.results[0].value
    )
  })

  it('waits for provider compaction to drain before Plan preflight', async () => {
    const drained = deferred<void>()
    const harness = createHarness({ preemptCompaction: () => drained.promise })

    const turn = harness.workflow.run(request(), { kind: 'user' })
    await vi.waitFor(() => expect(harness.finalization.preemptCompaction).toHaveBeenCalledOnce())

    expect(harness.interactions.reservePrompt).toHaveBeenCalledOnce()
    expect(harness.preflightPlan).not.toHaveBeenCalled()

    drained.resolve(undefined)
    await expect(turn).resolves.toEqual({ stopReason: 'end_turn' })
    expect(harness.preflightPlan).toHaveBeenCalledOnce()
  })

  it('keeps an admitted turn running when the prompt-start callback throws', async () => {
    const harness = createHarness({
      onPromptStarted: () => {
        throw new Error('renderer unavailable')
      }
    })

    await expect(harness.workflow.run(request(), { kind: 'user' })).resolves.toEqual({
      stopReason: 'end_turn'
    })
    expect(harness.finalizer).toHaveBeenCalledOnce()
    expect(harness.journal.slice(7, 11)).toEqual(['handoff', 'start', 'state', 'artifact:open'])
  })

  it('finalizes a cancellation after Artifact activation without preparing or dispatching', async () => {
    const harness = createHarness({ cancellationCheckpoint: async () => 'cancelled' })

    await expect(harness.workflow.run(request(), { kind: 'user' })).resolves.toEqual({
      stopReason: 'cancelled'
    })

    expect(harness.artifacts.open).toHaveBeenCalledWith('s1', expect.any(String), {
      promptMessageId: 'message-1'
    })
    expect(harness.preparation).not.toHaveBeenCalled()
    expect(harness.executor).not.toHaveBeenCalled()
    const [handles, outcome] = harness.finalizer.mock.calls[0]
    expect(outcome).toEqual({ kind: 'not-dispatched' })
    expect(handles).not.toHaveProperty('prepared')
    expect(handles).not.toHaveProperty('context')
    await handles.disposeArtifact()
    expect(harness.artifacts.dispose).toHaveBeenCalledWith(expect.any(Object))
  })

  it('turns execution failure into one finalization outcome with pending Skill state', async () => {
    const failure = new Error('provider failed')
    const harness = createHarness({
      execute: async () => {
        throw failure
      }
    })

    await expect(harness.workflow.run(request(), { kind: 'user' })).rejects.toBe(failure)

    expect(harness.finalizer).toHaveBeenCalledOnce()
    const [handles, outcome] = harness.finalizer.mock.calls[0]
    expect(outcome).toEqual({ kind: 'failed', error: failure })
    handles.emitUserMessage()
    handles.failPendingSkillActivities()
    handles.failPendingSkillActivities()
    expect(harness.pushUserMessage).toHaveBeenCalledOnce()
    expect(harness.emitSkillActivities.mock.calls.map((call) => call[3])).toEqual([
      'in_progress',
      'failed'
    ])
    expect(harness.onProviderPromptAccepted).not.toHaveBeenCalled()
  })

  it('claims side-chat advisories for preparation and commits them after provider admission', async () => {
    const commit = vi.fn(async () => undefined)
    const restore = vi.fn()
    const claim = vi.fn(() => ({
      historyPreamble: 'Side chat advisory: use black.',
      commit,
      restore
    }))
    const harness = createHarness({ sideChatClaim: claim })
    const prompt = request()
    prompt.historyPreamble = 'Existing history.'

    await harness.workflow.run(prompt, { kind: 'user' })

    expect(claim).toHaveBeenCalledWith('s1')
    expect(harness.preparation).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          historyPreamble: 'Existing history.\n\nSide chat advisory: use black.'
        })
      })
    )
    expect(commit).toHaveBeenCalledWith('message-1')
    expect(restore).not.toHaveBeenCalled()
    expect(commit.mock.invocationCallOrder[0]).toBeLessThan(
      harness.onProviderPromptAccepted.mock.invocationCallOrder[0]
    )
  })

  it('restores claimed side-chat advisories when the provider never accepts the prompt', async () => {
    const commit = vi.fn()
    const restore = vi.fn()
    const harness = createHarness({
      sideChatClaim: () => ({ historyPreamble: 'Side note.', commit, restore }),
      execute: async () => {
        throw new Error('provider rejected startup')
      }
    })

    await expect(harness.workflow.run(request(), { kind: 'user' })).rejects.toThrow(
      'provider rejected startup'
    )

    expect(commit).not.toHaveBeenCalled()
    expect(restore).toHaveBeenCalledOnce()
  })

  it.each([
    ['an app continuation', { continuation: true }, { kind: 'app-continuation' as const }],
    ['a suppressed user message', { suppressUserMessage: true }, { kind: 'user' as const }]
  ])('does not consume side-chat advisories for %s', async (_name, requestPatch, mode) => {
    const claim = vi.fn()
    const harness = createHarness({ sideChatClaim: claim })

    await harness.workflow.run(Object.assign(request(), requestPatch), mode)

    expect(claim).not.toHaveBeenCalled()
  })

  it.each([
    ['user', { kind: 'user' as const }],
    [
      'application',
      {
        kind: 'application' as const,
        attribution: {
          kind: 'application' as const,
          feature: 'compute' as const,
          purpose: 'job-completion-analysis' as const,
          deliveryKey: 'compute-delivery-1',
          jobIds: ['job-1']
        }
      }
    ]
  ])('passes protected Plan guidance through an ordinary %s Attempt', async (_name, mode) => {
    const projection = planProjection()
    const harness = createHarness({ admitPlan: () => ({ active: projection }) })
    const prompt = request()
    prompt.turnIntent = 'plan-first'

    await harness.workflow.run(prompt, mode)

    expect(harness.preparation).toHaveBeenCalledWith(
      expect.objectContaining({
        protectedContext: expect.stringContaining(
          'approval=approved lifecycle=approved\ntask=Analyze the result\n- Analyze: not_started'
        ),
        turnPromptReminders: [expect.stringContaining('Plan mode (ACTIVE')]
      })
    )
    const handles = harness.finalizer.mock.calls[0][0]
    const interaction = handles.interaction
    handles.beforeInteractionRelease()
    await handles.afterInteractionRelease()
    expect(harness.planLifecycle.beforeRelease).toHaveBeenCalledWith('s1', interaction)
    expect(harness.planLifecycle.afterRelease).toHaveBeenCalledWith('s1')
    expect(harness.finalization.compactIfIdle).toHaveBeenCalledWith('s1')
  })

  it('reads the current Session Compute execution targets for every Turn preparation', async () => {
    const resolveComputeExecutionTargetIds = vi.fn(() => ['ssh:cedar-gpu'])
    const harness = createHarness({ resolveComputeExecutionTargetIds })

    await harness.workflow.run(request(), { kind: 'user' })

    expect(resolveComputeExecutionTargetIds).toHaveBeenCalledWith('s1')
    expect(harness.preparation).toHaveBeenCalledWith(
      expect.objectContaining({ selectedComputeHostIds: ['ssh:cedar-gpu'] })
    )
  })

  it('passes a rejected Plan delivery as protected guidance', async () => {
    const rejected = {
      ...planProjection(),
      approval: 'rejected' as const,
      lifecycle: 'rejected' as const
    }
    const harness = createHarness({ admitPlan: () => ({ protectedRejected: rejected }) })

    await harness.workflow.run(request(), { kind: 'app-continuation' })

    expect(harness.preparation).toHaveBeenCalledWith(
      expect.objectContaining({
        protectedContext: expect.stringContaining('approval=rejected')
      })
    )
  })
})
