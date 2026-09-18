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
  const probe = vi.fn(() => result(statuses.shift() ?? 'not-found'))
  return { selection: selectCredentialIdentity({ platform: 'darwin', packaged, probe }), probe }
}

describe('credential identity selection', () => {
  const statuses = ['exists', 'not-found', 'access-blocked', 'error', 'unsupported'] as const
  it.each([true, false])('selects sequentially for all status pairs (packaged=%s)', (packaged) => {
    const suffix = packaged ? '' : ' (DEV)'
    const current = `Open-Science${suffix}`
    const legacy = `Open Science${suffix}`
    for (const preferred of statuses) {
      for (const previous of statuses) {
        const { selection, probe } = choose([preferred, previous], packaged)
        expect(selection).toEqual({
          backend: 'mac-keychain',
          appName: preferred === 'exists' || previous !== 'exists' ? current : legacy,
          exists: preferred === 'exists' || previous === 'exists'
        })
        expect(probe.mock.calls).toEqual(
          preferred === 'exists' ? [[current]] : [[current], [legacy]]
        )
      }
    }
  })

  it.each([true, false])('continues after thrown probes (legacy exists=%s)', (legacyExists) => {
    const probe = vi.fn<() => IdentityProbeResult>(() => {
      throw new Error('password=PRIVATE-ERROR')
    })
    if (legacyExists)
      probe
        .mockImplementationOnce(() => {
          throw new Error('PRIVATE-ERROR')
        })
        .mockImplementationOnce(() => ({ status: 'exists' }))
    expect(selectCredentialIdentity({ platform: 'darwin', packaged: true, probe })).toEqual({
      backend: 'mac-keychain',
      appName: legacyExists ? 'Open Science' : 'Open-Science',
      exists: legacyExists
    })
    expect(probe.mock.calls).toEqual([['Open-Science'], ['Open Science']])
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
