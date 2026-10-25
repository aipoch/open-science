import { describe, expect, it, vi } from 'vitest'
import { DestinationPolicy } from '../../packages/notebook-network-sandbox/runtime/src/gateway/address-policy'
import { createRuntimeConfig } from '../../packages/notebook-network-sandbox/src/config'

import {
  DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
  OPEN_SCIENCE_DOMAIN_GROUP_IDS,
  buildNotebookNetworkPolicy,
  normalizeNotebookNetworkSettings,
  notebookNetworkSettingsAllowDomain,
  parseCustomAllowedDomainInput,
  validateCustomAllowedDomain
} from './notebook-network'

import { OPEN_SCIENCE_DOMAIN_GROUP_IDS as settingDomainGroups } from './notebook-network-settings'

it('preserves the public domain group identity across the settings boundary', () => {
  expect(OPEN_SCIENCE_DOMAIN_GROUP_IDS).toBe(settingDomainGroups)
})

const lookup = vi.hoisted(() => vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]))
vi.mock('node:dns/promises', () => ({ lookup }))

describe('disabled automatic domain access', () => {
  it.each([
    ['rest.uniprot.org', 'rest.uniprot.org', 'www.uniprot.org'],
    ['*.ncbi.nlm.nih.gov', 'eutils.ncbi.nlm.nih.gov', 'www.nih.gov'],
    ['*.uniprot.org', 'rest.uniprot.org', 'www.rcsb.org']
  ])('asks for %s despite overlapping built-in rules', async (disabled, host, sibling) => {
    const settings = normalizeNotebookNetworkSettings({ disabledOpenScienceDomains: [disabled] })
    const inspect = (value: typeof settings): DestinationPolicy =>
      new DestinationPolicy(
        createRuntimeConfig({
          policy: buildNotebookNetworkPolicy(value),
          resources: { root: '/resources' }
        })
      )

    expect
      .soft(await inspect(settings).inspect(host, 443))
      .toMatchObject({ kind: 'ask', source: 'explicit', host })
    expect.soft(notebookNetworkSettingsAllowDomain(settings, host)).toBe(false)
    expect(await inspect(settings).inspect(sibling, 443)).toMatchObject({ kind: 'allow' })

    // A later explicit approval remains effective; turning off auto-allow is not a permanent ban.
    const approved = { ...settings, allowedDomains: [host] }
    expect(await inspect(approved).inspect(host, 443)).toMatchObject({ kind: 'allow' })
    expect(notebookNetworkSettingsAllowDomain(approved, host)).toBe(true)
  })
})

describe('notebook network policy', () => {
  it('passes the application default policy to the sandbox including label wildcards', () => {
    expect(() =>
      createRuntimeConfig({
        policy: buildNotebookNetworkPolicy(DEFAULT_NOTEBOOK_NETWORK_SETTINGS),
        resources: { root: '/resources' }
      })
    ).not.toThrow()
  })

  it('enables every Open-Science domain group by default', () => {
    const policy = buildNotebookNetworkPolicy(DEFAULT_NOTEBOOK_NETWORK_SETTINGS)

    expect(policy.allowedDomains).toContain('pypi.org')
    expect(policy.allowedDomains).toContain('rest.uniprot.org')
    expect(policy.allowedDomains).toContain('clinicaltrials.gov')
  })

  it('removes disabled groups and individual built-in domains', () => {
    const policy = buildNotebookNetworkPolicy({
      allowedDomains: ['research.example'],
      disabledOpenScienceDomainGroups: ['literature'],
      disabledOpenScienceDomains: ['rest.uniprot.org']
    })

    expect(policy.allowedDomains).toContain('research.example')
    expect(policy.allowedDomains).not.toContain('api.crossref.org')
    expect(policy.allowedDomains).not.toContain('rest.uniprot.org')
  })

  it('keeps the required package-registry group enabled', () => {
    const settings = normalizeNotebookNetworkSettings({
      disabledOpenScienceDomainGroups: ['packageRegistries'],
      disabledOpenScienceDomains: ['pypi.org']
    })

    expect(settings.disabledOpenScienceDomainGroups).toEqual([])
    expect(settings.disabledOpenScienceDomains).toEqual([])
    expect(buildNotebookNetworkPolicy(settings).allowedDomains).toContain('pypi.org')
  })

  it('allows only catalogued package-mirror redirect hosts', () => {
    const policy = buildNotebookNetworkPolicy(DEFAULT_NOTEBOOK_NETWORK_SETTINGS)

    expect(policy.allowedDomains).toContain('mirrors.nju.edu.cn')
    expect(policy.allowedDomains).not.toContain('redirect.example')
  })

  it('rejects URLs, wildcards, local targets, IP literals, and single-label domains', () => {
    expect(validateCustomAllowedDomain('https://example.com')).toEqual({
      ok: false,
      reason: 'format'
    })
    expect(validateCustomAllowedDomain('*.example.com')).toEqual({ ok: false, reason: 'format' })
    expect(validateCustomAllowedDomain('localhost')).toEqual({ ok: false, reason: 'reserved' })
    expect(validateCustomAllowedDomain('127.0.0.1')).toEqual({ ok: false, reason: 'reserved' })
    expect(validateCustomAllowedDomain('intranet')).toEqual({ ok: false, reason: 'format' })
    expect(validateCustomAllowedDomain('hooks.slack.com')).toEqual({
      ok: true,
      hostname: 'hooks.slack.com'
    })
  })

  it('normalizes safe international and case-variant hostnames', () => {
    expect(validateCustomAllowedDomain('DATA.Example.COM')).toEqual({
      ok: true,
      hostname: 'data.example.com'
    })
    expect(validateCustomAllowedDomain('例子.测试')).toEqual({
      ok: true,
      hostname: 'xn--fsqu00a.xn--0zwm56d'
    })
  })

  it('sanitizes persisted settings and preserves only known built-in switches', () => {
    expect(
      normalizeNotebookNetworkSettings({
        allowedDomains: ['DATA.Example.COM', 'localhost', 'data.example.com'],
        disabledOpenScienceDomainGroups: ['literature', 'unknown'],
        disabledOpenScienceDomains: ['rest.uniprot.org', 'unknown.example']
      })
    ).toEqual({
      allowedDomains: ['data.example.com'],
      disabledOpenScienceDomainGroups: ['literature'],
      disabledOpenScienceDomains: ['rest.uniprot.org']
    })
  })

  it('does not give unknown public reads persistent target or preview permission', async () => {
    const settings = DEFAULT_NOTEBOOK_NETWORK_SETTINGS
    const policy = buildNotebookNetworkPolicy(settings)
    const destination = new DestinationPolicy(policy)

    expect(await destination.inspect('unknown.research.example', 443)).toMatchObject({
      kind: 'ask',
      source: 'unknown'
    })
    expect(notebookNetworkSettingsAllowDomain(settings, 'unknown.research.example')).toBe(false)
    expect(buildNotebookNetworkPolicy(settings)).toEqual(policy)
  })

  it('leaves public domains to request inspection and target approval', () => {
    const policy = buildNotebookNetworkPolicy(DEFAULT_NOTEBOOK_NETWORK_SETTINGS)

    expect(policy.deniedDomains).toEqual([])
    expect(policy.deniedDomainReasons).toEqual({})
  })
})

describe('custom public domain input', () => {
  it.each([
    ['*.example.com', '*.example.com'],
    ['  *.EXAMPLE.com.  ', '*.example.com'],
    ['https://www.example.com:8443/path?q=1#part', 'www.example.com'],
    ['http://data.example.com/path', 'data.example.com'],
    ['data.example.com:8443/path?q=1#part', 'data.example.com'],
    ['//data.example.com/path', 'data.example.com'],
    ['https://*.example.com/path?q=1', '*.example.com'],
    ['https://例子.测试/path', 'xn--fsqu00a.xn--0zwm56d'],
    ['*.例子.测试', '*.xn--fsqu00a.xn--0zwm56d']
  ])('extracts the domain rule from %s', (input, hostname) => {
    expect(parseCustomAllowedDomainInput(input)).toEqual({ ok: true, hostname })
  })

  it.each([
    '',
    ' ',
    '*',
    '*.*.example.com',
    'api.*.example.com',
    '*example.com',
    '*.com',
    '*.localhost',
    '*.127.0.0.1',
    'https://127.1/path',
    'https://[::1]/',
    'ftp://example.com/path',
    'https:///example.com',
    'https://0x7f000001/path',
    'https://user:password@example.com/path',
    'https://@example.com',
    'https://example.com:99999/path',
    'https://example.com\\other.example',
    'https://exa\nmple.com',
    'https://-bad.example'
  ])('rejects invalid or non-public-domain input %j', (input) => {
    expect(parseCustomAllowedDomainInput(input).ok).toBe(false)
  })

  it('persists wildcard rules without reinterpreting historical URLs as grants', () => {
    const settings = normalizeNotebookNetworkSettings({
      allowedDomains: [
        '*.EXAMPLE.com',
        '*.example.com',
        'data.example.com',
        'https://other.example/path',
        'api.*.example.com',
        '*.localhost'
      ]
    })
    expect(settings.allowedDomains).toEqual(['*.example.com', 'data.example.com'])
    expect(normalizeNotebookNetworkSettings(JSON.parse(JSON.stringify(settings)))).toEqual(settings)
  })

  it('parses only exact hosts even when the browser URL parser encodes wildcard stars', () => {
    const NativeURL = URL
    class BrowserURL extends NativeURL {
      get hostname(): string {
        return super.hostname.replaceAll('*', '%2A')
      }
    }
    vi.stubGlobal('URL', BrowserURL)
    try {
      expect(parseCustomAllowedDomainInput('https://*.example.com/path')).toEqual({
        ok: true,
        hostname: '*.example.com'
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('matches descendant subdomains consistently in the UI and sandbox', async () => {
    const settings = normalizeNotebookNetworkSettings({ allowedDomains: ['*.example.com'] })
    const policy = new DestinationPolicy(
      createRuntimeConfig({
        policy: buildNotebookNetworkPolicy(settings),
        resources: { root: '/resources' }
      })
    )
    for (const host of ['data.example.com', 'deep.data.example.com']) {
      expect(notebookNetworkSettingsAllowDomain(settings, host)).toBe(true)
      expect(await policy.inspect(host, 443)).toMatchObject({ kind: 'allow' })
    }
    for (const host of ['example.com', 'otherexample.com', 'example.com.other.example']) {
      expect(notebookNetworkSettingsAllowDomain(settings, host)).toBe(false)
      expect(await policy.inspect(host, 443)).toMatchObject({ kind: 'ask' })
    }
  })

  it('preserves explicit ask rules under a custom wildcard', async () => {
    const settings = normalizeNotebookNetworkSettings({
      allowedDomains: ['*.uniprot.org'],
      disabledOpenScienceDomains: ['rest.uniprot.org']
    })
    expect(notebookNetworkSettingsAllowDomain(settings, 'rest.uniprot.org')).toBe(false)
    expect(
      await new DestinationPolicy(buildNotebookNetworkPolicy(settings)).inspect(
        'rest.uniprot.org',
        443
      )
    ).toMatchObject({ kind: 'ask', source: 'explicit' })
  })

  it('keeps private service grants exact-only', () => {
    expect(
      normalizeNotebookNetworkSettings({
        trustedPrivateDestinations: [
          {
            hostname: '*.example.com',
            port: 443,
            approvedAddresses: ['10.32.0.7']
          }
        ]
      }).trustedPrivateDestinations
    ).toEqual([])
  })

  it('never permits a private DNS destination through a custom wildcard', async () => {
    lookup.mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }])
    const settings = normalizeNotebookNetworkSettings({ allowedDomains: ['*.example.com'] })
    expect(
      await new DestinationPolicy(buildNotebookNetworkPolicy(settings)).inspect(
        'data.example.com',
        443
      )
    ).toMatchObject({ kind: 'deny', configurable: false })
  })
})

describe('private trust persistence contract', () => {
  it('preserves historical defaults and never promotes a private grant to a public domain grant', () => {
    expect(normalizeNotebookNetworkSettings({})).toEqual(DEFAULT_NOTEBOOK_NETWORK_SETTINGS)
    const rule = { hostname: 'lab.internal.example', port: 8443, approvedAddresses: ['10.32.0.7'] }
    const settings = normalizeNotebookNetworkSettings({ trustedPrivateDestinations: [rule] })
    expect(buildNotebookNetworkPolicy(settings).trustedPrivateDestinations).toEqual([rule])
    expect(notebookNetworkSettingsAllowDomain(settings, rule.hostname)).toBe(false)
    expect(settings.allowedDomains).toEqual([])
    expect(normalizeNotebookNetworkSettings(JSON.parse(JSON.stringify(settings)))).toEqual(settings)
  })
  it('fails closed for ambiguous duplicate services and malformed records', () => {
    const rule = { hostname: 'lab.internal.example', port: 8443, approvedAddresses: ['10.32.0.7'] }
    expect(
      normalizeNotebookNetworkSettings({
        trustedPrivateDestinations: [rule, { ...rule, approvedAddresses: ['10.32.0.8'] }]
      }).trustedPrivateDestinations
    ).toEqual([])
    expect(
      normalizeNotebookNetworkSettings({ trustedPrivateDestinations: [{ ...rule, port: 0 }] })
        .trustedPrivateDestinations
    ).toEqual([])
  })
})
