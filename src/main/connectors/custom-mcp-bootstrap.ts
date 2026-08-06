import type { CustomMcpServerConfig } from './mcp-client-manager'
import type { StoredConnectors, StoredCustomMcpServer } from '../settings/types'
import { customConnectorAliasKey, customConnectorAliases } from '../../shared/custom-connector'
import { ALL_CONNECTOR_IDS } from './registry'

// Pure mapping/filtering helpers used to wire custom MCP servers into app bootstrap (ipc.ts).
// Split out from ipc.ts so they can be unit-tested without pulling in ipc.ts's Electron-touching
// transitive imports (acp/ipc, artifacts/ipc, settings/crypto, ...).
// See docs/internal/2026-07-12-custom-mcp-connectors-plan4.md §3.2/§3.4.

// Maps a stored custom MCP server to the config McpClientManager needs, for any supported
// transport. A stdio server with a missing command becomes an empty string so a misconfigured
// entry fails the connect attempt (caught by the caller) rather than throwing here.
export function toCustomMcpConfig(server: StoredCustomMcpServer): CustomMcpServerConfig {
  return {
    id: server.id,
    name: server.name,
    transport: server.transport,
    command: server.command ?? '',
    args: server.args,
    env: server.env,
    url: server.url,
    headers: server.headers,
    ...(server.oauth
      ? {
          oauth: {
            ...server.oauth,
            ...(server.oauthState ? { state: server.oauthState } : {})
          }
        }
      : {})
  }
}

// Supported custom MCP server transports: stdio plus the remote HTTP variants.
const SUPPORTED_CUSTOM_MCP_TRANSPORTS = new Set<StoredCustomMcpServer['transport']>([
  'stdio',
  'streamable_http',
  'sse'
])

// Legacy records derive their public route from the display name. A derived route that is already
// owned by a bundled Connector or another custom record must remain visible in Settings but cannot
// be exposed or dispatched.
export const isCustomMcpServerRouteSafe = (
  server: StoredCustomMcpServer,
  allServers: readonly StoredCustomMcpServer[]
): boolean => {
  const aliases = new Set(customConnectorAliases(server).map(customConnectorAliasKey))
  if (ALL_CONNECTOR_IDS.some((id) => aliases.has(customConnectorAliasKey(id)))) return false

  return allServers.every(
    (candidate) =>
      candidate === server ||
      customConnectorAliases(candidate).every(
        (alias) => !aliases.has(customConnectorAliasKey(alias))
      )
  )
}

// Selects runnable custom servers for discovery and skill-doc sync. OAuth Connectors remain absent
// until sign-in has produced an access token, even if an older settings record says enabled.
export function selectEnabledCustomServers(
  connectors: StoredConnectors | undefined
): StoredCustomMcpServer[] {
  const servers = connectors?.customMcpServers ?? []
  return servers.filter(
    (server) =>
      server.enabled &&
      isCustomMcpServerRouteSafe(server, servers) &&
      SUPPORTED_CUSTOM_MCP_TRANSPORTS.has(server.transport) &&
      (!server.oauth || Boolean(server.oauthState?.tokens?.access_token))
  )
}
