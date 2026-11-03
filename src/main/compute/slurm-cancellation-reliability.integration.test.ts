import { afterEach, describe, expect, it, vi } from 'vitest'
import { createComputeExecution, createJobCancellation } from '@aipoch/compute/node'
import type { ComputeConnectionLease } from '@aipoch/compute/node'
import type { ClaimedComputeJobOperation, ComputeJobOperationRecord } from '@aipoch/compute'
import { createMigratedComputeTestDatabase } from './compute-integration.test-support'

let db: Awaited<ReturnType<typeof createMigratedComputeTestDatabase>> | undefined
type CancellationSetup = Awaited<
  ReturnType<typeof createMigratedComputeTestDatabase>
>['repositories'] & {
  claim: ClaimedComputeJobOperation
  operation: ComputeJobOperationRecord
}
afterEach(async () => {
  await db?.dispose()
  db = undefined
})

describe('Slurm cancellation persistence', () => {
  const scope = { projectId: 'project', sessionId: 'session', providerId: 'ssh:slurm' }
  const prepare = async (): Promise<CancellationSetup> => {
    db = await createMigratedComputeTestDatabase('slurm-cancellation-reliability-')
    await db.repositories.jobs.create({
      id: 'job',
      ...scope,
      shape: 'scheduler_cluster',
      executionMode: 'slurm',
      intent: 'test',
      command: 'sleep 10',
      commandHash: 'hash',
      initialStatus: 'running',
      allowUnencryptedPersistence: true,
      remoteWorkdir: '/scratch/job'
    })
    await db.repositories.jobs.update('job', {
      remoteHandle: JSON.stringify({
        driver: 'slurm',
        version: 1,
        scheduler_job_id: '123',
        workdir: '/scratch/job',
        stdout_path: '/scratch/job/stdout',
        stderr_path: '/scratch/job/stderr'
      })
    })
    const operation = await db.repositories.operations.request('job', 'cancel', scope, new Date())
    const claim = await db.repositories.operations.claimNext('cancel', new Date(), 30000, 'lease')
    if (!claim || !operation.found) throw new Error('Expected active cancellation')
    return { ...db.repositories, claim, operation: operation.record }
  }

  it('restores polling after rejection and reopens the same failed row with a new revision', async () => {
    const { jobs, operations, claim, operation } = await prepare()
    const settled = await operations.settle(claim, new Date(), {
      outcome: 'failed',
      error: { code: 'cancel_request_rejected', message: 'Permission denied' }
    })
    expect(settled).toMatchObject({ outcome: 'failed', revision: claim.operation.revision + 1 })
    expect(await jobs.findNonTerminal()).toHaveLength(1)
    expect(await jobs.findNonTerminalByProvider(scope.providerId)).toHaveLength(1)
    expect(await jobs.countActiveByProvider(scope.providerId)).toBe(1)
    expect(
      await jobs.updateIfStatus('job', ['running'], { stdoutTail: 'still running' })
    ).not.toBeNull()
    const reopened = await operations.request('job', 'cancel', scope, new Date())
    expect(reopened).toMatchObject({
      found: true,
      record: {
        id: operation.id,
        phase: 'active',
        outcome: null,
        errorCode: null,
        errorMessage: null
      }
    })
    if (reopened.found) expect(reopened.record.revision).toBe(settled!.revision + 1)
    expect(await db!.client.computeJobOperation.count()).toBe(1)
    expect(
      await operations.settle(claim, new Date(), {
        outcome: 'failed',
        error: { code: 'cancel_request_rejected', message: 'stale' }
      })
    ).toBeNull()
    const retry = await operations.claimNext('cancel', new Date(), 30000, 'retry')
    const retryFailure = await operations.settle(retry!, new Date(), {
      outcome: 'failed',
      error: { code: 'cancel_request_rejected', message: 'Second rejection' }
    })
    const events = await db!.client.backgroundResultDelivery.findMany({
      orderBy: { createdAt: 'asc' }
    })
    expect(events).toHaveLength(2)
    expect(events.map((event) => event.sourceId)).toEqual([
      `${operation.id}:${settled!.revision}`,
      `${operation.id}:${retryFailure!.revision}`
    ])
    expect(events[0].sourceSnapshot).toContain('Permission denied')
    expect(JSON.parse(events[0].sourceSnapshot!).jobStatus).toBe('running')
    expect(events[1].sourceSnapshot).toContain('Second rejection')
    expect((await jobs.get('job'))?.notified_at).toBeUndefined()
    expect(
      await jobs.updateIfStatus('job', ['running'], {
        status: 'success',
        exitCode: 0,
        finishedAt: new Date()
      })
    ).not.toBeNull()
  })

  it('commits unavailable job and failed cancellation together without cleanup or harvest', async () => {
    const { jobs, operations, claim } = await prepare()
    await operations.settle(claim, new Date(), {
      outcome: 'failed',
      error: { code: 'cancel_confirmation_failed', message: 'No confirmation path' },
      job: {
        status: 'error',
        errorCode: 'job_status_unavailable',
        errorMessage: 'No record; remote process may still run.',
        finishedAt: new Date()
      }
    })
    expect(await jobs.get('job')).toMatchObject({
      status: 'error',
      error_code: 'job_status_unavailable',
      error_message: 'No record; remote process may still run.',
      cancellation_status: 'failed',
      cancellation_error: { code: 'cancel_confirmation_failed', message: 'No confirmation path' },
      remote_cleanup_disposition: 'pending'
    })
    expect((await jobs.get('job'))?.harvested_at).toBeUndefined()
    expect(await jobs.countActiveByProvider(scope.providerId)).toBe(0)
    expect(await jobs.findNotificationReadyUnnotified()).toHaveLength(1)
    expect(await db!.client.backgroundResultDelivery.count()).toBe(0)
  })

  it('settles natural completion atomically and makes cancellation deliverable before harvest', async () => {
    const { jobs, operations, claim } = await prepare()
    await operations.settle(claim, new Date(), {
      outcome: 'superseded',
      job: { status: 'success', exitCode: 0, finishedAt: new Date() }
    })
    expect(await jobs.get('job')).toMatchObject({ status: 'success', exit_code: 0 })
    expect(await jobs.findNotificationReadyUnnotified()).toHaveLength(0)
    await jobs.update('job', { status: 'running', errorCode: null })
    await db!.client.computeJobOperation.deleteMany()
    await operations.request('job', 'cancel', scope, new Date())
    const second = await operations.claimNext('cancel', new Date(), 30000, 'second')
    expect(await operations.fulfill(second!, new Date())).toBe(true)
    expect((await jobs.get('job'))?.harvested_at).toBeUndefined()
    expect(await jobs.findNotificationReadyUnnotified()).toHaveLength(1)
    expect(await jobs.claimNotification('job', new Date())).not.toBeNull()
    expect(await jobs.claimNotification('job', new Date())).toBeNull()
  })

  it.each(['rejected', 'completed', 'timeout', 'out_of_memory', 'unavailable'] as const)(
    'settles %s through the real reaper and keeps task and operation outcomes distinct',
    async (kind) => {
      const { jobs, operations, claim } = await prepare()
      await operations.retry(claim, new Date(), new Date(0))
      const ok = (stdout = ''): Awaited<ReturnType<ComputeConnectionLease['run']>> => ({
        stdout,
        stderr: '',
        exitCode: 0,
        timedOut: false,
        truncated: false
      })
      const run = vi.fn(async (command: string) => {
        if (command.startsWith('scancel '))
          return kind === 'rejected'
            ? {
                ...ok(),
                exitCode: 1,
                stderr: 'scancel: error: Access/permission denied for job 123'
              }
            : kind === 'unavailable'
              ? { ...ok(), exitCode: 1, stderr: 'scancel: error: Invalid job id specified' }
              : ok()
        if (command.startsWith('squeue '))
          return ok(kind === 'rejected' ? '123|RUNNING|None\n' : '')
        if (command.startsWith('scontrol '))
          return kind === 'completed' || kind === 'timeout' || kind === 'out_of_memory'
            ? ok(
                kind === 'out_of_memory'
                  ? 'JobId=123 JobState=OUT_OF_MEMORY ExitCode=1:0'
                  : kind === 'timeout'
                    ? 'JobId=123 JobState=FAILED ExitCode=124:0'
                    : 'JobId=123 JobState=COMPLETED ExitCode=0:0'
              )
            : { ...ok(), exitCode: 1, stderr: 'slurm_load_jobs error: Invalid job id specified' }
        if (command.startsWith('sacct '))
          return { ...ok(), exitCode: 1, stderr: 'Slurm accounting storage is disabled' }
        return ok()
      })
      const onFailed = vi.fn(),
        onConfirmed = vi.fn()
      const reaper = createComputeExecution().createCancellationReaper(
        operations,
        jobs,
        { acquire: async () => ({ run, upload: vi.fn(), download: vi.fn() }) },
        { onFailed, onConfirmed }
      )
      expect(await reaper.runOnce()).toBe(true)
      const status = await createJobCancellation(operations, jobs).status('job', scope)
      expect(status).not.toHaveProperty('cancellation_status')
      expect(status).not.toHaveProperty('error_code')
      if (kind === 'rejected') {
        expect(status).toMatchObject({
          status: 'running',
          result_final: false,
          cancellation: { status: 'failed', error: { code: 'cancel_request_rejected' } }
        })
        expect(onFailed).toHaveBeenCalledWith(
          'job',
          expect.objectContaining({
            operationId: claim.operation.id,
            revision: claim.operation.revision + 3,
            error: expect.objectContaining({ code: 'cancel_request_rejected' })
          })
        )
        expect(await jobs.countActiveByProvider(scope.providerId)).toBe(1)
      } else if (kind === 'out_of_memory') {
        expect(status).toMatchObject({
          status: 'failed',
          result_final: false,
          exit_code: 1,
          stderr_tail: 'Slurm scheduler state: OUT_OF_MEMORY.'
        })
        expect(status.cancellation).toBeUndefined()
        expect(await operations.get('job', 'cancel')).toMatchObject({ outcome: 'superseded' })
      } else if (kind === 'completed' || kind === 'timeout') {
        expect(status).toMatchObject({
          status: kind === 'timeout' ? 'timeout' : 'success',
          result_final: false,
          exit_code: kind === 'timeout' ? 124 : 0
        })
        expect(status.cancellation).toBeUndefined()
        expect(await operations.get('job', 'cancel')).toMatchObject({ outcome: 'superseded' })
        expect(onConfirmed).toHaveBeenCalledWith('job')
      } else {
        expect(status).toMatchObject({
          status: 'error',
          result_final: true,
          error: { code: 'job_status_unavailable' },
          cancellation: { status: 'failed', error: { code: 'cancel_confirmation_failed' } }
        })
        expect(onFailed).not.toHaveBeenCalled()
        expect(onConfirmed).toHaveBeenCalledWith('job')
      }
    }
  )
})
