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
  approvedAddresses: readonly string[]
}>

export type PrivateDestinationRequest = Readonly<{ hostname: string; port: number }>
export type PrivateDestinationReview =
  | Readonly<{ ok: true; destination: TrustedPrivateDestination }>
  | Readonly<{ ok: false; reason: 'invalid' | 'ineligible' | 'dns' }>

export type NotebookNetworkSettings = Readonly<{
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
