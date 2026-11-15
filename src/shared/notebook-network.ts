import { normalizeStrictWhitelist, normalizeWhitelistGroups } from './notebook-network-strict'
import { normalizeNetworkDestinationGrants } from './network-destination-grants'
import type { DownloadProgress } from '@aipoch/resilient-download'
import {
  OPEN_SCIENCE_DOMAIN_GROUP_IDS,
  OPEN_SCIENCE_DOMAIN_GROUPS,
  formatNetworkHostname,
  requiresNetworkException,
  normalizeNetworkHostname,
  type OpenScienceDomainGroupId,
  type TrustedPrivateDestination,
  type NotebookNetworkSettings,
  type NotebookNetworkPolicy
} from './notebook-network-settings'
export { formatNetworkHostname, normalizeNetworkHostname } from './notebook-network-settings'
export {
  OPEN_SCIENCE_DOMAIN_GROUP_IDS,
  OPEN_SCIENCE_DOMAIN_GROUPS
} from './notebook-network-settings'
export type {
  OpenScienceDomainGroupId,
  OpenScienceDomainGroup,
  TrustedPrivateDestination,
  PrivateDestinationRequest,
  PrivateDestinationReview,
  NotebookNetworkSettings,
  NotebookNetworkPolicy
} from './notebook-network-settings'
export type NotebookNetworkStatusReason =
  | 'linuxBubblewrapMissing'
  | 'macSeatbeltUnavailable'
  | 'runtimeFailure'
  | 'trustBundleInvalid'
  | 'windowsHostMissing'
  | 'windowsGatewayPortUnavailable'
  | 'windowsLoopbackMissing'
  | 'windowsNetworkFenceMissing'
  | 'windowsOwnershipMissing'
  | 'windowsProfileMissing'

export type NotebookRuntimeSetupPhase = 'checking' | 'downloading' | 'verifying'

export type NotebookNetworkStatus = Readonly<{
  windowsRuntimeSetup?: Readonly<{
    downloadBytes: number
    canCancel: boolean
    cancelled: boolean
    failure?: Readonly<{ component: 'node' | 'powershell'; phase: NotebookRuntimeSetupPhase }>
  }>
}> &
  (
    | Readonly<{
        kind: 'checking'
        runtimePreparation?: Readonly<{
          component: 'node' | 'powershell'
          phase: NotebookRuntimeSetupPhase
          download?: DownloadProgress
          received?: number
          total?: number
        }>
      }>
    | Readonly<{ kind: 'ready'; warnings: readonly NotebookNetworkStatusReason[] }>
    | Readonly<{
        kind: 'setupRequired'
        platform: 'linux' | 'win32'
        reasons: readonly NotebookNetworkStatusReason[]
      }>
    | Readonly<{ kind: 'unsupported'; platform: NodeJS.Platform }>
    | Readonly<{ kind: 'error'; reason: NotebookNetworkStatusReason }>
  )

export const DEFAULT_NOTEBOOK_NETWORK_SETTINGS: NotebookNetworkSettings = Object.freeze({
  mode: 'relaxed',
  allowedDomains: [],
  disabledOpenScienceDomainGroups: [],
  disabledOpenScienceDomains: []
})

const uniqueSorted = <Value extends string>(values: readonly Value[]): Value[] =>
  [...new Set(values)].sort()

const isOpenScienceDomainGroupId = (value: unknown): value is OpenScienceDomainGroupId =>
  typeof value === 'string' && (OPEN_SCIENCE_DOMAIN_GROUP_IDS as readonly string[]).includes(value)

const isIpv4Literal = (hostname: string): boolean => {
  const parts = hostname.split('.')
  return (
    parts.length === 4 &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255)
  )
}

const isReservedHostname = (hostname: string): boolean =>
  hostname === 'localhost' ||
  hostname.endsWith('.localhost') ||
  isIpv4Literal(hostname) ||
  hostname.includes(':')

export type DomainValidationResult =
  | Readonly<{ ok: true; hostname: string }>
  | Readonly<{ ok: false; reason: 'empty' | 'format' | 'reserved' }>

export const domainPatternMatches = (pattern: string, hostname: string): boolean => {
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(2)
    if (!suffix.includes('*')) return hostname !== suffix && hostname.endsWith(`.${suffix}`)
    const suffixExpression = suffix
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[^.]+')
    return new RegExp(`^(?:[^.]+\\.)+${suffixExpression}$`).test(hostname)
  }
  if (pattern.includes('*')) {
    const expression = pattern
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[^.]+')
    return new RegExp(`^${expression}$`).test(hostname)
  }
  return pattern === hostname
}

export const notebookNetworkSettingsAllowDomain = (
  settings: NotebookNetworkSettings,
  hostname: string
): boolean => {
  const normalized = hostname.toLowerCase().replace(/\.$/, '')
  const policy = buildLinkPreviewDomainPolicy(settings)
  return (
    policy.allowedDomains.includes(normalized) ||
    (!policy.askDomains.some((pattern) => domainPatternMatches(pattern, normalized)) &&
      policy.allowedDomains.some((pattern) => domainPatternMatches(pattern, normalized)))
  )
}

export const validateCustomAllowedDomain = (value: string): DomainValidationResult => {
  if (!value) return { ok: false, reason: 'empty' }
  if (value !== value.trim() || /[\s/:\\?#*@]/.test(value) || value.includes('*')) {
    return { ok: false, reason: 'format' }
  }

  let hostname: string
  try {
    hostname = new URL(`http://${value}`).hostname.toLowerCase().replace(/\.$/, '')
  } catch {
    return { ok: false, reason: 'format' }
  }

  if (
    !hostname ||
    hostname.length > 253 ||
    hostname
      .split('.')
      .some((label) => !label || label.length > 63 || !/^[a-z0-9-]+$/.test(label)) ||
    hostname.split('.').some((label) => label.startsWith('-') || label.endsWith('-'))
  ) {
    return { ok: false, reason: 'format' }
  }
  if (isReservedHostname(hostname)) return { ok: false, reason: 'reserved' }
  if (!hostname.includes('.')) return { ok: false, reason: 'format' }
  return { ok: true, hostname }
}

// Stored grants accept domain rules only. URL conversion belongs to explicit user input.
const validateCustomAllowedDomainRule = (value: string): DomainValidationResult => {
  const wildcard = value.startsWith('*.')
  const result = validateCustomAllowedDomain(wildcard ? value.slice(2) : value)
  return result.ok && wildcard ? { ok: true, hostname: `*.${result.hostname}` } : result
}

export const parseCustomAllowedDomainInput = (value: string): DomainValidationResult => {
  const input = value.trim()
  if (!input) return { ok: false, reason: 'empty' }
  // Reject characters that the URL parser would silently remove or treat as separators.
  if (/[\s\\]/.test(input)) return { ok: false, reason: 'format' }
  const source = /^[a-z][a-z\d+.-]*:\/\//i.test(input)
    ? input
    : input.startsWith('//')
      ? `https:${input}`
      : `https://${input}`
  try {
    const authorityStart = source.indexOf('://') + 3
    const authority = source.slice(authorityStart).split(/[/?#]/, 1)[0]
    const wildcard = authority.startsWith('*.')
    // Chromium percent-encodes '*' in hostnames whereas Node preserves it. Parse only
    // the exact domain so both runtimes retain the same explicit wildcard semantics.
    const url = new URL(
      wildcard ? source.slice(0, authorityStart) + source.slice(authorityStart + 2) : source
    )
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !authority ||
      authority.includes('@') ||
      url.username ||
      url.password
    ) {
      return { ok: false, reason: 'format' }
    }
    return validateCustomAllowedDomainRule(wildcard ? `*.${url.hostname}` : url.hostname)
  } catch {
    return { ok: false, reason: 'format' }
  }
}

const normalizeAllowedDomains = (value: unknown): string[] => {
  if (!Array.isArray(value)) return []
  return uniqueSorted(
    value.flatMap((entry) => {
      if (typeof entry !== 'string') return []
      const result = validateCustomAllowedDomainRule(entry)
      return result.ok ? [result.hostname] : []
    })
  )
}

export const normalizeNotebookNetworkSettings = (value: unknown): NotebookNetworkSettings => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return DEFAULT_NOTEBOOK_NETWORK_SETTINGS
  }
  const record = value as Record<string, unknown>
  const disabledGroups = Array.isArray(record.disabledOpenScienceDomainGroups)
    ? uniqueSorted(
        record.disabledOpenScienceDomainGroups.filter(
          (value): value is OpenScienceDomainGroupId =>
            isOpenScienceDomainGroupId(value) &&
            !OPEN_SCIENCE_DOMAIN_GROUPS.find((group) => group.id === value)?.locked
        )
      )
    : []
  const builtInDomains = new Set(
    OPEN_SCIENCE_DOMAIN_GROUPS.filter((group) => !group.locked).flatMap((group) => group.domains)
  )
  const disabledDomains = Array.isArray(record.disabledOpenScienceDomains)
    ? uniqueSorted(
        record.disabledOpenScienceDomains.filter(
          (domain): domain is string => typeof domain === 'string' && builtInDomains.has(domain)
        )
      )
    : []

  return {
    mode: record.mode === 'strict' ? 'strict' : 'relaxed',
    ...(record.strictWhitelistVersion === 1 ? { strictWhitelistVersion: 1 as const } : {}),
    ...(Array.isArray(record.strictWhitelist)
      ? { strictWhitelist: normalizeStrictWhitelist(record.strictWhitelist) }
      : {}),
    ...(Array.isArray(record.strictWhitelistGroups)
      ? { strictWhitelistGroups: normalizeWhitelistGroups(record.strictWhitelistGroups) }
      : {}),
    ...(Array.isArray(record.destinationGrants)
      ? {
          destinationGrants: normalizeNetworkDestinationGrants(record.destinationGrants).filter(
            (entry) => requiresNetworkException(entry.hostname, entry.protocol)
          )
        }
      : {}),
    ...(Array.isArray(record.trustedPrivateDestinations)
      ? {
          trustedPrivateDestinations: normalizeTrustedPrivateDestinations(
            record.trustedPrivateDestinations
          )
        }
      : {}),
    allowedDomains: normalizeAllowedDomains(record.allowedDomains),
    disabledOpenScienceDomainGroups: disabledGroups,
    disabledOpenScienceDomains: disabledDomains
  }
}

const buildLinkPreviewDomainPolicy = (settings: NotebookNetworkSettings): NotebookNetworkPolicy => {
  const disabledGroups = new Set(settings.disabledOpenScienceDomainGroups)
  const disabledDomains = new Set(settings.disabledOpenScienceDomains)
  const askDomains = uniqueSorted(
    OPEN_SCIENCE_DOMAIN_GROUPS.flatMap((group) =>
      group.locked
        ? []
        : group.domains.filter(
            (domain) => disabledGroups.has(group.id) || disabledDomains.has(domain)
          )
    )
  )
  const builtIn = OPEN_SCIENCE_DOMAIN_GROUPS.filter(
    (group) => group.locked || !disabledGroups.has(group.id)
  )
    .flatMap((group) => group.domains)
    .filter(
      (domain) =>
        OPEN_SCIENCE_DOMAIN_GROUPS.find((group) => group.domains.includes(domain))?.locked ||
        !askDomains.some((pattern) => domainPatternMatches(pattern, domain))
    )

  return {
    ...(settings.trustedPrivateDestinations?.length
      ? { trustedPrivateDestinations: settings.trustedPrivateDestinations }
      : {}),
    allowedDomains: uniqueSorted([...builtIn, ...settings.allowedDomains]),
    // Exact custom approvals override these automatic-access exclusions. Remove matching
    // built-in exact rules above so they cannot masquerade as explicit approvals.
    askDomains,
    deniedDomains: [],
    deniedDomainReasons: {}
  }
}
// Notebook HTTPS admission is independent from link-preview and icon consent.
export const buildNotebookNetworkPolicy = (
  settings: NotebookNetworkSettings
): NotebookNetworkPolicy => ({
  mode: settings.mode ?? 'relaxed',
  ...(settings.mode === 'strict' ? { strictWhitelist: settings.strictWhitelist ?? [] } : {}),
  ...(settings.mode !== 'strict' && settings.trustedPrivateDestinations?.length
    ? { trustedPrivateDestinations: settings.trustedPrivateDestinations }
    : {}),
  allowedDomains: [],
  askDomains: [],
  deniedDomains: [],
  deniedDomainReasons: {}
})

// Shape validation only. Trusted entries are explicit protocol/host exceptions;
// runtime access does not depend on a DNS address snapshot.
export const normalizeTrustedPrivateDestinations = (
  value: unknown
): TrustedPrivateDestination[] => {
  if (!Array.isArray(value)) return []
  const entries = new Map<string, TrustedPrivateDestination>()
  const ids = new Set<string>()
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const { id, hostname, port, protocol, approvedAddresses, managedGrantId, source } = item
    const hostValue = typeof hostname === 'string' ? normalizeNetworkHostname(hostname) : undefined
    const host = hostValue ? { ok: true as const, hostname: hostValue } : undefined
    const hasManagedId = typeof managedGrantId === 'string' && managedGrantId.length > 0
    const hasManagedSource = source === 'global-destination-grant'
    if (
      (id !== undefined && (typeof id !== 'string' || !id.trim())) ||
      !host?.ok ||
      (protocol !== undefined && protocol !== 'http' && protocol !== 'https') ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      !Array.isArray(approvedAddresses) ||
      !approvedAddresses.every((address) => typeof address === 'string' && address.length <= 45) ||
      hasManagedId !== hasManagedSource ||
      (managedGrantId !== undefined && !hasManagedId)
    )
      continue
    if (!requiresNetworkException(host.hostname, protocol)) continue
    const key = `${protocol ?? 'https'}://${formatNetworkHostname(host.hostname)}:${port}:${hasManagedId ? managedGrantId : 'manual'}`
    // Duplicate records must never combine into a wider grant.
    if (entries.has(key) || (id !== undefined && ids.has(id))) return []
    if (id !== undefined) ids.add(id)
    entries.set(key, {
      ...(id !== undefined ? { id } : {}),
      hostname: host.hostname,
      port,
      ...(protocol !== undefined ? { protocol } : {}),
      approvedAddresses: uniqueSorted(approvedAddresses),
      ...(hasManagedId ? { managedGrantId, source: 'global-destination-grant' as const } : {})
    })
  }
  return [...entries.values()].sort(
    (a, b) => a.hostname.localeCompare(b.hostname) || a.port - b.port
  )
}
