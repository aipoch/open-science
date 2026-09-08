import { describe, expect, it, vi } from 'vitest'
import { DestinationPolicy } from '../../packages/notebook-network-sandbox/runtime/src/gateway/address-policy'
import { createRuntimeConfig } from '../../packages/notebook-network-sandbox/src/config'

import {
  DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
  buildNotebookNetworkPolicy,
  normalizeNotebookNetworkSettings,
  notebookNetworkSettingsAllowDomain,
  validateCustomAllowedDomain
} from './notebook-network'

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '8.8.8.8', family: 4 }])
}))

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

    expect.soft(await inspect(settings).inspect(host, 443)).toMatchObject({ kind: 'ask', host })
    expect.soft(notebookNetworkSettingsAllowDomain(settings, host)).toBe(false)
    expect(await inspect(settings).inspect(sibling, 443)).toMatchObject({ kind: 'allow' })

    // A later explicit approval remains effective; turning off auto-allow is not a permanent ban.
    const approved = { ...settings, allowedDomains: [host] }
    expect(await inspect(approved).inspect(host, 443)).toMatchObject({ kind: 'allow' })
    expect(notebookNetworkSettingsAllowDomain(approved, host)).toBe(true)
  })
})

describe('notebook network policy', () => {
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

  it('leaves public domains to the approval and allowlist flow', () => {
    const policy = buildNotebookNetworkPolicy(DEFAULT_NOTEBOOK_NETWORK_SETTINGS)

    expect(policy.deniedDomains).toEqual([])
    expect(policy.deniedDomainReasons).toEqual({})
  })
})
