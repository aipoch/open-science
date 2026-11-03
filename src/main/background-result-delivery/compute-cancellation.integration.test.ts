import { afterEach, expect, it, vi } from 'vitest'
import { createJobCancellation } from '@aipoch/compute/node'
import type { ComputeJobOperationRecord } from '@aipoch/compute'
import type { JobSummary } from '../../shared/compute'
import { createMigratedComputeTestDatabase } from '../compute/compute-integration.test-support'
import { ComputeJobResultDeliveryAdapter } from './compute-adapter'
import { BackgroundResultDeliveryOwner } from './owner'
import { BackgroundResultDeliveryRepository } from './repository'
import { resolveBackgroundResultSources } from './source-resolver'

let database: Awaited<ReturnType<typeof createMigratedComputeTestDatabase>> | undefined
let owner: BackgroundResultDeliveryOwner | undefined
afterEach(async () => {
  owner?.dispose()
  owner = undefined
  await database?.dispose()
  database = undefined
})

const scope = { projectId: 'project', sessionId: 'session', providerId: 'ssh:cluster' }
type TestDatabase = Awaited<ReturnType<typeof createMigratedComputeTestDatabase>>
const prepare = async (
  initialStatus: 'queued' | 'running'
): Promise<{
  jobs: TestDatabase['repositories']['jobs']
  operations: TestDatabase['repositories']['operations']
  repository: BackgroundResultDeliveryRepository
  summary(): Promise<JobSummary>
  adapter: ComputeJobResultDeliveryAdapter
}> => {
  database = await createMigratedComputeTestDatabase('compute-cancellation-delivery-')
  const { jobs, operations } = database.repositories
  await jobs.create({
    id: 'job',
    ...scope,
    shape: 'scheduler_cluster',
    executionMode: 'slurm',
    intent: 'Analyze',
    command: 'analysis',
    commandHash: 'hash',
    initialStatus,
    allowUnencryptedPersistence: true
  })
  const repository = new BackgroundResultDeliveryRepository(async () => database!.client)
  const summary = async (): Promise<JobSummary> => {
    const job = await jobs.get('job')
    if (!job) throw new Error('Missing fixture Job.')
    return {
      ...job,
      left_on_remote: undefined,
      display_name: 'Cluster',
      notified_at: job.notified_at,
      notification_consumed_at: job.notification_consumed_at
    }
  }
  const adapter = new ComputeJobResultDeliveryAdapter({
    register: (source) => repository.register(source),
    enqueue: (source) => repository.enqueue(source),
    acknowledgeObserved: async (source) => {
      const { delivery } = await repository.acknowledgeObserved(source)
      return delivery.state === 'dispatching' ? 'committed' : 'suppressed'
    },
    listWaiting: () => repository.listWaiting('compute-job'),
    hasDeliveryPath: (kind, id) => repository.hasDeliveryPath(kind, id)
  })
  await adapter.observeJob(await summary())
  return { jobs, operations, repository, summary, adapter }
}

it('recovers settled cancellation events, deduplicates each revision and later delivers the task result', async () => {
  const { jobs, operations, repository, summary, adapter } = await prepare('running')
  const reject = async (message: string): Promise<ComputeJobOperationRecord | null> => {
    await operations.request('job', 'cancel', scope, new Date())
    const claim = await operations.claimNext('cancel', new Date(), 30_000, message)
    if (!claim) throw new Error('Expected cancellation claim.')
    return operations.settle(claim, new Date(), {
      outcome: 'failed',
      error: { code: 'cancel_request_rejected', message }
    })
  }
  const first = await reject('First permission denial.')
  const sendContinuation = vi.fn((request: { text: string; continuationMessageId: string }) => ({
    admitted: Promise.resolve(),
    result: Promise.resolve({
      stopReason: 'end_turn',
      continuationMessageId: request.continuationMessageId
    })
  }))
  // Construct after settlement: no onFailed callback is needed to recover the durable event.
  owner = new BackgroundResultDeliveryOwner({
    repository,
    resolveSources: async (deliveries) =>
      resolveBackgroundResultSources(deliveries, {
        loadNotebookRuns: async () => [],
        loadComputeJobs: async (sources) =>
          new Map(
            await Promise.all(
              sources.map(async (source) => [source.sourceId, await summary()] as const)
            )
          )
      }),
    waitForAuthoritiesReady: async () => undefined,
    sendContinuation,
    isContinuationSaved: async () => true,
    canStartSessionTurn: () => true
  })
  expect(await owner.drainSession(scope.sessionId)).toBe('consumed')
  await owner.drainSession(scope.sessionId)
  expect(sendContinuation).toHaveBeenCalledOnce()
  expect(sendContinuation.mock.calls[0][0].text).toContain('First permission denial.')
  expect((await jobs.get('job'))?.notified_at).toBeUndefined()
  expect(await repository.find('compute-job:job')).toMatchObject({ state: 'waiting-result' })

  const second = await reject('Second permission denial.')
  expect(second?.id).toBe(first?.id)
  expect(second?.revision).toBeGreaterThan(first!.revision)
  expect(await owner.drainSession(scope.sessionId)).toBe('consumed')
  expect(sendContinuation).toHaveBeenCalledTimes(2)
  expect(sendContinuation.mock.calls[1][0].text).toContain('Second permission denial.')

  await jobs.updateIfStatus('job', ['running'], {
    status: 'success',
    exitCode: 0,
    finishedAt: new Date(),
    harvestedAt: new Date()
  })
  await jobs.claimNotification('job', new Date())
  await adapter.observeNotification(await summary())
  expect(await owner.drainSession(scope.sessionId)).toBe('consumed')
  await adapter.observeNotification(await summary())
  await owner.drainSession(scope.sessionId)
  expect(sendContinuation).toHaveBeenCalledTimes(3)
  expect(sendContinuation.mock.calls[2][0].text).toContain('"status":"success"')
  expect(sendContinuation.mock.calls[2][0].text).not.toContain('"cancellation":')
})

it('lets a foreground cancelled result win automatic delivery before harvest and after restart', async () => {
  const { jobs, operations, repository, summary, adapter } = await prepare('queued')
  await createJobCancellation(operations, jobs).request('job', scope)
  await Promise.all([
    adapter.observeResult(await summary()),
    (async () => {
      await jobs.claimNotification('job', new Date())
      await adapter.observeNotification(await summary())
    })()
  ])
  expect(await repository.find('compute-job:job')).toMatchObject({ state: 'consumed' })
  expect((await jobs.get('job'))?.harvested_at).toBeUndefined()
  await jobs.update('job', { harvestedAt: new Date() })
  await adapter.recoverWaiting(async () => summary())
  await adapter.observeNotification(await summary())
  expect(await repository.find('compute-job:job')).toMatchObject({ state: 'consumed' })
  expect(await repository.listPendingSessionIds()).toEqual([])
})
