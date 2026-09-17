import { expect, it } from 'vitest'
import { credentialRecoveryMessage } from './recovery'
import { CredentialIdentityError } from './selection'

it.each(['linux-backend-unsupported:KWallet', 'linux-secret-service-metadata-unavailable'])(
  'explains Linux recovery without suggesting a backend or profile switch: %s',
  (reason) => {
    const english = credentialRecoveryMessage(new CredentialIdentityError(reason), ['en'])
    expect(english).toContain('/usr/bin/busctl')
    expect(english).toContain('without changing the backend or profile')
    const chinese = credentialRecoveryMessage(new CredentialIdentityError(reason), ['zh-CN'])
    expect(chinese).toContain('原有的默认密钥环')
    expect(chinese).toContain(reason)
  }
)

it.each(['keychain-locked', 'keychain-search-incomplete', 'keychain-state-changed'])(
  'includes the concrete macOS probe code in localized recovery guidance: %s',
  (reason) => {
    const error = new CredentialIdentityError('probe-access-blocked', {
      appName: 'Open-Science',
      status: 'access-blocked',
      reason,
      osStatus: 0
    })
    for (const locale of ['en', 'zh-CN']) {
      const message = credentialRecoveryMessage(error, [locale])
      expect(message).toContain('probe-access-blocked')
      expect(message).toContain(reason)
    }
  }
)
