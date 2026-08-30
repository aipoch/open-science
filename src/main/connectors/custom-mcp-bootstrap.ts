import type { CustomMcpServerConfig } from './mcp-client-manager'
import type { StoredConnectors, StoredCustomMcpServer } from '../settings/types'
import { hasEmbeddedConnectorCredentials } from '../settings/connector-template'
import { ALL_CONNECTOR_IDS } from './registry'
import { validateResourceId } from '../../shared/resource-id'
import { customServerSecurityFingerprint } from '../settings/custom-server-identity'
import { isSecureCustomMcpUrl } from './custom-mcp-url'
import { hasAmbiguousCustomMcpCredentialNames } from './custom-mcp-windows-credential-names'

export type CustomMcpFailureAvailability = 'unavailable' | 'unauthenticated'

export const classifyCustomMcpFailure = (error: unknown): CustomMcpFailureAvailability =>
  error instanceof Error &&
  /(?:401|403|unauthoriz|authenticat|forbidden|invalid_token|(?:log(?:ged)?|sign(?:ed)?)[\s_-]?in)/i.test(
    error.message
  )
    ? 'unauthenticated'
    : 'unavailable'

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
    configurationFingerprint: customServerSecurityFingerprint(server),
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
            ...(server.oauth.clientId && server.oauthClientSecret
              ? { clientSecret: server.oauthClientSecret }
              : {}),
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

// A name already owned by a bundled Connector or another custom record remains visible in Settings
// but cannot be exposed or dispatched.
export const isCustomMcpServerRouteSafe = (
  server: StoredCustomMcpServer,
  allServers: readonly StoredCustomMcpServer[]
): boolean => {
  if (
    validateResourceId(server.id) ||
    ALL_CONNECTOR_IDS.includes(server.id) ||
    ALL_CONNECTOR_IDS.includes(server.name) ||
    hasAmbiguousCustomMcpCredentialNames(server) ||
    (server.transport !== 'stdio' && (!server.url || !isSecureCustomMcpUrl(server.url)))
  ) {
    return false
  }

  return allServers.every(
    (candidate) =>
      candidate === server ||
      (candidate.id !== server.id &&
        candidate.name !== server.name &&
        candidate.id !== server.name &&
        candidate.name !== server.id)
  )
}

const hasResolvedSecretRecord = (
  refs: Record<string, string> | undefined,
  values: Record<string, string> | undefined
): boolean => !refs || Object.keys(refs).every((name) => Object.hasOwn(values ?? {}, name))

const hasCompleteCustomMcpCredentials = (server: StoredCustomMcpServer): boolean =>
  server.transport === 'stdio'
    ? hasResolvedSecretRecord(server.envRefs, server.env)
    : hasResolvedSecretRecord(server.headerRefs, server.headers) &&
      (!server.oauthClientSecretRef || server.oauthClientSecret !== undefined)

export const hasUsableCustomMcpCredentials = (server: StoredCustomMcpServer): boolean =>
  hasCompleteCustomMcpCredentials(server) && !hasEmbeddedConnectorCredentials(server)

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
      hasUsableCustomMcpCredentials(server) &&
      SUPPORTED_CUSTOM_MCP_TRANSPORTS.has(server.transport) &&
      (!server.oauth || Boolean(server.oauthState?.tokens?.access_token))
  )
}
