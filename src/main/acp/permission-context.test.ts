import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification
} from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'

import { opencodeFramework } from '../agent-framework'
import {
  AcpPermissionContext,
  AGENT_PERMISSION_ACTION_ORIGIN,
  HUMAN_PERMISSION_ACTION_ORIGIN
} from './permission-context'
import type { AcpPermissionContextOptions } from './permission-context'

const NOTEBOOK_SERVERS = ['open-science-notebook']

const permissionRouting = (
  overrides: Partial<NonNullable<AcpPermissionContextOptions['routing']>> = {}
): NonNullable<AcpPermissionContextOptions['routing']> => ({
  resolveAppSessionId: (sessionId) => sessionId,
  sessionSnapshot: () => ({
    cwd: '/workspace',
    frameworkId: 'opencode',
    permissionProfile: { selectedProfile: 'ask' }
  }),
  hasActivePrimarySession: () => true,
  capturePrompt: () => undefined,
  currentInteractionSequence: () => undefined,
  mcpServerNamesFor: () => NOTEBOOK_SERVERS,
  reviewerContextFor: () => undefined,
  resolveReviewerPermission: () => undefined,
  currentFramework: () => opencodeFramework,
  resolveProjectId: () => 'default-project',
  ...overrides
})

const permissionRequest = (
  sessionId: string,
  toolCallId: string,
  overrides: Partial<RequestPermissionRequest['toolCall']> = {}
): RequestPermissionRequest => ({
  sessionId,
  toolCall: {
    toolCallId,
    title: 'open_science_notebook_notebook_execute',
    kind: 'other',
    status: 'pending',
    rawInput: {},
    ...overrides
  },
  options: [
    { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }
  ]
})

const observe = (
  context: AcpPermissionContext,
  notification: SessionNotification,
  framework: 'codex' | 'opencode' | 'claude-code'
): void => {
  context.observeToolCall(notification, {
    sessionId: notification.sessionId,
    framework,
    mcpServerNames: NOTEBOOK_SERVERS
  })
}

describe('ACP permission context', () => {
  it('reports allowed, rejected, and session-cancelled permission lifecycles', async () => {
    const onPermissionSettled = vi.fn()
    const context = new AcpPermissionContext({
      emitPermissionRequest: vi.fn(),
      routing: permissionRouting(),
      onPermissionSettled
    })

    const allowed = context.requestPermission(permissionRequest('session-1', 'allow-call'))
    const allowedRequest = context.getPendingRequests()[0]
    await context.respondToPermission(
      { requestId: allowedRequest.requestId, optionId: 'allow-once' },
      HUMAN_PERMISSION_ACTION_ORIGIN
    )
    await allowed

    const rejected = context.requestPermission(permissionRequest('session-1', 'reject-call'))
    const rejectedRequest = context.getPendingRequests()[0]
    await context.respondToPermission(
      { requestId: rejectedRequest.requestId, optionId: 'reject-once' },
      HUMAN_PERMISSION_ACTION_ORIGIN
    )
    await rejected

    const cancelled = context.requestPermission(permissionRequest('session-1', 'cancel-call'))
    const cancelledRequest = context.getPendingRequests()[0]
    context.cancelForSession('session-1')
    await cancelled

    expect(onPermissionSettled).toHaveBeenNthCalledWith(1, allowedRequest.requestId, 'resolved')
    expect(onPermissionSettled).toHaveBeenNthCalledWith(2, rejectedRequest.requestId, 'rejected')
    expect(onPermissionSettled).toHaveBeenNthCalledWith(3, cancelledRequest.requestId, 'cancelled')
  })

  it('cancels a late OpenCode primary request when no prompt owns the active Session', async () => {
    const emitPermissionRequest = vi.fn()
    const resolveReviewerPermission = vi.fn()
    const context = new AcpPermissionContext({
      emitPermissionRequest,
      routing: permissionRouting({ resolveReviewerPermission })
    })

    await expect(
      context.handleProviderRequest(
        permissionRequest('primary-session', 'late-call', { title: 'Bash', kind: 'execute' })
      )
    ).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(resolveReviewerPermission).not.toHaveBeenCalled()
    expect(emitPermissionRequest).not.toHaveBeenCalled()
  })

  it('routes an isolated OpenCode reviewer request without a primary attachment', async () => {
    const reviewerResponse = {
      outcome: { outcome: 'selected' as const, optionId: 'reject-once' }
    }
    const resolveReviewerPermission = vi.fn(() => reviewerResponse)
    const context = new AcpPermissionContext({
      emitPermissionRequest: vi.fn(),
      routing: permissionRouting({
        hasActivePrimarySession: () => false,
        reviewerContextFor: () => ({
          frameworkId: 'opencode',
          mcpServerNames: ['open-science-reviewer']
        }),
        resolveReviewerPermission
      })
    })
    const request = permissionRequest('reviewer-session', 'reviewer-call', {
      title: 'Bash',
      kind: 'execute'
    })

    await expect(context.handleProviderRequest(request)).resolves.toEqual(reviewerResponse)
    expect(resolveReviewerPermission).toHaveBeenCalledWith(request)
  })

  it('correlates provider updates under the stable adopted Session identity', () => {
    const context = new AcpPermissionContext({
      emitPermissionRequest: vi.fn(),
      routing: permissionRouting({
        resolveAppSessionId: () => 'stable-session',
        sessionSnapshot: () => ({
          frameworkId: 'codex',
          permissionProfile: { selectedProfile: 'ask' }
        })
      })
    })

    context.observeProviderUpdate({
      sessionId: 'provider-session',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-1',
        title: 'mcp.open-science-notebook.notebook_execute',
        kind: 'execute',
        status: 'pending',
        rawInput: {
          server: 'open-science-notebook',
          tool: 'notebook_execute',
          arguments: { language: 'python', code: 'print(1)' }
        },
        _meta: { is_mcp_tool_call: true }
      }
    })

    expect(context.snapshot().sessions).toMatchObject({
      'stable-session': { codexMcpIdentities: 1 }
    })
    expect(context.snapshot().sessions).not.toHaveProperty('provider-session')
  })

  it('consumes a Codex MCP identity only for the matching session, call, and tool', () => {
    const context = new AcpPermissionContext({
      emitPermissionRequest: vi.fn(),
      routing: permissionRouting()
    })
    observe(
      context,
      {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'call-1',
          kind: 'execute',
          title: 'mcp.open-science-notebook.ask_user_question',
          status: 'pending',
          rawInput: {
            server: 'open-science-notebook',
            tool: 'ask_user_question',
            arguments: {}
          },
          _meta: { is_mcp_tool_call: true }
        }
      },
      'codex'
    )

    expect(
      context.consumeTrustedCodexMcpToolCall(
        'wrong-session',
        'call-1',
        'open-science-notebook/ask_user_question'
      )
    ).toBe(false)
    expect(
      context.consumeTrustedCodexMcpToolCall(
        'session-1',
        'wrong-call',
        'open-science-notebook/ask_user_question'
      )
    ).toBe(false)
    expect(
      context.consumeTrustedCodexMcpToolCall(
        'session-1',
        'call-1',
        'open-science-notebook/notebook_state'
      )
    ).toBe(false)
    expect(
      context.consumeTrustedCodexMcpToolCall(
        'session-1',
        'call-1',
        'open-science-notebook/ask_user_question'
      )
    ).toBe(true)
    expect(
      context.consumeTrustedCodexMcpToolCall(
        'session-1',
        'call-1',
        'open-science-notebook/ask_user_question'
      )
    ).toBe(false)
  })

  it('correlates sparse Codex approvals and bounds retained provider aliases', async () => {
    const context = new AcpPermissionContext({
      emitPermissionRequest: vi.fn(),
      routing: permissionRouting()
    })

    for (let index = 0; index < 40; index += 1) {
      observe(
        context,
        {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: `call-${index}`,
            kind: 'execute',
            title: 'mcp.open-science-notebook.notebook_execute',
            status: 'pending',
            rawInput: {
              server: 'open-science-notebook',
              tool: 'notebook_execute',
              arguments: { language: 'python', code: `print(${index})` }
            },
            _meta: { is_mcp_tool_call: true }
          }
        },
        'codex'
      )
    }

    expect(context.snapshot()).toEqual({
      pendingRequests: [],
      sessions: {
        'session-1': {
          codexMcpIdentities: 32,
          claudeCodeMcpInputs: 0,
          opencodeMcpInputs: 0,
          opencodeNativeSkills: 0,
          opencodeClosedToolCalls: 0,
          pendingWaiters: 0
        }
      }
    })

    const restored = await context.restoreToolCall(
      {
        ...permissionRequest('session-1', 'call-39', {
          title: undefined,
          kind: 'execute',
          rawInput: undefined
        }),
        _meta: { is_mcp_tool_approval: true }
      },
      {
        sessionId: 'session-1',
        framework: 'codex',
        mcpServerNames: NOTEBOOK_SERVERS,
        isCancelled: () => false
      }
    )

    expect(restored?.toolCall).toMatchObject({
      title: 'mcp.open-science-notebook.notebook_execute',
      rawInput: { language: 'python', code: 'print(39)' },
      _meta: { toolName: 'notebook_execute' }
    })
  })

  it('rendezvouses an OpenCode request with a bounded late preview and removes its waiter', async () => {
    const context = new AcpPermissionContext({
      emitPermissionRequest: vi.fn(),
      routing: permissionRouting()
    })
    const code = 'x <- 1\n'.repeat(2_000)

    observe(
      context,
      {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'call-1',
          title: 'open_science_notebook_notebook_execute',
          kind: 'other',
          status: 'pending',
          rawInput: {}
        }
      },
      'opencode'
    )

    const restored = context.restoreToolCall(permissionRequest('session-1', 'call-1'), {
      sessionId: 'session-1',
      framework: 'opencode',
      mcpServerNames: NOTEBOOK_SERVERS,
      isCancelled: () => false
    })

    await vi.waitFor(() => expect(context.snapshot().sessions['session-1']?.pendingWaiters).toBe(1))

    observe(
      context,
      {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-1',
          status: 'in_progress',
          rawInput: { language: 'r', code }
        }
      },
      'opencode'
    )

    const result = await restored
    expect(result?.toolCall.rawInput).toEqual({
      language: 'r',
      code: code.slice(0, 7_500),
      inputTruncated: true
    })
    expect(context.snapshot().sessions['session-1']?.pendingWaiters ?? 0).toBe(0)
  })

  it('keeps a human-only decision parked when an agent-origin action tries to resolve it', async () => {
    const emitted: Array<{ requestId: string }> = []
    const context = new AcpPermissionContext({
      emitPermissionRequest: (request) => emitted.push(request),
      routing: permissionRouting()
    })
    const pending = context.requestPermission(permissionRequest('session-1', 'call-1'))

    await expect(
      context.respondToPermission(
        { requestId: emitted[0].requestId, optionId: 'allow-once' },
        AGENT_PERMISSION_ACTION_ORIGIN
      )
    ).resolves.toBe(false)
    expect(context.snapshot().pendingRequests).toEqual([
      {
        requestId: emitted[0].requestId,
        sessionId: 'session-1',
        toolCallId: 'call-1',
        requiredOrigin: 'human'
      }
    ])

    await expect(
      context.respondToPermission(
        { requestId: emitted[0].requestId, optionId: 'allow-once' },
        HUMAN_PERMISSION_ACTION_ORIGIN
      )
    ).resolves.toBe(true)
    await expect(pending).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' }
    } satisfies RequestPermissionResponse)
  })

  it('drops waiter and preview residue when OpenCode correlation times out', async () => {
    vi.useFakeTimers()
    try {
      const onOpenCodeWaitTimeout = vi.fn()
      const context = new AcpPermissionContext({
        emitPermissionRequest: vi.fn(),
        routing: permissionRouting(),
        onOpenCodeWaitTimeout
      })
      observe(
        context,
        {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'call-1',
            title: 'open_science_notebook_notebook_execute',
            kind: 'other',
            status: 'pending',
            rawInput: {}
          }
        },
        'opencode'
      )
      const restored = context.restoreToolCall(permissionRequest('session-1', 'call-1'), {
        sessionId: 'session-1',
        framework: 'opencode',
        mcpServerNames: NOTEBOOK_SERVERS,
        isCancelled: () => false
      })

      await vi.advanceTimersByTimeAsync(1_000)

      await expect(restored).resolves.toMatchObject({
        toolCall: { _meta: { toolName: 'open_science_notebook_notebook_execute' } }
      })
      expect(onOpenCodeWaitTimeout).toHaveBeenCalledWith({
        sessionId: 'session-1',
        toolCallId: 'call-1',
        waitMs: 1_000
      })
      expect(context.snapshot()).toEqual({ pendingRequests: [], sessions: {} })
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels pending correlation waiters and decisions on session cleanup', async () => {
    const emitted: Array<{ requestId: string }> = []
    const context = new AcpPermissionContext({
      emitPermissionRequest: (request) => emitted.push(request),
      routing: permissionRouting()
    })

    observe(
      context,
      {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'call-1',
          title: 'open_science_notebook_notebook_execute',
          kind: 'other',
          status: 'pending',
          rawInput: {}
        }
      },
      'opencode'
    )
    const correlation = context.restoreToolCall(permissionRequest('session-1', 'call-1'), {
      sessionId: 'session-1',
      framework: 'opencode',
      mcpServerNames: NOTEBOOK_SERVERS,
      isCancelled: () => false
    })
    const decision = context.requestPermission(permissionRequest('session-1', 'call-2'))

    await vi.waitFor(() => expect(context.snapshot().sessions['session-1']?.pendingWaiters).toBe(1))
    context.cancelForSession('session-1')

    await expect(correlation).resolves.toBeUndefined()
    await expect(decision).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(context.snapshot()).toEqual({ pendingRequests: [], sessions: {} })
  })

  it('disposes every session without retaining preview or waiter metadata', async () => {
    const context = new AcpPermissionContext({
      emitPermissionRequest: vi.fn(),
      routing: permissionRouting()
    })
    observe(
      context,
      {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'call-1',
          title: 'open_science_notebook_notebook_execute',
          kind: 'other',
          status: 'pending',
          rawInput: {}
        }
      },
      'opencode'
    )
    const correlation = context.restoreToolCall(permissionRequest('session-1', 'call-1'), {
      sessionId: 'session-1',
      framework: 'opencode',
      mcpServerNames: NOTEBOOK_SERVERS,
      isCancelled: () => false
    })

    await vi.waitFor(() => expect(context.snapshot().sessions['session-1']?.pendingWaiters).toBe(1))
    context.dispose()

    await expect(correlation).resolves.toBeUndefined()
    expect(context.snapshot()).toEqual({ pendingRequests: [], sessions: {} })
  })
})
