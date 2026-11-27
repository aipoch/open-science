import { isLoopbackProviderBaseUrl } from '@aipoch/providers/transport'
import type { TrustedPrivateDestination } from './notebook-network-settings'
import { normalizeNetworkHostname } from './notebook-network-settings'

export type ProviderNetworkAuthority = Readonly<{
  hostname: string
  port: number
  protocol: 'http' | 'https'
}>

export const providerNetworkAuthority = (value: string): ProviderNetworkAuthority | undefined => {
  try {
    const url = new URL(value)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) return undefined
    const hostname = normalizeNetworkHostname(url.hostname)
    if (url.port === '0' || !hostname || url.username || url.password || url.search || url.hash)
      return undefined
    return {
      hostname,
      port: url.port ? Number(url.port) : url.protocol === 'http:' ? 80 : 443,
      protocol: url.protocol.slice(0, -1) as 'http' | 'https'
    }
  } catch {
    return undefined
  }
}

export const providerNetworkDestination = (
  value: string
): TrustedPrivateDestination | undefined => {
  const authority = providerNetworkAuthority(value)
  if (!authority || authority.protocol !== 'http' || isLoopbackProviderBaseUrl(value))
    return undefined
  return { ...authority, sharedWithAgent: true, approvedAddresses: [] }
}

export const providerNetworkDestinationIsTrusted = (
  value: string,
  rules: readonly TrustedPrivateDestination[]
): boolean =>
  rules.some(
    (rule) =>
      rule.sharedWithAgent === true &&
      !rule.managedGrantId &&
      rule.protocol === 'http' &&
      providerNetworkDestinationMatches(value, rule)
  )

export const providerNetworkDestinationMatches = (
  value: string | URL,
  rule: Pick<TrustedPrivateDestination, 'hostname' | 'port' | 'protocol'>
): boolean => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.username || url.password) return false
  const authority = providerNetworkAuthority(url.origin)
  return Boolean(
    authority &&
    authority.protocol === (rule.protocol ?? 'https') &&
    authority.hostname === normalizeNetworkHostname(rule.hostname) &&
    authority.port === rule.port
  )
}
