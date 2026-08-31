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
    'fe80::1'
  ])('blocks the non-public address %s', (address) => {
    expect(isInternetAddress(address)).toBe(false)
  })

  it.each(['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111'])(
    'allows the public address %s',
    (address) => {
      expect(isInternetAddress(address)).toBe(true)
    }
  )
})
