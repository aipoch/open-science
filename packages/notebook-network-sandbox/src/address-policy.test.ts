import { beforeEach, describe, expect, it, vi } from 'vitest'

const lookup = vi.hoisted(() => vi.fn())
vi.mock('node:dns/promises', () => ({ lookup }))
const networkInterfaces = vi.hoisted(() => vi.fn(() => ({})))
vi.mock('node:os', () => ({ networkInterfaces }))

import {
  DestinationPolicy,
  reviewPrivateDestination
} from '../runtime/src/gateway/address-policy.js'

beforeEach(() => {
  networkInterfaces.mockReturnValue({})
  lookup.mockReset()
  lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
})

describe('Notebook destination policy', () => {
  it('keeps exact and wildcard rules distinct', async () => {
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

  it('matches an embedded wildcard as exactly one hostname label', async () => {
    const policy = new DestinationPolicy({
      allowedDomains: [],
      deniedDomains: ['s3.*.amazonaws.com', '*.s3.*.amazonaws.com', '*.s3-*.amazonaws.com']
    })

    await expect(policy.inspect('s3.us-east-1.amazonaws.com', 443)).resolves.toMatchObject({
      kind: 'deny'
    })
    await expect(policy.inspect('s3.amazonaws.com', 443)).resolves.toMatchObject({ kind: 'ask' })
    await expect(policy.inspect('bucket.s3.us-east-1.amazonaws.com', 443)).resolves.toMatchObject({
      kind: 'deny'
    })
    await expect(
      policy.inspect('bucket.with.dots.s3.us-east-1.amazonaws.com', 443)
    ).resolves.toMatchObject({ kind: 'deny' })
    await expect(policy.inspect('bucket.s3-us-west-2.amazonaws.com', 443)).resolves.toMatchObject({
      kind: 'deny'
    })
  })

  it('applies port-qualified and deny-all rules before approval', async () => {
    const portPolicy = new DestinationPolicy({
      allowedDomains: ['example.com:443'],
      deniedDomains: ['blocked.example:22']
    })
    await expect(portPolicy.inspect('example.com', 443)).resolves.toMatchObject({ kind: 'allow' })
    await expect(portPolicy.inspect('example.com', 80)).resolves.toMatchObject({ kind: 'ask' })
    await expect(portPolicy.inspect('blocked.example', 22)).resolves.toMatchObject({ kind: 'deny' })

    const denyAll = new DestinationPolicy({ allowedDomains: [], deniedDomains: ['*'] })
    await expect(denyAll.inspect('anything.example', 443)).resolves.toMatchObject({ kind: 'deny' })
    expect(lookup).not.toHaveBeenCalledWith('anything.example', expect.anything())
  })

  it('rejects any hostname with a private address in its DNS answer', async () => {
    lookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 }
    ])
    const policy = new DestinationPolicy({ allowedDomains: ['example.com'], deniedDomains: [] })

    await expect(policy.inspect('example.com', 443)).resolves.toEqual({
      kind: 'deny',
      reason: 'destination resolves to a non-public network address',
      configurable: false
    })
  })

  it.each(['64:ff9b::7f00:1', 'fec0::1'])(
    'rejects non-public IPv6 destination %s without DNS lookup',
    async (address) => {
      const policy = new DestinationPolicy({ allowedDomains: [], deniedDomains: [] })

      await expect(policy.inspect(address, 443)).resolves.toMatchObject({ kind: 'deny' })
      expect(lookup).not.toHaveBeenCalled()
    }
  )
  it('distinguishes explicit approval from an unknown public destination', async () => {
    const policy = new DestinationPolicy({
      allowedDomains: ['*.example.com'],
      askDomains: ['restricted.example.com'],
      deniedDomains: []
    })
    await expect(policy.inspect('restricted.example.com', 443)).resolves.toMatchObject({
      kind: 'ask',
      source: 'explicit'
    })
    await expect(policy.inspect('unknown.example', 443)).resolves.toEqual({
      kind: 'ask',
      source: 'unknown',
      host: 'unknown.example',
      address: '93.184.216.34'
    })
  })

  it('lets exact approvals override ask rules but never hard denies', async () => {
    const policy = new DestinationPolicy({
      allowedDomains: ['approved.example', 'blocked.example'],
      askDomains: ['approved.example'],
      deniedDomains: ['blocked.example']
    })
    await expect(policy.inspect('APPROVED.EXAMPLE.', 443)).resolves.toMatchObject({ kind: 'allow' })
    await expect(policy.inspect('blocked.example', 443)).resolves.toMatchObject({
      kind: 'deny',
      configurable: false
    })
  })

  it('does not let broad or mismatched-port approvals override explicit ask', async () => {
    const policy = new DestinationPolicy({
      allowedDomains: ['*', '*.example.com', 'data.example.com:8443'],
      askDomains: ['*.example.com'],
      deniedDomains: []
    })
    await expect(policy.inspect('data.example.com', 443)).resolves.toMatchObject({
      kind: 'ask',
      source: 'explicit'
    })
    await expect(policy.inspect('data.example.com', 8443)).resolves.toMatchObject({ kind: 'allow' })
  })

  it('normalizes public IP variants without mistaking them for DNS names', async () => {
    const policy = new DestinationPolicy({ allowedDomains: [], deniedDomains: [] })
    for (const host of ['8.8.8.8', '0x08080808', '134744072']) {
      await expect(policy.inspect(host, 443)).resolves.toMatchObject({
        kind: 'ask',
        host: '8.8.8.8'
      })
    }
    expect(lookup).not.toHaveBeenCalled()
  })

  it('fails closed for DNS failure even with exact target permission', async () => {
    lookup.mockRejectedValue(new Error('lookup failed'))
    const policy = new DestinationPolicy({ allowedDomains: ['example.com'], deniedDomains: [] })
    await expect(policy.inspect('example.com', 443)).resolves.toMatchObject({
      kind: 'deny',
      configurable: false
    })
  })

  it('checks every answer again on the next inspection', async () => {
    const policy = new DestinationPolicy({ allowedDomains: ['example.com'], deniedDomains: [] })
    await expect(policy.inspect('example.com', 443)).resolves.toMatchObject({
      kind: 'allow',
      address: '93.184.216.34'
    })
    lookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '2002:7f00:1::', family: 6 }
    ])
    await expect(policy.inspect('example.com', 443)).resolves.toMatchObject({
      kind: 'deny',
      configurable: false
    })
  })
})

describe('reviewed private service rules', () => {
  const rule = {
    hostname: 'lab.internal.example',
    port: 8443,
    approvedAddresses: ['10.32.0.7', 'fd12::7']
  }
  const policy = (): DestinationPolicy =>
    new DestinationPolicy({
      allowedDomains: [],
      deniedDomains: [],
      trustedPrivateDestinations: [rule]
    })
  it('requires the exact host, port and every reviewed address, without widening public rules', async () => {
    lookup.mockResolvedValue([
      { address: '10.32.0.7', family: 4 },
      { address: 'fd12::7', family: 6 }
    ])
    await expect(policy().inspect(rule.hostname, 8443)).resolves.toMatchObject({
      kind: 'allow',
      address: '10.32.0.7'
    })
    await expect(policy().inspect(rule.hostname, 443)).resolves.toMatchObject({ kind: 'deny' })
    await expect(policy().inspect(`sub.${rule.hostname}`, 8443)).resolves.toMatchObject({
      kind: 'deny'
    })
    await expect(
      new DestinationPolicy({ allowedDomains: [rule.hostname], deniedDomains: [] }).inspect(
        rule.hostname,
        8443
      )
    ).resolves.toMatchObject({ kind: 'deny' })
    lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    await expect(policy().inspect(rule.hostname, 8443)).resolves.toMatchObject({ kind: 'ask' })
  })
  it.each([
    '10.32.0.8',
    '127.0.0.1',
    '169.254.169.254',
    '100.64.0.7',
    '::1',
    'fe80::1',
    '::ffff:10.32.0.7',
    '93.184.216.34'
  ])('blocks an additional unreviewed or ineligible answer %s', async (address) => {
    lookup.mockResolvedValue([
      { address: '10.32.0.7', family: 4 },
      { address, family: address.includes(':') ? 6 : 4 }
    ])
    await expect(policy().inspect(rule.hostname, 8443)).resolves.toMatchObject({ kind: 'deny' })
  })
  it('accepts a subset and canonical IPv6 spellings, but never a hard deny', async () => {
    lookup.mockResolvedValue([{ address: 'fd12:0:0:0:0:0:0:7', family: 6 }])
    await expect(policy().inspect(rule.hostname, 8443)).resolves.toMatchObject({ kind: 'allow' })
    await expect(
      new DestinationPolicy({
        allowedDomains: [],
        deniedDomains: [rule.hostname],
        trustedPrivateDestinations: [rule]
      }).inspect(rule.hostname, 8443)
    ).resolves.toMatchObject({ kind: 'deny' })
    expect(lookup).toHaveBeenCalledTimes(1)
  })
  it('does not honor malformed grants or DNS failure', async () => {
    lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }])
    await expect(
      new DestinationPolicy({
        allowedDomains: [],
        deniedDomains: [],
        trustedPrivateDestinations: [{ ...rule, approvedAddresses: ['127.0.0.1'] }]
      }).inspect(rule.hostname, 8443)
    ).resolves.toMatchObject({ kind: 'deny' })
    lookup.mockRejectedValue(new Error('offline'))
    await expect(policy().inspect(rule.hostname, 8443)).resolves.toMatchObject({ kind: 'deny' })
  })
})

describe('private service review', () => {
  it.each([
    'lab.internal.example/path',
    'lab.internal.example?key=x',
    'lab.internal.example#part',
    'lab.internal.example\\path',
    'lab%2einternal.example'
  ])('rejects URL syntax before normalizing %s', async (hostname) => {
    await expect(reviewPrivateDestination({ hostname, port: 8443 })).resolves.toEqual({
      ok: false,
      reason: 'invalid'
    })
    expect(lookup).not.toHaveBeenCalled()
  })

  it.each([
    'fd12::7%en0',
    'fd00:ec2::254',
    'fd00:0ec2:0000:0000:0000:0000:0000:0254',
    '169.254.169.254',
    '127.0.0.1',
    '100.64.0.1',
    '::ffff:10.32.0.7'
  ])('never admits reserved endpoint %s', async (address) => {
    lookup.mockResolvedValue([{ address }])
    await expect(
      reviewPrivateDestination({ hostname: 'lab.internal.example', port: 8443 })
    ).resolves.toEqual({ ok: false, reason: 'ineligible' })
    const policy = new DestinationPolicy({
      allowedDomains: ['lab.internal.example'],
      deniedDomains: [],
      trustedPrivateDestinations: [
        { hostname: 'lab.internal.example', port: 8443, approvedAddresses: [address] }
      ]
    })
    await expect(policy.inspect('lab.internal.example', 8443)).resolves.toMatchObject({
      kind: 'deny'
    })
  })
  it('checks current host interfaces at review and on each connection', async () => {
    lookup.mockResolvedValue([{ address: '10.32.0.7', family: 4 }])
    const request = { hostname: 'lab.internal.example', port: 8443 }
    const reviewed = await reviewPrivateDestination(request)
    expect(reviewed.ok).toBe(true)
    if (!reviewed.ok) return
    const policy = new DestinationPolicy({
      allowedDomains: [],
      deniedDomains: [],
      trustedPrivateDestinations: [reviewed.destination]
    })
    await expect(policy.inspect(request.hostname, request.port)).resolves.toMatchObject({
      kind: 'allow'
    })
    networkInterfaces.mockReturnValue({ en0: [{ address: '10.32.0.7' }] })
    await expect(reviewPrivateDestination(request)).resolves.toEqual({
      ok: false,
      reason: 'ineligible'
    })
    await expect(policy.inspect(request.hostname, request.port)).resolves.toMatchObject({
      kind: 'deny'
    })
  })
})
