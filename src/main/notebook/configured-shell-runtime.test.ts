import { describe, expect, it, vi } from 'vitest'

import {
  resolveAvailableShellRuntimeBinding,
  resolveConfiguredShellRuntimeBinding
} from './configured-shell-runtime'

describe('resolveConfiguredShellRuntimeBinding', () => {
  it('uses an explicit PowerShell preference even while retaining a WSL profile', () => {
    expect(
      resolveConfiguredShellRuntimeBinding(
        {
          localShellRuntime: 'powershell',
          wslSelection: { distro: 'Ubuntu-24.04', user: 'candidate' },
          activatedWslSelection: { distro: 'Ubuntu-22.04', user: 'scientist' }
        },
        'win32'
      )
    ).toEqual({ kind: 'powershell', version: '5.1' })
  })

  it('fails closed when WSL2 Bash is selected without a complete profile', () => {
    expect(() =>
      resolveConfiguredShellRuntimeBinding({ localShellRuntime: 'wsl2-bash' }, 'win32')
    ).toThrow('The activated WSL2 Shell profile is unavailable.')
  })

  it('fails closed for a legacy WSL preference that has only an unactivated candidate', () => {
    expect(() =>
      resolveConfiguredShellRuntimeBinding(
        {
          localShellRuntime: 'wsl2-bash',
          wslSelection: { distro: 'Ubuntu-22.04', user: 'scientist' }
        },
        'win32'
      )
    ).toThrow('activated WSL2 Shell profile is unavailable')
  })

  it('binds WSL2 Bash to the exact selected profile without host fallback', () => {
    const binding = resolveConfiguredShellRuntimeBinding(
      {
        localShellRuntime: 'wsl2-bash',
        wslSelection: { distro: 'Ubuntu-24.04', user: 'candidate' },
        activatedWslSelection: { distro: 'Ubuntu-22.04', user: 'scientist' }
      },
      'win32'
    )

    expect(binding).toMatchObject({
      kind: 'wsl2-bash',
      distro: 'Ubuntu-22.04',
      user: 'scientist'
    })
    expect(binding).toHaveProperty('profileId')
    expect(Object.isFrozen(binding)).toBe(true)
  })
})

describe('resolveAvailableShellRuntimeBinding', () => {
  it('falls back to PowerShell when the activated WSL profile fails its readiness check', async () => {
    const settings = {
      localShellRuntime: 'wsl2-bash' as const,
      activatedWslSelection: { distro: 'Ubuntu-22.04', user: 'scientist' }
    }
    await expect(
      resolveAvailableShellRuntimeBinding(settings, async () => false, 'win32')
    ).resolves.toEqual({ kind: 'powershell', version: '5.1' })
  })
})

it.each([false, 'throw', 'missing'] as const)(
  'uses PowerShell when WSL readiness is %s',
  async (failure) => {
    const probe = vi.fn(async () => {
      if (failure === 'throw') throw new Error('WSL unavailable')
      return false
    })
    await expect(
      resolveAvailableShellRuntimeBinding(
        {
          localShellRuntime: 'wsl2-bash',
          ...(failure === 'missing'
            ? {}
            : { activatedWslSelection: { distro: 'Ubuntu', user: 'user' } })
        },
        probe,
        'win32'
      )
    ).resolves.toEqual({ kind: 'powershell', version: '5.1' })
    if (failure === 'missing') expect(probe).not.toHaveBeenCalled()
  }
)

it('checks the activated profile rather than the candidate and preserves a ready WSL binding', async () => {
  const active = { distro: 'Ubuntu', user: 'active' }
  const probe = vi.fn(async () => true)
  const settings = {
    localShellRuntime: 'wsl2-bash' as const,
    activatedWslSelection: active,
    wslSelection: { distro: 'Debian', user: 'candidate' }
  }
  expect(await resolveAvailableShellRuntimeBinding(settings, probe, 'win32')).toEqual(
    resolveConfiguredShellRuntimeBinding(settings, 'win32')
  )
  expect(probe).toHaveBeenCalledExactlyOnceWith(active)
})

it('does not probe WSL for the PowerShell preference', async () => {
  const probe = vi.fn()
  expect(
    await resolveAvailableShellRuntimeBinding({ localShellRuntime: 'powershell' }, probe, 'win32')
  ).toEqual({ kind: 'powershell', version: '5.1' })
  expect(probe).not.toHaveBeenCalled()
})
