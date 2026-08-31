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

type DestinationPolicyOptions = Readonly<{
  allowedDomains: readonly string[]
  deniedDomains: readonly string[]
  deniedDomainReasons?: Readonly<Record<string, string>>
}>

type DestinationVerdict =
  | Readonly<{ kind: 'allow'; address: string }>
  | Readonly<{ kind: 'ask'; host: string; address: string }>
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
  if (isIP(unwrapped)) return unwrapped.toLowerCase()
  const ascii = domainToASCII(unwrapped.trim().replace(/\.$/, '').toLowerCase())
  if (!ascii || ascii.length > 253) return undefined
  const labels = ascii.split('.')
  if (
    labels.some(
      (label) => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
    )
  ) {
    return undefined
  }
  return ascii
}

const ipv4Number = (address: string): number => {
  const octets = address.split('.').map(Number)
  return (((octets[0]! * 256 + octets[1]!) * 256 + octets[2]!) * 256 + octets[3]!) >>> 0
}

const ipv4In = (address: number, base: string, bits: number): boolean => {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return (address & mask) === (ipv4Number(base) & mask)
}

const parseIpv6 = (address: string): bigint | undefined => {
  const withoutZone = address.split('%', 1)[0]!
  const halves = withoutZone.split('::')
  if (halves.length > 2) return undefined
  const read = (part: string): number[] | undefined => {
    if (!part) return []
    const words: number[] = []
    for (const token of part.split(':')) {
      if (token.includes('.')) {
        if (isIP(token) !== 4) return undefined
        const value = ipv4Number(token)
        words.push((value >>> 16) & 0xffff, value & 0xffff)
      } else {
        if (!/^[0-9a-f]{1,4}$/i.test(token)) return undefined
        words.push(Number.parseInt(token, 16))
      }
    }
    return words
  }
  const left = read(halves[0]!)
  const right = read(halves[1] ?? '')
  if (!left || !right) return undefined
  const missing = 8 - left.length - right.length
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return undefined
  const words = [...left, ...Array.from({ length: missing }, () => 0), ...right]
  return words.reduce((value, word) => (value << 16n) | BigInt(word), 0n)
}

const ipv6In = (address: bigint, base: bigint, bits: number): boolean => {
  const shift = BigInt(128 - bits)
  return address >> shift === base >> shift
}

const isInternetAddress = (address: string): boolean => {
  const family = isIP(address)
  if (family === 4) {
    const value = ipv4Number(address)
    const reserved: readonly [string, number][] = [
      ['0.0.0.0', 8],
      ['10.0.0.0', 8],
      ['100.64.0.0', 10],
      ['127.0.0.0', 8],
      ['169.254.0.0', 16],
      ['172.16.0.0', 12],
      ['192.0.0.0', 24],
      ['192.0.2.0', 24],
      ['192.168.0.0', 16],
      ['198.18.0.0', 15],
      ['198.51.100.0', 24],
      ['203.0.113.0', 24],
      ['224.0.0.0', 4],
      ['240.0.0.0', 4]
    ]
    return !reserved.some(([base, bits]) => ipv4In(value, base, bits))
  }
  if (family !== 6) return false
  const value = parseIpv6(address)
  if (value === undefined) return false
  const blocked: readonly [string, number][] = [
    ['::', 128],
    ['::1', 128],
    ['::ffff:0:0', 96],
    ['64:ff9b::', 96],
    ['64:ff9b:1::', 48],
    ['100::', 64],
    ['2001:db8::', 32],
    ['2001:10::', 28],
    ['fc00::', 7],
    ['fec0::', 10],
    ['fe80::', 10],
    ['ff00::', 8]
  ]
  return !blocked.some(([base, bits]) => {
    const parsed = parseIpv6(base)
    return parsed !== undefined && ipv6In(value, parsed, bits)
  })
}

class DestinationPolicy {
  readonly #allowed: readonly Rule[]
  readonly #denied: readonly Readonly<{ raw: string; rule: Rule }>[]
  readonly #reasons: Readonly<Record<string, string>>

  constructor(options: DestinationPolicyOptions) {
    this.#allowed = options.allowedDomains.map(parseRule)
    this.#denied = options.deniedDomains.map((raw) => ({ raw, rule: parseRule(raw) }))
    this.#reasons = options.deniedDomainReasons ?? {}
  }

  async inspect(input: string, port: number): Promise<DestinationVerdict> {
    const host = normalizeRequestedHost(input)
    if (!host) return { kind: 'deny', reason: 'malformed host', configurable: false }
    const blocked = this.#denied.find(({ rule }) => ruleAccepts(rule, host, port))
    if (blocked) {
      return {
        kind: 'deny',
        reason: this.#reasons[blocked.raw] ?? 'host is blocked by policy',
        configurable: false
      }
    }
    const addresses = isIP(host)
      ? [host]
      : await lookup(host, { all: true, verbatim: true }).then(
          (records) => records.map(({ address }) => address),
          () => []
        )
    if (addresses.length === 0) {
      return { kind: 'deny', reason: 'host did not resolve', configurable: false }
    }
    if (addresses.some((address) => !isInternetAddress(address))) {
      return {
        kind: 'deny',
        reason: 'destination resolves to a non-public network address',
        configurable: false
      }
    }
    const address = addresses[0]!
    if (this.#allowed.some((rule) => ruleAccepts(rule, host, port))) {
      return { kind: 'allow', address }
    }
    return { kind: 'ask', host, address }
  }
}

export { DestinationPolicy, isInternetAddress }
export type { DestinationPolicyOptions, DestinationVerdict }
