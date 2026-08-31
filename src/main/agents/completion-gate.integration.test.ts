import { describe, expect, it, vi } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { join } from 'node:path'

import {
  CompletionGateCoordinator,
  CompletionGateRuntimeRegistry,
  createCompletionGateSwitchNotifier,
  runCompletionGatedTool
} from './completion-gate'
import type { ApprovalResult } from '../../shared/agents-contract'
import type { SpecialistView } from '../../shared/specialist'
import type { SpecialistService } from '../specialist/service'
import type { SessionBindingService } from '../specialist/session-binding'
import { AgentsService, type AgentsCatalogSource } from './agents-service'
import {
  CompletionHandoffLifecycle,
  InMemoryCompletionHandoffRepository
} from './completion-handoff-lifecycle'
import { NotebookLocalRpcServer } from '../notebook/local-rpc-server'
import type { NotebookRuntimeService } from '../notebook/runtime-service'
import { OpenCodeImmediateHandoffRuntime } from '../acp/opencode-immediate-handoff'
import { createCodexCompletionGateRuntime } from '../acp/codex-completion-handoff'
import { createOpenCodeImmediateHandoffRuntime } from '../acp/opencode-immediate-handoff'
import { createClaudeCodeCompletionGateRuntime } from './claude-code-handoff'
import {
  framePythonRequest,
  parseLoopResponse,
  type KernelLoopResponse
} from '../notebook/kernel-protocol'
import {
  createCompletionGateAgentHarness,
  deferred,
  approvedSpecialist,
  type CompletionGateAgentHarness
} from './completion-gate.test-harness'

const specialist: SpecialistView = approvedSpecialist()
const catalog: AgentsCatalogSource = {
  listSkillCatalog: async () => [],
  getConnectors: async () => ({ enabledIds: [], autoAllowIds: [] })
}

const completionContext = {
  sessionId: 'trusted-session',
  callerRole: 'main' as const,
  turnId: 'tool-1',
  controlInvocationGeneration: 1,
  toolInvocationId: 'tool-1'
}

const LOOP = join(__dirname, '../../../resources/notebook/repl_loop.js')

const startLoop = (
  env: NodeJS.ProcessEnv
): {
  child: ChildProcessWithoutNullStreams
  send: (code: string, controlInvocationId?: string) => Promise<KernelLoopResponse>
} => {
  const child = spawn(process.execPath, [LOOP], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...env }
  })
  const readline = createInterface({ input: child.stdout })
  const waiting = new Map<string, (response: KernelLoopResponse) => void>()
  readline.on('line', (line) => {
    const response = parseLoopResponse(line)
    if (!response) return
    const resolve = waiting.get(response.reqId)
    if (!resolve) return
    waiting.delete(response.reqId)
    resolve(response)
  })
  return {
    child,
    send: (code, controlInvocationId) =>
      new Promise((resolve) => {
        const reqId = randomUUID()
        waiting.set(reqId, resolve)
        child.stdin.write(framePythonRequest(reqId, code, controlInvocationId))
      })
  }
}

const createHarness = (approval: ApprovalResult): CompletionGateAgentHarness =>
  createCompletionGateAgentHarness({ approval })

describe('completion gate tracer bullet', () => {
  it('persists the captured envelope through the production coordinator lifecycle seam', async () => {
    const repository = new InMemoryCompletionHandoffRepository()
    const runtime = {
      stopOldPrompt: vi.fn(async () => undefined),
      waitForOwnershipRelease: vi.fn(async () => undefined),
      reconfigure: vi.fn(async () => undefined),
      continueAsApproved: vi.fn(async () => undefined),
      reportHandoffFailure: vi.fn(async () => undefined)
    }
    const lifecycle = new CompletionHandoffLifecycle(repository, runtime)
    const coordinator = new CompletionGateCoordinator(runtime, lifecycle)
    await coordinator.arm(completionContext, 'Approved Specialist')

    await runCompletionGatedTool({
      coordinator,
      context: completionContext,
      deliverToCurrentPrompt: vi.fn(async () => undefined),
      execute: async () => ({ result: 'app owned' })
    })

    expect(await repository.get(completionContext)).toMatchObject({
      stage: 'continued',
      envelope: { kind: 'returned', value: { result: 'app owned' } }
    })
  })

  it('persists the original prompt provenance exactly once from the approved switch to continuation', async () => {
    const repository = new InMemoryCompletionHandoffRepository()
    const runtime = {
      stopOldPrompt: vi.fn(async () => undefined),
      waitForOwnershipRelease: vi.fn(async () => undefined),
      reconfigure: vi.fn(async () => undefined),
      continueAsApproved: vi.fn(async () => undefined),
      reportHandoffFailure: vi.fn(async () => undefined)
    }
    const lifecycle = new CompletionHandoffLifecycle(repository, runtime)
    const coordinator = new CompletionGateCoordinator(runtime, lifecycle)
    const original = {
      ...completionContext,
      originatingTurnId: 'prompt-message-17',
      originatingUserMessageId: 'prompt-message-17',
      attachmentIds: ['upload-1'],
      artifactIds: ['artifact-1']
    }

    await createCompletionGateSwitchNotifier(coordinator).notify({
      sessionId: original.sessionId,
      targetName: 'Approved Specialist',
      turnId: original.turnId,
      controlInvocationGeneration: original.controlInvocationGeneration,
      toolInvocationId: original.toolInvocationId,
      originatingTurnId: original.originatingTurnId,
      originatingUserMessageId: original.originatingUserMessageId,
      attachmentIds: original.attachmentIds,
      artifactIds: original.artifactIds
    })
    await runCompletionGatedTool({
      coordinator,
      context: original,
      deliverToCurrentPrompt: vi.fn(async () => undefined),
      execute: async () => ({ result: 'app owned' })
    })

    expect(await repository.get(original)).toMatchObject({
      provenance: {
        originatingTurnId: 'prompt-message-17',
        originatingUserMessageId: 'prompt-message-17',
        attachmentIds: ['upload-1'],
        artifactIds: ['artifact-1']
      }
    })
    expect(runtime.continueAsApproved).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ originatingUserMessageId: 'prompt-message-17' }),
      expect.objectContaining({
        originatingTurnId: 'prompt-message-17',
        originatingUserMessageId: 'prompt-message-17',
        attachmentIds: ['upload-1'],
        artifactIds: ['artifact-1']
      })
    )
  })

  it('does not capture a completion when durable approval admission fails', async () => {
    const repository = new InMemoryCompletionHandoffRepository()
    const update = repository.update.bind(repository)
    vi.spyOn(repository, 'update')
      .mockRejectedValueOnce(new Error('transient disk failure'))
      .mockImplementation(update)
    const runtime = {
      stopOldPrompt: vi.fn(async () => undefined),
      waitForOwnershipRelease: vi.fn(async () => undefined),
      reconfigure: vi.fn(async () => undefined),
      continueAsApproved: vi.fn(async () => undefined),
      reportHandoffFailure: vi.fn(async () => undefined)
    }
    const lifecycle = new CompletionHandoffLifecycle(repository, runtime)
    const coordinator = new CompletionGateCoordinator(runtime, lifecycle)

    await expect(coordinator.arm(completionContext, 'Approved Specialist')).rejects.toThrow(
      'transient disk failure'
    )
    const deliverToCurrentPrompt = vi.fn(async () => undefined)
    await runCompletionGatedTool({
      coordinator,
      context: completionContext,
      deliverToCurrentPrompt,
      execute: async () => ({ result: 'captured after retry' })
    })

    expect(deliverToCurrentPrompt).toHaveBeenCalledOnce()
    expect(await repository.get(completionContext)).toBeUndefined()
  })

  it('routes interleaved trusted sessions independently and emits ordered sanitized lifecycle diagnostics', async () => {
    const lifecycle: unknown[] = []
    const calls: string[] = []
    const coordinator = new CompletionGateCoordinator({
      stopOldPrompt: async (context) => {
        calls.push(`stop:${context.sessionId}`)
      },
      waitForOwnershipRelease: async (context) => {
        calls.push(`release:${context.sessionId}`)
      },
      reconfigure: async ({ targetName }, context) => {
        calls.push(`reconfigure:${context.sessionId}:${targetName}`)
      },
      continueAsApproved: async ({ targetName }, context) => {
        calls.push(`continue:${context.sessionId}:${targetName}`)
      },
      reportHandoffFailure: async () => undefined
    })
    coordinator.subscribeLifecycle((event) => lifecycle.push(event))

    const first = { ...completionContext, sessionId: 'trusted-session-a' }
    const second = {
      ...completionContext,
      sessionId: 'trusted-session-b',
      turnId: 'tool-2',
      controlInvocationGeneration: 2,
      toolInvocationId: 'tool-2'
    }
    coordinator.arm(first, 'Approved Specialist A')
    coordinator.arm(second, 'Approved Specialist B')

    await Promise.all([
      runCompletionGatedTool({
        coordinator,
        context: second,
        deliverToCurrentPrompt: async () => undefined,
        execute: async () => ({
          transcript: 'RAW_TRANSCRIPT_MUST_NOT_APPEAR',
          credential: 'CREDENTIAL_MUST_NOT_APPEAR'
        })
      }),
      runCompletionGatedTool({
        coordinator,
        context: first,
        deliverToCurrentPrompt: async () => undefined,
        execute: async () => ({ token: 'RAW_TOKEN_MUST_NOT_APPEAR' })
      })
    ])

    expect(calls).toContain('reconfigure:trusted-session-a:Approved Specialist A')
    expect(calls).toContain('reconfigure:trusted-session-b:Approved Specialist B')
    expect(lifecycle).toHaveLength(10)
    expect(lifecycle).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'approval-committed', sessionId: 'trusted-session-a' }),
        expect.objectContaining({ kind: 'completion-captured', sessionId: 'trusted-session-b' }),
        expect.objectContaining({ kind: 'ownership-released', sessionId: 'trusted-session-a' }),
        expect.objectContaining({ kind: 'reconfigured', sessionId: 'trusted-session-b' }),
        expect.objectContaining({ kind: 'continuation-started', sessionId: 'trusted-session-a' })
      ])
    )
    expect(lifecycle.map((event) => (event as { order: number }).order)).toEqual(
      Array.from({ length: lifecycle.length }, (_, index) => index + 1)
    )
    const serialized = JSON.stringify(lifecycle)
    expect(serialized).not.toContain('RAW_TRANSCRIPT_MUST_NOT_APPEAR')
    expect(serialized).not.toContain('CREDENTIAL_MUST_NOT_APPEAR')
    expect(serialized).not.toContain('RAW_TOKEN_MUST_NOT_APPEAR')
  })

  it('classifies lifecycle failures without publishing raw error or completion data', async () => {
    const lifecycle: unknown[] = []
    const coordinator = new CompletionGateCoordinator({
      stopOldPrompt: async () => undefined,
      waitForOwnershipRelease: async () => undefined,
      reconfigure: async () => {
        throw new Error('RAW_CONNECTOR_ARGUMENT_MUST_NOT_APPEAR')
      },
      continueAsApproved: async () => undefined,
      reportHandoffFailure: async () => undefined
    })
    coordinator.subscribeLifecycle((event) => lifecycle.push(event))
    coordinator.arm(completionContext, 'Approved Specialist')

    await runCompletionGatedTool({
      coordinator,
      context: completionContext,
      deliverToCurrentPrompt: async () => undefined,
      execute: async () => ({
        systemInstructions: 'RAW_SYSTEM_INSTRUCTIONS_MUST_NOT_APPEAR',
        history: 'RAW_HISTORY_PAYLOAD_MUST_NOT_APPEAR'
      })
    })

    expect(lifecycle.at(-1)).toEqual(
      expect.objectContaining({ kind: 'handoff-failed', failureStage: 'reconfigure' })
    )
    const serialized = JSON.stringify(lifecycle)
    expect(serialized).not.toContain('RAW_CONNECTOR_ARGUMENT_MUST_NOT_APPEAR')
    expect(serialized).not.toContain('RAW_SYSTEM_INSTRUCTIONS_MUST_NOT_APPEAR')
    expect(serialized).not.toContain('RAW_HISTORY_PAYLOAD_MUST_NOT_APPEAR')
  })

  it('drops a stale captured completion after a newer trusted session intent commits', async () => {
    const ownershipReleased = deferred()
    const calls: string[] = []
    const lifecycle: unknown[] = []
    const coordinator = new CompletionGateCoordinator({
      stopOldPrompt: async (context) => {
        calls.push(`stop:${context.controlInvocationGeneration}`)
      },
      waitForOwnershipRelease: async (context) => {
        calls.push(`wait:${context.controlInvocationGeneration}`)
        if (context.controlInvocationGeneration === 1) await ownershipReleased.promise
      },
      reconfigure: async ({ targetName }, context) => {
        calls.push(`reconfigure:${context.controlInvocationGeneration}:${targetName}`)
      },
      continueAsApproved: async ({ targetName }, context) => {
        calls.push(`continue:${context.controlInvocationGeneration}:${targetName}`)
      },
      reportHandoffFailure: async () => undefined
    })
    coordinator.subscribeLifecycle((event) => lifecycle.push(event))

    const stale = {
      sessionId: 'trusted-session',
      turnId: 'trusted-turn',
      controlInvocationGeneration: 1,
      toolInvocationId: 'trusted-tool'
    }
    const current = {
      sessionId: 'trusted-session',
      turnId: 'trusted-turn',
      controlInvocationGeneration: 2,
      toolInvocationId: 'trusted-tool'
    }
    coordinator.arm(stale, 'Old Specialist')
    const staleCompletion = runCompletionGatedTool({
      coordinator,
      context: stale,
      deliverToCurrentPrompt: async () => {
        calls.push('deliver:old')
      },
      execute: async () => 'old result'
    })
    await Promise.resolve()
    await Promise.resolve()
    coordinator.arm(current, 'Current Specialist')
    ownershipReleased.resolve()
    await staleCompletion

    await runCompletionGatedTool({
      coordinator,
      context: current,
      deliverToCurrentPrompt: async () => {
        calls.push('deliver:current')
      },
      execute: async () => 'current result'
    })

    expect(calls).toEqual([
      'stop:1',
      'wait:1',
      'stop:2',
      'wait:2',
      'reconfigure:2:Current Specialist',
      'continue:2:Current Specialist'
    ])
    expect(lifecycle).toContainEqual(
      expect.objectContaining({
        kind: 'handoff-superseded',
        sessionId: 'trusted-session',
        turnId: 'trusted-turn',
        controlInvocationGeneration: 1,
        targetName: 'Old Specialist'
      })
    )
  })

  it('ignores forged sandbox routing and sequencing payload fields', async () => {
    const harness = createHarness({ status: 'approved' })
    const trusted = {
      sessionId: 'trusted-session',
      callerRole: 'main' as const,
      turnId: 'trusted-turn',
      controlInvocationGeneration: 1,
      toolInvocationId: 'trusted-tool'
    }
    await harness.agents.dispatch(
      {
        op: 'switch',
        params: {
          name: 'Approved Specialist',
          session_id: 'forged-session',
          sessionId: 'forged-session',
          specialist_id: 'forged-specialist',
          target_specialist_id: 'forged-target',
          reconfigure: 'forged-reconfigure',
          generation: 999
        }
      },
      trusted
    )

    const forgedSession = await runCompletionGatedTool({
      coordinator: harness.coordinator,
      context: { ...trusted, sessionId: 'forged-session' },
      deliverToCurrentPrompt: harness.deliverToOldPrompt,
      execute: async () => 'forged completion'
    })
    const trustedSession = await runCompletionGatedTool({
      coordinator: harness.coordinator,
      context: trusted,
      deliverToCurrentPrompt: harness.deliverToOldPrompt,
      execute: async () => 'trusted completion'
    })

    expect(forgedSession).toMatchObject({ kind: 'deliver-to-current-prompt' })
    expect(trustedSession).toMatchObject({
      kind: 'capture-for-handoff',
      targetName: 'Approved Specialist'
    })
    expect(harness.persistBinding).toHaveBeenCalledWith('trusted-session', 'specialist-approved')
  })

  it('releases abandoned handoff generations when the trusted session closes', async () => {
    const harness = createHarness({ status: 'approved' })
    harness.coordinator.arm(completionContext, 'Approved Specialist')

    harness.coordinator.releaseSession(completionContext.sessionId)
    const disposition = await runCompletionGatedTool({
      coordinator: harness.coordinator,
      context: completionContext,
      deliverToCurrentPrompt: harness.deliverToOldPrompt,
      execute: async () => 'late completion'
    })

    expect(disposition).toMatchObject({ kind: 'deliver-to-current-prompt' })
    expect(harness.deliverToOldPrompt).toHaveBeenCalledOnce()
    expect(harness.calls).toEqual(['provider-request:old'])
  })

  it('captures an approved real host.agents.switch tool completion before an old prompt can request again', async () => {
    const harness = createHarness({ status: 'approved' })
    const host = {
      agents: {
        switch: (name: string | null) =>
          harness.agents.dispatch({ op: 'switch', params: { name } }, completionContext)
      }
    }

    await runCompletionGatedTool({
      coordinator: harness.coordinator,
      context: completionContext,
      deliverToCurrentPrompt: harness.deliverToOldPrompt,
      execute: async () => {
        const switched = await host.agents.switch('Approved Specialist')
        // This must run before the outer completion is captured.
        return { switched, afterAwait: 'completed' }
      }
    })

    expect(harness.persistBinding).toHaveBeenCalledWith('trusted-session', 'specialist-approved')
    expect(harness.deliverToOldPrompt).not.toHaveBeenCalled()
    expect(harness.continuations).toMatchObject([
      {
        targetName: 'Approved Specialist',
        envelope: { kind: 'returned', value: expect.objectContaining({ afterAwait: 'completed' }) }
      }
    ])
    expect(harness.calls).toEqual([
      'stop-old-prompt',
      'ownership-released',
      'reconfigure:Approved Specialist',
      'provider-request:Approved Specialist'
    ])
  })

  it('does not let an approved switch capture another control invocation in the same session', async () => {
    const harness = createHarness({ status: 'approved' })
    await harness.agents.dispatch(
      { op: 'switch', params: { name: 'Approved Specialist' } },
      completionContext
    )

    const otherContext = {
      sessionId: completionContext.sessionId,
      turnId: 'tool-2',
      controlInvocationGeneration: 2,
      toolInvocationId: 'tool-2'
    }
    const other = await runCompletionGatedTool({
      coordinator: harness.coordinator,
      context: otherContext,
      deliverToCurrentPrompt: harness.deliverToOldPrompt,
      execute: async () => 'other result'
    })

    expect(other).toMatchObject({ kind: 'deliver-to-current-prompt' })
    expect(harness.deliverToOldPrompt).toHaveBeenCalledTimes(1)

    const approved = await runCompletionGatedTool({
      coordinator: harness.coordinator,
      context: completionContext,
      deliverToCurrentPrompt: harness.deliverToOldPrompt,
      execute: async () => 'approved result'
    })

    expect(approved).toMatchObject({ kind: 'capture-for-handoff' })
    expect(harness.deliverToOldPrompt).toHaveBeenCalledTimes(1)
  })

  it('fails safe to normal delivery until production registers a complete handoff runtime', async () => {
    const registry = new CompletionGateRuntimeRegistry()
    const coordinator = new CompletionGateCoordinator(registry)
    const deliver = vi.fn(async () => undefined)
    createCompletionGateSwitchNotifier(coordinator).notify({
      sessionId: completionContext.sessionId,
      targetName: 'Approved Specialist',
      turnId: completionContext.turnId,
      controlInvocationGeneration: completionContext.controlInvocationGeneration,
      toolInvocationId: completionContext.toolInvocationId
    })

    const disposition = await runCompletionGatedTool({
      coordinator,
      context: completionContext,
      deliverToCurrentPrompt: deliver,
      execute: async () => 'legacy completion'
    })

    expect(disposition).toMatchObject({ kind: 'deliver-to-current-prompt' })
    expect(deliver).toHaveBeenCalledOnce()
  })

  it('selects the concrete Codex, OpenCode, and Claude adapters over the generic startup fallback', async () => {
    const calls: string[] = []
    const frameworkFor = (sessionId: string): 'codex' | 'opencode' | 'claude-code' | undefined => {
      const framework = sessionId.split(':')[0]
      return framework === 'codex' || framework === 'opencode' || framework === 'claude-code'
        ? framework
        : undefined
    }
    const sharedRuntime = {
      isSessionUsingFramework: (sessionId: string, framework: string) =>
        frameworkFor(sessionId) === framework,
      getSessionFramework: frameworkFor,
      capturePromptForHandoff: (sessionId: string) => ({
        prompt: { sessionId, text: 'original prompt' },
        originatingTurnToken: `turn:${sessionId}`
      }),
      cancelPrompt: async ({ sessionId }: { sessionId: string }) => {
        calls.push(`stop:${sessionId}`)
      },
      waitForPromptRelease: async (sessionId: string) => {
        calls.push(`release:${sessionId}`)
      },
      waitForPromptOwnershipRelease: async (sessionId: string) => {
        calls.push(`release:${sessionId}`)
      },
      switchSpecialist: async (sessionId: string) => {
        calls.push(`reconfigure:${sessionId}`)
        return { contextReset: true }
      },
      continueApprovedHandoff: async (sessionId: string) => {
        calls.push(`continue:${sessionId}`)
      },
      startContinuation: async ({ sessionId }: { sessionId: string }) => {
        calls.push(`continue:${sessionId}`)
      }
    }
    const generic = {
      stopOldPrompt: async () => {
        calls.push('generic-stop')
      },
      waitForOwnershipRelease: async () => {
        calls.push('generic-release')
      },
      reconfigure: async () => {
        calls.push('generic-reconfigure')
      },
      continueAsApproved: async () => {
        calls.push('generic-continue')
      },
      reportHandoffFailure: async () => undefined
    }
    const registry = new CompletionGateRuntimeRegistry()
    registry.register(generic)
    registry.register(
      createCodexCompletionGateRuntime({
        runtime: sharedRuntime as never,
        resolveApprovedSpecialistId: () => 'specialist-approved'
      })
    )
    registry.register(
      createOpenCodeImmediateHandoffRuntime({
        runtime: sharedRuntime as never,
        resolveSpecialistId: () => 'specialist-approved',
        reportHandoffFailure: async () => undefined
      })
    )
    registry.register(
      createClaudeCodeCompletionGateRuntime({
        sessionFramework: frameworkFor,
        cancelPrompt: sharedRuntime.cancelPrompt,
        waitForPromptOwnershipRelease: sharedRuntime.waitForPromptOwnershipRelease,
        resolveSpecialistId: () => 'specialist-approved',
        resolveSwitchReadBack: async (sessionId, targetName) => ({
          status: 'approved',
          operation: 'switch',
          binding: { sessionId, specialistId: 'specialist-approved', targetName }
        }),
        prepareReplayContext: async () => undefined,
        discardReplayContext: async () => undefined,
        switchSpecialist: sharedRuntime.switchSpecialist,
        createContinuationRequest: async ({ sessionId }) => ({ sessionId, text: 'continue' }),
        sendAppContinuation: async ({ sessionId }) => {
          calls.push(`continue:${sessionId}`)
        }
      })
    )
    const coordinator = new CompletionGateCoordinator(registry)

    for (const framework of ['codex', 'opencode', 'claude-code']) {
      const context = {
        ...completionContext,
        sessionId: `${framework}:session`,
        turnId: `${framework}:turn`,
        toolInvocationId: `${framework}:turn`
      }
      await coordinator.arm(context, 'Approved Specialist')
      await runCompletionGatedTool({
        coordinator,
        context,
        deliverToCurrentPrompt: vi.fn(async () => undefined),
        execute: async () => 'outer completion'
      })
    }

    expect(calls).toEqual([
      'stop:codex:session',
      'release:codex:session',
      'reconfigure:codex:session',
      'continue:codex:session',
      'stop:opencode:session',
      'release:opencode:session',
      'reconfigure:opencode:session',
      'continue:opencode:session',
      'stop:claude-code:session',
      'release:claude-code:session',
      'reconfigure:claude-code:session',
      'continue:claude-code:session'
    ])
    expect(calls).not.toContain('generic-stop')
  })

  it('keeps a claimed completion captured when reconfiguration fails', async () => {
    const reportHandoffFailure = vi.fn(async () => undefined)
    const coordinator = new CompletionGateCoordinator({
      stopOldPrompt: async () => undefined,
      waitForOwnershipRelease: async () => undefined,
      reconfigure: async () => {
        throw new Error('reconfigure failed')
      },
      continueAsApproved: async () => undefined,
      reportHandoffFailure
    })
    const deliver = vi.fn(async () => undefined)
    coordinator.arm(completionContext, 'Approved Specialist')

    const disposition = await runCompletionGatedTool({
      coordinator,
      context: completionContext,
      deliverToCurrentPrompt: deliver,
      execute: async () => 'outer result'
    })

    expect(disposition).toMatchObject({ kind: 'capture-for-handoff' })
    expect(deliver).not.toHaveBeenCalled()
    expect(reportHandoffFailure).toHaveBeenCalledOnce()
  })

  it('delivers a declined switch completion exactly once to the unchanged old prompt', async () => {
    const harness = createHarness({ status: 'declined', operation: 'switch' })
    const host = {
      agents: {
        switch: (name: string | null) =>
          harness.agents.dispatch(
            { op: 'switch', params: { name } },
            { sessionId: 'trusted-session', callerRole: 'main' }
          )
      }
    }

    await runCompletionGatedTool({
      coordinator: harness.coordinator,
      context: completionContext,
      deliverToCurrentPrompt: harness.deliverToOldPrompt,
      execute: async () => ({ switched: await host.agents.switch('Approved Specialist') })
    })

    expect(harness.persistBinding).not.toHaveBeenCalled()
    expect(harness.deliverToOldPrompt).toHaveBeenCalledTimes(1)
    expect(harness.calls).toEqual(['provider-request:old'])
  })

  it('does not reconfigure from a stop request until the runtime explicitly releases ownership', async () => {
    const released = deferred()
    const calls: string[] = []
    const coordinator = new CompletionGateCoordinator({
      stopOldPrompt: async () => {
        calls.push('stop-old-prompt')
      },
      waitForOwnershipRelease: async () => released.promise,
      reconfigure: async () => {
        calls.push('reconfigure')
      },
      continueAsApproved: async () => {
        calls.push('continuation')
      },
      reportHandoffFailure: async () => undefined
    })
    coordinator.arm(completionContext, 'Approved Specialist')

    const handingOff = runCompletionGatedTool({
      coordinator,
      context: completionContext,
      deliverToCurrentPrompt: async () => {
        calls.push('old-prompt')
      },
      execute: async () => 'outer result'
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(calls).toEqual(['stop-old-prompt'])
    released.resolve()
    await handingOff
    expect(calls).toEqual(['stop-old-prompt', 'reconfigure', 'continuation'])
  })

  it('captures an approved outer-tool error once for the new continuation without reviving the old prompt', async () => {
    const harness = createHarness({ status: 'approved' })
    const outerError = new Error('tool failed after the approved switch')
    const execute = vi.fn(async () => {
      await harness.agents.dispatch(
        { op: 'switch', params: { name: 'Approved Specialist' } },
        completionContext
      )
      throw outerError
    })

    const disposition = await runCompletionGatedTool({
      coordinator: harness.coordinator,
      context: completionContext,
      deliverToCurrentPrompt: harness.deliverToOldPrompt,
      execute
    })

    expect(execute).toHaveBeenCalledOnce()
    expect(disposition).toMatchObject({
      kind: 'capture-for-handoff',
      targetName: 'Approved Specialist',
      envelope: { kind: 'threw', error: outerError }
    })
    expect(harness.persistBinding).toHaveBeenCalledWith('trusted-session', 'specialist-approved')
    expect(harness.deliverToOldPrompt).not.toHaveBeenCalled()
    expect(harness.continuations).toMatchObject([
      {
        targetName: 'Approved Specialist',
        envelope: { kind: 'threw', error: outerError }
      }
    ])
    expect(harness.calls).toEqual([
      'stop-old-prompt',
      'ownership-released',
      'reconfigure:Approved Specialist',
      'provider-request:Approved Specialist'
    ])
  })

  it('waits for a long-running approved outer tool before it hands the completed envelope off', async () => {
    const harness = createHarness({ status: 'approved' })
    const afterSwitch = deferred()
    const finishOuterTool = deferred<string>()
    const execute = vi.fn(async () => {
      await harness.agents.dispatch(
        { op: 'switch', params: { name: 'Approved Specialist' } },
        completionContext
      )
      afterSwitch.resolve()
      return finishOuterTool.promise
    })

    const completion = runCompletionGatedTool({
      coordinator: harness.coordinator,
      context: completionContext,
      deliverToCurrentPrompt: harness.deliverToOldPrompt,
      execute
    })
    await afterSwitch.promise

    expect(execute).toHaveBeenCalledOnce()
    expect(harness.calls).toEqual([])
    expect(harness.deliverToOldPrompt).not.toHaveBeenCalled()

    finishOuterTool.resolve('finished after long work')
    await completion

    expect(harness.continuations).toMatchObject([
      {
        targetName: 'Approved Specialist',
        envelope: { kind: 'returned', value: 'finished after long work' }
      }
    ])
    expect(harness.calls).toEqual([
      'stop-old-prompt',
      'ownership-released',
      'reconfigure:Approved Specialist',
      'provider-request:Approved Specialist'
    ])
  })

  it('uses Main Agent as the approved continuation target without fabricating a Main profile', async () => {
    const harness = createHarness({ status: 'approved' })
    const execute = vi.fn(async () =>
      harness.agents.dispatch({ op: 'switch', params: { name: null } }, completionContext)
    )

    const disposition = await runCompletionGatedTool({
      coordinator: harness.coordinator,
      context: completionContext,
      deliverToCurrentPrompt: harness.deliverToOldPrompt,
      execute
    })

    expect(execute).toHaveBeenCalledOnce()
    expect(disposition).toMatchObject({ kind: 'capture-for-handoff', targetName: null })
    expect(harness.persistBinding).toHaveBeenCalledWith('trusted-session', undefined)
    expect(harness.deliverToOldPrompt).not.toHaveBeenCalled()
    expect(harness.continuations).toHaveLength(1)
    expect(harness.continuations[0]).toMatchObject({
      targetName: null,
      envelope: {
        kind: 'returned',
        value: {
          status: 'approved',
          operation: 'switch',
          binding: { sessionId: 'trusted-session', targetName: null }
        }
      }
    })
    expect(harness.calls).toEqual([
      'stop-old-prompt',
      'ownership-released',
      'reconfigure:null',
      'provider-request:null'
    ])
  })

  it('hands one outer completion to only the newest approved target in a single tool execution', async () => {
    const harness = createHarness({ status: 'approved' })
    const execute = vi.fn(async () => {
      await harness.agents.dispatch({ op: 'switch', params: { name: null } }, completionContext)
      return harness.agents.dispatch(
        { op: 'switch', params: { name: 'Approved Specialist' } },
        completionContext
      )
    })

    const disposition = await runCompletionGatedTool({
      coordinator: harness.coordinator,
      context: completionContext,
      deliverToCurrentPrompt: harness.deliverToOldPrompt,
      execute
    })

    expect(execute).toHaveBeenCalledOnce()
    expect(disposition).toMatchObject({
      kind: 'capture-for-handoff',
      targetName: 'Approved Specialist'
    })
    expect(harness.persistBinding).toHaveBeenNthCalledWith(1, 'trusted-session', undefined)
    expect(harness.persistBinding).toHaveBeenNthCalledWith(
      2,
      'trusted-session',
      'specialist-approved'
    )
    expect(harness.deliverToOldPrompt).not.toHaveBeenCalled()
    expect(harness.continuations).toHaveLength(1)
    expect(harness.continuations[0]).toMatchObject({ targetName: 'Approved Specialist' })
    expect(harness.calls).toEqual([
      'stop-old-prompt',
      'ownership-released',
      'reconfigure:Approved Specialist',
      'provider-request:Approved Specialist'
    ])
  })

  it('uses the real repl host.agents.switch SDK route before the completion gate intercepts its outer result', async () => {
    const harness = createHarness({ status: 'approved' })
    const server = new NotebookLocalRpcServer({} as NotebookRuntimeService, {
      transport: 'tcp',
      token: 'completion-gate-token',
      agentsService: harness.agents
    })
    const connection = await server.issueControlConnection(
      'trusted-session',
      'default-project',
      'root-frame-trusted-session'
    )
    const releaseInvocation = connection.beginControlInvocation(completionContext)
    const loop = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: connection.endpoint,
      OPEN_SCIENCE_MCP_RPC_TOKEN: connection.token,
      OPEN_SCIENCE_NOTEBOOK_SESSION_ID: 'trusted-session'
    })

    try {
      const disposition = await runCompletionGatedTool({
        coordinator: harness.coordinator,
        context: completionContext,
        deliverToCurrentPrompt: harness.deliverToOldPrompt,
        execute: async () => {
          const response = await loop.send(
            "const switched = await host.agents.switch('Approved Specialist'); return JSON.stringify({ switched, afterAwait: 'completed' })",
            completionContext.toolInvocationId
          )
          expect(response.error).toBeNull()
          return JSON.parse(response.result ?? '{}') as { afterAwait?: string }
        }
      })

      expect(disposition).toMatchObject({
        kind: 'capture-for-handoff',
        envelope: { kind: 'returned', value: { afterAwait: 'completed' } }
      })
      expect(harness.deliverToOldPrompt).not.toHaveBeenCalled()
      expect(harness.calls).toEqual([
        'stop-old-prompt',
        'ownership-released',
        'reconfigure:Approved Specialist',
        'provider-request:Approved Specialist'
      ])
    } finally {
      loop.child.kill()
      releaseInvocation()
      connection.release()
      await server.close()
    }
  })

  it('hands the real SDK completion to the OpenCode continuation before any synchronous old request', async () => {
    const calls: string[] = []
    const providerRequests: Array<{
      identity: string
      skills: string[]
      connectors: string[]
      notebookSpecialistId: string | undefined
      turnToken: string
      completion: unknown
    }> = []
    let projection = {
      identity: 'Old Specialist',
      skills: ['Old Skill'],
      connectors: ['old-connector'],
      notebookSpecialistId: 'specialist-old' as string | undefined
    }
    const runtime = new OpenCodeImmediateHandoffRuntime({
      isOpenCodeSession: () => true,
      captureCurrentPrompt: () => ({
        prompt: { sessionId: 'trusted-session', text: 'analyse the original dataset' },
        originatingTurnToken: 'original-user-turn'
      }),
      stopOldPrompt: async () => {
        calls.push('stop-old-prompt')
      },
      waitForOwnershipRelease: async () => {
        calls.push('ownership-released')
      },
      resolveSpecialistId: async () => 'specialist-approved',
      applySpecialistProjection: async () => {
        calls.push('reconfigure')
        projection = {
          identity: 'Approved Specialist',
          skills: ['Approved Skill'],
          connectors: ['approved-connector'],
          notebookSpecialistId: 'specialist-approved'
        }
      },
      continueOriginalTurn: async ({ originatingTurnToken, completion }) => {
        calls.push('provider-request:new')
        providerRequests.push({ ...projection, turnToken: originatingTurnToken, completion })
      },
      reportHandoffFailure: async () => undefined
    })
    const coordinator = new CompletionGateCoordinator(runtime)
    const agents = new AgentsService({
      specialistService: {
        getByName: vi.fn(async () => specialist),
        resolveRunnableByName: vi.fn(async () => specialist),
        resolveRunnableById: vi.fn(async () => specialist),
        list: vi.fn(async () => [specialist])
      } as unknown as SpecialistService,
      catalog,
      approvalGateway: { decide: vi.fn(async () => ({ status: 'approved' as const })) },
      sessionBinding: {
        getBinding: vi.fn(),
        setBinding: vi.fn()
      } as unknown as SessionBindingService,
      persistSessionSpecialist: vi.fn(async () => undefined),
      switchNotifier: createCompletionGateSwitchNotifier(coordinator)
    })
    const server = new NotebookLocalRpcServer({} as NotebookRuntimeService, {
      transport: 'tcp',
      token: 'opencode-handoff-token',
      agentsService: agents
    })
    const connection = await server.issueControlConnection(
      'trusted-session',
      'default-project',
      'root-frame-trusted-session'
    )
    const releaseInvocation = connection.beginControlInvocation(completionContext)
    const loop = startLoop({
      OPEN_SCIENCE_MCP_RPC_ENDPOINT: connection.endpoint,
      OPEN_SCIENCE_MCP_RPC_TOKEN: connection.token,
      OPEN_SCIENCE_NOTEBOOK_SESSION_ID: 'trusted-session'
    })

    try {
      await runCompletionGatedTool({
        coordinator,
        context: completionContext,
        deliverToCurrentPrompt: async () => {
          calls.push('provider-request:old')
          providerRequests.push({
            ...projection,
            turnToken: 'original-user-turn',
            completion: 'delivered to old prompt'
          })
        },
        execute: async () => {
          const response = await loop.send(
            "const switched = await host.agents.switch('Approved Specialist'); return JSON.stringify({ switched, afterAwait: 'completed' })",
            completionContext.toolInvocationId
          )
          expect(response.error).toBeNull()
          return JSON.parse(response.result ?? '{}')
        }
      })

      expect(calls).toEqual([
        'stop-old-prompt',
        'ownership-released',
        'reconfigure',
        'provider-request:new'
      ])
      expect(providerRequests).toEqual([
        {
          identity: 'Approved Specialist',
          skills: ['Approved Skill'],
          connectors: ['approved-connector'],
          notebookSpecialistId: 'specialist-approved',
          turnToken: 'original-user-turn',
          completion: {
            kind: 'returned',
            value: expect.objectContaining({ afterAwait: 'completed' })
          }
        }
      ])
    } finally {
      loop.child.kill()
      releaseInvocation()
      connection.release()
      await server.close()
    }
  })
})
