import { expect, it } from 'vitest'
import { normalizeNotebookNetworkSettings, buildNotebookNetworkPolicy } from './notebook-network'
import { migrateNotebookNetworkSettings } from './notebook-network-strict'
it('seeds built-ins once and never restores deleted rules', () => {
  const first = migrateNotebookNetworkSettings(
    normalizeNotebookNetworkSettings({ disabledOpenScienceDomainGroups: ['nih'] })
  )
  expect(first.mode).toBe('relaxed')
  expect(first.strictWhitelist?.length).toBeGreaterThan(50)
  expect(first.strictWhitelist?.some((r) => r.groupId === 'nih')).toBe(false)
  expect(migrateNotebookNetworkSettings({ ...first, strictWhitelist: [] }).strictWhitelist).toEqual(
    []
  )
})
it('does not send relaxed trust rules to strict runtime policy', () => {
  const settings = normalizeNotebookNetworkSettings({
    mode: 'strict',
    strictWhitelist: [],
    trustedPrivateDestinations: [
      { hostname: 'localhost', port: 80, protocol: 'http', approvedAddresses: [] }
    ]
  })
  expect(buildNotebookNetworkPolicy(settings)).toMatchObject({
    mode: 'strict',
    strictWhitelist: []
  })
  expect(buildNotebookNetworkPolicy(settings).trustedPrivateDestinations).toBeUndefined()
})
it.each([
  '*',
  '*.com',
  '*.localhost',
  '*.127.0.0.1',
  'api.*.example.org',
  'https://example.org/path',
  'example.org:443'
])('does not admit malformed whitelist pattern %s', (hostnamePattern) => {
  const settings = normalizeNotebookNetworkSettings({
    mode: 'strict',
    strictWhitelist: [
      { id: 'invalid', protocol: 'https', hostnamePattern, port: 443, origin: 'manual' }
    ]
  })
  expect(settings.strictWhitelist).toEqual([])
})
it('canonicalizes protocol, international hostnames, ports and duplicate destinations', () => {
  const settings = normalizeNotebookNetworkSettings({
    strictWhitelist: [
      {
        id: 'first',
        protocol: 'HTTPS',
        hostnamePattern: 'BÜCHER.example.',
        port: 443,
        origin: 'manual'
      },
      {
        id: 'duplicate',
        protocol: 'https',
        hostnamePattern: 'xn--bcher-kva.example',
        port: 443,
        origin: 'manual'
      },
      {
        id: 'invalid-port',
        protocol: 'http',
        hostnamePattern: 'localhost',
        port: 65536,
        origin: 'manual'
      }
    ]
  })
  expect(settings.strictWhitelist).toEqual([
    {
      id: 'first',
      protocol: 'https',
      hostnamePattern: 'xn--bcher-kva.example',
      port: 443,
      origin: 'manual'
    }
  ])
})
