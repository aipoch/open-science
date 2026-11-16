import { describe, expect, it, vi } from 'vitest'
import type { ComputeJob } from '../../shared/compute'
import { initialHostedJournal } from './hugging-face-job-journal'
import { createHuggingFaceJobRuntime } from './hugging-face-job-runtime'
import { createKubernetesJobRuntime } from './kubernetes-job-runtime'
import { initialModalJournal } from './modal-job-journal'
import { createModalJobRuntime } from './modal-job-runtime'
import { initialRayJournal } from './ray-job-journal'
import { createRayJobRuntime } from './ray-job-runtime'
import type { ComputeJobRepository } from './job-repository'

const baseJob = (executionMode: string): ComputeJob =>
  ({
    job_id: 'idle-job',
    provider_id: 'provider-1',
    project_id: 'project-1',
    session_id: 'session-1',
    execution_mode: executionMode,
    status: 'success',
    harvested_at: 1,
    remote_cleanup_disposition: 'pending',
    left_on_remote: '[]',
    file_evidence: { checksum: 'evidence' }
  }) as unknown as ComputeJob

const assertIdleRuntime = async (
  create: (findWork: ReturnType<typeof vi.fn>) => {
    start(): void
    tick(): Promise<void>
    wake(): Promise<void>
    stop(): Promise<void>
  }
): Promise<void> => {
  vi.useFakeTimers()
  const findWork = vi.fn(async () => [])
  const runtime = create(findWork)
  try {
    runtime.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(findWork).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(5_001)
    expect(findWork).toHaveBeenCalledOnce()

    // The outer JobRuntime invokes tick() from its 60-second fallback.
    await vi.advanceTimersByTimeAsync(54_999)
    await runtime.tick()
    expect(findWork).toHaveBeenCalledTimes(2)
  } finally {
    await runtime.stop()
    vi.useRealTimers()
  }
}

describe('external runtime idle cadence', () => {
  it('stops Kubernetes active polling for an already blocked harvested job', async () => {
    await assertIdleRuntime((findWork) =>
      createKubernetesJobRuntime({
        jobRepository: {
          findKubernetesWork: findWork.mockImplementation(async () => [
            { ...baseJob('kubernetes'), harvest_error: 'blocked' }
          ])
        } as unknown as ComputeJobRepository,
        storageRoot: '/data',
        onJobUpdated: vi.fn(),
        harvest: vi.fn(async () => undefined)
      })
    )
  })

  it('stops Hugging Face active polling after publication is not cleanable', async () => {
    const job = baseJob('hugging_face_jobs')
    job.remote_handle = initialHostedJournal(job.job_id, job.provider_id, {
      account: 'account',
      namespace: 'namespace',
      flavor: 'cpu',
      image: 'image',
      bucket: 'bucket',
      rateMicroUsdPerMinute: 1
    })
    await assertIdleRuntime((findWork) =>
      createHuggingFaceJobRuntime({
        jobRepository: {
          findHostedWork: findWork.mockImplementation(async () => [job]),
          canCleanJournalResources: vi.fn(() => false)
        } as unknown as ComputeJobRepository,
        storageRoot: '/data',
        onJobUpdated: vi.fn(),
        harvest: vi.fn(async () => undefined)
      })
    )
  })

  it('stops Modal active polling after publication is not cleanable', async () => {
    const job = baseJob('modal_sandbox')
    job.remote_handle = initialModalJournal(job.job_id, job.provider_id, {
      environmentName: 'environment',
      appName: 'app',
      appId: 'app-id',
      image: 'image',
      cpus: 1,
      memoryMiB: 128
    })
    await assertIdleRuntime((findWork) =>
      createModalJobRuntime({
        jobRepository: {
          findModalWork: findWork.mockImplementation(async () => [job]),
          canCleanJournalResources: vi.fn(() => false)
        } as unknown as ComputeJobRepository,
        storageRoot: '/data',
        onJobUpdated: vi.fn(),
        harvest: vi.fn(async () => undefined)
      })
    )
  })

  it('stops Ray active polling after cleanup settles', async () => {
    const job = baseJob('ray_jobs')
    job.remote_handle = initialRayJournal(job.job_id, job.provider_id, {
      endpoint: 'https://ray.example',
      sharedRoot: '/shared',
      remoteRoot: '/remote',
      sessionName: 'session',
      cpus: 1,
      gpus: 0
    })
    const settleRayCleanup = vi.fn(async () => ({
      ...job,
      remote_cleanup_disposition: 'cleaned' as const
    }))
    await assertIdleRuntime((findWork) =>
      createRayJobRuntime({
        jobRepository: {
          findRayWork: findWork.mockImplementationOnce(async () => [job]),
          settleRayCleanup
        } as unknown as ComputeJobRepository,
        storageRoot: '/data',
        onJobUpdated: vi.fn(),
        harvest: vi.fn(async () => undefined)
      })
    )
    expect(settleRayCleanup).toHaveBeenCalledExactlyOnceWith(job)
  })
})
