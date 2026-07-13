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
    headers: server.headers
  }
}

// Supported custom MCP server transports (Phase 2: stdio + remote streamable_http/sse). OAuth is
// a later task, so an `oauth`-configured remote entry (once that field exists) would still land
// here once it has a reachable url — auth is handled by the transport, not this selector.
const SUPPORTED_CUSTOM_MCP_TRANSPORTS = new Set<StoredCustomMcpServer['transport']>([
  'stdio',
  'streamable_http',
  'sse'
])

// Selects enabled custom servers across all supported transports, for dispatch and skill-doc sync.
export function selectEnabledCustomServers(
  connectors: StoredConnectors | undefined
): StoredCustomMcpServer[] {
  return (
    connectors?.customMcpServers?.filter(
      (s) => s.enabled && SUPPORTED_CUSTOM_MCP_TRANSPORTS.has(s.transport)
    ) ?? []
  )
}
