import { isIP } from 'node:net'

const isLoopbackHost = (hostname: string): boolean => {
  const unbracketed =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname

  if (unbracketed.toLowerCase() === 'localhost' || unbracketed === '::1') return true
  return isIP(unbracketed) === 4 && unbracketed.split('.')[0] === '127'
}

export const isSecureCustomMcpUrl = (value: string): boolean => {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHost(url.hostname))
  } catch {
    return false
  }
}

export const assertSecureCustomMcpUrl = (value: string): void => {
  if (!isSecureCustomMcpUrl(value)) {
    throw new Error('Remote MCP server URL must use HTTPS or loopback HTTP.')
  }
}
