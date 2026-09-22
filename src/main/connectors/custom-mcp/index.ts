// Public boundary for custom MCP transport, authentication and configuration admission.
export { McpClientManager, McpToolCallError } from './client-manager'
export type { CustomMcpServerConfig, McpClientManagerTool } from './client-manager'
export {
  classifyCustomMcpFailure,
  toCustomMcpConfig,
  isCustomMcpServerRouteSafe,
  hasUsableCustomMcpCredentials,
  selectEnabledCustomServers
} from './bootstrap'
export type { CustomMcpFailureAvailability } from './bootstrap'
export { isSecureCustomMcpUrl, assertSecureCustomMcpUrl } from './url'
export { hasAmbiguousCustomMcpCredentialNames } from './windows-credential-names'
