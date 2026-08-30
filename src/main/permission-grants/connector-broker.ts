import type { ApprovalDecision, ConnectorApprovalScope } from '../../shared/settings'
import type {
  PermissionCapability,
  PermissionGrantContext,
  PermissionGrantScope
} from '../../shared/permission-grants'
import type { PermissionGrantRegistry } from './registry'

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

  preflight(request: ConnectorPermissionRequest): ConnectorPolicyDecision {
    const policyId = (alias: string): string => `${alias}/${request.method}`
    if (
      request.policy.aliases.some((alias) =>
        request.policy.blockedToolIds?.includes(policyId(alias))
      )
    ) {
      throw new Error(`tool blocked by policy: ${request.connector}/${request.method}`)
    }
    const skipApprovals = request.policy.aliases.some((alias) =>
      request.policy.autoAllowIds?.includes(alias)
    )
    const requiresApproval = request.policy.aliases.some((alias) =>
      request.policy.askToolIds?.includes(policyId(alias))
    )
    return skipApprovals || !requiresApproval ? 'allow' : 'require_approval'
  }

  async authorize(
    request: ConnectorPermissionRequest,
    policyDecision: ConnectorPolicyDecision = this.preflight(request),
    options: ConnectorAuthorizationOptions = {}
  ): Promise<PermissionGrantScope | undefined> {
    options.signal?.throwIfAborted()
    if (policyDecision === 'allow') return undefined

    if (await this.registry?.resolve(request.capability, request.context)) return undefined
    options.signal?.throwIfAborted()
    if (!this.prompt) {
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
    const decision = options.signal
      ? await this.prompt(prompt, options.signal)
      : await this.prompt(prompt)
    options.signal?.throwIfAborted()
    if (decision === 'deny' || !availableScopes.includes(decision)) {
      throw new Error(`tool call denied by user: ${request.connector}/${request.method}`)
    }
    if (decision === 'once') return undefined

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
    return undefined
  }

  async remember(request: ConnectorPermissionRequest, scope: PermissionGrantScope): Promise<void> {
    // Remembered authority must be durable before the current call is released.
    await this.registry!.remember({ capability: request.capability, scope })
  }
}

export { ConnectorPermissionBroker }
export type {
  ConnectorPermissionPrompt,
  ConnectorPermissionRequest,
  ConnectorPolicyDecision,
  ConnectorPolicyInput
}
