import { expect, it } from 'vitest'
import {
  assertInstallationChannelCertified,
  type InstallationChannel
} from './channel-certification'
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
