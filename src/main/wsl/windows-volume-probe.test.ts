import { describe, expect, it, vi } from 'vitest'

import { probeWindowsVolume, type WindowsVolumeCommand } from './windows-volume-probe'

const commandWith = (stdout: string, exitCode = 0): WindowsVolumeCommand => ({
  run: vi.fn(async () => ({ stdout, stderr: '', exitCode }))
})

describe('probeWindowsVolume', () => {
  it.each([
    ['fixed NTFS', '{"driveType":3,"fileSystem":"NTFS","isReady":true}', 'local-ntfs'],
    ['mapped network drive', '{"driveType":4,"fileSystem":"NTFS","isReady":true}', 'not-local'],
    ['fixed exFAT', '{"driveType":3,"fileSystem":"exFAT","isReady":true}', 'not-ntfs'],
    ['fixed ReFS', '{"driveType":3,"fileSystem":"ReFS","isReady":true}', 'not-ntfs']
  ])('classifies %s from stable DriveInfo JSON', async (_label, stdout, kind) => {
    await expect(probeWindowsVolume('Z:\\science', commandWith(stdout))).resolves.toMatchObject({
      kind
    })
  })

  it('fails closed when the Windows volume API cannot describe the path', async () => {
    await expect(probeWindowsVolume('Z:\\science', commandWith('not-json'))).resolves.toEqual({
      kind: 'unavailable'
    })
  })
})
