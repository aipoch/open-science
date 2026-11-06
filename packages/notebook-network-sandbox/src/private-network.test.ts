import { describe, expect, it } from 'vitest'

import { validPrivateDestination } from '../runtime/src/gateway/address-policy.js'

describe('Notebook sandbox trusted private-service shape', () => {
  it.each([
    { hostname: 'localhost', port: 8080, protocol: 'http' as const },
    { hostname: '127.0.0.1', port: 8443, protocol: 'https' as const },
    { hostname: '10.0.0.7', port: 80, protocol: 'http' as const },
    { hostname: 'service.internal.example', port: 443, protocol: 'https' as const },
    { hostname: '::1', port: 8080, protocol: 'http' as const }
  ])('accepts an explicit %s trusted service rule', (rule) => {
    expect(validPrivateDestination({ ...rule, approvedAddresses: [] })).toBe(true)
  })

  it.each([
    { hostname: 'service.example', port: 443, protocol: 'ftp', approvedAddresses: [] },
    { hostname: 'service.example', port: 0, protocol: 'https', approvedAddresses: [] },
    {
      hostname: 'service.example',
      port: 443,
      protocol: 'https',
      approvedAddresses: ['x'.repeat(46)]
    }
  ])('rejects malformed trusted service input', (rule) => {
    expect(validPrivateDestination(rule as never)).toBe(false)
  })
})
