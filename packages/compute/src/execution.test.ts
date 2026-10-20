import { describe, expect, it, vi } from 'vitest'
import { createComputeExecution } from './execution'
import type { ComputeJob } from './model'
import type { ComputeHostRepository, ComputeJobRepository } from './ports'

describe('execution scope ownership', () => {
  it('isolates identical job ids across runtimes and drains all overlapping handoff leases', async () => {
    const a = createComputeExecution(),
      b = createComputeExecution()
    const first = a.holdDispatch('job'),
      second = a.holdDispatch('job')
    expect(a.isDispatching('job')).toBe(true)
    expect(b.isDispatching('job')).toBe(false)
    const settled = vi.fn()
    const drain = a.waitForDispatch(['job', 'job']).then(settled)
    first()
    first()
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    expect(a.isDispatching('job')).toBe(true)
    second()
    await drain
    expect(settled).toHaveBeenCalledOnce()
    expect(a.isDispatching('job')).toBe(false)
  })

  it.each([false, true])(
    'releases dispatch after a finalizer rejection without releasing another handoff: %s',
    async (withHandoff) => {
      const scope = createComputeExecution()
      const release = withHandoff ? scope.holdDispatch('job') : undefined
      const failure = new Error('Evidence receipt could not be written')
      const finalizeDispatchError = vi.fn(async () => {
        throw failure
      })
      const dispatch = scope.dispatchJob('job', {
        connectionBroker: { acquire: vi.fn() },
        hostRepository: { get: async () => null } as unknown as ComputeHostRepository,
        jobRepository: { get: async () => null } as unknown as ComputeJobRepository,
        finalizeDispatchError
      })
      expect(scope.isDispatching('job')).toBe(true)
      const settled = vi.fn()
      const drain = scope.waitForDispatch(['job']).then(settled)
      await expect(dispatch).rejects.toBe(failure)
      expect(finalizeDispatchError).toHaveBeenCalledExactlyOnceWith('job')
      if (withHandoff) {
        expect(scope.isDispatching('job')).toBe(true)
        expect(settled).not.toHaveBeenCalled()
        release!()
      }
      expect(scope.isDispatching('job')).toBe(false)
      await drain
      expect(settled).toHaveBeenCalledOnce()
    }
  )

  it('shares the submission handoff with its poller, while a restarted scope recovers the row', async () => {
    const scope = createComputeExecution()
    const release = scope.holdDispatch('job')
    const job = {
      job_id: 'job',
      provider_id: 'ssh:host',
      project_id: 'p',
      session_id: 's',
      status: 'submitted',
      remote_workdir: '~/scratch/.open-science/jobs/job'
    } as ComputeJob
    const updateIfStatus = vi.fn(async () => null)
    const jobs = {
      findNonTerminal: async () => [job],
      findTerminalUnharvested: async () => [],
      updateIfStatus
    } as unknown as ComputeJobRepository
    const acquire = vi.fn(async () => ({
      run: async () => ({
        exitCode: 0,
        stdout: 'OPEN_SCIENCE_DISPATCH_RECOVERY_V1\nworkdir:0\nexit_code:\npid:\ncwd_match:0',
        stderr: '',
        timedOut: false,
        truncated: false
      }),
      upload: vi.fn(),
      download: vi.fn()
    }))
    const deps = {
      jobRepository: jobs,
      hostRepository: { get: async () => null } as unknown as ComputeHostRepository,
      connectionBroker: { acquire }
    }
    await scope.createPoller(deps).tick()
    expect(acquire).not.toHaveBeenCalled()
    await createComputeExecution().createPoller(deps).tick()
    expect(acquire).toHaveBeenCalledOnce()
    expect(updateIfStatus).toHaveBeenCalledWith(
      'job',
      ['submitted'],
      expect.objectContaining({ status: 'error', errorCode: 'dispatch_failed' })
    )
    release()
    await scope.waitForDispatch(['job'])
  })
})
