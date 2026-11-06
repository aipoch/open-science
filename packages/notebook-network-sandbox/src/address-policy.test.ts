import { beforeEach, describe, expect, it, vi } from 'vitest'

const lookup = vi.hoisted(() => vi.fn())
vi.mock('node:dns/promises', () => ({ lookup }))

import { DestinationPolicy } from '../runtime/src/gateway/address-policy.js'

beforeEach(() => {
  lookup.mockReset()
  lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
})

describe('Notebook destination policy', () => {
  it('allows an HTTPS domain when DNS answers mix local and public addresses', async () => {
    lookup.mockResolvedValue([
      { address: '127.0.0.1', family: 4 },
      { address: '93.184.216.34', family: 4 }
    ])
    const policy = new DestinationPolicy({ allowedDomains: ['example.com'], deniedDomains: [] })
    await expect(policy.inspect('example.com', 443)).resolves.toMatchObject({
      kind: 'allow',
      address: '127.0.0.1'
    })
  })

  it('keeps exact and wildcard domain rules distinct', async () => {
    const policy = new DestinationPolicy({
      allowedDomains: ['example.com', '*.allowed.example'],
      deniedDomains: []
    })
    await expect(policy.inspect('example.com', 443)).resolves.toMatchObject({ kind: 'allow' })
    await expect(policy.inspect('sub.example.com', 443)).resolves.toMatchObject({ kind: 'ask' })
    await expect(policy.inspect('allowed.example', 443)).resolves.toMatchObject({ kind: 'ask' })
    await expect(policy.inspect('sub.allowed.example', 443)).resolves.toMatchObject({
      kind: 'allow'
    })
  })

  it('denies HTTP domain requests before approval', async () => {
    const policy = new DestinationPolicy({ allowedDomains: ['example.com'], deniedDomains: [] })
    await expect(policy.inspect('example.com', 80, 'http')).resolves.toEqual({
      kind: 'deny',
      reason: 'only HTTPS destinations are allowed by default',
      configurable: false
    })
  })

  it('denies literal IP destinations by default', async () => {
    const policy = new DestinationPolicy({ allowedDomains: [], deniedDomains: [] })
    await expect(policy.inspect('8.8.8.8', 443)).resolves.toMatchObject({
      kind: 'deny',
      configurable: false
    })
    expect(lookup).not.toHaveBeenCalled()
  })

  it('allows a trusted HTTP literal IP without DNS lookup', async () => {
    const policy = new DestinationPolicy({
      allowedDomains: [],
      deniedDomains: [],
      trustedPrivateDestinations: [
        { hostname: '127.0.0.1', port: 8080, protocol: 'http', approvedAddresses: [] }
      ]
    })
    await expect(policy.inspect('127.0.0.1', 8080, 'http')).resolves.toMatchObject({
      kind: 'allow',
      address: '127.0.0.1'
    })
    expect(lookup).not.toHaveBeenCalled()
  })

  it('allows a trusted HTTP hostname as an explicit exception', async () => {
    const policy = new DestinationPolicy({
      allowedDomains: [],
      deniedDomains: [],
      trustedPrivateDestinations: [
        { hostname: 'example.com', port: 80, protocol: 'http', approvedAddresses: [] }
      ]
    })
    await expect(policy.inspect('example.com', 80, 'http')).resolves.toMatchObject({
      kind: 'allow'
    })
  })

  it.each([
    ['http', 8080],
    ['https', 80]
  ] as const)(
    'matches a trusted %s rule on port %s without port-based protocol assumptions',
    async (protocol, port) => {
      const policy = new DestinationPolicy({
        allowedDomains: [],
        deniedDomains: [],
        trustedPrivateDestinations: [
          { hostname: 'service.example', port, protocol, approvedAddresses: [] }
        ]
      })
      await expect(policy.inspect('service.example', port, protocol)).resolves.toMatchObject({
        kind: 'allow'
      })
      await expect(
        policy.inspect('service.example', port, protocol === 'http' ? 'https' : 'http')
      ).resolves.not.toMatchObject({ kind: 'allow' })
    }
  )

  it('does not use current DNS addresses as a trusted rule condition', async () => {
    const policy = new DestinationPolicy({
      allowedDomains: [],
      deniedDomains: [],
      trustedPrivateDestinations: [
        {
          hostname: 'lab.internal.example',
          port: 8443,
          protocol: 'https',
          approvedAddresses: ['10.32.0.7']
        }
      ]
    })
    lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    await expect(policy.inspect('lab.internal.example', 8443, 'https')).resolves.toMatchObject({
      kind: 'allow'
    })
  })

  it('does not let a trusted HTTP rule authorize HTTPS or another port', async () => {
    const policy = new DestinationPolicy({
      allowedDomains: [],
      deniedDomains: [],
      trustedPrivateDestinations: [
        { hostname: 'localhost', port: 8080, protocol: 'http', approvedAddresses: [] }
      ]
    })
    await expect(policy.inspect('localhost', 8080, 'https')).resolves.toMatchObject({ kind: 'ask' })
    await expect(policy.inspect('localhost', 8081, 'http')).resolves.toMatchObject({ kind: 'deny' })
  })

  it('keeps hard denies ahead of trusted exceptions', async () => {
    const policy = new DestinationPolicy({
      allowedDomains: [],
      deniedDomains: ['localhost'],
      trustedPrivateDestinations: [
        { hostname: 'localhost', port: 8080, protocol: 'http', approvedAddresses: [] }
      ]
    })
    await expect(policy.inspect('localhost', 8080, 'http')).resolves.toMatchObject({
      kind: 'deny',
      configurable: false
    })
  })
})
