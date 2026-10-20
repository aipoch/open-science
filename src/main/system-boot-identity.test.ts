import { expect, it } from 'vitest'
import {
  assertSystemRestarted,
  normalizeDarwinBootIdentity,
  systemBootIdentity,
  hasSystemRestarted,
  isStableBootIdentity,
  normalizeKernelBootIdentity,
  type BootPlatform
} from './system-boot-identity'
const old = '12345678-1234-4321-8123-123456789abc',
  next = '87654321-1234-4321-8123-123456789abc'
it.each(['darwin', 'windows', 'linux'] as BootPlatform[])(
  'strictly validates stored and current %s kernel identity',
  (platform) => {
    const a = normalizeKernelBootIdentity(platform, old.toUpperCase() + '\n'),
      b = normalizeKernelBootIdentity(platform, next)
    expect(hasSystemRestarted(a, b)).toBe(true)
    expect(hasSystemRestarted(a, a)).toBe(false)
    expect(() => assertSystemRestarted(a, a)).toThrow('system restart')
    for (const invalid of [
      '',
      '-'.repeat(36),
      '00000000-0000-0000-0000-000000000000',
      '1234-56781234-4321-8123-123456789abc',
      '{ sec = 1, usec = 2 }'
    ]) {
      expect(() => normalizeKernelBootIdentity(platform, invalid)).toThrow()
      expect(isStableBootIdentity(`${platform}-boot:${invalid}`)).toBe(false)
      expect(hasSystemRestarted(`${platform}-boot:${invalid}`, b)).toBe(false)
      expect(hasSystemRestarted(a, `${platform}-boot:${invalid}`)).toBe(false)
      expect(() => assertSystemRestarted(`${platform}-boot:${invalid}`, b)).toThrow('unavailable')
    }
    expect(hasSystemRestarted(a, `other-boot:${next}`)).toBe(false)
    expect(hasSystemRestarted(old, b)).toBe(false)
  }
)
it('does not interpret a scheme migration as reboot', () => {
  expect(hasSystemRestarted(`darwin-boot:${old}`, `linux-boot:${next}`)).toBe(false)
  expect(() => assertSystemRestarted(`darwin-boot:${old}`, `linux-boot:${next}`)).toThrow(
    'unavailable'
  )
})

it('requires a kernel boot UUID and rejects time-derived identities', () => {
  expect(normalizeDarwinBootIdentity('A1234567-1234-1234-1234-123456789ABC\n')).toBe(
    'darwin-boot:a1234567-1234-1234-1234-123456789abc'
  )
  expect(() =>
    normalizeDarwinBootIdentity('{ sec = 1788876198, usec = 1234 } Tue Sep 8 15:23:18 2026')
  ).toThrow('could not be parsed')
})
it.skipIf(process.platform !== 'darwin')(
  'reports the same real macOS boot in UTC and Asia/Shanghai',
  () => {
    const previous = process.env.TZ
    try {
      process.env.TZ = 'UTC'
      const utc = systemBootIdentity()
      process.env.TZ = 'Asia/Shanghai'
      expect(systemBootIdentity()).toBe(utc)
    } finally {
      if (previous === undefined) delete process.env.TZ
      else process.env.TZ = previous
    }
  }
)
