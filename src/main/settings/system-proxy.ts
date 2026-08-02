import { session } from 'electron'

// Resolve the same public origin the subscription contacts. Electron evaluates the user's native
// proxy settings (including PAC rules) for this URL; the resulting endpoint can then be handed to
// the native Codex process, which does not use Chromium's network stack itself.
const CODEX_PROXY_TARGET_URL = 'https://chatgpt.com/'

export const SYSTEM_PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NO_PROXY',
  'no_proxy'
] as const

export type SystemProxyEnvironment = Partial<Record<(typeof SYSTEM_PROXY_ENV_KEYS)[number], string>>

export type ResolveProxy = (url: string) => Promise<string>

export const clearSystemProxyEnvironment = (env: NodeJS.ProcessEnv): void => {
  for (const key of SYSTEM_PROXY_ENV_KEYS) delete env[key]
}

// App-owned local services are intentionally restricted to loopback. Keep those calls out of an
// inherited or resolved proxy while covering the common spellings understood by different HTTP
// stacks (host, IPv4 range/CIDR, and bracketed/unbracketed IPv6).
const LOOPBACK_PROXY_BYPASS = [
  'localhost',
  '.localhost',
  '127.0.0.1',
  '127.0.0.0/8',
  '::1',
  '[::1]'
] as const

export const loopbackProxyBypassEnvironment = (
  sourceEnv: NodeJS.ProcessEnv = process.env
): Pick<SystemProxyEnvironment, 'NO_PROXY' | 'no_proxy'> => {
  // Some clients prefer the lowercase alias once it exists. Give both aliases the same union so
  // adding a missing spelling cannot hide bypasses inherited through the other one.
  const inheritedBypass = [sourceEnv.NO_PROXY, sourceEnv.no_proxy]
    .flatMap((value) => value?.split(',') ?? [])
    .map((entry) => entry.trim())
    .filter(Boolean)
  const bypass = [...new Set([...inheritedBypass, ...LOOPBACK_PROXY_BYPASS])].join(',')

  return {
    NO_PROXY: bypass,
    no_proxy: bypass
  }
}

const proxyEnvironmentForDirective = (
  kind: string,
  address: string
): SystemProxyEnvironment | undefined => {
  const normalizedKind = kind.toUpperCase()
  const scheme =
    normalizedKind === 'HTTPS'
      ? 'https'
      : normalizedKind === 'SOCKS4'
        ? 'socks4'
        : normalizedKind === 'SOCKS' || normalizedKind === 'SOCKS5'
          ? 'socks5'
          : normalizedKind === 'PROXY' || normalizedKind === 'HTTP'
            ? 'http'
            : undefined
  if (!scheme) return undefined

  try {
    const url = new URL(`${scheme}://${address}`)
    if (
      !url.hostname ||
      url.username ||
      url.password ||
      (url.pathname !== '' && url.pathname !== '/') ||
      url.search ||
      url.hash
    ) {
      return undefined
    }

    // WHATWG URL reports the origin of non-special schemes such as socks5 as `null`; rebuild from
    // the already-validated normalized host so every supported directive produces a usable URL.
    const proxyUrl = `${scheme}://${url.host}`
    if (scheme === 'socks4' || scheme === 'socks5') {
      return { ALL_PROXY: proxyUrl, all_proxy: proxyUrl }
    }

    return {
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl
    }
  } catch {
    return undefined
  }
}

// Electron returns a semicolon-delimited fallback list such as
// `PROXY proxy.example:3128; DIRECT`. Preserve its order and use the first supported decision.
export const parseSystemProxyRules = (rules: string): SystemProxyEnvironment => {
  for (const rawDirective of rules.split(';')) {
    const directive = rawDirective.trim()
    if (!directive) continue

    const [kind, ...addressParts] = directive.split(/\s+/)
    if (kind.toUpperCase() === 'DIRECT') return {}

    const environment = proxyEnvironmentForDirective(kind, addressParts.join(' '))
    if (environment) return environment
  }

  return {}
}

export const resolveSystemProxyEnvironment = async (
  resolveProxy: ResolveProxy = (url) => session.defaultSession.resolveProxy(url),
  sourceEnv: NodeJS.ProcessEnv = process.env
): Promise<SystemProxyEnvironment | undefined> => {
  try {
    const proxyEnv = parseSystemProxyRules(await resolveProxy(CODEX_PROXY_TARGET_URL))
    if (Object.keys(proxyEnv).length === 0) return {}

    return { ...proxyEnv, ...loopbackProxyBypassEnvironment(sourceEnv) }
  } catch {
    // `undefined` is distinct from the empty environment produced by an explicit DIRECT decision.
    // Callers preserve the app's inherited proxy variables only for this resolver-failure fallback.
    return undefined
  }
}
