import { describe, expect, it, vi } from 'vitest'

import {
  CompletionGateCoordinator,
  CompletionGateRuntimeRegistry,
  runCompletionGatedTool,
  type ToolCompletionEnvelope,
  type TrustedToolCompletionContext
} from './completion-gate'
import {
  createClaudeCodeCompletionGateRuntime,
  registerClaudeCodeCompletionGateRuntime,
  selectPersistedUserTaskContext
} from './claude-code-handoff'

const context: TrustedToolCompletionContext = {
  sessionId: 'session-claude',
  turnId: 'turn-1',
  controlInvocationGeneration: 1,
  toolInvocationId: 'tool-1'
}

describe('Claude Code completion handoff', () => {
  it('selects only durable user task context for a resumed-session replay', () => {
    expect(
      selectPersistedUserTaskContext([
        { id: 'u-1', role: 'user', content: 'Load the saved dataset', status: 'complete' },
        { id: 'a-1', role: 'agent', content: 'Displayed answer', status: 'complete' },
        { id: 'assistant-1', role: 'assistant', content: 'Provider response', status: 'complete' },
        { id: 'system-1', role: 'system', content: 'System instruction', status: 'complete' },
        { id: 'tool-1', role: 'tool', content: 'Tool output', status: 'complete' },
        { id: 'u-error', role: 'user', content: 'Failed draft', status: 'error' },
        { id: 'u-2', role: 'user', content: '  Compare the cohorts  ', status: 'complete' }
      ])
    ).toEqual([
      { messageId: 'u-1', text: 'Load the saved dataset' },
      { messageId: 'u-2', text: 'Compare the cohorts' }
    ])
  })

  it('leaves a non-Claude session on the established completion path so other framework adapters can register beside it', async () => {
    const registry = new CompletionGateRuntimeRegistry()
    registerClaudeCodeCompletionGateRuntime(registry, {
      sessionFramework: () => 'opencode',
      cancelPrompt: vi.fn(),
      waitForPromptOwnershipRelease: vi.fn(),
      resolveSpecialistId: vi.fn(),
      resolveSwitchReadBack: vi.fn(),
      prepareReplayContext: vi.fn(),
      discardReplayContext: vi.fn(),
      switchSpecialist: vi.fn(),
      createContinuationRequest: vi.fn(),
      sendAppContinuation: vi.fn()
    })
    const coordinator = new CompletionGateCoordinator(registry)
    coordinator.arm(context, 'Approved Specialist')
    const deliverToCurrentPrompt = vi.fn(async () => undefined)

    const disposition = await runCompletionGatedTool({
      coordinator,
      context,
      execute: async () => 'legacy completion',
      deliverToCurrentPrompt
    })

    expect(disposition).toMatchObject({ kind: 'deliver-to-current-prompt' })
    expect(deliverToCurrentPrompt).toHaveBeenCalledOnce()
  })

  it('replaces the released Claude session, replays the captured completion, then continues as the approved specialist', async () => {
    const calls: string[] = []
    const captured: ToolCompletionEnvelope = {
      kind: 'returned',
      value: { switched: { status: 'approved' }, afterAwait: 'complete' }
    }
    const switchReadBack = {
      status: 'approved' as const,
      operation: 'switch' as const,
      binding: {
        sessionId: context.sessionId,
        specialistId: 'specialist-approved',
        targetName: 'Approved Specialist',
        revision: 7
      }
    }
    const runtime = createClaudeCodeCompletionGateRuntime({
      sessionFramework: () => 'claude-code',
      cancelPrompt: vi.fn(async () => {
        calls.push('cancel-old')
      }),
      waitForPromptOwnershipRelease: vi.fn(async () => {
        calls.push('old-released')
      }),
      resolveSpecialistId: vi.fn(() => 'specialist-approved'),
      resolveSwitchReadBack: vi.fn(async () => switchReadBack),
      prepareReplayContext: vi.fn(async (input) => {
        expect(input.capturedCompletion).toEqual(captured)
        expect(input.switchReadBack).toEqual(switchReadBack)
        calls.push('prepare-replay-context')
      }),
      discardReplayContext: vi.fn(async () => undefined),
      switchSpecialist: vi.fn(async (_sessionId, specialistId) => {
        calls.push(`replace-session:${specialistId}`)
        return { contextReset: true }
      }),
      createContinuationRequest: vi.fn(async (input) => {
        expect(input.switchReadBack).toEqual(switchReadBack)
        calls.push('continuation-context')
        return {
          sessionId: input.sessionId,
          text: 'continue approved task',
          suppressUserMessage: true
        }
      }),
      sendAppContinuation: vi.fn(async (request) => {
        calls.push(`provider:${request.text}`)
      })
    })
    const coordinator = new CompletionGateCoordinator(runtime)
    coordinator.arm(context, 'Approved Specialist')
    const deliverToCurrentPrompt = vi.fn(async () => {
      calls.push('provider:old')
    })

    const disposition = await runCompletionGatedTool({
      coordinator,
      context,
      execute: async () => captured.value,
      deliverToCurrentPrompt
    })

    expect(disposition).toMatchObject({ kind: 'capture-for-handoff', envelope: captured })
    expect(deliverToCurrentPrompt).not.toHaveBeenCalled()
    expect(calls).toEqual([
      'cancel-old',
      'old-released',
      'prepare-replay-context',
      'replace-session:specialist-approved',
      'continuation-context',
      'provider:continue approved task'
    ])
  })

  it('reports reset or replay failure without restoring the old Claude prompt', async () => {
    const reportHandoffFailure = vi.fn(async () => undefined)
    const createContinuationRequest = vi.fn()
    const discardReplayContext = vi.fn(async () => undefined)
    const runtime = createClaudeCodeCompletionGateRuntime({
      sessionFramework: () => 'claude-code',
      cancelPrompt: vi.fn(async () => undefined),
      waitForPromptOwnershipRelease: vi.fn(async () => undefined),
      resolveSpecialistId: vi.fn(() => 'specialist-approved'),
      resolveSwitchReadBack: vi.fn(async () => ({
        status: 'approved' as const,
        operation: 'switch' as const,
        binding: {
          sessionId: context.sessionId,
          specialistId: 'specialist-approved',
          targetName: 'Approved Specialist',
          revision: 1
        }
      })),
      prepareReplayContext: vi.fn(async () => undefined),
      discardReplayContext,
      switchSpecialist: vi.fn(async () => {
        throw new Error('replacement failed')
      }),
      createContinuationRequest,
      sendAppContinuation: vi.fn(),
      reportHandoffFailure
    })
    const coordinator = new CompletionGateCoordinator(runtime)
    coordinator.arm(context, 'Approved Specialist')
    const deliverToCurrentPrompt = vi.fn(async () => undefined)

    await runCompletionGatedTool({
      coordinator,
      context,
      execute: async () => 'outer completion',
      deliverToCurrentPrompt
    })

    expect(deliverToCurrentPrompt).not.toHaveBeenCalled()
    expect(createContinuationRequest).not.toHaveBeenCalled()
    expect(discardReplayContext).toHaveBeenCalledWith(context.sessionId)
    expect(reportHandoffFailure).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'replacement failed' }),
      expect.objectContaining({ targetName: 'Approved Specialist' }),
      context
    )
  })
})
