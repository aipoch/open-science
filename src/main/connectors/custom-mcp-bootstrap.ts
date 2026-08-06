import type { CustomMcpServerConfig } from './mcp-client-manager'
import type { StoredConnectors, StoredCustomMcpServer } from '../settings/types'

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

// Selects runnable custom servers for discovery and skill-doc sync. OAuth Connectors remain absent
// until sign-in has produced an access token, even if an older settings record says enabled.
export function selectEnabledCustomServers(
  connectors: StoredConnectors | undefined
): StoredCustomMcpServer[] {
  return (
    connectors?.customMcpServers?.filter(
      (s) =>
        s.enabled &&
        SUPPORTED_CUSTOM_MCP_TRANSPORTS.has(s.transport) &&
        (!s.oauth || Boolean(s.oauthState?.tokens?.access_token))
    ) ?? []
  )
}
