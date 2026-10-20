import { isSecureRemoteUrl } from '@aipoch/connector-core/url-admission'
export const isSecureCustomMcpUrl = isSecureRemoteUrl
export const assertSecureCustomMcpUrl = (value: string): void => {
  if (!isSecureRemoteUrl(value))
    throw new Error('Remote MCP server URL must use HTTPS or loopback HTTP.')
}
