import { beforeEach, expect, it, vi } from 'vitest'
const lookup = vi.hoisted(() => vi.fn())
vi.mock('node:dns/promises', () => ({ lookup }))
import {
  DestinationPolicy,
  reviewNetworkDestination
} from '../runtime/src/gateway/address-policy.js'

beforeEach(() => {
  lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }])
})

it.each(['127.0.0.1', '169.254.169.254', '10.0.0.1', '198.18.0.1', '::1', 'fd00:ec2::254'])(
  'offers explicit review of %s without granting it',
  async (address) => {
    const policy = new DestinationPolicy({
      allowedDomains: ['*'],
      deniedDomains: [],
      reviewDestinations: true
    })
    expect(await policy.inspect(address, 443)).toMatchObject({
      kind: 'ask',
      source: 'explicit',
      addresses: [address]
    })
  }
)

it('preserves all resolved addresses for approval and pins the chosen connection address', async () => {
  lookup.mockResolvedValue([
    { address: '93.184.216.34', family: 4 },
    { address: '127.0.0.1', family: 4 }
  ])
  const policy = new DestinationPolicy({
    allowedDomains: ['example.org'],
    deniedDomains: [],
    reviewDestinations: true
  })
  expect(await policy.inspect('example.org', 443)).toMatchObject({
    kind: 'ask',
    source: 'explicit',
    address: '93.184.216.34',
    addresses: ['127.0.0.1', '93.184.216.34']
  })
})

it('reviews sensitive targets while rejecting invalid ports and failed DNS', async () => {
  expect(await reviewNetworkDestination({ hostname: 'localhost', port: 8080 })).toMatchObject({
    hostname: 'localhost',
    approvedAddresses: ['127.0.0.1']
  })
  await expect(reviewNetworkDestination({ hostname: 'localhost', port: 0 })).rejects.toThrow()
  lookup.mockRejectedValue(new Error('dns'))
  await expect(
    reviewNetworkDestination({ hostname: 'missing.example', port: 443 })
  ).rejects.toThrow()
})

it.each(['PYPI.ORG.', 'pypi.org'])(
  'uses the canonical hostname for allowed review of %s',
  async (hostname) => {
    lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    const policy = new DestinationPolicy({
      allowedDomains: ['pypi.org'],
      deniedDomains: [],
      reviewDestinations: true
    })
    expect(await policy.inspect(hostname, 443)).toMatchObject({
      kind: 'allow',
      host: 'pypi.org',
      addresses: ['93.184.216.34']
    })
  }
)
