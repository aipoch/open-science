import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse
} from '@agentclientprotocol/sdk'

import type { AgentFrameworkId } from '../../shared/settings'
import type { AcpElicitationOwner } from './elicitation-owner'
import type { AcpPermissionContext } from './permission-context'

type AcpClientInteractionOwnerOptions = {
  routing: {
    resolveAppSessionId: (providerSessionId: string) => string
    isActiveSession: (appSessionId: string) => boolean
    frameworkForSession: (appSessionId: string) => AgentFrameworkId | undefined
    reviewerFrameworkForSession: (providerSessionId: string) => AgentFrameworkId | undefined
    promptMessageIdForSession: (appSessionId: string) => string | undefined
  }
  elicitation: Pick<AcpElicitationOwner, 'request'>
  permission: Pick<
    AcpPermissionContext,
    'consumeTrustedCodexMcpToolCall' | 'handleProviderRequest' | 'hasTrustedCodexMcpToolCall'
  >
}

type ElicitationIntent =
  { kind: 'authorization'; toolCallId: string } | { kind: 'user-input' } | { kind: 'reject' }

const classifyElicitation = (
  frameworkId: AgentFrameworkId | undefined,
  params: CreateElicitationRequest
): ElicitationIntent => {
  const meta = params._meta
  const isCodexMcpApproval =
    typeof meta === 'object' && meta !== null && meta.codex_approval_kind === 'mcp_tool_call'
  if (!isCodexMcpApproval) return { kind: 'user-input' }
  if (frameworkId !== 'codex') return { kind: 'reject' }

  const toolCallId = 'toolCallId' in params ? params.toolCallId : undefined
  return typeof toolCallId === 'string' ? { kind: 'authorization', toolCallId } : { kind: 'reject' }
}

// Keeps provider transport quirks at one seam so authorization can never be projected as user input.
class AcpClientInteractionOwner {
  constructor(private readonly options: AcpClientInteractionOwnerOptions) {}

  createElicitation(params: CreateElicitationRequest): Promise<CreateElicitationResponse> {
    if (!('sessionId' in params) || typeof params.sessionId !== 'string') {
      return Promise.resolve({ action: 'cancel' })
    }

    const sessionId = this.options.routing.resolveAppSessionId(params.sessionId)
    const isActiveSession = this.options.routing.isActiveSession(sessionId)
    const reviewerFramework = this.options.routing.reviewerFrameworkForSession(params.sessionId)
    if (!isActiveSession && reviewerFramework === undefined) {
      return Promise.resolve({ action: 'cancel' })
    }

    const intent = classifyElicitation(
      reviewerFramework ?? this.options.routing.frameworkForSession(sessionId),
      params
    )
    if (intent.kind === 'reject') return Promise.resolve({ action: 'cancel' })
    if (intent.kind === 'authorization') {
      return this.requestCodexMcpAuthorization(params.sessionId, sessionId, intent.toolCallId)
    }
    if (reviewerFramework !== undefined) return Promise.resolve({ action: 'cancel' })

    const promptMessageId = this.options.routing.promptMessageIdForSession(sessionId)
    return this.options.elicitation.request(
      params,
      { sessionId },
      promptMessageId ? { promptMessageId } : undefined
    )
  }

  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    return this.options.permission.handleProviderRequest(params)
  }

  private async requestCodexMcpAuthorization(
    providerSessionId: string,
    appSessionId: string,
    toolCallId: string
  ): Promise<CreateElicitationResponse> {
    if (
      this.options.permission.consumeTrustedCodexMcpToolCall(
        appSessionId,
        toolCallId,
        'open-science-notebook/ask_user_question'
      )
    ) {
      return { action: 'accept' }
    }
    if (!this.options.permission.hasTrustedCodexMcpToolCall(appSessionId, toolCallId)) {
      return { action: 'cancel' }
    }

    const allowOnceOptionId = 'codex-elicitation-allow-once'
    const response = await this.options.permission.handleProviderRequest({
      sessionId: providerSessionId,
      toolCall: { toolCallId, kind: 'execute', status: 'pending' },
      options: [
        { optionId: allowOnceOptionId, name: 'Allow once', kind: 'allow_once' },
        {
          optionId: 'codex-elicitation-reject-once',
          name: 'Deny',
          kind: 'reject_once'
        }
      ],
      _meta: { is_mcp_tool_approval: true }
    })
    if (response.outcome.outcome === 'cancelled') return { action: 'cancel' }
    return response.outcome.optionId === allowOnceOptionId
      ? { action: 'accept' }
      : { action: 'decline' }
  }
}

export { AcpClientInteractionOwner }
