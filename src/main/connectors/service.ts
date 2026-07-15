import { ParserEngine } from './engine'
import { ALL_CONNECTOR_IDS, getDescriptor } from './registry'
import { toCustomMcpConfig } from './custom-mcp-bootstrap'
import type { CustomMcpServerConfig } from './mcp-client-manager'
import type { ConnectorCredentials, ToolDescriptor } from './types'
import type { StoredConnectors } from '../settings/types'
import type { ApprovalDecision } from '../../shared/settings'

type McpClientManagerLike = {
  call(
    config: CustomMcpServerConfig,
    method: string,
    args: Record<string, unknown>
  ): Promise<unknown>
}

type ConnectorServiceDeps = {
  engine?: ParserEngine
  mcpClientManager?: McpClientManagerLike
  getConnectors: () => StoredConnectors | undefined
  resolveApiKey: (ref?: string) => string | undefined
  // Human approval gate for a tool call that isn't pre-approved. Absent (e.g. in tests) means the
  // call runs without prompting. A connector call sends data to an external service, so a call that
  // is neither pre-allowed nor skip-approved must be confirmed before it runs.
  requestApproval?: (info: {
    connector: string
    method: string
    args: Record<string, unknown>
  }) => Promise<ApprovalDecision>
  // Handlers for bundled tools that run privileged local code (e.g. write an artifact, open a preview)
  // instead of the read-only HTTP ParserEngine. Keyed by `${connector}/${method}`; invoked after the
  // same enable/policy/approval gate as any other bundled call.
  localToolHandlers?: Record<string, (args: Record<string, unknown>) => Promise<unknown>>
}

// Agent-agnostic gate: enforces enabled state + per-tool policy, prompts for approval on un-trusted
// calls, injects credentials, and dispatches each call to either the bundled ParserEngine or a
// user-added custom MCP server's McpClientManager. See docs/internal/2026-07-12-custom-mcp-connectors-plan4.md §3.2.
export class ConnectorService {
  private readonly engine: ParserEngine
  constructor(private readonly deps: ConnectorServiceDeps) {
    this.engine = deps.engine ?? new ParserEngine()
  }

  isEnabled(connector: string): boolean {
    // Bundled connectors are enabled by default; only an explicit opt-out disables one.
    return !(this.deps.getConnectors()?.disabledConnectorIds ?? []).includes(connector)
  }

  async call(connector: string, method: string, args: Record<string, unknown>): Promise<unknown> {
    const descriptor = getDescriptor(connector, method)
    const isBundled = descriptor !== undefined || ALL_CONNECTOR_IDS.includes(connector)
    if (isBundled) return this.callBundled(connector, method, args, descriptor)

    const custom = (this.deps.getConnectors()?.customMcpServers ?? []).find(
      (s) => s.name === connector
    )
    if (!custom) throw new Error(`connector not enabled: ${connector}`)
    return this.callCustom(custom, method, args)
  }

  private async callBundled(
    connector: string,
    method: string,
    args: Record<string, unknown>,
    descriptor: ToolDescriptor | undefined
  ): Promise<unknown> {
    if (!this.isEnabled(connector)) throw new Error(`connector not enabled: ${connector}`)
    if (!descriptor) throw new Error(`unknown tool: ${connector}/${method}`)

    if (this.isBlocked(connector, method)) {
      throw new Error(`tool blocked by policy: ${connector}/${method}`)
    }
    await this.ensureApproved(connector, method, args)

    // Bundled tools that need privileged local behavior run here, after the same gate, instead of the
    // read-only HTTP engine.
    const localHandler = this.deps.localToolHandlers?.[`${connector}/${method}`]
    if (localHandler) return localHandler(args)

    return this.engine.call(descriptor, args, this.credentials())
  }

  private async callCustom(
    custom: NonNullable<StoredConnectors['customMcpServers']>[number],
    method: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    if (!custom.enabled) throw new Error(`connector not enabled: ${custom.name}`)
    if (this.isBlocked(custom.name, method)) {
      throw new Error(`tool blocked by policy: ${custom.name}/${method}`)
    }
    if (!this.deps.mcpClientManager) throw new Error('connector runtime not configured')
    await this.ensureApproved(custom.name, method, args)

    return this.deps.mcpClientManager.call(toCustomMcpConfig(custom), method, args)
  }

  private isBlocked(connector: string, method: string): boolean {
    const blocked = this.deps.getConnectors()?.blockedToolIds ?? []
    return blocked.includes(`${connector}/${method}`)
  }

  // Tools run without a prompt by default. A call is confirmed by a human only when the tool is
  // explicitly set to "Ask each time" AND the connector does not skip approvals.
  private async ensureApproved(
    connector: string,
    method: string,
    args: Record<string, unknown>
  ): Promise<void> {
    const c = this.deps.getConnectors()
    const requiresAsk = (c?.askToolIds ?? []).includes(`${connector}/${method}`)
    const skipApprovals = (c?.autoAllowIds ?? []).includes(connector)
    if (!requiresAsk || skipApprovals) return
    if (!this.deps.requestApproval) return // no approver wired (tests) — do not block

    const decision = await this.deps.requestApproval({ connector, method, args })
    if (decision !== 'allow') {
      throw new Error(`tool call denied by user: ${connector}/${method}`)
    }
  }

  private credentials(): ConnectorCredentials {
    const c = this.deps.getConnectors()
    return { ncbiEmail: c?.contactEmail, ncbiApiKey: this.deps.resolveApiKey(c?.ncbiApiKeyRef) }
  }
}
