import { expect, it } from 'vitest'
import { credentialRecoveryMessage } from './recovery'
import { CredentialIdentityError } from './selection'
import { inventoryDiagnosticSchema, windowsCredentialDiagnosticSchema } from './diagnostic'
import { initLogger, writeFatalLogSync } from '@aipoch/diagnostics/node'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readCredentialCiphertexts } from './ciphertext-inventory'
import { DatabaseSync } from 'node:sqlite'

it.each(['journal', 'credentials', 'pending', 'database'])(
  'explains the actual %s inventory failure without suggesting key recovery',
  (kind) => {
    const root = mkdtempSync(join(tmpdir(), 'private-inventory-'))
    try {
      const path = join(root, 'open-science.db')
      if (kind === 'journal') {
        const db = new DatabaseSync(path)
        db.exec('CREATE TABLE fixture(value TEXT)')
        db.close()
        writeFileSync(`${path}-journal`, Buffer.from([1]))
      } else if (kind === 'credentials') {
        writeFileSync(join(root, 'credentials.json'), '{PRIVATE-SECRET')
      } else if (kind === 'pending') {
        writeFileSync(join(root, 'credentials.json.crash.tmp'), 'PRIVATE-SECRET')
      } else writeFileSync(path, 'PRIVATE-SECRET is not a database')
      const contents = (): Record<string, Buffer> =>
        Object.fromEntries(readdirSync(root).map((name) => [name, readFileSync(join(root, name))]))
      const before = contents()
      let failure: unknown
      try {
        readCredentialCiphertexts({ configRoot: root, profilePath: join(root, 'profile') })
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(CredentialIdentityError)
      expect((failure as CredentialIdentityError).reason).toBe('ciphertext-inventory-unavailable')
      const message = credentialRecoveryMessage(failure as CredentialIdentityError, ['en'])
      const expected = {
        journal: [
          'Affected data: Application database',
          'Stage: Checking database journals',
          'The rollback journal header is incomplete.'
        ],
        credentials: [
          'Affected data: Credential configuration',
          'Stage: Parsing configuration',
          'The configuration is not valid JSON.'
        ],
        pending: [
          'Affected data: Credential configuration',
          'Stage: Reading files',
          'An unfinished configuration write needs recovery.'
        ],
        database: [
          'Affected data: Application database',
          'Stage: Reading database contents',
          'The database could not be read.'
        ]
      }[kind]!
      for (const text of expected) expect(message).toContain(text)
      expect(message).toContain(
        'Startup has stopped. This check has not modified the original data.'
      )
      expect(message).not.toContain('Unlock the system credential store')
      expect(message).not.toContain(root)
      expect(message).not.toContain('PRIVATE-SECRET')
      expect(contents()).toEqual(before)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)

it('does not suggest key recovery when an older inventory error has no details', () => {
  const message = credentialRecoveryMessage(
    new CredentialIdentityError('ciphertext-inventory-unavailable'),
    ['en']
  )
  expect(message).toContain('The failing data source and exact cause are unknown.')
  expect(message).not.toContain('Unlock the system credential store')
})

it.each(inventoryDiagnosticSchema.shape.reason.options)(
  'localizes inventory reason %s and its object and stage in every shipped language',
  (reason) => {
    const index = inventoryDiagnosticSchema.shape.reason.options.indexOf(reason)
    const sources = inventoryDiagnosticSchema.shape.source.options
    const stages = inventoryDiagnosticSchema.shape.stage.options
    const error = new CredentialIdentityError('ciphertext-inventory-unavailable', undefined, {
      code: 'inventory-failed',
      source: sources[index % sources.length],
      stage: stages[index % stages.length],
      reason
    })
    const english = credentialRecoveryMessage(error, ['en'])
    const englishDetails = english
      .split('\n')
      .filter((line) => /^(Affected data|Stage|Failure reason):/.test(line))
    expect(englishDetails).toHaveLength(3)
    for (const locale of ['de', 'es', 'fr', 'ja', 'ko', 'ru', 'zh-CN', 'zh-TW']) {
      const translated = credentialRecoveryMessage(error, [locale])
      expect(translated).toContain('CREDENTIAL_DETAIL: inventory-failed')
      for (const detail of englishDetails) expect(translated).not.toContain(detail.split(': ')[1])
    }
  }
)

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

it.each(windowsCredentialDiagnosticSchema.shape.code.options)(
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
