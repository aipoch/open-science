import { beforeEach, expect, it, vi } from 'vitest'

const lookup = vi.hoisted(() => vi.fn())
vi.mock('node:dns/promises', () => ({ lookup }))

import {
  DestinationPolicy,
  reviewPrivateDestination
} from '../runtime/src/gateway/address-policy.js'

beforeEach(() => lookup.mockReset())

it('reviews trusted service shape without resolving DNS', async () => {
  await expect(
    reviewPrivateDestination({ hostname: 'localhost', port: 8080, protocol: 'http' })
  ).resolves.toEqual({
    ok: true,
    destination: {
      hostname: 'localhost',
      port: 8080,
      protocol: 'http',
      approvedAddresses: []
    }
  })
  expect(lookup).not.toHaveBeenCalled()
})

it('defaults legacy trusted service entries to HTTPS without resolving DNS', async () => {
  await expect(reviewPrivateDestination({ hostname: '127.0.0.1', port: 443 })).resolves.toEqual({
    ok: true,
    destination: {
      hostname: '127.0.0.1',
      port: 443,
      protocol: 'https',
      approvedAddresses: []
    }
  })
  expect(lookup).not.toHaveBeenCalled()
})

it('accepts literal IPs and rejects malformed trusted service input', async () => {
  await expect(
    reviewPrivateDestination({ hostname: '127.0.0.1', port: 8443, protocol: 'https' })
  ).resolves.toMatchObject({ ok: true })
  await expect(reviewPrivateDestination({ hostname: '*.example.com', port: 443 })).resolves.toEqual(
    {
      ok: false,
      reason: 'invalid'
    }
  )
  await expect(reviewPrivateDestination({ hostname: 'localhost', port: 0 })).resolves.toEqual({
    ok: false,
    reason: 'invalid'
  })
})

it('reviews bracketed IPv6 and localhost without DNS validation', async () => {
  await expect(
    reviewPrivateDestination({ hostname: '[2001:0DB8::1]', port: 8080, protocol: 'http' })
  ).resolves.toEqual({
    ok: true,
    destination: {
      hostname: '2001:db8::1',
      port: 8080,
      protocol: 'http',
      approvedAddresses: []
    }
  })
  await expect(
    reviewPrivateDestination({ hostname: 'localhost', port: 80, protocol: 'https' })
  ).resolves.toMatchObject({
    ok: false,
    reason: 'ineligible'
  })
  expect(lookup).not.toHaveBeenCalled()
})

it('keeps mixed DNS answers as routing evidence for HTTPS domains', async () => {
  lookup.mockResolvedValue([
    { address: '127.0.0.1', family: 4 },
    { address: '93.184.216.34', family: 4 }
  ])
  const policy = new DestinationPolicy({ allowedDomains: ['example.org'], deniedDomains: [] })
  await expect(policy.inspect('example.org', 443, 'https')).resolves.toMatchObject({
    kind: 'allow',
    address: '127.0.0.1'
  })
})
