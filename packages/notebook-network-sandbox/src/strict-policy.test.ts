import { beforeEach, expect, it, vi } from 'vitest'
const lookup = vi.hoisted(() => vi.fn())
vi.mock('node:dns/promises', () => ({ lookup }))
import { DestinationPolicy } from '../runtime/src/gateway/address-policy.js'
beforeEach(() => lookup.mockReset())
const policy = (): DestinationPolicy =>
  new DestinationPolicy({
    mode: 'strict',
    allowedDomains: ['*'],
    deniedDomains: [],
    trustedPrivateDestinations: [
      { hostname: '127.0.0.1', protocol: 'http', port: 80, approvedAddresses: [] }
    ],
    strictWhitelist: [{ protocol: 'https', hostnamePattern: '*.example.org', port: 443 }]
  })
it.each([
  ['example.org', 443, 'https'],
  ['other.test', 443, 'https'],
  ['api.example.org', 80, 'https'],
  ['api.example.org', 443, 'http'],
  ['127.0.0.1', 80, 'http']
] as const)(
  'denies unmatched %s before DNS without authorization',
  async (host, port, protocol) => {
    expect(await policy().inspect(host, port, protocol)).toMatchObject({
      kind: 'deny',
      configurable: false
    })
    expect(lookup).not.toHaveBeenCalled()
  }
)
it('allows a matched hostname without resolving or inspecting its addresses', async () => {
  expect(await policy().inspect('API.Example.org.', 443, 'https')).toMatchObject({
    kind: 'allow',
    address: 'api.example.org'
  })
  expect(lookup).not.toHaveBeenCalled()
})
it('allows explicit IPv6 HTTP entries and keeps hard deny rules', async () => {
  const rules = {
    mode: 'strict' as const,
    allowedDomains: [],
    strictWhitelist: [{ protocol: 'http' as const, hostnamePattern: '::1', port: 8080 }]
  }
  expect(
    await new DestinationPolicy({ ...rules, deniedDomains: [] }).inspect('::1', 8080, 'http')
  ).toMatchObject({ kind: 'allow' })
  expect(
    await new DestinationPolicy({ ...rules, deniedDomains: ['*'] }).inspect('::1', 8080, 'http')
  ).toMatchObject({ kind: 'deny', configurable: false })
})
