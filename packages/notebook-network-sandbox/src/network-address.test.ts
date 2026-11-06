import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  normalizeNetworkHostname,
  formatNetworkHostname,
  requiresNetworkException
} from './network-address.js'
import { normalizeRequestedHost } from '../runtime/src/gateway/address-policy.js'

describe('shared network address normalization', () => {
  it('resolves the shared helper for CommonJS consumers such as Playwright', () => {
    expect(
      createRequire(import.meta.url).resolve('@aipoch/notebook-network-sandbox/network-address')
    ).toBe(fileURLToPath(new URL('./network-address.ts', import.meta.url)))
  })

  it.each([
    ['LOCALHOST.', 'localhost'],
    ['127.1', '127.0.0.1'],
    ['0x7f000001', '127.0.0.1'],
    ['[2001:0DB8:0:0::1]', '2001:db8::1'],
    ['::1', '::1'],
    ['例子.测试', 'xn--fsqu00a.xn--0zwm56d']
  ])('canonicalizes %s identically at settings and runtime boundaries', (input, canonical) => {
    expect(normalizeNetworkHostname(input)).toBe(canonical)
    expect(normalizeRequestedHost(input)).toBe(canonical)
    expect(formatNetworkHostname(canonical)).toBe(
      canonical.includes(':') ? `[${canonical}]` : canonical
    )
  })
  it.each([
    'https://example.com',
    'host:8080',
    '[::1]:443',
    '*.example.com',
    'bad_host',
    'host/path',
    'user@host',
    'fe80::1%en0'
  ])('rejects ambiguous host %s', (input) => {
    expect(normalizeNetworkHostname(input)).toBeUndefined()
    expect(normalizeRequestedHost(input)).toBeUndefined()
  })
  it.each(['localhost', 'private.internal', 'mixed.example'])(
    'requires only HTTP exceptions for domain %s',
    (host) => {
      expect(requiresNetworkException(host, 'https')).toBe(false)
      expect(requiresNetworkException(host, 'http')).toBe(true)
    }
  )
  it.each(['127.0.0.1', '8.8.8.8', '::1', '2001:db8::1'])(
    'requires exact authorization for IP %s with either protocol',
    (host) => {
      expect(requiresNetworkException(host, 'https')).toBe(true)
      expect(requiresNetworkException(host, 'http')).toBe(true)
    }
  )
})
