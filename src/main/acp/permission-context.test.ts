import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification
} from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'

import {
  AcpPermissionContext,
  AGENT_PERMISSION_ACTION_ORIGIN,
  HUMAN_PERMISSION_ACTION_ORIGIN
} from './permission-context'

const NOTEBOOK_SERVERS = ['open-science-notebook']

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
  it('correlates sparse Codex approvals and bounds retained provider aliases', async () => {
    const context = new AcpPermissionContext({ emitPermissionRequest: vi.fn() })

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
    const context = new AcpPermissionContext({ emitPermissionRequest: vi.fn() })
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
      emitPermissionRequest: (request) => emitted.push(request)
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
      emitPermissionRequest: (request) => emitted.push(request)
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
    const context = new AcpPermissionContext({ emitPermissionRequest: vi.fn() })
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
