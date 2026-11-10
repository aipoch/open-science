export type NotebookNetworkMode = 'relaxed' | 'strict'
export type NotebookWhitelistGroup = Readonly<{ id: string; name: string }>
export type NotebookStrictWhitelistEntry =
  import('@aipoch/notebook-network-sandbox/network-address').StrictNetworkRule &
    Readonly<{
      id: string
      groupId?: string
      origin: 'builtin' | 'manual'
    }>

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
  id?: string
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
  mode?: NotebookNetworkMode
  strictWhitelistVersion?: 1
  strictWhitelist?: readonly NotebookStrictWhitelistEntry[]
  strictWhitelistGroups?: readonly NotebookWhitelistGroup[]
  destinationGrants?: readonly import('./network-destination-grants').NetworkDestinationGrant[]
  trustedPrivateDestinations?: readonly TrustedPrivateDestination[]
  allowedDomains: readonly string[]
  disabledOpenScienceDomainGroups: readonly OpenScienceDomainGroupId[]
  disabledOpenScienceDomains: readonly string[]
}>

export type NotebookNetworkPolicy = Readonly<{
  mode?: NotebookNetworkMode
  strictWhitelist?: readonly NotebookStrictWhitelistEntry[]
  trustedPrivateDestinations?: readonly TrustedPrivateDestination[]
  allowedDomains: readonly string[]
  askDomains: readonly string[]
  deniedDomains: readonly string[]
  deniedDomainReasons: Readonly<Record<string, string>>
}>

export {
  normalizeNetworkHostname,
  formatNetworkHostname,
  isNetworkIpLiteral,
  requiresNetworkException
} from '@aipoch/notebook-network-sandbox/network-address'

export const trustedDestinationId = (rule: TrustedPrivateDestination): string =>
  rule.id ??
  rule.managedGrantId ??
  `manual:${rule.protocol ?? 'https'}://${rule.hostname}:${rule.port}`
