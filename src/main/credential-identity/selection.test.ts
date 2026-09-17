import { describe, expect, it, vi, type Mock } from 'vitest'

import {
  selectCredentialIdentity,
  type CredentialIdentity,
  type IdentityProbeResult
} from './selection'

const result = (status: IdentityProbeResult['status']): IdentityProbeResult => ({ status })
const choose = (
  statuses: IdentityProbeResult['status'][],
  packaged = true
): { selection: CredentialIdentity; probe: Mock<() => IdentityProbeResult> } => {
  const probe = vi.fn(() => result(statuses.shift()!))
  return { selection: selectCredentialIdentity({ platform: 'darwin', packaged, probe }), probe }
}

describe('credential identity selection', () => {
  it('chooses the new identity without querying the old one when it exists', () => {
    const { selection, probe } = choose(['exists'])
    expect(selection).toMatchObject({ appName: 'Open-Science', exists: true })
    expect(probe.mock.calls).toEqual([['Open-Science']])
  })

  it('queries the old identity only after an explicit new-identity not-found', () => {
    const { selection, probe } = choose(['not-found', 'exists'])
    expect(selection).toMatchObject({ appName: 'Open Science', exists: true })
    expect(probe.mock.calls).toEqual([['Open-Science'], ['Open Science']])
  })

  it('selects the new identity as a later creation target when both are absent', () => {
    const { selection, probe } = choose(['not-found', 'not-found'])
    expect(selection).toMatchObject({ appName: 'Open-Science', exists: false })
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it.each(['access-blocked', 'error', 'unsupported'] as const)(
    'does not fall back or allow creation on %s',
    (status) => {
      const probe = vi.fn(() => result(status))
      expect(() => selectCredentialIdentity({ platform: 'darwin', packaged: true, probe })).toThrow(
        /credential/i
      )
      expect(probe).toHaveBeenCalledTimes(1)
    }
  )

  it.each(['access-blocked', 'error'] as const)(
    'also fails closed on old-identity %s',
    (status) => {
      expect(() => choose(['not-found', status])).toThrow(/credential/i)
    }
  )

  it('does not interpret a thrown query exception as not-found', () => {
    const probe = vi.fn(() => {
      throw new Error('I/O failed')
    })
    expect(() => selectCredentialIdentity({ platform: 'darwin', packaged: true, probe })).toThrow(
      /credential/i
    )
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('uses separate development identities', () => {
    const { selection, probe } = choose(['not-found', 'exists'], false)
    expect(selection.appName).toBe('Open Science (DEV)')
    expect(probe.mock.calls).toEqual([['Open-Science (DEV)'], ['Open Science (DEV)']])
  })

  it('does not cache a legacy selection across launches', () => {
    expect(choose(['not-found', 'exists']).selection.appName).toBe('Open Science')
    expect(choose(['exists']).selection.appName).toBe('Open-Science')
  })

  it('keeps Windows on the same profile-scoped DPAPI backend without macOS item queries', () => {
    const probe = vi.fn()
    const selection = selectCredentialIdentity({ platform: 'win32', packaged: true, probe })
    expect(selection).toEqual({ backend: 'windows-dpapi', appName: 'Open-Science' })
    expect(probe).not.toHaveBeenCalled()
  })

  it('requires a Linux metadata adapter without calling the macOS probe, and preserves file mode', () => {
    const probe = vi.fn()
    expect(() => selectCredentialIdentity({ platform: 'linux', packaged: true, probe })).toThrow(
      /credential/i
    )
    expect(
      selectCredentialIdentity({
        platform: 'linux',
        packaged: true,
        credentialStore: 'file',
        probe
      })
    ).toEqual({ backend: 'file', appName: 'Open-Science' })
    const linuxProbe = vi.fn(() => ({ status: 'exists' as const }))
    expect(
      selectCredentialIdentity({ platform: 'linux', packaged: true, probe, linuxProbe })
    ).toEqual({ backend: 'linux-secret-service', appName: 'Open Science', exists: true })
    expect(linuxProbe).toHaveBeenCalledExactlyOnceWith('Open Science')
    expect(probe).not.toHaveBeenCalled()
  })
})
