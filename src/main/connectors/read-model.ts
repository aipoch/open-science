import { CONNECTOR_CATALOG, type ConnectorMeta } from '@aipoch/connector-builtins/catalog'
import {
  hasUsableCustomMcpCredentials,
  isCustomMcpServerRouteSafe,
  type CustomMcpFailureAvailability
} from './custom-mcp-config'
import { getConnectorTools } from './registry'
import type { StoredConnectors } from '../settings/types'
export type { CustomMcpFailureAvailability } from './custom-mcp-config'
export type ConnectorReadModel = {
  id: string
  name: string
  displayName: string
  description: string
  mainEnabled: boolean
  // Authentication/availability state, projected without secret detail. Custom connectors report
  // 'unavailable'/'unauthenticated'/'credential_unavailable' from their stored shape; bundled
  // connectors are 'available'.
  availability: 'available' | 'unavailable' | 'unauthenticated' | 'credential_unavailable'
  source: 'bundled' | 'custom'
  tools: { id: string; description: string }[]
}

export const projectConnectorsFromStored = (
  stored: StoredConnectors | undefined,
  customServerAvailability: (id: string) => CustomMcpFailureAvailability | undefined = () =>
    undefined
): ConnectorReadModel[] => {
  const disabled = new Set(stored?.disabledConnectorIds ?? [])
  const bundled: ConnectorReadModel[] = (CONNECTOR_CATALOG as ConnectorMeta[]).map((meta) => ({
    id: meta.id,
    name: meta.id,
    displayName: meta.displayName,
    description: meta.description,
    mainEnabled: !disabled.has(meta.id),
    availability: 'available',
    source: 'bundled',
    tools: getConnectorTools(meta.id).map((tool) => ({
      id: tool.id,
      description: tool.description
    }))
  }))

  const customServers = stored?.customMcpServers ?? []
  const custom: ConnectorReadModel[] = customServers
    .filter((server) => isCustomMcpServerRouteSafe(server, customServers))
    .map((server) => {
      const runtimeAvailability = customServerAvailability(server.id)
      const unreachable =
        (server.transport === 'stdio' && !server.command) ||
        (server.transport !== 'stdio' && !server.url)
      const credentialUnavailable = !hasUsableCustomMcpCredentials(server)
      const unauthenticated = Boolean(server.oauth && !server.oauthState?.tokens?.access_token)
      return {
        // Local Specialist references use the UUID; name remains the immutable public route.
        id: server.id,
        name: server.name,
        displayName: server.displayName,
        description: server.description ?? '',
        mainEnabled: server.enabled && !credentialUnavailable && !unauthenticated,
        // Custom MCP servers expose their tools dynamically; we do not enumerate them here (the
        // milestone decides whole-Connector inclusion only). An empty tools list keeps the shape
        // consistent without leaking transport/command details.
        availability: unreachable
          ? 'unavailable'
          : credentialUnavailable
            ? 'credential_unavailable'
            : unauthenticated
              ? 'unauthenticated'
              : (runtimeAvailability ?? 'available'),
        source: 'custom',
        tools: []
      }
    })

  return [...bundled, ...custom]
}
