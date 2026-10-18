import { expect, it } from 'vitest'
import { credentialRecoveryMessage } from './recovery'
import { CredentialIdentityError } from './selection'
import { credentialDiagnosticSchema } from './diagnostic'
import { initLogger, writeFatalLogSync } from '@aipoch/diagnostics/node'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

it('preserves safe diagnostics in the real synchronous fatal log sink', () => {
  const logDir = mkdtempSync(join(tmpdir(), 'credential-diagnostic-log-'))
  try {
    initLogger({ logDir, mirrorToConsole: false })
    const error = new CredentialIdentityError('windows-profile-key-unavailable', undefined, {
      code: 'profile-read-failed',
      systemCode: 'EBUSY'
    })
    writeFatalLogSync('desktop-bootstrap', 'desktop startup failed', {
      validationDiagnostic: error.diagnostic
    })
    expect(
      JSON.parse(readFileSync(join(logDir, 'main.log'), 'utf8')).data.validationDiagnostic
    ).toEqual({ code: 'profile-read-failed', systemCode: 'EBUSY' })
  } finally {
    rmSync(logDir, { recursive: true, force: true })
  }
})

it('shows the specific Windows file-lock reason and safe system code', () => {
  const error = new CredentialIdentityError('windows-profile-key-unavailable', undefined, {
    code: 'profile-read-failed',
    systemCode: 'EBUSY'
  })
  const message = credentialRecoveryMessage(error, ['zh-CN'])
  expect(message).toContain('Local State 正被其他进程占用。')
  expect(message).toContain('CREDENTIAL_DETAIL: profile-read-failed')
  expect(message).toContain('SYSTEM_ERROR: EBUSY')
  expect(message).toContain('现有凭据未被替换')
})

it.each(credentialDiagnosticSchema.shape.code.options)(
  'localizes Windows diagnostic %s in every shipped language',
  (code) => {
    const error = new CredentialIdentityError('windows-profile-key-unavailable', undefined, {
      code
    })
    const english = credentialRecoveryMessage(error, ['en'])
    const englishDetail = english
      .split('CREDENTIAL_IDENTITY: windows-profile-key-unavailable\n\n')[1]
      .split('\n')[0]
    for (const locale of ['de', 'es', 'fr', 'ja', 'ko', 'ru', 'zh-CN', 'zh-TW']) {
      const message = credentialRecoveryMessage(error, [locale])
      expect(message).toContain(`CREDENTIAL_DETAIL: ${code}`)
      expect(message).not.toContain(englishDetail)
    }
  }
)

it('rejects untrusted diagnostics at the error boundary', () => {
  const error = new CredentialIdentityError('windows-profile-key-unavailable', undefined, {
    code: 'profile-read-failed',
    systemCode: 'PRIVATE-PATH',
    secret: 'PRIVATE-SECRET'
  } as never)
  expect(error.diagnostic).toBeUndefined()
  expect(credentialRecoveryMessage(error, ['en'])).not.toContain('PRIVATE-')
})

it.each(['linux-backend-unsupported:KWallet', 'linux-secret-service-metadata-unavailable'])(
  'explains Linux recovery without suggesting a backend or profile switch: %s',
  (reason) => {
    const english = credentialRecoveryMessage(new CredentialIdentityError(reason), ['en'])
    expect(english).toContain('/usr/bin/busctl')
    expect(english).toContain('KWallet')
    expect(english).toContain('Do not change the password-store backend or profile')
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

it('distinguishes unsupported ciphertext from an unsupported OS credential backend', () => {
  const message = credentialRecoveryMessage(
    new CredentialIdentityError('unsupported-ciphertext-version'),
    ['en']
  )
  expect(message).toContain('encrypted data format')
  expect(message).not.toContain('not supported by this system credential backend')
})
