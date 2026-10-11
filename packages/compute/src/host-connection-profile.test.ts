import { describe, expect, it } from 'vitest'
import {
  HostConnectionProfileValidationError,
  isHostConnectionPortValid,
  parseHostConnectionPort,
  validateHostConnectionProfile
} from './host-connection-profile'

describe('portable host connection domain', () => {
  it('normalizes optional fields without mutating input', () => {
    const input = Object.freeze({
      sshAlias: ' cluster ',
      displayName: ' ',
      user: ' scientist ',
      port: ' 2200 ',
      identityFile: ' ~/.ssh/key '
    })
    expect(validateHostConnectionProfile(input)).toEqual({
      sshAlias: 'cluster',
      displayName: 'cluster',
      user: 'scientist',
      port: 2200,
      identityFile: '~/.ssh/key'
    })
    expect(input.sshAlias).toBe(' cluster ')
  })
  it.each([undefined, '', '  '])('preserves an absent optional port %s', (port) => {
    expect(parseHostConnectionPort(port)).toBeUndefined()
    expect(isHostConnectionPortValid(port)).toBe(true)
    expect(() =>
      validateHostConnectionProfile({ sshAlias: 'cluster', port }, { requirePort: true })
    ).toThrow(HostConnectionProfileValidationError)
  })
  it.each([0, -1, 65536, 1.5, NaN, Infinity, '22x', '1e2', '22\n-oProxyCommand=x'])(
    'rejects invalid ports %s',
    (port) => {
      expect(isHostConnectionPortValid(port)).toBe(false)
      expect(() => parseHostConnectionPort(port)).toThrow(HostConnectionProfileValidationError)
    }
  )
  it.each([1, 65535, '22'])('accepts valid ports %s', (port) => {
    expect(parseHostConnectionPort(port)).toBe(Number(port))
  })
  it.each(['', ' ', 'host\nname', 'host\0name', 'x'.repeat(256)])(
    'rejects empty, oversized or control-bearing aliases',
    (sshAlias) => {
      expect(() => validateHostConnectionProfile({ sshAlias })).toThrow(
        HostConnectionProfileValidationError
      )
    }
  )
  it('requires a username only when the caller selects that policy', () => {
    expect(validateHostConnectionProfile({ sshAlias: 'cluster' })).toEqual({
      sshAlias: 'cluster',
      displayName: 'cluster'
    })
    expect(() =>
      validateHostConnectionProfile({ sshAlias: 'cluster' }, { requireUser: true })
    ).toThrow(HostConnectionProfileValidationError)
  })
})
