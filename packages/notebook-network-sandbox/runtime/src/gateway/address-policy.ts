import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { domainToASCII } from 'node:url'

type Rule = Readonly<{
  suffix: string
  subdomains: boolean
  all: boolean
  labels?: readonly string[]
  port?: number
}>

export type TrustedPrivateDestination = Readonly<{
  hostname: string
  port: number
  protocol?: 'http' | 'https'
  /** Kept for settings/grant compatibility; it is never used as an authorization condition. */
  approvedAddresses: readonly string[]
  managedGrantId?: string
  source?: 'global-destination-grant'
}>

type DestinationPolicyOptions = Readonly<{
  trustedPrivateDestinations?: readonly TrustedPrivateDestination[]
  allowedDomains: readonly string[]
  askDomains?: readonly string[]
  deniedDomains: readonly string[]
  deniedDomainReasons?: Readonly<Record<string, string>>
}>

type DestinationVerdict =
  | Readonly<{ kind: 'allow'; address: string; host?: string; addresses?: readonly string[] }>
  | Readonly<{
      kind: 'ask'
      source: 'explicit' | 'unknown'
      host: string
      address: string
      addresses?: readonly string[]
      reason?: string
    }>
  | Readonly<{ kind: 'deny'; reason: string; configurable: boolean }>

const parseRule = (text: string): Rule => {
  const separator = text.lastIndexOf(':')
  const hasPort = separator > 0 && /^\d+$/.test(text.slice(separator + 1))
  const hostPart = hasPort ? text.slice(0, separator) : text
  const wildcard = hostPart.startsWith('*.')
  const suffix = wildcard ? hostPart.slice(2) : hostPart
  return {
    suffix,
    subdomains: wildcard,
    all: hostPart === '*',
    ...(suffix.includes('*') ? { labels: suffix.split('.') } : {}),
    ...(hasPort ? { port: Number(text.slice(separator + 1)) } : {})
  }
}

const ruleAccepts = (rule: Rule, host: string, port: number): boolean => {
  if (rule.port !== undefined && rule.port !== port) return false
  if (rule.all) return true
  if (rule.labels) {
    let labels = host.split('.')
    if (rule.subdomains) {
      if (labels.length <= rule.labels.length) return false
      labels = labels.slice(-rule.labels.length)
    }
    return (
      (rule.subdomains || labels.length === rule.labels.length) &&
      rule.labels.every((label, index) => {
        if (label === '*') return true
        if (!label.includes('*')) return label === labels[index]
        const expression = label
          .split('*')
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('.+')
        return new RegExp(`^${expression}$`).test(labels[index]!)
      })
    )
  }
  return rule.subdomains ? host.endsWith(`.${rule.suffix}`) : host === rule.suffix
}

const normalizeRequestedHost = (input: string): string | undefined => {
  const unwrapped = input.startsWith('[') && input.endsWith(']') ? input.slice(1, -1) : input
  if (isIP(unwrapped) === 4) return unwrapped
  if (isIP(unwrapped) === 6)
    return new URL(`http://[${unwrapped}]/`).hostname.slice(1, -1).toLowerCase()
  const ascii = domainToASCII(unwrapped.trim().replace(/\.$/, '').toLowerCase())
  if (!ascii || ascii.length > 253) return undefined
  const labels = ascii.split('.')
  if (
    labels.some(
      (label) => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
    )
  )
    return undefined
  return ascii
}

const formatNetworkHostname = (hostname: string): string =>
  hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname

const canonicalAddress = (address: string): string => {
  const unscoped = address.split('%', 1)[0]!
  return isIP(unscoped) === 6 ? new URL(`http://[${unscoped}]/`).hostname.slice(1, -1) : unscoped
}

const validPrivateService = (value: { hostname: string; port: number }): boolean =>
  Boolean(
    value &&
    typeof value.hostname === 'string' &&
    normalizeRequestedHost(value.hostname) !== undefined &&
    Number.isInteger(value.port) &&
    value.port >= 1 &&
    value.port <= 65535
  )

const validPrivateDestination = (value: TrustedPrivateDestination): boolean =>
  validPrivateService(value) &&
  (value.protocol === undefined || value.protocol === 'http' || value.protocol === 'https') &&
  Array.isArray(value.approvedAddresses) &&
  value.approvedAddresses.every((address) => typeof address === 'string' && address.length <= 45)

const reviewPrivateDestination = async (request: {
  hostname: string
  port: number
  protocol?: 'http' | 'https'
}): Promise<
  | { ok: true; destination: TrustedPrivateDestination }
  | { ok: false; reason: 'invalid' | 'ineligible' | 'dns' }
> => {
  if (!request || typeof request.hostname !== 'string') return { ok: false, reason: 'invalid' }
  if (/[\s/\\@?#%]/.test(request.hostname.trim())) return { ok: false, reason: 'invalid' }
  const hostname = normalizeRequestedHost(request.hostname)
  if (!hostname || !validPrivateService({ hostname, port: request.port }))
    return { ok: false, reason: 'invalid' }
  return {
    ok: true,
    destination: {
      hostname,
      port: request.port,
      protocol: request.protocol ?? 'https',
      approvedAddresses: []
    }
  }
}

class DestinationPolicy {
  readonly #trusted: readonly TrustedPrivateDestination[]
  readonly #allowed: readonly Rule[]
  readonly #asked: readonly Rule[]
  readonly #denied: readonly Readonly<{ raw: string; rule: Rule }>[]
  readonly #reasons: Readonly<Record<string, string>>

  constructor(options: DestinationPolicyOptions) {
    this.#trusted = (options.trustedPrivateDestinations ?? [])
      .filter(validPrivateDestination)
      .map((entry) => ({
        ...entry,
        hostname: normalizeRequestedHost(entry.hostname)!,
        protocol: entry.protocol ?? 'https'
      }))
    this.#allowed = options.allowedDomains.map(parseRule)
    this.#asked = (options.askDomains ?? []).map(parseRule)
    this.#denied = options.deniedDomains.map((raw) => ({ raw, rule: parseRule(raw) }))
    this.#reasons = options.deniedDomainReasons ?? {}
  }

  async inspect(
    input: string,
    port: number,
    protocol: 'http' | 'https' = 'https'
  ): Promise<DestinationVerdict> {
    const host = normalizeRequestedHost(input)
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      return { kind: 'deny', reason: 'invalid port', configurable: false }
    if (!host) return { kind: 'deny', reason: 'malformed host', configurable: false }
    const blocked = this.#denied.find(({ rule }) => ruleAccepts(rule, host, port))
    if (blocked) {
      return {
        kind: 'deny',
        reason: this.#reasons[blocked.raw] ?? 'host is blocked by policy',
        configurable: false
      }
    }
    const trusted = this.#trusted.find(
      (entry) => entry.hostname === host && entry.port === port && entry.protocol === protocol
    )
    const addresses = isIP(host)
      ? [host]
      : await lookup(host, { all: true, verbatim: true }).then(
          (records) => records.map(({ address }) => address),
          () => []
        )
    if (!addresses.length)
      return { kind: 'deny', reason: 'host did not resolve', configurable: false }
    if (trusted) return { kind: 'allow', address: addresses[0]! }
    if (isIP(host))
      return {
        kind: 'deny',
        reason: 'literal IP destinations require a trusted private service rule',
        configurable: false
      }
    if (protocol !== 'https')
      return {
        kind: 'deny',
        reason: 'only HTTPS destinations are allowed by default',
        configurable: false
      }
    const address = addresses[0]!
    const needsApproval = this.#asked.some((rule) => ruleAccepts(rule, host, port))
    if (
      this.#allowed.some(
        (rule) =>
          ruleAccepts(rule, host, port) &&
          (!needsApproval || (!rule.subdomains && !rule.labels && !rule.all))
      )
    )
      return { kind: 'allow', address }
    return {
      kind: 'ask',
      source: needsApproval ? 'explicit' : 'unknown',
      host,
      address,
      addresses: [...new Set(addresses.map(canonicalAddress))].sort()
    }
  }
}

export {
  DestinationPolicy,
  formatNetworkHostname,
  normalizeRequestedHost,
  reviewPrivateDestination,
  validPrivateDestination
}
export type { DestinationPolicyOptions, DestinationVerdict }
