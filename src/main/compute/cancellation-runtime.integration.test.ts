import { afterEach, expect, it, vi } from 'vitest'

import type { ComputeJob } from '../../shared/compute'
import type { ComputeConnectionBroker } from './connection-broker'
import { ComputeJobCancellationOwner } from './compute-job-cancellation-owner'
import { createMigratedComputeTestDatabase } from './compute-integration.test-support'
import type { harvestJob } from './harvest-engine'
import { createComputeJobRuntime } from './job-runtime'
import type { ComputeHostRepository } from './repository'

let dispose: (() => Promise<void>) | undefined
afterEach(async () => {
  await dispose?.()
})

it('publishes cancellation and keeps cancelling other jobs while result collection is blocked', async () => {
  const database = await createMigratedComputeTestDatabase('compute-cancellation-runtime-')
  dispose = database.dispose
  const { jobs, operations } = database.repositories
  const scope = { projectId: 'project-1', sessionId: 'session-1', providerId: 'ssh:test' }
  for (const id of ['job-1', 'job-2']) {
    const workdir = `~/.open-science/jobs/${id}`
    await jobs.create({
      id,
      ...scope,
      shape: 'direct_ssh',
      intent: 'cancellation regression',
      command: 'sleep 100',
      commandHash: 'hash',
      remoteWorkdir: workdir,
      initialStatus: 'running',
      allowUnencryptedPersistence: true
    })
    await jobs.update(id, {
      remoteHandle: JSON.stringify({
        pid: 4321,
        workdir,
        stdout_path: `${workdir}/stdout`,
        stderr_path: `${workdir}/stderr`,
        exit_code_path: `${workdir}/exit_code`
      })
    })
    await new ComputeJobCancellationOwner(operations, jobs).request(id, scope)
  }
  let release!: () => void
  const collection = new Promise<void>((resolve) => {
    release = resolve
  })
  const harvestSignals: AbortSignal[] = []
  const harvest = vi.fn((...[, deps]: Parameters<typeof harvestJob>) => {
    harvestSignals.push(deps.signal!)
    return collection
  })
  const confirmed = vi.fn<(job: ComputeJob) => Promise<void>>(async () => undefined)
  const runtime = createComputeJobRuntime(
    {
      computeService: {
        bindJobHarvestRetry: () => () => undefined,
        handleJobUpdated: vi.fn(),
        handleJobCancellationConfirmed: confirmed,
        startQueueReconciliation: vi.fn(),
        stopQueueReconciliation: vi.fn()
      },
      jobRepository: jobs,
      operationRepository: operations,
      hostRepository: {} as ComputeHostRepository,
      connectionBroker: {
        acquire: async () => ({
          run: async () => ({
            stdout: 'absent',
            stderr: '',
            exitCode: 0,
            truncated: false,
            timedOut: false
          })
        })
      } as unknown as ComputeConnectionBroker,
      storageRoot: '/unused'
    },
    {
      harvest,
      createPoller: () => ({
        start: vi.fn(),
        stop: vi.fn(async () => undefined),
        pause: vi.fn(async () => undefined),
        resume: vi.fn()
      })
    }
  )
  try {
    await runtime.start()
    await vi.waitFor(() => expect(harvest).toHaveBeenCalled(), { timeout: 2000 })
    await vi.waitFor(() => expect(confirmed).toHaveBeenCalledTimes(2), { timeout: 2500 })
    for (const id of ['job-1', 'job-2']) {
      expect(await operations.get(id, 'cancel')).toMatchObject({
        phase: 'settled',
        outcome: 'fulfilled'
      })
      expect(await jobs.get(id)).toMatchObject({
        status: 'failed',
        cancellation_status: 'cancelled'
      })
    }
    await vi.waitFor(() => expect(harvest).toHaveBeenCalledTimes(2))
    let stopped = false
    const stopping = runtime.stop().then(() => {
      stopped = true
    })
    await vi.waitFor(() => expect(harvestSignals.every((signal) => signal.aborted)).toBe(true))
    expect(stopped).toBe(false)
    release()
    await stopping
    expect(stopped).toBe(true)
  } finally {
    release()
    await runtime.stop()
  }
})
