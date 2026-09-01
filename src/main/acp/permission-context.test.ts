import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification
} from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'

import { sanitizeSessionPermissionRuntimeContext } from '../../shared/session-persistence'
import { opencodeFramework } from '../agent-framework'
import {
  AcpPermissionContext,
  AGENT_PERMISSION_ACTION_ORIGIN,
  HUMAN_PERMISSION_ACTION_ORIGIN
} from './permission-context'
import type { AcpPermissionContextOptions } from './permission-context'
import { permissionRequestFingerprint } from './permission-broker'

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
  framework: 'codex' | 'opencode' | 'claude-code' | 'codebuddy'
): void => {
  context.observeToolCall(notification, {
    sessionId: notification.sessionId,
    framework,
    mcpServerNames: NOTEBOOK_SERVERS
  })
}

describe('ACP permission context', () => {
  it.each([
    {
      name: 'Claude Code',
      framework: 'claude-code' as const,
      title: 'mcp__open-science-notebook__notebook_execute',
      providerToolName: 'mcp__open-science-notebook__notebook_execute',
      toolKind: 'other' as const,
      rawInput: { language: 'python', code: 'token=test-notebook-secret\nprint(1)' },
      notificationRawInput: {
        language: 'python',
        code: 'token=test-notebook-secret\nprint(1)'
      },
      meta: { claudeCode: { toolName: 'mcp__open-science-notebook__notebook_execute' } }
    },
    {
      name: 'OpenCode',
      framework: 'opencode' as const,
      title: 'open_science_notebook_notebook_execute',
      providerToolName: 'open_science_notebook_notebook_execute',
      toolKind: 'other' as const,
      rawInput: { language: 'python', code: 'token=test-notebook-secret\nprint(1)' },
      notificationRawInput: {
        language: 'python',
        code: 'token=test-notebook-secret\nprint(1)'
      },
      meta: { toolName: 'open_science_notebook_notebook_execute' }
    },
    {
      name: 'Codex Responses / Bridge',
      framework: 'codex' as const,
      title: 'mcp.open-science-notebook.notebook_execute',
      providerToolName: 'notebook_execute',
      toolKind: 'execute' as const,
      rawInput: { language: 'python', code: 'token=test-notebook-secret\nprint(1)' },
      notificationRawInput: {
        server: 'open-science-notebook',
        tool: 'notebook_execute',
        arguments: { language: 'python', code: 'token=test-notebook-secret\nprint(1)' }
      },
      meta: { is_mcp_tool_call: true }
    }
  ])(
    'projects an exact restored Notebook replay through the original toolCallId for $name',
    async ({
      framework,
      title,
      providerToolName,
      toolKind,
      rawInput,
      notificationRawInput,
      meta
    }) => {
      const context = new AcpPermissionContext({
        emitPermissionRequest: vi.fn(),
        routing: permissionRouting({
          sessionSnapshot: () => ({
            cwd: '/workspace',
            frameworkId: framework,
            permissionProfile: { selectedProfile: 'ask' }
          })
        })
      })
      const request = {
        requestId: 'permission-restored',
        sessionId: 'session-1',
        toolCallId: 'tool-original',
        title,
        providerToolName,
        isMcp: true,
        mcpIdentity: 'open-science-notebook/notebook_execute',
        toolKind,
        rawInput,
        options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' as const }]
      }
      const fingerprint = permissionRequestFingerprint(request)
      expect(fingerprint).toMatch(/^[a-f0-9]{64}$/)
      const restoredPermission = sanitizeSessionPermissionRuntimeContext({
        state: 'pending',
        request,
        originatingPromptMessageId: 'prompt-1',
        fingerprint,
        createdAt: 1
      })
      expect(restoredPermission).toBeDefined()
      expect(JSON.stringify(restoredPermission)).not.toContain('test-notebook-secret')
      await context.prepareRestoredDecision(
        restoredPermission!,
        request.options[0],
        'default-project'
      )

      observe(
        context,
        {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tool-replayed',
            title,
            kind: toolKind,
            status: 'pending',
            rawInput: notificationRawInput,
            _meta: meta
          }
        },
        framework
      )

      expect(context.presentationToolCallId('session-1', 'tool-replayed')).toBe('tool-original')
      context.clearRestoredDecision('session-1')
      expect(context.presentationToolCallId('session-1', 'tool-replayed')).toBe('tool-original')
      context.clearCorrelationsForSession('session-1')
      expect(context.presentationToolCallId('session-1', 'tool-replayed')).toBe('tool-replayed')
    }
  )

  it('preserves a legacy restored Notebook fingerprint above the current preview limit', async () => {
    const code = 'x'.repeat(7_600)
    const title = 'mcp.open-science-notebook.notebook_execute'
    const context = new AcpPermissionContext({
      emitPermissionRequest: vi.fn(),
      routing: permissionRouting({
        sessionSnapshot: () => ({
          cwd: '/workspace',
          frameworkId: 'codex',
          permissionProfile: { selectedProfile: 'ask' }
        })
      })
    })
    const request = {
      requestId: 'permission-restored',
      sessionId: 'session-1',
      toolCallId: 'tool-original',
      title,
      providerToolName: 'notebook_execute',
      isMcp: true,
      mcpIdentity: 'open-science-notebook/notebook_execute',
      toolKind: 'execute' as const,
      rawInput: { language: 'python', code },
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' as const }]
    }
    const restoredPermission = sanitizeSessionPermissionRuntimeContext({
      state: 'pending',
      request,
      originatingPromptMessageId: 'prompt-1',
      fingerprint: permissionRequestFingerprint(request)!,
      createdAt: 1
    })

    await context.prepareRestoredDecision(
      restoredPermission!,
      request.options[0],
      'default-project'
    )
    observe(
      context,
      {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-replayed',
          title,
          kind: 'execute',
          status: 'pending',
          rawInput: {
            server: 'open-science-notebook',
            tool: 'notebook_execute',
            arguments: { language: 'python', code }
          },
          _meta: { is_mcp_tool_call: true }
        }
      },
      'codex'
    )

    expect(context.presentationToolCallId('session-1', 'tool-replayed')).toBe('tool-original')
  })

  it('keeps a non-matching restored Notebook replay on its provider toolCallId', async () => {
    const context = new AcpPermissionContext({
      emitPermissionRequest: vi.fn(),
      routing: permissionRouting()
    })
    const request = {
      requestId: 'permission-restored',
      sessionId: 'session-1',
      toolCallId: 'tool-original',
      title: 'open_science_notebook_notebook_execute',
      providerToolName: 'open_science_notebook_notebook_execute',
      isMcp: true,
      mcpIdentity: 'open-science-notebook/notebook_execute',
      toolKind: 'other' as const,
      rawInput: { language: 'python', code: 'print(1)' },
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' as const }]
    }
    await context.prepareRestoredDecision(
      {
        state: 'pending',
        request,
        originatingPromptMessageId: 'prompt-1',
        fingerprint: permissionRequestFingerprint(request)!,
        createdAt: 1
      },
      request.options[0],
      'default-project'
    )

    observe(
      context,
      {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool-replayed',
          title: request.title,
          kind: 'other',
          status: 'pending',
          rawInput: { language: 'python', code: 'print(2)' },
          _meta: { toolName: request.providerToolName }
        }
      },
      'opencode'
    )

    expect(context.presentationToolCallId('session-1', 'tool-replayed')).toBe('tool-replayed')
  })

  it.each([
    ['Claude Code', 'claude-code'],
    ['OpenCode', 'opencode'],
    ['Codex Responses', 'codex'],
    ['Codex Bridge', 'codex']
  ] as const)(
    'reports allowed, rejected, and session-cancelled permission lifecycles for %s',
    async (_name, frameworkId) => {
      const onPermissionSettled = vi.fn()
      const onToolPermissionSettled = vi.fn()
      const context = new AcpPermissionContext({
        emitPermissionRequest: vi.fn(),
        routing: permissionRouting({
          sessionSnapshot: () => ({
            cwd: '/workspace',
            frameworkId,
            permissionProfile: { selectedProfile: 'ask' }
          })
        }),
        onPermissionSettled,
        onToolPermissionSettled
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
      expect(onPermissionSettled).toHaveBeenNthCalledWith(
        3,
        cancelledRequest.requestId,
        'cancelled'
      )
      expect(onToolPermissionSettled).toHaveBeenNthCalledWith(1, allowedRequest, 'resolved')
      expect(onToolPermissionSettled).toHaveBeenNthCalledWith(2, rejectedRequest, 'rejected')
      expect(onToolPermissionSettled).toHaveBeenNthCalledWith(3, cancelledRequest, 'cancelled')
    }
  )

  it('retains the originating prompt for rejected and cancelled permission settlements', async () => {
    const onToolPermissionSettled = vi.fn()
    const context = new AcpPermissionContext({
      emitPermissionRequest: vi.fn(),
      routing: permissionRouting(),
      onToolPermissionSettled
    })
    const policyContext = {
      profile: 'ask' as const,
      frameworkId: 'opencode' as const,
      cwd: '/workspace',
      mcpServerNames: NOTEBOOK_SERVERS
    }

    const rejected = context.requestPermission(permissionRequest('session-1', 'reject-call'), {
      ...policyContext,
      promptMessageId: 'prompt-rejected'
    })
    const rejectedRequest = context.getPendingRequests()[0]
    await context.respondToPermission(
      { requestId: rejectedRequest.requestId, optionId: 'reject-once' },
      HUMAN_PERMISSION_ACTION_ORIGIN
    )
    await rejected

    const cancelled = context.requestPermission(permissionRequest('session-1', 'cancel-call'), {
      ...policyContext,
      promptMessageId: 'prompt-cancelled'
    })
    const cancelledRequest = context.getPendingRequests()[0]
    context.cancelForSession('session-1')
    await cancelled

    expect(onToolPermissionSettled).toHaveBeenNthCalledWith(1, rejectedRequest, 'rejected', {
      promptMessageId: 'prompt-rejected'
    })
    expect(onToolPermissionSettled).toHaveBeenNthCalledWith(2, cancelledRequest, 'cancelled', {
      promptMessageId: 'prompt-cancelled'
    })
  })

  it('does not create an approval wait for trusted automatic permission', async () => {
    const context = new AcpPermissionContext({
      emitPermissionRequest: vi.fn(),
      routing: permissionRouting()
    })
    const params = permissionRequest('session-1', 'auto-call')

    await expect(
      context.requestPermission(params, {
        profile: 'full',
        frameworkId: 'opencode',
        cwd: '/workspace',
        mcpServerNames: NOTEBOOK_SERVERS
      })
    ).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } })

    expect(context.getPendingRequests()).toEqual([])
  })

  it('cancels a late OpenCode primary request when no prompt owns the active Session', async () => {
    const emitPermissionRequest = vi.fn()
    const resolveReviewerPermission = vi.fn()
    const onToolPermissionSettled = vi.fn()
    const context = new AcpPermissionContext({
      emitPermissionRequest,
      routing: permissionRouting({ resolveReviewerPermission }),
      onToolPermissionSettled
    })

    await expect(
      context.handleProviderRequest(
        permissionRequest('primary-session', 'late-call', { title: 'Bash', kind: 'execute' })
      )
    ).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(resolveReviewerPermission).not.toHaveBeenCalled()
    expect(emitPermissionRequest).not.toHaveBeenCalled()
    expect(onToolPermissionSettled).not.toHaveBeenCalled()
  })

  it('reports a late-cancelled OpenCode Notebook permission as permission-closed activity', async () => {
    const onToolPermissionSettled = vi.fn()
    const context = new AcpPermissionContext({
      emitPermissionRequest: vi.fn(),
      routing: permissionRouting({
        capturePrompt: () => ({
          sequence: 7,
          promptMessageId: 'prompt-1',
          isCancellationAccepted: () => true
        }),
        currentInteractionSequence: () => 7
      }),
      onToolPermissionSettled
    })

    await expect(
      context.handleProviderRequest(
        permissionRequest('session-1', 'late-notebook-call', {
          rawInput: { language: 'python', code: 'print(1)' }
        })
      )
    ).resolves.toEqual({ outcome: { outcome: 'cancelled' } })

    expect(onToolPermissionSettled).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        toolCallId: 'late-notebook-call',
        title: 'open_science_notebook_notebook_execute',
        isMcp: true,
        mcpIdentity: 'open-science-notebook/notebook_execute',
        rawInput: { language: 'python', code: 'print(1)' }
      }),
      'cancelled',
      { promptMessageId: 'prompt-1' }
    )
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

  it('keeps the permission preview bounded while authorizing the complete trusted input', async () => {
    const code = 'x <- 1\n'.repeat(2_000)
    const onNotebookExecutionAuthorized = vi.fn()
    const context = new AcpPermissionContext({
      emitPermissionRequest: (request) => {
        queueMicrotask(() => {
          void context.respondToPermission(
            { requestId: request.requestId, optionId: 'allow-once' },
            HUMAN_PERMISSION_ACTION_ORIGIN
          )
        })
      },
      routing: permissionRouting({
        capturePrompt: () => ({
          sequence: 1,
          promptMessageId: 'prompt-1',
          isCancellationAccepted: () => false
        }),
        currentInteractionSequence: () => 1
      }),
      onNotebookExecutionAuthorized
    })

    observe(
      context,
      {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'call-1',
          title: 'open_science_notebook_repl_execute',
          kind: 'other',
          status: 'pending',
          rawInput: { code }
        }
      },
      'opencode'
    )

    await expect(
      context.handleProviderRequest(
        permissionRequest('session-1', 'call-1', {
          title: 'open_science_notebook_repl_execute',
          rawInput: {}
        })
      )
    ).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
    expect(onNotebookExecutionAuthorized).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'executeControl',
        rawInput: {
          language: 'javascript',
          code: code.slice(0, 7_500),
          inputTruncated: true
        },
        executionInput: { code }
      })
    )
  })

  it('authorizes a native Claude Notebook call once when executable input arrives late', () => {
    const onNotebookExecutionAuthorized = vi.fn()
    const context = new AcpPermissionContext({
      emitPermissionRequest: vi.fn(),
      routing: permissionRouting(),
      onNotebookExecutionAuthorized
    })
    const toolCall = {
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call' as const,
        toolCallId: 'call-1',
        title: 'mcp__open-science-notebook__notebook_execute',
        kind: 'execute' as const,
        status: 'pending' as const,
        rawInput: {}
      }
    }
    const permissionContext = {
      sessionId: 'session-1',
      framework: 'claude-code' as const,
      mcpServerNames: NOTEBOOK_SERVERS,
      nativeFullAccess: true,
      promptMessageId: 'prompt-1'
    }

    context.observeToolCall(toolCall, permissionContext)
    for (let index = 0; index < 2; index += 1) {
      context.observeToolCall(
        {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'call-1',
            status: 'in_progress',
            rawInput: { language: 'python', code: 'print(1)' }
          }
        },
        permissionContext
      )
    }

    expect(onNotebookExecutionAuthorized).toHaveBeenCalledOnce()
    expect(onNotebookExecutionAuthorized).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        toolCallId: 'call-1',
        promptMessageId: 'prompt-1',
        method: 'execute',
        executionInput: { language: 'python', code: 'print(1)' }
      })
    )
  })

  it('authorizes a native CodeBuddy Notebook call in full access mode', () => {
    const onNotebookExecutionAuthorized = vi.fn()
    const context = new AcpPermissionContext({
      emitPermissionRequest: vi.fn(),
      routing: permissionRouting(),
      onNotebookExecutionAuthorized
    })
    const toolCall = {
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call' as const,
        toolCallId: 'call-1',
        title: 'mcp__open-science-notebook__notebook_execute',
        kind: 'execute' as const,
        status: 'pending' as const,
        rawInput: { language: 'python', code: 'print(1)' },
        _meta: {
          'codebuddy.ai/toolName': 'mcp__open-science-notebook__notebook_execute'
        }
      }
    }
    const permissionContext = {
      sessionId: 'session-1',
      framework: 'codebuddy' as const,
      mcpServerNames: NOTEBOOK_SERVERS,
      nativeFullAccess: true,
      promptMessageId: 'prompt-1'
    }

    context.observeToolCall(toolCall, permissionContext)
    context.observeToolCall(toolCall, permissionContext)

    expect(onNotebookExecutionAuthorized).toHaveBeenCalledOnce()
    expect(onNotebookExecutionAuthorized).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        toolCallId: 'call-1',
        promptMessageId: 'prompt-1',
        method: 'execute',
        executionInput: { language: 'python', code: 'print(1)' }
      })
    )
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

  it('disposes complete execution input after its permission preview is consumed', async () => {
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
          rawInput: { language: 'python', code: 'print(1)' }
        }
      },
      'opencode'
    )

    await context.restoreToolCall(permissionRequest('session-1', 'call-1'), {
      sessionId: 'session-1',
      framework: 'opencode',
      mcpServerNames: NOTEBOOK_SERVERS,
      isCancelled: () => false
    })
    expect(context.snapshot().sessions).toHaveProperty('session-1')

    context.dispose()

    expect(context.snapshot()).toEqual({ pendingRequests: [], sessions: {} })
  })
})
