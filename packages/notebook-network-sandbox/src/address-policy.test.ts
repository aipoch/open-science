import { beforeEach, describe, expect, it, vi } from 'vitest'

const lookup = vi.hoisted(() => vi.fn())
vi.mock('node:dns/promises', () => ({ lookup }))

import { DestinationPolicy } from '../runtime/src/gateway/address-policy.js'

beforeEach(() => {
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
})
