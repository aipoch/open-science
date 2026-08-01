import { toCustomMcpConfig, selectEnabledCustomServers } from './custom-mcp-bootstrap'
import { syncConnectorSkillDocs, syncCustomServerSkillDocs } from './provision'
import { ALL_CONNECTOR_IDS } from './registry'
import type { McpClientManager } from './mcp-client-manager'
import type { StoredConnectors } from '../settings/types'

type ConnectorRuntimeSettingsProjectionOptions = {
  readConnectors: () => Promise<StoredConnectors | undefined>
  skillsDir: string
  mcpClientManager: Pick<McpClientManager, 'listTools'>
  syncBundledSkillDocs?: typeof syncConnectorSkillDocs
  syncCustomSkillDocs?: typeof syncCustomServerSkillDocs
  reportError?: (error: unknown) => void
}

// Owns the live, derived Connector snapshot consumed by dispatch and the corresponding generated
// Skill documents. Durable policy remains in SettingsRepository; refresh failures stay isolated from
// bootstrap and Settings mutations exactly as before.
class ConnectorRuntimeSettingsProjection {
  private snapshot: StoredConnectors | undefined
  private refreshQueue: Promise<void> = Promise.resolve()
  private readonly syncBundledSkillDocs: typeof syncConnectorSkillDocs
  private readonly syncCustomSkillDocs: typeof syncCustomServerSkillDocs
  private readonly reportError: (error: unknown) => void

  constructor(private readonly options: ConnectorRuntimeSettingsProjectionOptions) {
    this.syncBundledSkillDocs = options.syncBundledSkillDocs ?? syncConnectorSkillDocs
    this.syncCustomSkillDocs = options.syncCustomSkillDocs ?? syncCustomServerSkillDocs
    this.reportError =
      options.reportError ??
      ((error) => {
        console.error('Failed to sync connector skill docs:', error)
      })
  }

  current(): StoredConnectors | undefined {
    return this.snapshot
  }

  async refresh(): Promise<void> {
    const queued = this.refreshQueue.then(() => this.refreshOnce())
    this.refreshQueue = queued
    return queued
  }

  private async refreshOnce(): Promise<void> {
    try {
      const connectors = await this.options.readConnectors()
      this.snapshot = connectors

      const disabled = new Set(connectors?.disabledConnectorIds ?? [])
      const enabledIds = ALL_CONNECTOR_IDS.filter((id) => !disabled.has(id))

      await this.syncBundledSkillDocs(this.options.skillsDir, enabledIds)
      await this.syncCustomSkillDocs(
        this.options.skillsDir,
        selectEnabledCustomServers(connectors),
        (server) => this.options.mcpClientManager.listTools(toCustomMcpConfig(server))
      )
    } catch (error) {
      this.reportError(error)
    }
  }
}

export { ConnectorRuntimeSettingsProjection }
export type { ConnectorRuntimeSettingsProjectionOptions }
