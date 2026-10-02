import type { ApprovalDecision, ConnectorApprovalScope } from '../../shared/settings'
import type {
  PermissionCapability,
  PermissionGrantContext,
  PermissionGrantScope
} from '../../shared/permission-grants'
import type { PermissionGrantRegistry } from './registry'
import { logPermissionDiagnostic, type PermissionDiagnostic } from './diagnostics'
import { randomUUID } from 'node:crypto'

type ConnectorPermissionPrompt = (
  info: {
    connector: string
    method: string
    args: Record<string, unknown>
    sessionId?: string
    availableScopes: ConnectorApprovalScope[]
    approvalTarget?: ConnectorApprovalTarget
  },
  signal?: AbortSignal
) => Promise<ApprovalDecision>

type ConnectorApprovalTarget = {
  connectorId: string
  connectorName: string
  displayName: string
  transport: 'stdio' | 'streamable_http' | 'sse'
  target: string
}

type ConnectorPolicyInput = {
  aliases: readonly string[]
  autoAllowIds?: readonly string[]
  blockedToolIds?: readonly string[]
  askToolIds?: readonly string[]
}

type ConnectorPermissionRequest = {
  capability: PermissionCapability
  context: PermissionGrantContext
  connector: string
  method: string
  args: Record<string, unknown>
  approvalTarget?: ConnectorApprovalTarget
  policy: ConnectorPolicyInput
}

type ConnectorPolicyDecision = 'allow' | 'require_approval'
type ConnectorAuthorizationOptions = { deferRemember?: boolean; signal?: AbortSignal }

class ConnectorPermissionBroker {
  constructor(
    private readonly registry: PermissionGrantRegistry | undefined,
    private readonly prompt: ConnectorPermissionPrompt | undefined
  ) {}

  private trace(
    request: ConnectorPermissionRequest,
    details: Omit<PermissionDiagnostic, 'sessionId' | 'capability'>
  ): void {
    logPermissionDiagnostic({
      sessionId: request.context.sessionId ?? 'unbound',
      capability: request.capability,
      ...details
    })
  }

  preflight(request: ConnectorPermissionRequest): ConnectorPolicyDecision {
    const policyId = (alias: string): string => `${alias}/${request.method}`
    if (
      request.policy.aliases.some((alias) =>
        request.policy.blockedToolIds?.includes(policyId(alias))
      )
    ) {
      this.trace(request, {
        stage: 'decision',
        authority: 'connector_policy',
        reason: 'connector_policy_blocked',
        outcome: 'rejected'
      })
      throw new Error(`tool blocked by policy: ${request.connector}/${request.method}`)
    }
    const skipApprovals = request.policy.aliases.some((alias) =>
      request.policy.autoAllowIds?.includes(alias)
    )
    const requiresApproval = request.policy.aliases.some((alias) =>
      request.policy.askToolIds?.includes(policyId(alias))
    )
    if (skipApprovals || !requiresApproval) {
      this.trace(request, {
        stage: 'decision',
        authority: 'connector_policy',
        reason: 'connector_policy_allow',
        outcome: 'allowed'
      })
      return 'allow'
    }
    return 'require_approval'
  }

  async authorize(
    request: ConnectorPermissionRequest,
    policyDecision: ConnectorPolicyDecision = this.preflight(request),
    options: ConnectorAuthorizationOptions = {}
  ): Promise<PermissionGrantScope | undefined> {
    options.signal?.throwIfAborted()
    if (policyDecision === 'allow') return undefined

    const requestId = randomUUID()
    const match = await this.registry?.resolve(request.capability, request.context)
    options.signal?.throwIfAborted()
    if (match) {
      this.trace(request, {
        stage: 'decision',
        requestId,
        authority: 'registry_grant',
        matchedScope: match.matchedScope,
        outcome: 'allowed'
      })
      return undefined
    }
    options.signal?.throwIfAborted()
    if (!this.prompt) {
      this.trace(request, {
        stage: 'decision',
        requestId,
        fallback: true,
        reason: 'approval_unavailable',
        outcome: 'rejected'
      })
      throw new Error(`approval unavailable: ${request.connector}/${request.method}`)
    }

    const availableScopes: ConnectorApprovalScope[] = ['once']
    if (this.registry) {
      if (request.context.projectId && request.context.sessionId) availableScopes.push('session')
      if (request.context.projectId) availableScopes.push('project')
      availableScopes.push('global')
    }

    const prompt = {
      connector: request.connector,
      method: request.method,
      args: request.args,
      ...(request.context.sessionId ? { sessionId: request.context.sessionId } : {}),
      availableScopes,
      ...(request.approvalTarget ? { approvalTarget: request.approvalTarget } : {})
    }
    this.trace(request, {
      stage: 'decision',
      requestId,
      authority: 'human',
      fallback: !this.registry,
      reason: this.registry ? 'grant_not_matched' : 'registry_unavailable',
      outcome: 'approval_required'
    })
    const decision = options.signal
      ? await this.prompt(prompt, options.signal)
      : await this.prompt(prompt)
    options.signal?.throwIfAborted()
    if (decision === 'deny' || !availableScopes.includes(decision)) {
      this.trace(request, {
        stage: 'settlement',
        requestId,
        authority: 'human',
        outcome: 'rejected'
      })
      throw new Error(`tool call denied by user: ${request.connector}/${request.method}`)
    }
    if (decision === 'once') {
      this.trace(request, {
        stage: 'settlement',
        requestId,
        authority: 'human',
        outcome: 'resolved'
      })
      return undefined
    }

    const scope: PermissionGrantScope =
      decision === 'global'
        ? { kind: 'global' }
        : decision === 'project'
          ? { kind: 'project', projectId: request.context.projectId! }
          : {
              kind: 'session',
              projectId: request.context.projectId!,
              sessionId: request.context.sessionId!
            }

    if (options.deferRemember) return scope

    options.signal?.throwIfAborted()
    await this.remember(request, scope)
    this.trace(request, {
      stage: 'settlement',
      requestId,
      authority: 'human',
      matchedScope: scope.kind,
      outcome: 'resolved'
    })
    return undefined
  }

  async remember(request: ConnectorPermissionRequest, scope: PermissionGrantScope): Promise<void> {
    // Remembered authority must be durable before the current call is released.
    try {
      await this.registry!.remember({ capability: request.capability, scope })
    } catch (error) {
      this.trace(request, {
        stage: 'decision',
        authority: 'human',
        reason: 'permission_settlement_failed',
        outcome: 'cancelled'
      })
      throw error
    }
  }
}

export { ConnectorPermissionBroker }
export type {
  ConnectorPermissionPrompt,
  ConnectorPermissionRequest,
  ConnectorPolicyDecision,
  ConnectorPolicyInput
}
