import type { TFunction } from 'i18next'

export const localizeConnectorError = (message: string, t: TFunction): string => {
  switch (message) {
    case 'MCP server configuration must be an object.':
      return t('MCP server configuration must be an object.')
    case 'MCP server environment variables must be an object.':
      return t('MCP server environment variables must be an object.')
    case 'MCP server headers must be an object.':
      return t('MCP server headers must be an object.')
    case 'Unsupported MCP transport.':
      return t('Unsupported MCP transport.')
    case 'MCP server must define either command or url.':
      return t('MCP server must define either command or url.')
    case 'MCP server transport does not match its connection fields.':
      return t('MCP server transport does not match its connection fields.')
    case 'MCP server names must remain unique after normalization.':
      return t('MCP server names must remain unique after normalization.')
    case 'MCP server name was normalized for Open Science.':
      return t('MCP server name was normalized for Open Science.')
    case 'Credential values were excluded and must be entered locally.':
      return t('Credential values were excluded and must be entered locally.')
    case 'The MCP client configuration must contain at least one server.':
      return t('The MCP client configuration must contain at least one server.')
    case 'MCP Registry server.json manifests cannot be imported as installed MCP client configurations.':
      return t(
        'MCP Registry server.json manifests cannot be imported as installed MCP client configurations.'
      )
    case 'OAuth registration and OAuth tokens were excluded from the MCP client configuration.':
      return t(
        'OAuth registration and OAuth tokens were excluded from the MCP client configuration.'
      )
    case 'Authorization server URL is required for a pre-registered client.':
      return t('Authorization server URL is required for a pre-registered client.')
    case 'Client metadata URL cannot be combined with a pre-registered client.':
      return t('Client metadata URL cannot be combined with a pre-registered client.')
    case 'Client ID is required when a client secret is configured.':
      return t('Client ID is required when a client secret is configured.')
    case 'OAuth redirect URI must be a valid URL.':
      return t('OAuth redirect URI must be a valid URL.')
    case 'OAuth redirect URI must be an http://127.0.0.1 loopback URL.':
      return t('OAuth redirect URI must be an http://127.0.0.1 loopback URL.')
    case 'OAuth redirect URI requires a pre-registered client ID.':
      return t('OAuth redirect URI requires a pre-registered client ID.')
    case 'Secure credential storage is unavailable. Unlock the system keychain and retry.':
      return t('Secure credential storage is unavailable. Unlock the system keychain and retry.')
    default:
      return message
  }
}
