export type NetworkProxyMode = 'system' | 'manual' | 'direct'

export type NetworkProxySettings = Readonly<{
  mode: NetworkProxyMode
  server?: string
  bypassRules?: string
}>

export const DEFAULT_NETWORK_PROXY_SETTINGS: NetworkProxySettings = Object.freeze({
  mode: 'system'
})

const SUPPORTED_PROXY_PROTOCOLS = new Set(['http:', 'https:', 'socks:', 'socks4:', 'socks5:'])

const normalizeBypassRules = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const entries = value
    .split(/[,;\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
  return entries.length > 0 ? [...new Set(entries)].join(',') : undefined
}

const normalizeProxyServer = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || !value.trim()) return undefined

  try {
    const url = new URL(value.trim())
    if (
      !SUPPORTED_PROXY_PROTOCOLS.has(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password ||
      (url.pathname !== '' && url.pathname !== '/') ||
      url.search ||
      url.hash
    ) {
      return undefined
    }

    return `${url.protocol}//${url.host}`
  } catch {
    return undefined
  }
}

export const networkProxyValidationMessage = (value: unknown): string | undefined => {
  if (!value || typeof value !== 'object') return 'Choose a proxy mode.'
  const candidate = value as Record<string, unknown>
  if (candidate.mode !== 'system' && candidate.mode !== 'manual' && candidate.mode !== 'direct') {
    return 'Choose System, Manual, or Direct.'
  }
  if (candidate.mode !== 'manual') return undefined
  if (typeof candidate.server !== 'string' || !candidate.server.trim()) {
    return 'Enter a proxy server URL, for example http://127.0.0.1:1086.'
  }

  try {
    const url = new URL(candidate.server.trim())
    if (!SUPPORTED_PROXY_PROTOCOLS.has(url.protocol)) {
      return 'Use an http, https, socks, socks4, or socks5 proxy URL.'
    }
    if (!url.hostname) return 'Enter a proxy URL with a host name or IP address.'
    if (url.username || url.password) {
      return 'Proxy URLs with embedded usernames or passwords are not supported.'
    }
    if ((url.pathname !== '' && url.pathname !== '/') || url.search || url.hash) {
      return 'Enter only the proxy scheme, host, and optional port.'
    }
  } catch {
    return 'Enter a complete proxy URL, for example http://127.0.0.1:1086.'
  }

  return undefined
}

export const normalizeNetworkProxySettings = (value: unknown): NetworkProxySettings | undefined => {
  if (networkProxyValidationMessage(value)) return undefined
  const candidate = value as Record<string, unknown>
  if (candidate.mode === 'system') return DEFAULT_NETWORK_PROXY_SETTINGS
  if (candidate.mode === 'direct') return Object.freeze({ mode: 'direct' })

  const server = normalizeProxyServer(candidate.server)
  if (!server) return undefined
  const bypassRules = normalizeBypassRules(candidate.bypassRules)
  return Object.freeze({
    mode: 'manual',
    server,
    ...(bypassRules ? { bypassRules } : {})
  })
}

export const resolveNetworkProxySettings = (value: unknown): NetworkProxySettings =>
  normalizeNetworkProxySettings(value) ?? DEFAULT_NETWORK_PROXY_SETTINGS
