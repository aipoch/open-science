/** Canonical host form shared by settings, grants and the renderer. IPv6 is unbracketed in storage. */
export const normalizeNetworkHostname = (value: string): string | undefined => {
  const trimmed = value.trim().toLowerCase().replace(/\.$/, '')
  if (!trimmed || /[\s/\\@?#%]/.test(trimmed)) return undefined
  if (
    (trimmed.startsWith('[') && !trimmed.endsWith(']')) ||
    (!trimmed.startsWith('[') && trimmed.endsWith(']'))
  )
    return undefined
  try {
    const authority = trimmed.includes(':') && !trimmed.startsWith('[') ? `[${trimmed}]` : trimmed
    const hostname = new URL(`https://${authority}`).hostname.replace(/^\[|\]$/g, '')
    if (!hostname || hostname.length > 253) return undefined
    if (
      !hostname.includes(':') &&
      hostname
        .split('.')
        .some(
          (label) =>
            !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
        )
    )
      return undefined
    return hostname
  } catch {
    return undefined
  }
}

/** IPv6 is bracketed wherever a host is rendered as part of an authority or key. */
export const formatNetworkHostname = (hostname: string): string =>
  hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname

export const isNetworkIpLiteral = (hostname: string): boolean =>
  hostname.includes(':') || /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(hostname)

export const requiresNetworkException = (hostname: string, protocol?: 'http' | 'https'): boolean =>
  protocol === 'http' || isNetworkIpLiteral(hostname)

export type StrictNetworkRule = Readonly<{
  protocol: 'http' | 'https'
  hostnamePattern: string
  port: number
}>

export const normalizeStrictNetworkRule = (value: unknown): StrictNetworkRule | undefined => {
  if (!value || typeof value !== 'object') return undefined
  const rule = value as Record<string, unknown>
  if (typeof rule.hostnamePattern !== 'string' || typeof rule.protocol !== 'string')
    return undefined
  const protocol = rule.protocol.toLowerCase()
  const pattern = rule.hostnamePattern.trim()
  const wildcard = pattern.startsWith('*.')
  const hostname = normalizeNetworkHostname(wildcard ? pattern.slice(2) : pattern)
  if (
    !hostname ||
    (wildcard && (isNetworkIpLiteral(hostname) || !hostname.includes('.'))) ||
    (protocol !== 'http' && protocol !== 'https') ||
    !Number.isInteger(rule.port) ||
    (rule.port as number) < 1 ||
    (rule.port as number) > 65535
  )
    return undefined
  return {
    protocol,
    hostnamePattern: wildcard ? `*.${hostname}` : hostname,
    port: rule.port as number
  }
}

/** Matches the requested authority only. DNS results never participate in strict admission. */
export const strictNetworkRuleMatches = (
  rules: readonly StrictNetworkRule[],
  input: string,
  port: number,
  protocol: 'http' | 'https'
): boolean => {
  const host = normalizeNetworkHostname(input)
  if (!host) return false
  return rules.some((value) => {
    const rule = normalizeStrictNetworkRule(value)
    if (!rule || rule.protocol !== protocol || rule.port !== port) return false
    return rule.hostnamePattern.startsWith('*.')
      ? host.endsWith(rule.hostnamePattern.slice(1))
      : host === rule.hostnamePattern
  })
}
