import { describe, expect, it } from 'vitest'

import { resolveConfiguredShellRuntimeBinding } from './configured-shell-runtime'

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
