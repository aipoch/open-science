import { describe, expect, it } from 'vitest'
import { isSecureRemoteUrl } from './url-admission'

describe('remote URL admission', () => {
  it.each([
    'https://example.test/mcp',
    'https://127.0.0.1:443',
    'http://localhost:4321/callback',
    'http://LOCALHOST:4321/callback',
    'http://127.0.0.1:8080',
    'http://127.255.255.254',
    'http://[::1]:8000'
  ])('admits secure or actual loopback URL %s', (url) => {
    expect(isSecureRemoteUrl(url)).toBe(true)
  })
  it.each([
    '',
    'not a URL',
    '/callback',
    'http://example.test',
    'http://localhost.example.test',
    'http://127.example.test',
    'http://[::2]',
    'http://192.168.1.1',
    'file:///tmp/secret',
    'javascript:alert(1)',
    'ftp://localhost',
    'http://localhost@attacker.test',
    'http://127.0.0.1.attacker.test'
  ])('rejects cleartext remote, deceptive host or non-HTTP URL %s', (url) => {
    expect(isSecureRemoteUrl(url)).toBe(false)
  })
})
