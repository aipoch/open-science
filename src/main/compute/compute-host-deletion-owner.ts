import { createLogger, errorLogFields } from '../logger'
import type { PermissionGrantRegistry } from '../permission-grants/registry'
import type { ComputeHostLifecycle } from './authentication-runtime'
import type { ComputeApprovalBroker } from './compute-approval-broker'
import { ComputeConnectionError, type ComputeConnectionBroker } from './connection-broker'
import type { ComputeJobRepository } from './job-repository'
import type { ComputeHostRepository } from './repository'

const log = createLogger('compute')

type ComputeHostDeletionDependencies = Readonly<{
  repository: ComputeHostRepository
  approvalBroker: Pick<ComputeApprovalBroker, 'invalidateProvider' | 'completeProviderInvalidation'>
  connectionBroker: Pick<
    ComputeConnectionBroker,
    'beginHostDeletion' | 'abortHostDeletion' | 'completeHostDeletion'
  >
  jobRepository?: ComputeJobRepository
  permissionGrantRegistry?: PermissionGrantRegistry
  hostLifecycle?: ComputeHostLifecycle
}>

type DeleteComputeHostOptions = Readonly<{ allowPasswordCredentialDeletion: boolean }>

const deleteComputeHost = async (
  dependencies: ComputeHostDeletionDependencies,
  providerId: string,
  options: DeleteComputeHostOptions
): Promise<void> => {
  const {
    repository,
    approvalBroker,
    connectionBroker,
    jobRepository,
    permissionGrantRegistry,
    hostLifecycle
  } = dependencies
  await jobRepository?.beginProviderDeletion?.(providerId)
  await connectionBroker.beginHostDeletion(providerId)
  let committed = false
  try {
    const host = await repository.get?.(providerId)
    if (host?.authentication?.mode === 'password' && !options.allowPasswordCredentialDeletion) {
      throw new Error('Channel only available from the local app: compute:delete')
    }
    if (jobRepository && (await jobRepository.hasDeletionBlockingJobsForProvider(providerId))) {
      throw new ComputeConnectionError('credential_change_blocked_by_jobs')
    }
    try {
      await approvalBroker.invalidateProvider(providerId)
      const commit = async (): Promise<void> => {
        await repository.delete(providerId)
        committed = true
      }
      if (hostLifecycle) {
        try {
          await hostLifecycle.pruneSessionEnabledHosts(providerId, commit)
        } catch (error) {
          if (!committed) throw error
          log.warn('compute Session cleanup after host deletion failed', errorLogFields(error))
        }
      } else await commit()
      try {
        await permissionGrantRegistry?.finalizeOwnerDeletion({
          kind: 'compute_provider',
          providerId
        })
      } catch (error) {
        log.warn(
          'compute permission grant projection finalization after host deletion failed',
          errorLogFields(error)
        )
      }
    } finally {
      approvalBroker.completeProviderInvalidation(providerId)
    }
  } finally {
    if (committed) {
      connectionBroker.completeHostDeletion(providerId)
      await jobRepository?.completeProviderDeletion?.(providerId)
    } else {
      connectionBroker.abortHostDeletion(providerId)
      await jobRepository?.abortProviderDeletion?.(providerId)
    }
  }
}

export { deleteComputeHost }
export type { ComputeHostDeletionDependencies, DeleteComputeHostOptions }
