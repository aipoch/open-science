import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse
} from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'

import type { AgentFrameworkId } from '../../shared/settings'
import { AcpClientInteractionOwner } from './client-interaction-owner'

const elicitationRequest = (): CreateElicitationRequest => ({
  mode: 'form',
  sessionId: 'provider-session',
  toolCallId: 'ask-1',
  message: 'Choose an approach',
  requestedSchema: {
    type: 'object',
    properties: {
      question_0: { type: 'string', enum: ['minimal', 'expanded'] }
    }
  }
})

const permissionRequest = (): RequestPermissionRequest => ({
  sessionId: 'provider-session',
  toolCall: {
    toolCallId: 'tool-1',
    title: 'Run command',
    kind: 'execute',
    status: 'pending'
  },
  options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }]
})

const codexApprovalRequest = (): CreateElicitationRequest => ({
  ...elicitationRequest(),
  toolCallId: 'mcp-tool-1',
  message: 'Allow this MCP tool?',
  _meta: { codex_approval_kind: 'mcp_tool_call' }
})

const createOwner = (
  options: {
    frameworkId?: AgentFrameworkId
    activeSession?: boolean
    reviewerFrameworkId?: AgentFrameworkId
    hasTrustedCodexMcpToolCall?: boolean
    consumeTrustedCodexMcpToolCall?: boolean
  } = {}
): {
  owner: AcpClientInteractionOwner
  requestElicitation: ReturnType<typeof vi.fn>
  requestPermission: ReturnType<typeof vi.fn>
  consumeTrustedCodexMcpToolCall: ReturnType<typeof vi.fn>
  hasTrustedCodexMcpToolCall: ReturnType<typeof vi.fn>
} => {
  const requestElicitation = vi
    .fn<(request: CreateElicitationRequest) => Promise<CreateElicitationResponse>>()
    .mockResolvedValue({ action: 'accept', content: { question_0: 'minimal' } })
  const requestPermission = vi
    .fn<(request: RequestPermissionRequest) => Promise<RequestPermissionResponse>>()
    .mockImplementation(async (request) => ({
      outcome: { outcome: 'selected', optionId: request.options[0].optionId }
    }))
  const consumeTrustedCodexMcpToolCall = vi.fn(
    () => options.consumeTrustedCodexMcpToolCall ?? false
  )
  const hasTrustedCodexMcpToolCall = vi.fn(() => options.hasTrustedCodexMcpToolCall ?? false)
  const owner = new AcpClientInteractionOwner({
    routing: {
      resolveAppSessionId: () => 'app-session',
      isActiveSession: () => options.activeSession ?? true,
      frameworkForSession: () => options.frameworkId ?? 'claude-code',
      reviewerFrameworkForSession: () => options.reviewerFrameworkId,
      promptMessageIdForSession: () => 'prompt-1'
    },
    elicitation: { request: requestElicitation },
    permission: {
      handleProviderRequest: requestPermission,
      consumeTrustedCodexMcpToolCall,
      hasTrustedCodexMcpToolCall
    }
  })

  return {
    owner,
    requestElicitation,
    requestPermission,
    consumeTrustedCodexMcpToolCall,
    hasTrustedCodexMcpToolCall
  }
}

describe('ACP client interaction owner', () => {
  it.each<AgentFrameworkId>(['claude-code', 'opencode', 'codex'])(
    'routes an ordinary %s elicitation to structured user input',
    async (frameworkId) => {
      const { owner, requestElicitation, requestPermission } = createOwner({ frameworkId })
      const request = elicitationRequest()

      await expect(owner.createElicitation(request)).resolves.toEqual({
        action: 'accept',
        content: { question_0: 'minimal' }
      })

      expect(requestElicitation).toHaveBeenCalledWith(
        request,
        { sessionId: 'app-session' },
        { promptMessageId: 'prompt-1' }
      )
      expect(requestPermission).not.toHaveBeenCalled()
    }
  )

  it('silently accepts the trusted Codex user-choice tool approval', async () => {
    const { owner, requestElicitation, requestPermission } = createOwner({
      frameworkId: 'codex',
      consumeTrustedCodexMcpToolCall: true
    })
    const request = codexApprovalRequest()

    await expect(owner.createElicitation(request)).resolves.toEqual({ action: 'accept' })

    expect(requestElicitation).not.toHaveBeenCalled()
    expect(requestPermission).not.toHaveBeenCalled()
  })

  it('routes a provider permission request to authorization', async () => {
    const { owner, requestElicitation, requestPermission } = createOwner()
    const request = permissionRequest()

    await expect(owner.requestPermission(request)).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' }
    })

    expect(requestPermission).toHaveBeenCalledWith(request)
    expect(requestElicitation).not.toHaveBeenCalled()
  })

  it('routes a trusted Codex MCP approval elicitation to authorization', async () => {
    const { owner, requestElicitation, requestPermission } = createOwner({
      frameworkId: 'codex',
      hasTrustedCodexMcpToolCall: true
    })

    await expect(owner.createElicitation(codexApprovalRequest())).resolves.toEqual({
      action: 'accept'
    })

    expect(requestPermission).toHaveBeenCalledWith({
      sessionId: 'provider-session',
      toolCall: { toolCallId: 'mcp-tool-1', kind: 'execute', status: 'pending' },
      options: [
        {
          optionId: 'codex-elicitation-allow-once',
          name: 'Allow once',
          kind: 'allow_once'
        },
        {
          optionId: 'codex-elicitation-reject-once',
          name: 'Deny',
          kind: 'reject_once'
        }
      ],
      _meta: { is_mcp_tool_approval: true }
    })
    expect(requestElicitation).not.toHaveBeenCalled()
  })

  it('routes a trusted Codex reviewer MCP approval elicitation to authorization', async () => {
    const { owner, requestElicitation, requestPermission } = createOwner({
      activeSession: false,
      reviewerFrameworkId: 'codex',
      hasTrustedCodexMcpToolCall: true
    })

    await expect(owner.createElicitation(codexApprovalRequest())).resolves.toEqual({
      action: 'accept'
    })

    expect(requestPermission).toHaveBeenCalledOnce()
    expect(requestElicitation).not.toHaveBeenCalled()
  })

  it('fails closed for ordinary reviewer elicitation', async () => {
    const { owner, requestElicitation, requestPermission } = createOwner({
      activeSession: false,
      reviewerFrameworkId: 'codex'
    })

    await expect(owner.createElicitation(elicitationRequest())).resolves.toEqual({
      action: 'cancel'
    })

    expect(requestPermission).not.toHaveBeenCalled()
    expect(requestElicitation).not.toHaveBeenCalled()
  })

  it.each([
    ['an untrusted Codex approval', 'codex' as const, false],
    ['Codex approval metadata from another framework', 'claude-code' as const, true]
  ])('fails closed for %s', async (_case, frameworkId, hasTrustedCodexMcpToolCall) => {
    const { owner, requestElicitation, requestPermission } = createOwner({
      frameworkId,
      hasTrustedCodexMcpToolCall
    })

    await expect(owner.createElicitation(codexApprovalRequest())).resolves.toEqual({
      action: 'cancel'
    })

    expect(requestElicitation).not.toHaveBeenCalled()
    expect(requestPermission).not.toHaveBeenCalled()
  })
})
