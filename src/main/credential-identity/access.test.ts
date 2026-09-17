import { describe, expect, it, vi, type Mock, type Mocked } from 'vitest'
import type { SecureStorageCipher } from '../secure-storage'
import { createCredentialAccess } from './access'
import type { CredentialIdentity } from './selection'

const identity: CredentialIdentity = {
  backend: 'mac-keychain',
  appName: 'Open Science',
  exists: true
}
const fixture = (
  selected = identity
): {
  cipher: Mocked<SecureStorageCipher>
  probe: Mock<() => { status: 'exists' }>
  recover: Mock
  access: ReturnType<typeof createCredentialAccess>
} => {
  const cipher = {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((v: string) => Buffer.from(`legacy:${v}`)),
    decryptString: vi.fn((v: Buffer) => {
      if (!v.toString().startsWith('legacy:')) throw new Error('bad ciphertext')
      return v.toString().slice(7)
    })
  }
  const recover = vi.fn()
  const probe = vi.fn(() => ({ status: 'exists' as const }))
  return {
    cipher,
    probe,
    recover,
    access: createCredentialAccess({ identity: selected, cipher, probe, recover })
  }
}

describe('process credential access', () => {
  it('reads old ciphertext with the one selected identity, without a second name lookup', () => {
    const { access, cipher, probe } = fixture()
    expect(access.decryptString(Buffer.from('legacy:old-secret'))).toBe('old-secret')
    expect(access.encryptString('next').toString()).toBe('legacy:next')
    expect(cipher.decryptString).toHaveBeenCalledTimes(1)
    expect(probe.mock.calls).toEqual([['Open Science']])
  })

  it('locks all future secret writes on decryption failure and emits recovery once', () => {
    const current: CredentialIdentity = {
      backend: 'mac-keychain',
      appName: 'Open-Science',
      exists: true
    }
    const { access, cipher, probe, recover } = fixture(current)
    expect(() => access.decryptString(Buffer.from('foreign:old'))).toThrow(/recovery/i)
    expect(() => access.encryptString('replacement')).toThrow(/recovery/i)
    expect(access.isEncryptionAvailable()).toBe(false)
    expect(cipher.encryptString).not.toHaveBeenCalled()
    expect(probe.mock.calls).toEqual([['Open-Science']])
    expect(recover).toHaveBeenCalledTimes(1)
  })

  it('does not create a replacement if a selected existing item disappears before first access', () => {
    const { cipher, recover } = fixture()
    const access = createCredentialAccess({
      identity,
      cipher,
      recover,
      probe: () => ({ status: 'not-found' })
    })
    expect(() => access.encryptString('replacement')).toThrow(/recovery/i)
    expect(cipher.isEncryptionAvailable).not.toHaveBeenCalled()
    expect(cipher.encryptString).not.toHaveBeenCalled()
  })

  it.each(['access-blocked', 'error'] as const)(
    'does not call safeStorage when recheck is %s',
    (status) => {
      const { cipher, recover } = fixture()
      const access = createCredentialAccess({
        identity,
        cipher,
        recover,
        probe: () => ({ status })
      })
      expect(() => access.isEncryptionAvailable()).toThrow(/recovery/i)
      expect(cipher.isEncryptionAvailable).not.toHaveBeenCalled()
    }
  )

  it('permits first creation only for a fresh selection and reuses the process cipher', () => {
    const { cipher, recover } = fixture()
    const probe = vi.fn(() => ({ status: 'not-found' as const }))
    const access = createCredentialAccess({
      identity: { ...identity, exists: false },
      cipher,
      recover,
      probe
    })
    expect(access.encryptString('first')).toBeInstanceOf(Buffer)
    expect(access.encryptString('second')).toBeInstanceOf(Buffer)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('does not create on a read even if the selected identity was originally absent', () => {
    const { cipher, recover } = fixture()
    const access = createCredentialAccess({
      identity: { ...identity, exists: false },
      cipher,
      recover,
      probe: () => ({ status: 'not-found' })
    })
    expect(() => access.decryptString(Buffer.from('legacy:orphaned'))).toThrow(/recovery/i)
    expect(cipher.isEncryptionAvailable).not.toHaveBeenCalled()
    expect(cipher.decryptString).not.toHaveBeenCalled()
  })
})

it.each(['false', 'throw'] as const)(
  'latches failed actual key availability (%s) before any write or decrypt',
  (mode) => {
    const { cipher, recover, access } = fixture()
    cipher.isEncryptionAvailable.mockImplementation(() => {
      if (mode === 'throw') throw new Error('OS denied key access')
      return false
    })
    expect(() => access.isEncryptionAvailable()).toThrow(/recovery/i)
    expect(() => access.encryptString('replacement')).toThrow(/recovery/i)
    expect(() => access.decryptString(Buffer.from('legacy:original'))).toThrow(/recovery/i)
    expect(cipher.encryptString).not.toHaveBeenCalled()
    expect(cipher.decryptString).not.toHaveBeenCalled()
    expect(recover).toHaveBeenCalledOnce()
  }
)

it('does not treat an availability call as permission to read orphaned history on a fresh identity', () => {
  const { access, cipher } = fixture({ ...identity, exists: false })
  expect(access.isEncryptionAvailable()).toBe(true)
  expect(() => access.decryptString(Buffer.from('legacy:orphaned'))).toThrow(/recovery/i)
  expect(cipher.decryptString).not.toHaveBeenCalled()
})

it('a concurrent first-creation loser stops without overwriting the winning key or retrying another name', async () => {
  const stored = { key: '', creates: 0 }
  const make = (label: string): ReturnType<typeof createCredentialAccess> => {
    const cipher = {
      isEncryptionAvailable: () => true,
      decryptString: () => '',
      encryptString: (value: string) => {
        stored.creates++
        if (stored.key) throw new Error('duplicate keychain item')
        stored.key = label
        return Buffer.from(value)
      }
    }
    return createCredentialAccess({
      identity: { ...identity, exists: false },
      cipher,
      probe: () => ({ status: 'not-found' }),
      recover: () => {}
    })
  }
  const winner = make('winner'),
    loser = make('loser')
  const outcomes = await Promise.allSettled([
    Promise.resolve().then(() => winner.encryptString('first')),
    Promise.resolve().then(() => loser.encryptString('second'))
  ])
  expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'rejected'])
  expect(() => loser.encryptString('retry')).toThrow(/recovery/i)
  expect(stored).toEqual({ key: 'winner', creates: 2 })
})

it('preserves safe macOS recheck diagnostics in the final redacted recovery log', async () => {
  const { cipher } = fixture()
  const { formatLine } = await import('../logger')
  const lines: string[] = []
  const access = createCredentialAccess({
    identity,
    cipher,
    probe: () => ({
      status: 'access-blocked',
      reason: 'keychain-search-list-changed',
      osStatus: 0
    }),
    recover: (error) =>
      lines.push(
        formatLine('error', 'credentials', 'access failed', {
          recoveryReason: error.reason,
          identityProbe: error.probe
        })
      )
  })
  expect(() => access.decryptString(Buffer.from('legacy:old'))).toThrow(/recovery/i)
  expect(() => access.encryptString('replacement')).toThrow(/recovery/i)
  expect(cipher.decryptString).not.toHaveBeenCalled()
  expect(cipher.encryptString).not.toHaveBeenCalled()
  expect(lines).toHaveLength(1)
  expect(JSON.parse(lines[0]).data.identityProbe).toEqual({
    appName: 'Open Science',
    status: 'access-blocked',
    reason: 'keychain-search-list-changed',
    osStatus: 0
  })
})
