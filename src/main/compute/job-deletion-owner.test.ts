import { describe, expect, it, vi } from 'vitest'

import type { ComputeHost, ComputeJob } from '../../shared/compute'
import { cleanupCommand, ComputeJobDeletionOwner } from './job-deletion-owner'
import type { ResolvedSshTarget, SshRunner } from './ssh-runner'

const target: ResolvedSshTarget = { sshBinary: 'ssh', host: 'cluster', extraArgs: [] }
const host = {
  id: 'host-1',
  providerId: 'ssh:cluster',
  displayName: 'Cluster',
  shape: 'direct_ssh',
  sshAlias: 'cluster',
  createdAt: 1,
  updatedAt: 1
} as ComputeHost

const job = (overrides: Partial<ComputeJob> = {}): ComputeJob => ({
  job_id: 'job-1',
  provider_id: host.providerId,
  project_id: 'project-1',
  session_id: 'session-1',
  shape: 'direct_ssh',
  status: 'running',
  intent: 'analysis',
  command: 'sleep 600',
  command_hash: 'hash',
  environment: undefined,
  resource_request: undefined,
  input_manifest: undefined,
  output_manifest: undefined,
  harvest_config: undefined,
  timeout_seconds: 600,
  remote_workdir: '~/.openscience/jobs/job-1',
  remote_handle: JSON.stringify({
    pid: 123,
    exit_code_path: '~/.openscience/jobs/job-1/exit_code',
    stdout_path: '~/.openscience/jobs/job-1/stdout',
    stderr_path: '~/.openscience/jobs/job-1/stderr',
    workdir: '~/.openscience/jobs/job-1'
  }),
  exit_code: undefined,
  stdout_tail: undefined,
  stderr_tail: undefined,
  error_code: undefined,
  created_at: 1,
  submitted_at: 1,
  started_at: 1,
  finished_at: undefined,
  harvested_at: undefined,
  ...overrides
})

// Preserve the inferred Vitest mock types so individual tests can configure failures without casts.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const createHarness = (jobs: ComputeJob[]) => {
  const order: string[] = []
  const lifecycle = {
    beginOwnerDeletion: vi.fn(async () => {
      order.push('begin')
    }),
    deleteOwnerRows: vi.fn(async () => {
      order.push('delete-rows')
    }),
    abortOwnerDeletion: vi.fn(async () => {
      order.push('abort')
    })
  }
  const jobRepository = {
    findByOwner: vi.fn(async () => jobs),
    listOwners: vi.fn(async () => [{ projectId: 'project-1', sessionId: 'session-1' }])
  }
  const hostRepository = { get: vi.fn(async (): Promise<ComputeHost | null> => host) }
  const runner = {
    run: vi.fn<SshRunner['run']>(async () => {
      order.push('remote-cleanup')
      return {
        exitCode: 0,
        stdout: '',
        stderr: '',
        truncated: false,
        timedOut: false
      }
    })
  } satisfies SshRunner
  const dispatchTracker = {
    waitFor: vi.fn(async () => {
      order.push('dispatch-drained')
    })
  }
  const runtime = {
    pause: vi.fn(async () => {
      order.push('poller-paused')
    }),
    resume: vi.fn(() => {
      order.push('poller-resumed')
    })
  }
  const queueManager = {
    pauseOwner: vi.fn(async () => {
      order.push('queue-paused')
    }),
    resumeOwner: vi.fn(() => {
      order.push('queue-resumed')
    })
  }
  const resolveTarget = vi.fn(async () => target)
  const owner = new ComputeJobDeletionOwner({
    jobRepository,
    lifecycle,
    queueManager,
    hostRepository,
    runner,
    dispatchTracker,
    resolveTarget
  })
  owner.bindRuntime(runtime)
  return {
    owner,
    order,
    lifecycle,
    jobRepository,
    hostRepository,
    runner,
    dispatchTracker,
    runtime,
    queueManager,
    resolveTarget
  }
}

describe('ComputeJobDeletionOwner', () => {
  it('kills the process group and removes the generated directory', () => {
    const rawHandle = job().remote_handle ?? ''
    const handle = JSON.parse(rawHandle) as Parameters<typeof cleanupCommand>[1]
    const command = cleanupCommand('~/.openscience/jobs/job-1', handle)
    expect(command).toContain('kill -TERM -- -123')
    expect(command).toContain('job.pid')
    expect(command).toContain('rm -rf --')
    expect(command).toContain('test ! -e')
  })

  it('retains an active Session row until owner authority commits', async () => {
    const harness = createHarness([job()])
    await harness.owner.prepareSessionJobDeletion('project-1', 'session-1')
    expect(harness.dispatchTracker.waitFor).toHaveBeenCalledWith(['job-1'])
    expect(harness.runner.run).not.toHaveBeenCalled()
    expect(harness.lifecycle.deleteOwnerRows).not.toHaveBeenCalled()
    expect(harness.runtime.resume).not.toHaveBeenCalled()

    harness.order.push('owner-authority')
    await harness.owner.commitSessionJobDeletion('project-1', 'session-1')

    expect(harness.lifecycle.deleteOwnerRows).toHaveBeenCalledWith({
      projectId: 'project-1',
      sessionId: 'session-1'
    })
    expect(harness.order).toEqual([
      'begin',
      'queue-paused',
      'poller-paused',
      'dispatch-drained',
      'owner-authority',
      'remote-cleanup',
      'delete-rows',
      'queue-resumed',
      'poller-resumed'
    ])
  })

  it('deletes queued jobs without contacting the remote host', async () => {
    const harness = createHarness([job({ status: 'queued', remote_handle: undefined })])
    await harness.owner.prepareSessionJobDeletion('project-1', 'session-1')
    await harness.owner.commitSessionJobDeletion('project-1', 'session-1')
    expect(harness.hostRepository.get).not.toHaveBeenCalled()
    expect(harness.runner.run).not.toHaveBeenCalled()
    expect(harness.lifecycle.deleteOwnerRows).toHaveBeenCalledOnce()
  })

  it('removes terminal Job directories during Project deletion', async () => {
    const harness = createHarness([
      job({ status: 'success', remote_handle: undefined, notified_at: 10 })
    ])
    await harness.owner.prepareProjectJobDeletion('project-1')
    expect(harness.runner.run).not.toHaveBeenCalled()
    await harness.owner.commitProjectJobDeletion('project-1')
    expect(harness.runner.run).toHaveBeenCalledOnce()
    expect(harness.lifecycle.deleteOwnerRows).toHaveBeenCalledWith({
      projectId: 'project-1'
    })
  })

  it('uses the persisted provider alias after a terminal Job host is deleted', async () => {
    const harness = createHarness([job({ status: 'success', remote_handle: undefined })])
    harness.hostRepository.get.mockResolvedValueOnce(null)

    await harness.owner.prepareSessionJobDeletion('project-1', 'session-1')

    expect(harness.resolveTarget).toHaveBeenCalledWith('cluster', undefined)
    expect(harness.runner.run).not.toHaveBeenCalled()
    await harness.owner.commitSessionJobDeletion('project-1', 'session-1')
    expect(harness.runner.run).toHaveBeenCalledOnce()
  })

  it('derives a legacy Job work directory from the retained host scratch root', async () => {
    const harness = createHarness([
      job({ status: 'success', remote_workdir: undefined, remote_handle: undefined })
    ])
    harness.hostRepository.get.mockResolvedValueOnce({ ...host, scratchRoot: '/scratch/scientist' })

    await harness.owner.prepareSessionJobDeletion('project-1', 'session-1')
    expect(harness.runner.run).not.toHaveBeenCalled()
    await harness.owner.commitSessionJobDeletion('project-1', 'session-1')

    expect(harness.runner.run.mock.calls[0]?.[1]).toContain(
      '/scratch/scientist/.openscience/jobs/job-1'
    )
  })

  it('retains the barrier and rows when post-authority remote cleanup fails', async () => {
    const harness = createHarness([job()])
    harness.runner.run.mockResolvedValueOnce({
      exitCode: 255,
      stdout: '',
      stderr: 'offline',
      truncated: false,
      timedOut: false
    })
    await harness.owner.prepareSessionJobDeletion('project-1', 'session-1')
    expect(harness.runner.run).not.toHaveBeenCalled()

    await expect(harness.owner.commitSessionJobDeletion('project-1', 'session-1')).rejects.toThrow(
      /remote Compute Job cleanup failed/i
    )
    expect(harness.lifecycle.deleteOwnerRows).not.toHaveBeenCalled()
    expect(harness.lifecycle.abortOwnerDeletion).not.toHaveBeenCalled()
    expect(harness.queueManager.resumeOwner).not.toHaveBeenCalled()
    expect(harness.runtime.resume).not.toHaveBeenCalled()
  })

  it('retries the full idempotent plan after a later Job cleanup fails', async () => {
    const secondJob = job({
      job_id: 'job-2',
      remote_workdir: '~/.openscience/jobs/job-2',
      remote_handle: JSON.stringify({
        pid: 456,
        exit_code_path: '~/.openscience/jobs/job-2/exit_code',
        stdout_path: '~/.openscience/jobs/job-2/stdout',
        stderr_path: '~/.openscience/jobs/job-2/stderr',
        workdir: '~/.openscience/jobs/job-2'
      })
    })
    const harness = createHarness([job(), secondJob])
    const ok = {
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    }
    harness.runner.run
      .mockResolvedValueOnce(ok)
      .mockResolvedValueOnce({ ...ok, exitCode: 255, stderr: 'offline' })
      .mockResolvedValueOnce(ok)
      .mockResolvedValueOnce(ok)

    await harness.owner.prepareSessionJobDeletion('project-1', 'session-1')
    await expect(harness.owner.commitSessionJobDeletion('project-1', 'session-1')).rejects.toThrow(
      /remote Compute Job cleanup failed for job-2/i
    )

    expect(harness.lifecycle.deleteOwnerRows).not.toHaveBeenCalled()
    expect(harness.queueManager.resumeOwner).not.toHaveBeenCalled()

    await harness.owner.commitSessionJobDeletion('project-1', 'session-1')

    expect(harness.runner.run).toHaveBeenCalledTimes(4)
    expect(harness.lifecycle.deleteOwnerRows).toHaveBeenCalledOnce()
    expect(harness.queueManager.resumeOwner).toHaveBeenCalledOnce()
  })

  it('retains rows and resumes runtime when outer owner deletion aborts', async () => {
    const harness = createHarness([job()])
    await harness.owner.prepareSessionJobDeletion('project-1', 'session-1')
    expect(harness.runner.run).not.toHaveBeenCalled()

    await harness.owner.abortSessionJobDeletion('project-1', 'session-1')

    expect(harness.lifecycle.deleteOwnerRows).not.toHaveBeenCalled()
    expect(harness.lifecycle.abortOwnerDeletion).toHaveBeenCalledWith({
      projectId: 'project-1',
      sessionId: 'session-1'
    })
    expect(harness.queueManager.resumeOwner).toHaveBeenCalledOnce()
    expect(harness.runtime.resume).toHaveBeenCalledOnce()
  })

  it('reconciles remote work after restoring an absent owner barrier at startup', async () => {
    const harness = createHarness([job()])
    const isOwnerLive = vi.fn(async () => false)

    await harness.owner.restoreOrphanJobDeletionBarriers(isOwnerLive)
    expect(harness.runner.run).not.toHaveBeenCalled()

    await harness.owner.reconcileOrphanJobs(isOwnerLive)

    expect(isOwnerLive).toHaveBeenCalledWith({
      projectId: 'project-1',
      sessionId: 'session-1'
    })
    expect(harness.lifecycle.beginOwnerDeletion).toHaveBeenCalledOnce()
    expect(harness.runner.run).toHaveBeenCalledOnce()
    expect(harness.lifecycle.deleteOwnerRows).toHaveBeenCalledOnce()
  })

  it('restores every orphan barrier before startup without contacting remote hosts', async () => {
    const harness = createHarness([job()])
    harness.jobRepository.listOwners.mockResolvedValueOnce([
      { projectId: 'project-1', sessionId: 'session-1' },
      { projectId: 'project-2', sessionId: 'session-2' }
    ])
    const isOwnerLive = vi.fn(async () => false)

    await harness.owner.restoreOrphanJobDeletionBarriers(isOwnerLive)

    expect(harness.lifecycle.beginOwnerDeletion).toHaveBeenCalledTimes(2)
    expect(harness.queueManager.pauseOwner).toHaveBeenCalledTimes(2)
    expect(harness.jobRepository.findByOwner).not.toHaveBeenCalled()
    expect(harness.runtime.pause).not.toHaveBeenCalled()
    expect(harness.runner.run).not.toHaveBeenCalled()
  })

  it('retains a restored Project barrier when remote cleanup fails and retries safely', async () => {
    const harness = createHarness([job()])
    await harness.owner.restoreProjectJobDeletion('project-1')
    harness.runner.run
      .mockResolvedValueOnce({
        exitCode: 255,
        stdout: '',
        stderr: 'offline',
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

    await harness.owner.prepareProjectJobDeletion('project-1')
    expect(harness.runner.run).not.toHaveBeenCalled()
    await expect(harness.owner.commitProjectJobDeletion('project-1')).rejects.toThrow(
      /remote Compute Job cleanup failed/i
    )

    expect(harness.lifecycle.abortOwnerDeletion).not.toHaveBeenCalled()
    expect(harness.queueManager.resumeOwner).not.toHaveBeenCalled()

    await harness.owner.commitProjectJobDeletion('project-1')

    expect(harness.lifecycle.beginOwnerDeletion).toHaveBeenCalledOnce()
    expect(harness.lifecycle.deleteOwnerRows).toHaveBeenCalledOnce()
    expect(harness.queueManager.resumeOwner).toHaveBeenCalledOnce()
  })

  it('rejects a remote directory outside the generated Job directory', async () => {
    const harness = createHarness([
      job({ remote_workdir: '/scratch/unrelated', remote_handle: undefined })
    ])
    await expect(harness.owner.prepareProjectJobDeletion('project-1')).rejects.toThrow(
      /unsafe remote work directory/i
    )
    expect(harness.runner.run).not.toHaveBeenCalled()
    expect(harness.lifecycle.deleteOwnerRows).not.toHaveBeenCalled()
  })

  it('rejects Windows-style work directories because SSH cleanup uses POSIX paths', async () => {
    const harness = createHarness([
      job({
        status: 'success',
        remote_workdir: String.raw`C:\Users\scientist\.openscience\jobs\job-1`,
        remote_handle: undefined
      })
    ])
    await expect(harness.owner.prepareProjectJobDeletion('project-1')).rejects.toThrow(
      /unsafe remote work directory/i
    )
    expect(harness.runner.run).not.toHaveBeenCalled()
    expect(harness.lifecycle.deleteOwnerRows).not.toHaveBeenCalled()
  })

  it('rejects a malformed active remote handle', async () => {
    const harness = createHarness([job({ remote_handle: '{bad json' })])
    await expect(harness.owner.prepareSessionJobDeletion('project-1', 'session-1')).rejects.toThrow(
      /invalid remote handle/i
    )
    expect(harness.runner.run).not.toHaveBeenCalled()
    expect(harness.lifecycle.deleteOwnerRows).not.toHaveBeenCalled()
  })
})
