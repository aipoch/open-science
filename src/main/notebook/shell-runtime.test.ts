import { describe, expect, it } from 'vitest'

import {
  captureShellRuntimeBinding,
  defaultShellRuntimeBinding,
  shellRuntimeAgentContract,
  shellRuntimeDialect,
  shellRuntimePlatform,
  shellRuntimeSandboxTarget
} from './shell-runtime'

describe('shell runtime binding', () => {
  it.each([
    ['win32', { kind: 'powershell', version: '5.1' }],
    ['linux', { kind: 'native-posix', shell: '/bin/sh' }],
    ['darwin', { kind: 'native-posix', shell: '/bin/sh' }]
  ] as const)('keeps the existing %s default', (platform, expected) => {
    expect(defaultShellRuntimeBinding(platform)).toEqual(expected)
  })

  it('captures an immutable WSL binding and derives every execution facet from it', () => {
    const selected = {
      kind: 'wsl2-bash' as const,
      profileId: 'profile-1',
      distro: 'Ubuntu-22.04',
      user: 'researcher'
    }
    const binding = captureShellRuntimeBinding(selected)

    selected.user = 'changed-after-capture'

    expect(binding).toEqual({
      kind: 'wsl2-bash',
      profileId: 'profile-1',
      distro: 'Ubuntu-22.04',
      user: 'researcher'
    })
    expect(Object.isFrozen(binding)).toBe(true)
    expect(shellRuntimeDialect(binding)).toBe('posix')
    expect(shellRuntimeSandboxTarget(binding)).toEqual({
      kind: 'wsl2',
      profileId: 'profile-1',
      distro: 'Ubuntu-22.04',
      user: 'researcher'
    })
    const agentContract = shellRuntimeAgentContract(binding)
    expect(agentContract.commandDescription).toContain('WSL2 Bash')
    expect(agentContract.executionDescription).toContain('selected sandboxed WSL2 profile')
    expect(agentContract.sessionInstruction).toContain(
      'even though the host and workspace path are Windows'
    )
    expect(JSON.stringify(agentContract)).not.toMatch(/profile-1|Ubuntu-22\.04|researcher/)
    expect(Object.isFrozen(agentContract)).toBe(true)
  })

  it.each([
    [{ kind: 'native-posix', shell: '/bin/sh' }, 'darwin', 'darwin'],
    [{ kind: 'native-posix', shell: '/bin/sh' }, 'linux', 'linux'],
    [{ kind: 'powershell', version: '5.1' }, 'win32', 'win32'],
    [
      {
        kind: 'wsl2-bash',
        profileId: 'profile-1',
        distro: 'Ubuntu-22.04',
        user: 'researcher'
      },
      'win32',
      'linux'
    ]
  ] as const)('derives execution platform %s on host %s as %s', (binding, host, expected) => {
    expect(shellRuntimePlatform(binding, host)).toBe(expected)
  })

  it('keeps an arbitrary native shell path out of every Agent-facing contract string', () => {
    const contract = shellRuntimeAgentContract({
      kind: 'native-posix',
      shell: '/private/custom-shell'
    })

    expect(JSON.stringify(contract)).not.toContain('/private/custom-shell')
    expect(contract.commandDescription).toContain('native POSIX shell')
    expect(contract.executionDescription).toContain('native POSIX shell')
    expect(contract.sessionInstruction).toContain('native POSIX shell')
  })
})
