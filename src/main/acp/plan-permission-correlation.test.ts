import type { RequestPermissionRequest } from '@agentclientprotocol/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PermissionProfileId } from '../../shared/permission-profiles'
import type { GeneratePlanContent } from '../../shared/session-plan/contract'
import { opencodeFramework } from '../agent-framework'
import { AcpPermissionContext } from './permission-context'

const sessionId = 'plan-session'
const title = 'open_science_plan_generate_plan'
const mcpServerNames = ['open-science-plan']
const planContent = (stepCount: number): GeneratePlanContent => ({
  task_summary: 'Review the research data',
  phases: [
    {
      name: 'Analysis',
      delegations: [
        {
          name: 'Main agent',
          steps: Array.from({ length: stepCount }, (_, index) => ({
            title: `Step ${index + 1}`,
            description: 'Inspect the data, produce findings, and verify the result.'
          }))
        }
      ]
    }
  ],
  desired_outputs: ['Verified report'],
  feasibility: { confidence: 'high', rationale: 'The data is available.' }
})

const request = (toolCallId: string, rawInput: unknown): RequestPermissionRequest => ({
  sessionId,
  toolCall: { toolCallId, title, kind: 'other', status: 'pending', rawInput },
  options: [
    { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'deny', name: 'Reject', kind: 'reject_once' }
  ]
})

const contexts: AcpPermissionContext[] = []
const createContext = (
  profile: PermissionProfileId = 'auto'
): {
  context: AcpPermissionContext
  emit: ReturnType<typeof vi.fn>
  timeout: ReturnType<typeof vi.fn>
  observe: (
    toolCallId: string,
    rawInput: unknown,
    overrides?: { sessionId?: string; title?: string }
  ) => void
} => {
  const emit = vi.fn()
  const timeout = vi.fn()
  const context = new AcpPermissionContext({
    emitPermissionRequest: emit,
    onOpenCodeWaitTimeout: timeout,
    routing: {
      resolveAppSessionId: (id) => id,
      sessionSnapshot: () => ({
        cwd: '/workspace',
        frameworkId: 'opencode',
        permissionProfile: { selectedProfile: profile, autoReviewStrategy: 'conservative' }
      }),
      hasActivePrimarySession: () => true,
      capturePrompt: () => ({
        sequence: 1,
        promptMessageId: 'prompt-1',
        isCancellationAccepted: () => false
      }),
      currentInteractionSequence: () => 1,
      mcpServerNamesFor: () => mcpServerNames,
      reviewerContextFor: () => undefined,
      resolveReviewerPermission: () => undefined,
      currentFramework: () => opencodeFramework,
      resolveProjectId: () => 'project-1'
    }
  })
  contexts.push(context)
  const observe = (
    toolCallId: string,
    rawInput: unknown,
    overrides: { sessionId?: string; title?: string } = {}
  ): void => {
    const observedSessionId = overrides.sessionId ?? sessionId
    const observedTitle = overrides.title ?? title
    context.observeToolCall(
      {
        sessionId: observedSessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId,
          title: observedTitle,
          kind: 'other',
          status: 'pending',
          rawInput,
          _meta: { toolName: observedTitle }
        }
      },
      { sessionId: observedSessionId, framework: 'opencode', mcpServerNames }
    )
  }
  return { context, observe, emit, timeout }
}

beforeEach(() => vi.useFakeTimers())

afterEach(() => {
  for (const context of contexts.splice(0)) {
    context.cancelForSession(sessionId)
    context.dispose()
  }
  vi.useRealTimers()
})

describe('OpenCode Plan permission correlation', () => {
  it.each(['observation-first', 'populated-request-first', 'empty-request-first'] as const)(
    'admits initial and revised Plan content without outer approval: %s',
    async (order) => {
      const { context, observe, emit, timeout } = createContext()
      for (const stepCount of [2, 4]) {
        const toolCallId = `plan-${stepCount}`
        const content = planContent(stepCount)
        const callOrder = stepCount === 2 ? 'observation-first' : order
        if (callOrder === 'observation-first') observe(toolCallId, content)
        const response = context.handleProviderRequest(
          request(toolCallId, callOrder === 'empty-request-first' ? {} : content)
        )
        if (callOrder !== 'observation-first') {
          // Give request_permission time to run before delivering the matching notification.
          await vi.advanceTimersByTimeAsync(250)
          expect(emit).not.toHaveBeenCalled()
          observe(toolCallId, content)
        }
        await expect(response).resolves.toEqual({
          outcome: { outcome: 'selected', optionId: 'once' }
        })
        expect(context.getPendingRequests()).toEqual([])
        expect(context.snapshot().sessions[sessionId]?.pendingWaiters ?? 0).toBe(0)
      }
      expect(emit).not.toHaveBeenCalled()
      expect(timeout).not.toHaveBeenCalled()
    }
  )

  it('uses observed identity immediately when only the permission request contains arguments', async () => {
    const { context, observe, emit } = createContext()
    observe('plan', {})
    await expect(context.handleProviderRequest(request('plan', planContent(4)))).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'once' }
    })
    expect(emit).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['session', 'call', 'tool'] as const)(
    'does not authorize Plan content from an observation for a different %s',
    async (mismatch) => {
      const { context, observe, emit } = createContext()
      let settled = false
      const response = context.handleProviderRequest(request('plan', planContent(4)))
      void response.then(() => {
        settled = true
      })
      observe(mismatch === 'call' ? 'other-call' : 'plan', planContent(4), {
        ...(mismatch === 'session' ? { sessionId: 'other-session' } : {}),
        ...(mismatch === 'tool' ? { title: 'open_science_plan_update_step_status' } : {})
      })
      await vi.advanceTimersByTimeAsync(1_000)
      expect(settled).toBe(false)
      expect(emit).toHaveBeenCalledOnce()
      expect(context.snapshot().sessions[sessionId]?.pendingWaiters ?? 0).toBe(0)
      context.cancelForSession(sessionId)
      await expect(response).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    }
  )

  it('cancels the correlation wait without exposing a redundant permission', async () => {
    const { context, observe, emit, timeout } = createContext()
    const response = context.handleProviderRequest(request('plan', planContent(4)))
    expect(context.snapshot().sessions[sessionId]?.pendingWaiters).toBe(1)
    context.cancelForSession(sessionId)
    await expect(response).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    observe('plan', planContent(4))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(emit).not.toHaveBeenCalled()
    expect(timeout).not.toHaveBeenCalled()
    expect(context.getPendingRequests()).toEqual([])
    expect(context.snapshot().sessions[sessionId]?.pendingWaiters ?? 0).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retains human approval after the existing one-second correlation timeout', async () => {
    const { context, observe, emit, timeout } = createContext()
    const response = context.handleProviderRequest(request('plan', planContent(4)))
    await vi.advanceTimersByTimeAsync(999)
    expect(emit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(timeout).toHaveBeenCalledExactlyOnceWith({
      sessionId,
      toolCallId: 'plan',
      waitMs: 1_000
    })
    expect(emit).toHaveBeenCalledOnce()
    observe('plan', planContent(4))
    await vi.advanceTimersByTimeAsync(0)
    expect(context.getPendingRequests()).toHaveLength(1)
    context.cancelForSession(sessionId)
    await expect(response).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    { ...planContent(4), schema_version: 1 },
    { ...planContent(4), phases: [] }
  ])(
    'retains outer approval for malformed content despite a matching notification: %j',
    async (input) => {
      const { context, observe, emit } = createContext()
      const response = context.handleProviderRequest(request('plan', input))
      observe('plan', input)
      await vi.advanceTimersByTimeAsync(0)
      expect(emit).toHaveBeenCalledOnce()
      context.cancelForSession(sessionId)
      await expect(response).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    }
  )

  it('retains Ask approval after a matching Plan notification', async () => {
    const { context, observe, emit } = createContext('ask')
    const response = context.handleProviderRequest(request('plan', planContent(4)))
    observe('plan', planContent(4))
    await vi.advanceTimersByTimeAsync(0)
    expect(emit).toHaveBeenCalledOnce()
    context.cancelForSession(sessionId)
    await expect(response).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
  })
})
