import { describe, expect, it } from 'vitest'
import {
  assertInstallationChannelCertified,
  usesSupervisedInstall,
  type ChannelAcceptance,
  type InstallationChannel
} from './channel-certification'

const evidence = (): ChannelAcceptance => ({
  evidence: 'isolated test evidence',
  platform: process.platform,
  architecture: process.arch
})

describe('usesSupervisedInstall', () => {
  it('is false for every channel while no acceptance evidence exists', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const)
      expect(usesSupervisedInstall(platform, '/tmp/update.bin')).toBe(false)
  })

  it('routes certified darwin and linux channels to the supervised path', () => {
    expect(usesSupervisedInstall('darwin', '/t/a.zip', { 'mac-zip': evidence() })).toBe(true)
    expect(usesSupervisedInstall('linux', '/t/a.deb', { 'linux-deb': evidence() })).toBe(true)
    expect(usesSupervisedInstall('linux', '/t/a.AppImage', { 'linux-appimage': evidence() })).toBe(
      true
    )
    expect(usesSupervisedInstall('linux', '/t/a.AppImage', { 'linux-deb': evidence() })).toBe(false)
  })

  it('keeps win32 on the legacy handoff even with evidence', () => {
    expect(usesSupervisedInstall('win32', '/t/a.exe', { 'windows-nsis': evidence() })).toBe(false)
  })
})

it.each(['mac-zip', 'windows-nsis', 'linux-appimage', 'linux-deb'] as InstallationChannel[])(
  'keeps uncertified %s closed without changing download state',
  (channel) => {
    expect(() => assertInstallationChannelCertified(channel)).toThrow(
      'not passed installed-package acceptance'
    )
    expect(() =>
      assertInstallationChannelCertified(channel, {
        [channel]: {
          evidence: 'isolated test evidence',
          platform: process.platform,
          architecture: process.arch
        }
      })
    ).not.toThrow()
    expect(() =>
      assertInstallationChannelCertified(channel, {
        [channel]: { evidence: '', platform: process.platform, architecture: process.arch }
      })
    ).toThrow()
  }
)
