import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const childProcessMocks = vi.hoisted(() => ({ execFileSync: vi.fn() }))

vi.mock('node:child_process', () => childProcessMocks)

import {
  hardenWindowsCacheAcl,
  hardenWindowsCacheAclWithIcacls,
  readWindowsCacheAcl
} from './micromamba-cache'

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

  it('falls back to the system ACL tool when PowerShell execution is denied', () => {
    childProcessMocks.execFileSync.mockImplementationOnce(() => {
      throw Object.assign(new Error('spawnSync powershell.exe EPERM'), { code: 'EPERM' })
    })
    childProcessMocks.execFileSync.mockReturnValueOnce('CONTOSO\\alice,S-1-5-21-1000\r\n')

    expect(hardenWindowsCacheAcl('D:\\osp-cache')).toBe(true)

    expect(childProcessMocks.execFileSync).toHaveBeenCalledTimes(3)
    expect(childProcessMocks.execFileSync).toHaveBeenNthCalledWith(
      2,
      'C:\\Windows\\System32\\whoami.exe',
      ['/user', '/fo', 'csv', '/nh'],
      { encoding: 'utf8', windowsHide: true }
    )
    expect(childProcessMocks.execFileSync).toHaveBeenNthCalledWith(
      3,
      'C:\\Windows\\System32\\icacls.exe',
      [
        'D:\\osp-cache',
        '/inheritance:r',
        '/grant:r',
        '*S-1-5-21-1000:(OI)(CI)F',
        '*S-1-5-18:(OI)(CI)F',
        '*S-1-5-32-544:(OI)(CI)F'
      ],
      { encoding: 'utf8', windowsHide: true }
    )
  })

  it('propagates current-user SID lookup failures from the fallback ACL tool', () => {
    childProcessMocks.execFileSync.mockReset()
    childProcessMocks.execFileSync.mockImplementationOnce(() => {
      throw new Error('whoami failed')
    })

    expect(() => hardenWindowsCacheAclWithIcacls('D:\\osp-cache')).toThrow('whoami failed')
    expect(childProcessMocks.execFileSync).toHaveBeenCalledOnce()
  })

  it('propagates DACL update failures from the fallback ACL tool', () => {
    childProcessMocks.execFileSync.mockReset()
    childProcessMocks.execFileSync.mockReturnValueOnce('CONTOSO\\alice,S-1-5-21-1000\r\n')
    childProcessMocks.execFileSync.mockImplementationOnce(() => {
      throw new Error('icacls failed')
    })

    expect(() => hardenWindowsCacheAclWithIcacls('D:\\osp-cache')).toThrow('icacls failed')
    expect(childProcessMocks.execFileSync).toHaveBeenCalledTimes(2)
  })

  it('uses the independent ACL fallback for non-permission PowerShell failures too', () => {
    childProcessMocks.execFileSync.mockImplementationOnce(() => {
      throw Object.assign(new Error('PowerShell command failed'), { code: 'UNKNOWN' })
    })
    childProcessMocks.execFileSync.mockReturnValueOnce('CONTOSO\\alice,S-1-5-21-1000\r\n')

    expect(hardenWindowsCacheAcl('D:\\osp-cache')).toBe(true)
    expect(childProcessMocks.execFileSync).toHaveBeenCalledTimes(3)
  })
})
