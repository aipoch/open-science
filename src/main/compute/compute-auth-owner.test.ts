import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: {}
}))

import type { ChangeComputeHostAuthenticationRequest, ComputeHost } from '../../shared/compute'
import { ComputeAuthOwner, type ComputeAuthRepository } from './compute-auth-owner'
import { PasswordSshAdapter } from './connection-adapters'
import {
  ComputeConnectionError,
  SshConfigComputeConnectionBroker,
  type ComputeConnectionLease
} from './connection-broker'
import { CredentialVault } from './credential-vault'
import type { SshRunner } from './ssh-runner'

const publicHost = (): ComputeHost =>
  ({
    id: 'host-1',
    providerId: 'ssh:cluster',
    displayName: 'Cluster',
    sshAlias: 'cluster',
    sshOverrides: { user: 'researcher', port: 22 },
    authentication: {
      mode: 'password',
      credentialStatus: 'configured',
      revision: 1,
      lastVerifiedAt: Date.parse('2026-08-17T00:00:00.000Z')
    }
  }) as ComputeHost

const resetHost = (): ComputeHost => ({
  ...publicHost(),
  authentication: {
    mode: 'password',
    credentialStatus: 'configured',
    revision: 2,
    lastVerifiedAt: Date.parse('2026-08-17T01:00:00.000Z')
  }
})

const authRepository = (overrides: Partial<ComputeAuthRepository> = {}): ComputeAuthRepository => ({
  getAuthenticationOperation: vi.fn(async () => null),
  preparePasswordCreate: vi.fn(async () => ({ kind: 'ready' as const })),
  createPasswordHost: vi.fn(async () => publicHost()),
  preparePasswordReset: vi.fn(async () => ({ kind: 'ready' as const, host: publicHost() })),
  resetPasswordHost: vi.fn(async () => resetHost()),
  get: vi.fn(async () => publicHost()),
  changeAuthentication: vi.fn(async () => publicHost()),
  ...overrides
})

const credentialVault = (
  overrides: Partial<Pick<CredentialVault, 'encrypt' | 'bindOperationIntent'>> = {}
): Pick<CredentialVault, 'encrypt' | 'bindOperationIntent'> => ({
  encrypt: vi.fn(() => Buffer.from('ciphertext')),
  bindOperationIntent: vi.fn(
    (_intent, existingFingerprint) => existingFingerprint ?? 'test-protected-fingerprint'
  ),
  ...overrides
})

const successfulLease = (): ComputeConnectionLease => ({
  run: vi.fn(async () => ({
    exitCode: 0,
    stdout: '',
    stderr: '',
    truncated: false,
    timedOut: false
  })),
  upload: vi.fn(async () => undefined),
  download: vi.fn(async () => ({
    exitCode: 0,
    stderr: '',
    timedOut: false,
    bytesWritten: 0,
    exceeded: false
  }))
})

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const setup = () => {
  const createPasswordHost = vi.fn(async () => publicHost())
  const repository = authRepository({ createPasswordHost })
  const acquireWithPassword = vi.fn(async () => successfulLease())
  const encrypt = vi.fn(() => Buffer.from('ciphertext'))
  const owner = new ComputeAuthOwner({
    repository,
    vault: credentialVault({ encrypt }),
    passwordAdapter: { acquireWithPassword } as unknown as PasswordSshAdapter,
    now: () => new Date('2026-08-17T00:00:00.000Z')
  })
  return { owner, createPasswordHost, acquireWithPassword, encrypt }
}

describe('Compute password-host application handler', () => {
  it('fences an old connection lease after a password reset commits', async () => {
    const transportRun = vi.fn(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    }))
    const broker = new SshConfigComputeConnectionBroker({
      getHost: vi.fn(async () => publicHost()),
      runner: { run: transportRun },
      passwordAdapter: {
        acquire: vi.fn(async () => ({
          run: transportRun,
          upload: vi.fn(),
          download: vi.fn()
        }))
      }
    })
    const oldLease = await broker.acquire('ssh:cluster', { intent: 'direct_command' })
    const owner = new ComputeAuthOwner({
      repository: authRepository({
        preparePasswordReset: vi.fn(async () => ({ kind: 'ready' as const, host: publicHost() })),
        resetPasswordHost: vi.fn(async () => resetHost())
      }),
      vault: credentialVault({
        encrypt: vi.fn(() => Buffer.from('replacement ciphertext'))
      }),
      passwordAdapter: {
        acquireWithPassword: vi.fn(async () => successfulLease())
      } as unknown as PasswordSshAdapter,
      invalidateAuthenticationIdentity: (providerId) =>
        broker.invalidateAuthenticationIdentity(providerId)
    })

    await owner.resetPassword({
      providerId: 'ssh:cluster',
      password: 'replacement secret',
      operationId: 'reset-operation-fence',
      expectedAuthenticationRevision: 1
    })

    await expect(oldLease.run('old work', { timeoutMs: 1000 })).rejects.toMatchObject({
      code: 'credential_conflict'
    })
    expect(transportRun).not.toHaveBeenCalled()
  })

  it('rejects a reset replay when the same operation identifier carries a different password', async () => {
    const vault = new CredentialVault(
      { getCredential: vi.fn(async () => null) },
      {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => 'gnome_libsecret',
        encryptString: (value) => Buffer.from(`encrypted:${value}`),
        decryptString: (value) => value.toString().replace(/^encrypted:/, '')
      },
      'linux'
    )
    const requestFingerprint = vault.bindOperationIntent(
      JSON.stringify(['reset_password', 'ssh:cluster', 1, 'original password'])
    )
    const preparePasswordReset = vi.fn()
    const owner = new ComputeAuthOwner({
      repository: authRepository({
        getAuthenticationOperation: vi.fn(async () => ({ requestFingerprint })),
        preparePasswordReset
      }),
      vault,
      passwordAdapter: {} as PasswordSshAdapter
    })

    await expect(
      owner.resetPassword({
        providerId: 'ssh:cluster',
        password: 'replacement password',
        operationId: 'reset-operation-1',
        expectedAuthenticationRevision: 1
      })
    ).rejects.toMatchObject({ code: 'credential_conflict' })
    expect(preparePasswordReset).not.toHaveBeenCalled()
  })

  it('validates a password reset before atomically advancing its authentication revision', async () => {
    const acquireWithPassword = vi.fn(async () => successfulLease())
    const preparePasswordReset = vi.fn(async () => ({ kind: 'ready' as const, host: publicHost() }))
    const resetPasswordHost = vi.fn(async () => resetHost())
    const encrypt = vi.fn(() => Buffer.from('replacement ciphertext'))
    const owner = new ComputeAuthOwner({
      repository: authRepository({
        createPasswordHost: vi.fn(),
        preparePasswordReset,
        resetPasswordHost
      }),
      vault: credentialVault({ encrypt }),
      passwordAdapter: { acquireWithPassword } as unknown as PasswordSshAdapter,
      now: () => new Date('2026-08-17T01:00:00.000Z')
    })

    const result = await owner.resetPassword({
      providerId: 'ssh:cluster',
      password: ' replacement password ',
      operationId: 'reset-operation-1',
      expectedAuthenticationRevision: 1
    })

    expect(preparePasswordReset).toHaveBeenCalledWith({
      providerId: 'ssh:cluster',
      operationId: 'reset-operation-1',
      requestFingerprint: 'test-protected-fingerprint',
      expectedAuthenticationRevision: 1
    })
    expect(acquireWithPassword).toHaveBeenCalledBefore(resetPasswordHost)
    expect(resetPasswordHost).toHaveBeenCalledWith({
      providerId: 'ssh:cluster',
      operationId: 'reset-operation-1',
      requestFingerprint: 'test-protected-fingerprint',
      expectedAuthenticationRevision: 1,
      ciphertext: Buffer.from('replacement ciphertext'),
      verifiedAt: new Date('2026-08-17T01:00:00.000Z')
    })
    expect(result.authentication?.revision).toBe(2)
  })

  it('serializes reset operations per Host so a stale request cannot validate after rotation', async () => {
    let releaseValidation!: () => void
    const validationGate = new Promise<void>((resolve) => {
      releaseValidation = resolve
    })
    const acquireWithPassword = vi.fn(async () => ({
      ...successfulLease(),
      run: vi.fn(async () => {
        await validationGate
        return { exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false }
      })
    }))
    const preparePasswordReset = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'ready', host: publicHost() })
      .mockRejectedValueOnce(new ComputeConnectionError('credential_conflict'))
    const resetPasswordHost = vi.fn(async () => resetHost())
    const owner = new ComputeAuthOwner({
      repository: authRepository({
        createPasswordHost: vi.fn(),
        preparePasswordReset,
        resetPasswordHost
      }),
      vault: credentialVault({ encrypt: vi.fn(() => Buffer.from('ciphertext')) }),
      passwordAdapter: { acquireWithPassword } as unknown as PasswordSshAdapter
    })
    const request = {
      providerId: 'ssh:cluster',
      password: 'new secret',
      expectedAuthenticationRevision: 1
    }

    const first = owner.resetPassword({ ...request, operationId: 'reset-1' })
    const stale = owner.resetPassword({ ...request, operationId: 'reset-2' })
    await vi.waitFor(() => expect(acquireWithPassword).toHaveBeenCalledOnce())
    expect(preparePasswordReset).toHaveBeenCalledOnce()
    releaseValidation()

    await expect(first).resolves.toMatchObject({ authentication: { revision: 2 } })
    await expect(stale).rejects.toMatchObject({ code: 'credential_conflict' })
    expect(acquireWithPassword).toHaveBeenCalledOnce()
    expect(resetPasswordHost).toHaveBeenCalledOnce()
  })

  it('replays a committed operation without encrypting, validating, or replacing again', async () => {
    const encrypt = vi.fn()
    const acquireWithPassword = vi.fn()
    const resetPasswordHost = vi.fn()
    const owner = new ComputeAuthOwner({
      repository: authRepository({
        createPasswordHost: vi.fn(),
        preparePasswordReset: vi.fn(async () => ({ kind: 'replay' as const, host: resetHost() })),
        resetPasswordHost
      }),
      vault: credentialVault({ encrypt }),
      passwordAdapter: { acquireWithPassword } as unknown as PasswordSshAdapter
    })

    await expect(
      owner.resetPassword({
        providerId: 'ssh:cluster',
        password: 'not used',
        operationId: 'reset-1',
        expectedAuthenticationRevision: 1
      })
    ).resolves.toMatchObject({ authentication: { revision: 2 } })
    expect(encrypt).not.toHaveBeenCalled()
    expect(acquireWithPassword).not.toHaveBeenCalled()
    expect(resetPasswordHost).not.toHaveBeenCalled()
  })

  it('does not replace durable state when reset validation fails', async () => {
    const resetPasswordHost = vi.fn()
    const invalidateAuthenticationIdentity = vi.fn()
    const owner = new ComputeAuthOwner({
      repository: authRepository({
        createPasswordHost: vi.fn(),
        preparePasswordReset: vi.fn(async () => ({ kind: 'ready' as const, host: publicHost() })),
        resetPasswordHost
      }),
      vault: credentialVault({ encrypt: vi.fn(() => Buffer.from('candidate')) }),
      passwordAdapter: {
        acquireWithPassword: vi.fn(async () => {
          throw new ComputeConnectionError('authentication_failed')
        })
      } as unknown as PasswordSshAdapter,
      invalidateAuthenticationIdentity
    })

    await expect(
      owner.resetPassword({
        providerId: 'ssh:cluster',
        password: 'wrong',
        operationId: 'reset-1',
        expectedAuthenticationRevision: 1
      })
    ).rejects.toMatchObject({ code: 'authentication_failed' })
    expect(resetPasswordHost).not.toHaveBeenCalled()
    expect(invalidateAuthenticationIdentity).not.toHaveBeenCalled()
  })

  it('does not fence leases when the password reset transaction rolls back', async () => {
    const invalidateAuthenticationIdentity = vi.fn()
    const owner = new ComputeAuthOwner({
      repository: authRepository({
        preparePasswordReset: vi.fn(async () => ({ kind: 'ready' as const, host: publicHost() })),
        resetPasswordHost: vi.fn(async () => {
          throw new Error('transaction rolled back')
        })
      }),
      vault: credentialVault({ encrypt: vi.fn(() => Buffer.from('candidate')) }),
      passwordAdapter: {
        acquireWithPassword: vi.fn(async () => successfulLease())
      } as unknown as PasswordSshAdapter,
      invalidateAuthenticationIdentity
    })

    await expect(
      owner.resetPassword({
        providerId: 'ssh:cluster',
        password: 'new secret',
        operationId: 'reset-rollback',
        expectedAuthenticationRevision: 1
      })
    ).rejects.toThrow('transaction rolled back')
    expect(invalidateAuthenticationIdentity).not.toHaveBeenCalled()
  })

  it('does not validate or replace durable state when reset encryption fails', async () => {
    const acquireWithPassword = vi.fn()
    const resetPasswordHost = vi.fn()
    const owner = new ComputeAuthOwner({
      repository: authRepository({
        createPasswordHost: vi.fn(),
        preparePasswordReset: vi.fn(async () => ({ kind: 'ready' as const, host: publicHost() })),
        resetPasswordHost
      }),
      vault: credentialVault({
        encrypt: vi.fn(() => {
          throw new ComputeConnectionError('secure_storage_unavailable')
        })
      }),
      passwordAdapter: { acquireWithPassword } as unknown as PasswordSshAdapter
    })

    await expect(
      owner.resetPassword({
        providerId: 'ssh:cluster',
        password: 'new secret',
        operationId: 'reset-1',
        expectedAuthenticationRevision: 1
      })
    ).rejects.toMatchObject({ code: 'secure_storage_unavailable' })
    expect(acquireWithPassword).not.toHaveBeenCalled()
    expect(resetPasswordHost).not.toHaveBeenCalled()
  })
  it('validates the candidate before atomically creating its safe public projection', async () => {
    const { owner, createPasswordHost, acquireWithPassword, encrypt } = setup()
    const password = '  arbitrary $()\n和 Unicode  '

    const result = await owner.createPassword({
      sshAlias: ' cluster ',
      authenticationMode: 'password',
      username: ' researcher ',
      port: 22,
      password,
      operationId: 'operation-1'
    })

    expect(encrypt).toHaveBeenCalledWith(password)
    expect(acquireWithPassword).toHaveBeenCalledWith(
      expect.objectContaining({
        sshAlias: 'cluster',
        sshOverrides: { user: 'researcher', port: 22 }
      }),
      password,
      expect.objectContaining({ intent: 'test_connection' })
    )
    expect(createPasswordHost).toHaveBeenCalledAfter(acquireWithPassword)
    expect(JSON.stringify(result)).not.toContain(password)
    expect(result.authentication).toEqual({
      mode: 'password',
      credentialStatus: 'configured',
      revision: 1,
      lastVerifiedAt: Date.parse('2026-08-17T00:00:00.000Z')
    })
  })

  it('rejects an option-like alias before password validation or persistence', async () => {
    const { owner, createPasswordHost, acquireWithPassword, encrypt } = setup()

    await expect(
      owner.createPassword({
        sshAlias: '-oProxyCommand=touch /tmp/not-approved',
        authenticationMode: 'password',
        username: 'researcher',
        port: 22,
        password: 'secret',
        operationId: 'operation-unsafe-alias'
      })
    ).rejects.toMatchObject({ code: 'unsupported_auth_configuration' })
    expect(encrypt).not.toHaveBeenCalled()
    expect(acquireWithPassword).not.toHaveBeenCalled()
    expect(createPasswordHost).not.toHaveBeenCalled()
  })

  it('rejects an invalid password-host display name before validation or persistence', async () => {
    const { owner, createPasswordHost, acquireWithPassword } = setup()

    await expect(
      owner.createPassword({
        sshAlias: 'cluster',
        displayName: 'Cluster\0hidden',
        authenticationMode: 'password',
        username: 'researcher',
        port: 22,
        password: 'secret',
        operationId: 'operation-invalid-profile'
      })
    ).rejects.toMatchObject({ code: 'unsupported_auth_configuration' })
    expect(acquireWithPassword).not.toHaveBeenCalled()
    expect(createPasswordHost).not.toHaveBeenCalled()
  })

  it('replays a committed password-host creation without contacting the SSH transport', async () => {
    const committed = {
      ...publicHost(),
      id: 'host-from-committed-operation',
      displayName: 'Committed Cluster'
    }
    const acquireWithPassword = vi.fn()
    const repository = {
      ...authRepository({
        createPasswordHost: vi.fn(async () => {
          throw new Error('a replay must not create again')
        })
      }),
      preparePasswordCreate: vi.fn(async () => ({ kind: 'replay' as const, host: committed }))
    }
    const owner = new ComputeAuthOwner({
      repository,
      vault: credentialVault({
        encrypt: vi.fn(() => {
          throw new Error('a replay must not encrypt again')
        })
      }),
      passwordAdapter: { acquireWithPassword } as unknown as PasswordSshAdapter
    })

    await expect(
      owner.createPassword({
        sshAlias: 'cluster',
        authenticationMode: 'password',
        username: 'researcher',
        port: 22,
        password: 'already committed',
        operationId: 'operation-replay'
      })
    ).resolves.toEqual(committed)
    expect(acquireWithPassword).not.toHaveBeenCalled()
  })

  it('rejects a duplicate password-host alias without contacting the SSH transport', async () => {
    const acquireWithPassword = vi.fn()
    const owner = new ComputeAuthOwner({
      repository: authRepository({
        preparePasswordCreate: vi.fn(async () => {
          throw new Error('A host with alias "cluster" is already registered.')
        })
      }),
      vault: credentialVault({
        encrypt: vi.fn(() => {
          throw new Error('a duplicate alias must be rejected before encryption')
        })
      }),
      passwordAdapter: { acquireWithPassword } as unknown as PasswordSshAdapter
    })

    await expect(
      owner.createPassword({
        sshAlias: 'cluster',
        authenticationMode: 'password',
        username: 'researcher',
        port: 22,
        password: 'must not be verified',
        operationId: 'operation-duplicate'
      })
    ).rejects.toThrow('A host with alias "cluster" is already registered.')
    expect(acquireWithPassword).not.toHaveBeenCalled()
  })

  it('leaves durable state untouched when candidate authentication fails', async () => {
    const { owner, createPasswordHost, acquireWithPassword } = setup()
    acquireWithPassword.mockRejectedValueOnce(new ComputeConnectionError('authentication_failed'))

    await expect(
      owner.createPassword({
        sshAlias: 'cluster',
        authenticationMode: 'password',
        username: 'researcher',
        port: 22,
        password: 'wrong secret',
        operationId: 'operation-1'
      })
    ).rejects.toMatchObject({ code: 'authentication_failed' })
    expect(createPasswordHost).not.toHaveBeenCalled()
  })

  it('never places an arbitrary password in SSH arguments or the child environment', async () => {
    const secret = 'quotes \'" $() `cmd`\n密碼'
    const runner: SshRunner = {
      run: vi
        .fn()
        .mockResolvedValueOnce({
          exitCode: 255,
          stdout: '',
          stderr: 'Permission denied',
          truncated: false,
          timedOut: false
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: '',
          stderr: '',
          truncated: false,
          timedOut: false
        })
    }
    const createPasswordHost = vi.fn(async () => publicHost())
    const owner = new ComputeAuthOwner({
      repository: authRepository({ createPasswordHost }),
      vault: credentialVault({ encrypt: vi.fn(() => Buffer.from('ciphertext')) }),
      passwordAdapter: new PasswordSshAdapter(
        {} as CredentialVault,
        runner,
        vi.fn(async () => ({ sshBinary: 'ssh', host: 'cluster', extraArgs: [] })),
        vi.fn(async () => ({})),
        vi.fn(async () => ({
          env: { SSH_ASKPASS: '/constrained/helper' },
          wasAnswered: () => true,
          dispose: async () => undefined
        }))
      ),
      now: () => new Date('2026-08-17T00:00:00.000Z')
    })

    await owner.createPassword({
      sshAlias: 'cluster',
      authenticationMode: 'password',
      username: 'researcher',
      port: 22,
      password: secret,
      operationId: 'operation-security'
    })

    expect(JSON.stringify(vi.mocked(runner.run).mock.calls)).not.toContain(secret)
    expect(createPasswordHost).toHaveBeenCalledWith(
      expect.objectContaining({ ciphertext: Buffer.from('ciphertext') })
    )
    expect(JSON.stringify(createPasswordHost.mock.calls)).not.toContain(secret)
  })

  it('rejects an oversized password before validation or persistence', async () => {
    const createPasswordHost = vi.fn(async () => publicHost())
    const acquireWithPassword = vi.fn(async () => successfulLease())
    const owner = new ComputeAuthOwner({
      repository: authRepository({ createPasswordHost }),
      vault: new CredentialVault(
        { getCredential: vi.fn(async () => null) },
        {
          isEncryptionAvailable: () => true,
          getSelectedStorageBackend: () => 'gnome_libsecret',
          encryptString: (value) => Buffer.from(value),
          decryptString: (value) => value.toString()
        },
        'linux'
      ),
      passwordAdapter: { acquireWithPassword } as unknown as PasswordSshAdapter
    })

    await expect(
      owner.createPassword({
        sshAlias: 'cluster',
        authenticationMode: 'password',
        username: 'researcher',
        port: 22,
        password: 'x'.repeat(16 * 1024 + 1),
        operationId: 'operation-oversized'
      })
    ).rejects.toMatchObject({ code: 'unsupported_auth_configuration' })
    expect(acquireWithPassword).not.toHaveBeenCalled()
    expect(createPasswordHost).not.toHaveBeenCalled()
  })
})

describe('Compute authentication identity-change application handler', () => {
  const passwordHost = publicHost()
  const request = (
    overrides: Partial<ChangeComputeHostAuthenticationRequest> = {}
  ): ChangeComputeHostAuthenticationRequest => ({
    providerId: passwordHost.providerId,
    expectedRevision: 1,
    operationId: 'operation-change-1',
    authenticationMode: 'ssh_config',
    username: 'new-researcher',
    port: 2222,
    ...overrides
  })

  it('returns the current Host without validation or mutation when authentication settings are unchanged', async () => {
    const validateSshConfig = vi.fn()
    const hasBlockingJobs = vi.fn()
    const changeAuthentication = vi.fn()
    const invalidateAuthenticationIdentity = vi.fn()
    const owner = new ComputeAuthOwner({
      repository: authRepository({
        get: vi.fn(async () => passwordHost),
        changeAuthentication
      }),
      vault: credentialVault({ encrypt: vi.fn() }),
      passwordAdapter: { acquireWithPassword: vi.fn() } as unknown as PasswordSshAdapter,
      validateSshConfig,
      hasBlockingJobs,
      invalidateAuthenticationIdentity
    })

    await expect(
      owner.changeAuthentication(
        request({
          authenticationMode: 'password',
          username: 'researcher',
          port: 22
        })
      )
    ).resolves.toBe(passwordHost)

    expect(hasBlockingJobs).not.toHaveBeenCalled()
    expect(validateSshConfig).not.toHaveBeenCalled()
    expect(changeAuthentication).not.toHaveBeenCalled()
    expect(invalidateAuthenticationIdentity).not.toHaveBeenCalled()
  })

  it('rejects an unchanged request carrying a stale authentication revision', async () => {
    const changeAuthentication = vi.fn()
    const owner = new ComputeAuthOwner({
      repository: authRepository({
        get: vi.fn(async () => passwordHost),
        changeAuthentication
      }),
      vault: credentialVault({ encrypt: vi.fn() }),
      passwordAdapter: {} as PasswordSshAdapter
    })

    await expect(
      owner.changeAuthentication(
        request({
          expectedRevision: 2,
          authenticationMode: 'password',
          username: 'researcher',
          port: 22
        })
      )
    ).rejects.toMatchObject({ code: 'credential_conflict' })
    expect(changeAuthentication).not.toHaveBeenCalled()
  })

  it('validates candidate SSH configuration before atomically switching and deleting the credential', async () => {
    const committed = {
      ...passwordHost,
      sshOverrides: { user: 'new-researcher', port: 2222 },
      authentication: {
        mode: 'ssh_config' as const,
        credentialStatus: 'missing' as const,
        revision: 2,
        lastVerifiedAt: Date.parse('2026-08-17T00:00:00.000Z')
      }
    }
    const get = vi.fn(async () => passwordHost)
    const changeAuthentication = vi.fn(async () => committed)
    const validateSshConfig = vi.fn(async () => undefined)
    const invalidateAuthenticationIdentity = vi.fn()
    const owner = new ComputeAuthOwner({
      repository: authRepository({ get, changeAuthentication }),
      vault: credentialVault({ encrypt: vi.fn() }),
      passwordAdapter: {} as PasswordSshAdapter,
      validateSshConfig,
      invalidateAuthenticationIdentity,
      now: () => new Date('2026-08-17T00:00:00.000Z')
    })

    await expect(owner.changeAuthentication(request())).resolves.toEqual(committed)

    expect(validateSshConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        id: passwordHost.id,
        providerId: passwordHost.providerId,
        sshAlias: passwordHost.sshAlias,
        sshOverrides: { user: 'new-researcher', port: 2222 }
      })
    )
    expect(changeAuthentication).toHaveBeenCalledAfter(validateSshConfig)
    expect(invalidateAuthenticationIdentity).toHaveBeenCalledAfter(changeAuthentication)
    expect(invalidateAuthenticationIdentity).toHaveBeenCalledWith(passwordHost.providerId)
    expect(changeAuthentication).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'ssh:cluster',
        expectedRevision: 1,
        authenticationMode: 'ssh_config'
      })
    )
    expect(
      (changeAuthentication as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0]
    ).not.toHaveProperty('ciphertext')
  })

  it('keeps the password identity durable when candidate SSH validation fails', async () => {
    const changeAuthentication = vi.fn()
    const owner = new ComputeAuthOwner({
      repository: authRepository({
        get: vi.fn(async () => passwordHost),
        changeAuthentication
      }),
      vault: credentialVault({ encrypt: vi.fn() }),
      passwordAdapter: {} as PasswordSshAdapter,
      validateSshConfig: vi.fn(async () => {
        throw new ComputeConnectionError('authentication_failed')
      })
    })

    await expect(owner.changeAuthentication(request())).rejects.toMatchObject({
      code: 'authentication_failed'
    })
    expect(changeAuthentication).not.toHaveBeenCalled()
  })

  it('keeps the old durable identity when the application stops after validation but before commit', async () => {
    const durableHost = passwordHost
    const validateSshConfig = vi.fn(async () => undefined)
    const changeAuthentication = vi.fn(async () => {
      throw new Error('application terminated before durable commit')
    })
    const get = vi.fn<(providerId: string) => Promise<ComputeHost>>().mockResolvedValue(durableHost)
    const owner = new ComputeAuthOwner({
      repository: authRepository({ get, changeAuthentication }),
      vault: credentialVault({ encrypt: vi.fn() }),
      passwordAdapter: {} as PasswordSshAdapter,
      validateSshConfig
    })

    await expect(owner.changeAuthentication(request())).rejects.toThrow(
      'application terminated before durable commit'
    )

    expect(validateSshConfig).toHaveBeenCalledOnce()
    expect(changeAuthentication).toHaveBeenCalledAfter(validateSshConfig)
    await expect(get(durableHost.providerId)).resolves.toBe(durableHost)
    expect(durableHost).toMatchObject({
      sshOverrides: { user: 'researcher', port: 22 },
      authentication: { mode: 'password', revision: 1 }
    })
  })

  it('switches SSH configuration to password only after password-only candidate validation', async () => {
    const sshHost = {
      ...passwordHost,
      sshOverrides: { user: 'old-user', port: 22, identityFile: '~/.ssh/id_ed25519' },
      authentication: {
        mode: 'ssh_config' as const,
        credentialStatus: 'missing' as const,
        revision: 4,
        lastVerifiedAt: undefined
      }
    }
    const acquireWithPassword = vi.fn(async () => successfulLease())
    const encrypt = vi.fn(() => Buffer.from('new-ciphertext'))
    const changeAuthentication = vi.fn(async () => ({
      ...sshHost,
      sshOverrides: { user: 'new-user', port: 2200 },
      authentication: {
        mode: 'password' as const,
        credentialStatus: 'configured' as const,
        revision: 5,
        lastVerifiedAt: Date.parse('2026-08-17T00:00:00.000Z')
      }
    }))
    const owner = new ComputeAuthOwner({
      repository: authRepository({
        get: vi.fn(async () => sshHost),
        changeAuthentication
      }),
      vault: credentialVault({ encrypt }),
      passwordAdapter: { acquireWithPassword } as unknown as PasswordSshAdapter,
      now: () => new Date('2026-08-17T00:00:00.000Z')
    })
    const password = 'new user secret'

    const result = await owner.changeAuthentication(
      request({
        expectedRevision: 4,
        authenticationMode: 'password',
        username: 'new-user',
        port: 2200,
        password
      })
    )

    expect(acquireWithPassword).toHaveBeenCalledWith(
      expect.objectContaining({
        id: sshHost.id,
        providerId: sshHost.providerId,
        sshAlias: sshHost.sshAlias,
        sshOverrides: { user: 'new-user', port: 2200 }
      }),
      password,
      expect.objectContaining({ intent: 'test_connection' })
    )
    expect(changeAuthentication).toHaveBeenCalledAfter(acquireWithPassword)
    expect(changeAuthentication).toHaveBeenCalledWith(
      expect.objectContaining({ ciphertext: Buffer.from('new-ciphertext') })
    )
    expect(result.providerId).toBe(sshHost.providerId)
    expect(result.sshAlias).toBe(sshHost.sshAlias)
  })

  it('uses the current password method to validate a candidate username and blocks before validation when jobs exist', async () => {
    const acquireWithPassword = vi.fn(async () => successfulLease())
    const changeAuthentication = vi.fn(async () => passwordHost)
    const hasBlockingJobs = vi.fn(async () => true)
    const owner = new ComputeAuthOwner({
      repository: authRepository({
        get: vi.fn(async () => passwordHost),
        changeAuthentication
      }),
      vault: credentialVault({ encrypt: vi.fn(() => Buffer.from('ciphertext')) }),
      passwordAdapter: { acquireWithPassword } as unknown as PasswordSshAdapter,
      hasBlockingJobs
    })

    await expect(
      owner.changeAuthentication(
        request({ authenticationMode: 'password', password: 'candidate-password' })
      )
    ).rejects.toMatchObject({ code: 'credential_change_blocked_by_jobs' })
    expect(hasBlockingJobs).toHaveBeenCalledWith(passwordHost.providerId)
    expect(acquireWithPassword).not.toHaveBeenCalled()
    expect(changeAuthentication).not.toHaveBeenCalled()
  })

  it('serializes authentication mutations for the same Host', async () => {
    let releaseFirst!: () => void
    const firstValidation = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const validateSshConfig = vi
      .fn()
      .mockImplementationOnce(() => firstValidation)
      .mockResolvedValueOnce(undefined)
    const owner = new ComputeAuthOwner({
      repository: authRepository({
        get: vi.fn(async () => passwordHost),
        changeAuthentication: vi.fn(async () => passwordHost)
      }),
      vault: credentialVault({ encrypt: vi.fn() }),
      passwordAdapter: {} as PasswordSshAdapter,
      validateSshConfig
    })

    const first = owner.changeAuthentication(request({ operationId: 'first' }))
    await vi.waitFor(() => expect(validateSshConfig).toHaveBeenCalledTimes(1))
    const second = owner.changeAuthentication(request({ operationId: 'second' }))
    await Promise.resolve()
    expect(validateSshConfig).toHaveBeenCalledTimes(1)
    releaseFirst()
    await Promise.all([first, second])
    expect(validateSshConfig).toHaveBeenCalledTimes(2)
  })

  it('returns an idempotent operation replay without repeating validation, Job checks, or commit', async () => {
    const replayed = {
      ...passwordHost,
      authentication: { ...passwordHost.authentication!, revision: 2 }
    }
    const validateSshConfig = vi.fn()
    const hasBlockingJobs = vi.fn()
    const changeAuthentication = vi.fn()
    const owner = new ComputeAuthOwner({
      repository: authRepository({
        replayAuthenticationChange: vi.fn(async () => replayed),
        get: vi.fn(),
        changeAuthentication
      }),
      vault: credentialVault({ encrypt: vi.fn() }),
      passwordAdapter: {} as PasswordSshAdapter,
      validateSshConfig,
      hasBlockingJobs
    })

    await expect(owner.changeAuthentication(request())).resolves.toBe(replayed)
    expect(validateSshConfig).not.toHaveBeenCalled()
    expect(hasBlockingJobs).not.toHaveBeenCalled()
    expect(changeAuthentication).not.toHaveBeenCalled()
  })

  it('allows only one of two same-revision window updates to commit', async () => {
    let revision = 1
    const get = vi.fn(async () => ({
      ...passwordHost,
      authentication: { ...passwordHost.authentication!, revision }
    }))
    const changeAuthentication = vi.fn(async (change: { expectedRevision: number }) => {
      if (change.expectedRevision !== revision) {
        throw new ComputeConnectionError('credential_conflict')
      }
      revision += 1
      return {
        ...passwordHost,
        authentication: { ...passwordHost.authentication!, revision }
      }
    })
    const owner = new ComputeAuthOwner({
      repository: authRepository({ get, changeAuthentication }),
      vault: credentialVault({ encrypt: vi.fn() }),
      passwordAdapter: {} as PasswordSshAdapter,
      validateSshConfig: vi.fn(async () => undefined)
    })

    const results = await Promise.allSettled([
      owner.changeAuthentication(request({ operationId: 'window-1' })),
      owner.changeAuthentication(request({ operationId: 'window-2' }))
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'credential_conflict' }
    })
  })
})
