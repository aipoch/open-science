import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const childProcessMocks = vi.hoisted(() => ({ execFileSync: vi.fn() }))

vi.mock('node:child_process', () => childProcessMocks)

import { hardenWindowsCacheAcl, readWindowsCacheAcl } from './micromamba-cache'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

describe('Windows micromamba cache PowerShell invocation', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    childProcessMocks.execFileSync.mockReset().mockReturnValue(
      JSON.stringify({
        OwnerSid: 'S-1-5-21-current',
        CurrentSid: 'S-1-5-21-current',
        Rules: []
      })
    )
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform!)
    vi.unstubAllEnvs()
  })

  it('uses the system PowerShell executable for ACL writes and reads without relying on PATH', () => {
    hardenWindowsCacheAcl('D:\\osp-cache')
    readWindowsCacheAcl('D:\\osp-cache')

    expect(childProcessMocks.execFileSync).toHaveBeenCalledTimes(2)
    for (const [executable] of childProcessMocks.execFileSync.mock.calls) {
      expect(executable).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    }
  })
})
