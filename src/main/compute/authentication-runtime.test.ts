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
