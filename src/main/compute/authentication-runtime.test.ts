import { describe, expect, it, vi } from 'vitest'

import type { ComputeHost } from '../../shared/compute'
import {
  createComputeAuthenticationOwner,
  createComputeAuthenticationRuntime
} from './authentication-runtime'
import type { PasswordSshAdapter } from './connection-adapters'
import { ComputeConnectionError, type ComputeConnectionLease } from './connection-broker'
import { CredentialVault, type ComputeCredentialCipher } from './credential-vault'
import type { ComputeHostRepository } from './repository'

const schedulerPasswordHost = (): ComputeHost => ({
  id: 'host-1',
  providerId: 'ssh:cluster',
  displayName: 'Cluster',
  sshAlias: 'cluster',
  shape: 'scheduler_cluster',
  scratchRoot: '/scratch/researcher',
  scratchPinned: false,
  concurrencyLimit: undefined,
  probeResult: undefined,
  sshOverrides: { user: 'researcher', port: 22 },
  authentication: {
    mode: 'password',
    credentialStatus: 'configured',
    revision: 4,
    lastVerifiedAt: undefined
  },
  detailsDoc: '',
  detailsUpdatedAt: undefined,
  detailsUpdatedBy: undefined,
  createdAt: Date.parse('2026-08-18T00:00:00.000Z'),
  updatedAt: Date.parse('2026-08-18T00:00:00.000Z')
})

const cipher: ComputeCredentialCipher = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString: (value) => Buffer.from(value),
  decryptString: (value) => value.toString()
}

describe('Compute authentication runtime', () => {
  it('preserves Session enablement and Permission Grants for an unchanged edit', async () => {
    const host = schedulerPasswordHost()
    const changeAuthentication = vi.fn()
    const pruneSessionEnabledHosts = vi.fn()
    const finalizeOwnerDeletion = vi.fn()
    const invalidateProvider = vi.fn()
    const invalidateAuthenticationIdentity = vi.fn()
    const owner = createComputeAuthenticationOwner({
      repository: {
        getAuthenticationOperation: vi.fn(async () => null),
        replayAuthenticationChange: vi.fn(async () => null),
        get: vi.fn(async () => host),
        changeAuthentication
      } as unknown as ComputeHostRepository,
      vault: {
        bindOperationIntent: vi.fn(() => 'fingerprint'),
        encrypt: vi.fn()
      } as unknown as CredentialVault,
      passwordAdapter: { acquireWithPassword: vi.fn() } as unknown as PasswordSshAdapter,
      sshRunner: { run: vi.fn() } as never,
      scpRunner: {} as never,
      approvalBroker: {
        invalidateProvider,
        completeProviderInvalidation: vi.fn()
      },
      hostLifecycle: { pruneSessionEnabledHosts },
      permissionGrantRegistry: { finalizeOwnerDeletion } as never,
      connectionBroker: {
        acquire: vi.fn(),
        invalidateAuthenticationIdentity,
        beginHostDeletion: vi.fn(async () => undefined),
        abortHostDeletion: vi.fn(),
        completeHostDeletion: vi.fn()
      } as never
    })

    await expect(
      owner.changeAuthentication({
        providerId: host.providerId,
        expectedRevision: 4,
        operationId: 'unchanged-edit',
        authenticationMode: 'password',
        username: 'researcher',
        port: 22
      })
    ).resolves.toBe(host)

    expect(changeAuthentication).not.toHaveBeenCalled()
    expect(pruneSessionEnabledHosts).not.toHaveBeenCalled()
    expect(finalizeOwnerDeletion).not.toHaveBeenCalled()
    expect(invalidateProvider).not.toHaveBeenCalled()
    expect(invalidateAuthenticationIdentity).not.toHaveBeenCalled()
  })

  it('does not report a committed authentication change as failed when projection cleanup fails', async () => {
    const host = schedulerPasswordHost()
    const committed = {
      ...host,
      sshOverrides: { user: 'replacement-user', port: 22 },
      authentication: { ...host.authentication!, revision: 5 }
    }
    const replayAuthenticationChange = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(committed)
    const changeAuthentication = vi.fn(async () => committed)
    const finalizeOwnerDeletion = vi.fn().mockRejectedValue(new Error('Grant cleanup failed'))
    const pruneSessionEnabledHosts = vi.fn(
      async (_providerId: string, afterPrune?: () => Promise<void>) => afterPrune?.()
    )
    const invalidateProvider = vi.fn(async () => undefined)
    const completeProviderInvalidation = vi.fn()
    const successfulLease: ComputeConnectionLease = {
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
    }
    const acquireWithPassword = vi.fn(async () => successfulLease)
    const owner = createComputeAuthenticationOwner({
      repository: {
        getAuthenticationOperation: vi.fn(async () => null),
        replayAuthenticationChange,
        get: vi.fn(async () => host),
        changeAuthentication
      } as unknown as ComputeHostRepository,
      vault: {
        bindOperationIntent: vi.fn(() => 'fingerprint'),
        encrypt: vi.fn(() => Buffer.from('ciphertext'))
      } as unknown as CredentialVault,
      passwordAdapter: { acquireWithPassword } as unknown as PasswordSshAdapter,
      sshRunner: { run: vi.fn() } as never,
      scpRunner: {} as never,
      approvalBroker: { invalidateProvider, completeProviderInvalidation },
      hostLifecycle: { pruneSessionEnabledHosts },
      permissionGrantRegistry: { finalizeOwnerDeletion } as never,
      connectionBroker: {
        acquire: vi.fn(),
        invalidateAuthenticationIdentity: vi.fn(),
        beginHostDeletion: vi.fn(async () => undefined),
        abortHostDeletion: vi.fn(),
        completeHostDeletion: vi.fn()
      } as never
    })
    const request = {
      providerId: host.providerId,
      expectedRevision: 4,
      operationId: 'retry-committed-cleanup',
      authenticationMode: 'password' as const,
      username: 'replacement-user',
      port: 22,
      password: 'replacement-password'
    }

    await expect(owner.changeAuthentication(request)).resolves.toBe(committed)
    await expect(owner.changeAuthentication(request)).resolves.toBe(committed)

    expect(changeAuthentication).toHaveBeenCalledOnce()
    expect(acquireWithPassword).toHaveBeenCalledOnce()
    expect(pruneSessionEnabledHosts).toHaveBeenCalledOnce()
    expect(finalizeOwnerDeletion).toHaveBeenCalledOnce()
    expect(invalidateProvider).toHaveBeenCalledOnce()
    expect(completeProviderInvalidation).toHaveBeenCalledOnce()
  })

  it('preserves a scheduler Host shape when persisting a background authentication failure', async () => {
    const host = schedulerPasswordHost()
    const updateAuthenticationFailure = vi.fn(async () => true)
    const repository = {
      get: vi.fn(async () => host),
      updateAuthenticationFailure,
      clearAuthenticationFailure: vi.fn(async () => undefined)
    } as unknown as ComputeHostRepository
    const vault = new CredentialVault({ getCredential: vi.fn(async () => null) }, cipher, 'linux')
    const failedLease: ComputeConnectionLease = {
      run: vi.fn(async () => {
        throw new ComputeConnectionError('authentication_failed')
      }),
      upload: vi.fn(async () => undefined),
      download: vi.fn(async () => ({
        exitCode: 0,
        stderr: '',
        timedOut: false,
        bytesWritten: 0,
        exceeded: false
      }))
    }
    const passwordAdapter = {
      acquire: vi.fn(async () => failedLease)
    } as unknown as PasswordSshAdapter
    const runtime = createComputeAuthenticationRuntime({
      repository,
      approvalBroker: {
        invalidateProvider: vi.fn(async () => undefined),
        completeProviderInvalidation: vi.fn()
      },
      authenticationDependencies: { vault, passwordAdapter }
    })

    const lease = await runtime.connectionBroker.acquire(host.providerId, { intent: 'job_poll' })
    await expect(
      lease.run('true', { timeoutMs: 1_000, loginShell: false, maxOutputBytes: 1_024 })
    ).rejects.toMatchObject({ code: 'authentication_failed' })

    expect(updateAuthenticationFailure).toHaveBeenCalledWith(
      host.providerId,
      4,
      expect.objectContaining({
        authenticationCode: 'authentication_failed',
        authenticationRevision: 4
      }),
      'scheduler_cluster'
    )
  })
})
