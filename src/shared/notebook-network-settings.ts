export const OPEN_SCIENCE_DOMAIN_GROUP_IDS = [
  'packageRegistries',
  'nih',
  'genomics',
  'proteomics',
  'literature',
  'clinical'
] as const

export type OpenScienceDomainGroupId = (typeof OPEN_SCIENCE_DOMAIN_GROUP_IDS)[number]

export type OpenScienceDomainGroup = Readonly<{
  id: OpenScienceDomainGroupId
  domains: readonly string[]
  locked?: boolean
}>

export type TrustedPrivateDestination = Readonly<{
  hostname: string
  port: number
  protocol?: 'http' | 'https'
  approvedAddresses: readonly string[]
  /** Present only for rules derived by the trusted backend from a global grant. */
  managedGrantId?: string
  source?: 'global-destination-grant'
}>

export type PrivateDestinationRequest = Readonly<{
  hostname: string
  port: number
  protocol?: 'http' | 'https'
}>
export type PrivateDestinationReview =
  | Readonly<{ ok: true; destination: TrustedPrivateDestination }>
  | Readonly<{ ok: false; reason: 'invalid' | 'ineligible' | 'dns' }>

export type NotebookNetworkSettings = Readonly<{
  destinationGrants?: readonly import('./network-destination-grants').NetworkDestinationGrant[]
  trustedPrivateDestinations?: readonly TrustedPrivateDestination[]
  allowedDomains: readonly string[]
  disabledOpenScienceDomainGroups: readonly OpenScienceDomainGroupId[]
  disabledOpenScienceDomains: readonly string[]
}>

export type NotebookNetworkPolicy = Readonly<{
  trustedPrivateDestinations?: readonly TrustedPrivateDestination[]
  allowedDomains: readonly string[]
  askDomains: readonly string[]
  deniedDomains: readonly string[]
  deniedDomainReasons: Readonly<Record<string, string>>
}>

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
    return hostname && hostname.length <= 253 ? hostname : undefined
  } catch {
    return undefined
  }
}

/** IPv6 is bracketed wherever a host is rendered as part of an authority or key. */
export const formatNetworkHostname = (hostname: string): string =>
  hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname
