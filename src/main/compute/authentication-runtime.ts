import type { ComputeHost } from '../../shared/compute'
import { createLogger, errorLogFields } from '../logger'
import type { PermissionGrantRegistry } from '../permission-grants/registry'
import { ComputeAuthOwner } from './compute-auth-owner'
import type { ComputeApprovalBroker } from './compute-approval-broker'
import { PasswordSshAdapter } from './connection-adapters'
import {
  SshConfigComputeConnectionBroker,
  classifyConnectionFailure,
  type ComputeConnectionBroker
} from './connection-broker'
import { CredentialVault } from './credential-vault'
import type { ComputeJobRepository } from './job-repository'
import type { ComputeHostRepository } from './repository'
import { SystemScpRunner, type ScpRunner } from './scp-runner'
import { SystemSshRunner, type SshRunner } from './ssh-runner'

const log = createLogger('compute')

type ComputeHostLifecycle = Readonly<{
  pruneSessionEnabledHosts(providerId: string, afterPrune?: () => Promise<void>): Promise<void>
}>

type AuthenticationRuntimeOptions = Readonly<{
  repository: ComputeHostRepository
  vault: CredentialVault
  passwordAdapter: PasswordSshAdapter
  sshRunner: SshRunner
  scpRunner: ScpRunner
  approvalBroker: Pick<ComputeApprovalBroker, 'invalidateProvider' | 'completeProviderInvalidation'>
  jobRepository?: ComputeJobRepository
  hostLifecycle?: ComputeHostLifecycle
  permissionGrantRegistry?: PermissionGrantRegistry
  connectionBroker: ComputeConnectionBroker
}>

type ComputeAuthenticationDependencies = Readonly<{
  vault?: CredentialVault
  passwordAdapter?: PasswordSshAdapter
  connectionBroker?: ComputeConnectionBroker
}>

type ComputeAuthenticationRuntimeOptions = Readonly<{
  repository: ComputeHostRepository
  approvalBroker: Pick<ComputeApprovalBroker, 'invalidateProvider' | 'completeProviderInvalidation'>
  jobRepository?: ComputeJobRepository
  hostLifecycle?: ComputeHostLifecycle
  permissionGrantRegistry?: PermissionGrantRegistry
  authenticationDependencies?: ComputeAuthenticationDependencies
  reportAuthenticationFailurePersistenceError?: (error: unknown) => void
}>

const createSshConfigCompatibilityBroker = (
  repository: ComputeHostRepository,
  runner: SshRunner,
  scpRunner?: ScpRunner
): ComputeConnectionBroker =>
  new SshConfigComputeConnectionBroker({
    getHost: (providerId) => repository.get(providerId),
    runner,
    scpRunner: scpRunner ?? new SystemScpRunner()
  })

const createComputeAuthenticationOwner = (
  options: AuthenticationRuntimeOptions
): ComputeAuthOwner =>
  new ComputeAuthOwner({
    repository: options.repository,
    vault: options.vault,
    passwordAdapter: options.passwordAdapter,
    validateSshConfig: async (candidate) => {
      const broker = new SshConfigComputeConnectionBroker({
        getHost: async (providerId) => (providerId === candidate.providerId ? candidate : null),
        runner: options.sshRunner,
        scpRunner: options.scpRunner
      })
      const lease = await broker.acquire(candidate.providerId, {
        intent: 'test_connection',
        interactive: true
      })
      const result = await lease.run('true', {
        timeoutMs: 30_000,
        loginShell: false,
        maxOutputBytes: 4 * 1024
      })
      const failure = classifyConnectionFailure(result)
      if (failure) throw failure
    },
    hasBlockingJobs: async (providerId) => {
      if (!options.jobRepository) return false
      return options.jobRepository.hasIdentityChangeBlockingJobsForProvider(providerId)
    },
    invalidateAuthenticationIdentity: (providerId) =>
      options.connectionBroker.invalidateAuthenticationIdentity?.(providerId),
    commitAuthentication: async (change) => {
      let committed: ComputeHost | undefined
      const commit = async (): Promise<void> => {
        committed = await options.repository.changeAuthentication(change)
        options.connectionBroker.invalidateAuthenticationIdentity?.(change.providerId)
        await options.approvalBroker.invalidateProvider(change.providerId)
      }
      try {
        if (options.hostLifecycle) {
          await options.hostLifecycle.pruneSessionEnabledHosts(change.providerId, commit)
        } else {
          await commit()
        }
      } catch (error) {
        if (!committed) throw error
        log.warn(
          'compute Session cleanup after authentication change failed',
          errorLogFields(error)
        )
      }
      if (!committed) throw new Error('The Compute Host authentication change did not commit.')

      try {
        await options.permissionGrantRegistry?.finalizeOwnerDeletion({
          kind: 'compute_provider',
          providerId: change.providerId
        })
      } catch (error) {
        log.warn(
          'compute permission grant projection finalization after authentication change failed',
          errorLogFields(error)
        )
      } finally {
        options.approvalBroker.completeProviderInvalidation(change.providerId)
      }
      return committed
    }
  })

const createComputeAuthenticationRuntime = (
  options: ComputeAuthenticationRuntimeOptions
): Readonly<{
  sshRunner: SshRunner
  scpRunner: ScpRunner
  credentialVault: CredentialVault
  connectionBroker: ComputeConnectionBroker
  authentication: ComputeAuthOwner
}> => {
  const sshRunner = new SystemSshRunner()
  const scpRunner = new SystemScpRunner()
  const credentialVault =
    options.authenticationDependencies?.vault ?? new CredentialVault(options.repository)
  const passwordAdapter =
    options.authenticationDependencies?.passwordAdapter ??
    new PasswordSshAdapter(credentialVault, sshRunner, undefined, undefined, undefined, scpRunner)
  const connectionBroker =
    options.authenticationDependencies?.connectionBroker ??
    new SshConfigComputeConnectionBroker({
      getHost: (providerId) => options.repository.get(providerId),
      runner: sshRunner,
      scpRunner,
      passwordAdapter,
      persistAuthenticationFailure: (host) =>
        options.repository
          .updateAuthenticationFailure(
            host.providerId,
            host.authentication?.revision ?? 0,
            {
              ok: false,
              probedAt: new Date().toISOString(),
              exitCode: null,
              errorTail: 'Authentication failed. Verify the username and password.',
              authenticationCode: 'authentication_failed',
              authenticationRevision: host.authentication?.revision ?? 0
            },
            host.shape
          )
          .then(() => undefined),
      clearPersistedAuthenticationFailure: (providerId) =>
        options.repository.clearAuthenticationFailure(providerId),
      reportAuthenticationFailurePersistenceError:
        options.reportAuthenticationFailurePersistenceError
    })
  return {
    sshRunner,
    scpRunner,
    credentialVault,
    connectionBroker,
    authentication: createComputeAuthenticationOwner({
      repository: options.repository,
      vault: credentialVault,
      passwordAdapter,
      sshRunner,
      scpRunner,
      approvalBroker: options.approvalBroker,
      jobRepository: options.jobRepository,
      hostLifecycle: options.hostLifecycle,
      permissionGrantRegistry: options.permissionGrantRegistry,
      connectionBroker
    })
  }
}

const projectComputeCredentialStatus = async (
  host: ComputeHost,
  credentialVault: Pick<CredentialVault, 'credentialStatus'>
): Promise<ComputeHost> =>
  host.authentication?.mode === 'password'
    ? {
        ...host,
        authentication: {
          ...host.authentication,
          credentialStatus: await credentialVault.credentialStatus(host.id)
        }
      }
    : host

export {
  createComputeAuthenticationOwner,
  createComputeAuthenticationRuntime,
  createSshConfigCompatibilityBroker,
  projectComputeCredentialStatus
}
export type {
  AuthenticationRuntimeOptions,
  ComputeAuthenticationDependencies,
  ComputeAuthenticationRuntimeOptions,
  ComputeHostLifecycle
}
