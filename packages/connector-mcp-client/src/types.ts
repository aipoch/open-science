import type {
  OAuthClientInformationMixed,
  OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js'

export type McpOAuthConfig = {
  clientMetadataUrl?: string
  authorizationServerUrl?: string
  scopes?: string[]
  clientId?: string
  redirectUri?: string
}
export type McpOAuthState = {
  tokens?: OAuthTokens
  clientInformation?: OAuthClientInformationMixed
  discoveryState?: OAuthDiscoveryState
}
