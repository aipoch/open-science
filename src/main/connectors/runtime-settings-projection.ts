import {
  classifyCustomMcpFailure,
  toCustomMcpConfig,
  selectEnabledCustomServers,
  type CustomMcpFailureAvailability
} from './custom-mcp-bootstrap'
import { syncConnectorSkillDocs, syncCustomServerSkillDocs } from './provision'
import { ALL_CONNECTOR_IDS } from './registry'
import { customConnectorSkillName } from '../../shared/custom-connector'
import type { McpClientManager } from './mcp-client-manager'
import { createLogger, errorLogFields } from '../logger'
import type { StoredConnectors, StoredCustomMcpServer } from '../settings/types'

const log = createLogger('connectors:runtime-settings')

type ConnectorRuntimeSettingsProjectionOptions = {
  readConnectors: () => Promise<StoredConnectors | undefined>
  skillsDir: string
  mcpClientManager: Pick<McpClientManager, 'listTools'>
  syncBundledSkillDocs?: typeof syncConnectorSkillDocs
  syncCustomSkillDocs?: typeof syncCustomServerSkillDocs
  reportError?: (error: unknown) => void
  notifyStatusChanged?: () => void
}

// Owns the live, derived Connector snapshot consumed by dispatch and the corresponding generated
// Skill documents. Durable policy remains in SettingsRepository; refresh failures stay isolated from
// bootstrap and Settings mutations exactly as before.
class ConnectorRuntimeSettingsProjection {
  private snapshot: StoredConnectors | undefined
  private materializedCustomSkills: string[] = []
  private discoveryAvailabilities = new Map<string, CustomMcpFailureAvailability>()
  private dispatchAvailabilities = new Map<string, CustomMcpFailureAvailability>()
  private pendingRefreshes = 0
  private pendingCustomServerRefreshes = new Map<string, number>()
  private refreshErrors = new Map<string, unknown>()
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
        log.error('failed to sync connector skill docs', errorLogFields(error))
      })
  }

  current(): StoredConnectors | undefined {
    return this.snapshot
  }

  materializedCustomSkillNames(): string[] {
    return [...this.materializedCustomSkills]
  }

  customServerAvailability(id: string): CustomMcpFailureAvailability | undefined {
    return this.dispatchAvailabilities.get(id) ?? this.discoveryAvailabilities.get(id)
  }

  isRefreshing(serverId?: string): boolean {
    if (this.pendingRefreshes > 0) return true
    return serverId
      ? (this.pendingCustomServerRefreshes.get(serverId) ?? 0) > 0
      : this.pendingCustomServerRefreshes.size > 0
  }

  isDegraded(): boolean {
    return this.refreshErrors.size > 0
  }

  setCustomServerDispatchAvailability(
    id: string,
    availability: CustomMcpFailureAvailability | undefined
  ): void {
    const current = this.dispatchAvailabilities.get(id)
    if (current === availability) return
    if (availability) this.dispatchAvailabilities.set(id, availability)
    else this.dispatchAvailabilities.delete(id)
    this.options.notifyStatusChanged?.()
  }

  async refresh(): Promise<void> {
    return this.enqueueRefresh()
  }

  async refreshCustomServer(serverId: string): Promise<void> {
    return this.enqueueRefresh(serverId)
  }

  private enqueueRefresh(serverId?: string): Promise<void> {
    if (serverId) {
      const pending = this.pendingCustomServerRefreshes.get(serverId) ?? 0
      this.pendingCustomServerRefreshes.set(serverId, pending + 1)
      if (pending === 0 && this.pendingRefreshes === 0) this.options.notifyStatusChanged?.()
    } else if (this.pendingRefreshes++ === 0) {
      this.options.notifyStatusChanged?.()
    }

    const queued = this.refreshQueue
      .then(() => this.refreshOnce(serverId))
      .finally(() => {
        if (serverId) {
          const remaining = (this.pendingCustomServerRefreshes.get(serverId) ?? 1) - 1
          if (remaining > 0) this.pendingCustomServerRefreshes.set(serverId, remaining)
          else {
            this.pendingCustomServerRefreshes.delete(serverId)
            if (this.pendingRefreshes === 0) this.options.notifyStatusChanged?.()
          }
        } else if (--this.pendingRefreshes === 0) {
          this.options.notifyStatusChanged?.()
        }
      })
    this.refreshQueue = queued.catch(() => undefined)
    return queued
  }

  private async refreshOnce(serverId?: string): Promise<void> {
    try {
      const connectors = await this.options.readConnectors()
      this.snapshot = connectors

      if (serverId) {
        await this.refreshCustomServerOnce(connectors, serverId)
        this.clearRefreshError(serverId)
        return
      }

      const disabled = new Set(connectors?.disabledConnectorIds ?? [])
      const enabledIds = ALL_CONNECTOR_IDS.filter((id) => !disabled.has(id))

      await this.syncBundledSkillDocs(this.options.skillsDir, enabledIds)
      const customServers = selectEnabledCustomServers(connectors)
      const customSync = await this.syncCustomSkillDocs(
        this.options.skillsDir,
        customServers,
        (server) => this.options.mcpClientManager.listTools(toCustomMcpConfig(server))
      )
      this.materializedCustomSkills = customSync.materializedNames.map(customConnectorSkillName)
      this.discoveryAvailabilities = new Map(
        customSync.failures.map(({ server, error }) => [server.id, classifyCustomMcpFailure(error)])
      )
      this.reportCustomSyncFailures(customSync.failures)
      this.clearRefreshError()
    } catch (error) {
      this.reportError(error)
      this.recordRefreshError(serverId, error)
      throw error
    }
  }

  private recordRefreshError(serverId: string | undefined, error: unknown): void {
    const key = serverId ?? '*'
    const wasDegraded = this.isDegraded()
    this.refreshErrors.set(key, error)
    if (serverId) this.discoveryAvailabilities.set(serverId, classifyCustomMcpFailure(error))
    if (!wasDegraded || serverId) this.options.notifyStatusChanged?.()
  }

  private clearRefreshError(serverId?: string): void {
    const wasDegraded = this.isDegraded()
    if (serverId) this.refreshErrors.delete(serverId)
    else this.refreshErrors.clear()
    if (wasDegraded !== this.isDegraded()) this.options.notifyStatusChanged?.()
  }

  private async refreshCustomServerOnce(
    connectors: StoredConnectors | undefined,
    serverId: string
  ): Promise<void> {
    const server = connectors?.customMcpServers?.find((candidate) => candidate.id === serverId)
    if (!server) return

    const name = server.name
    const enabledServer = selectEnabledCustomServers(connectors).find(
      (candidate) => candidate.id === serverId
    )
    const customSync = await this.syncCustomSkillDocs(
      this.options.skillsDir,
      enabledServer ? [enabledServer] : [],
      (candidate) => this.options.mcpClientManager.listTools(toCustomMcpConfig(candidate)),
      [name]
    )
    const skillName = customConnectorSkillName(name)
    const materialized = new Set(this.materializedCustomSkills)
    if (customSync.materializedNames.includes(name)) materialized.add(skillName)
    else materialized.delete(skillName)
    this.materializedCustomSkills = [...materialized]

    this.discoveryAvailabilities.delete(serverId)
    const failure = customSync.failures.find(({ server: failed }) => failed.id === serverId)
    if (failure) {
      this.discoveryAvailabilities.set(serverId, classifyCustomMcpFailure(failure.error))
    }
    this.reportCustomSyncFailures(customSync.failures)
  }

  private reportCustomSyncFailures(
    failures: Array<{ server: StoredCustomMcpServer; error: unknown }>
  ): void {
    for (const { server, error } of failures) {
      this.reportError(
        new Error(`Failed to sync custom MCP server "${server.name}" skill docs`, {
          cause: error
        })
      )
    }
  }
}

export { ConnectorRuntimeSettingsProjection }
export type { ConnectorRuntimeSettingsProjectionOptions }
