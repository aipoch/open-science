import { describe, expect, it } from 'vitest'

import { isInternetAddress } from '../runtime/src/gateway/address-policy.js'

describe('Notebook sandbox private-network guard', () => {
  it.each([
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.1',
    '::',
    '::1',
    'fc00::1',
    'fe80::1',
    '192.0.0.9',
    '192.0.2.1',
    '192.88.99.2',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '255.255.255.255',
    '::ffff:8.8.8.8',
    '::ffff:0:8.8.8.8',
    '::8.8.8.8',
    '64:ff9b::808:808',
    '64:ff9b:1::1',
    '100::1',
    '100:0:0:1::1',
    '2001::1',
    '2001:2::1',
    '2001:10::1',
    '2001:20::1',
    '2001:30::1',
    '2001:db8::1',
    '2002:0808:0808::1',
    '3fff::1',
    '3fff:fff::1',
    '5f00::1',
    '4000::1',
    'fec0::1',
    'ff02::1',
    '2606:4700::1%lo0',
    'not-an-ip'
  ])('blocks the non-public address %s', (address) => {
    expect(isInternetAddress(address)).toBe(false)
  })

  it.each([
    '1.1.1.1',
    '8.8.8.8',
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
    '3ffe::1',
    '192.88.98.1'
  ])('allows the public address %s', (address) => {
    expect(isInternetAddress(address)).toBe(true)
  })
})
