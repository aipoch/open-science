import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type { ComputeHost, ComputeJob } from '../../shared/compute'
import { cleanupCommand, ComputeJobDeletionOwner } from './job-deletion-owner'
import { ComputeConnectionError } from './connection-broker'
import type { SshRunner } from './ssh-runner'

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
    listOwners: vi.fn(async () => [{ projectId: 'project-1', sessionId: 'session-1' }]),
    get: vi.fn(
      async (jobId: string) => jobs.find((candidate) => candidate.job_id === jobId) ?? null
    ),
    settleRemoteCleanup: vi.fn(
      async (request: { jobId: string; disposition: 'cleaned' | 'abandoned' }) => ({
        ...jobs.find((candidate) => candidate.job_id === request.jobId)!,
        remote_cleanup_disposition: request.disposition
      })
    )
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
  const connectionBroker = {
    acquire: vi.fn(async () => ({
      run: (command: string, options: Parameters<SshRunner['run']>[2]) =>
        runner.run({} as never, command, options),
      upload: vi.fn(async () => undefined),
      download: vi.fn(async () => ({
        exitCode: 0,
        stderr: '',
        timedOut: false,
        bytesWritten: 0,
        exceeded: false
      }))
    }))
  }
  const requestCancellation = vi.fn(async () => {
    order.push('cancel-requested')
  })
  const confirmCancellation = vi.fn(async () => {
    order.push('cancel-confirmed')
  })
  const owner = new ComputeJobDeletionOwner({
    jobRepository,
    lifecycle,
    queueManager,
    hostRepository,
    connectionBroker,
    dispatchTracker,
    requestCancellation,
    confirmCancellation
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
    connectionBroker,
    requestCancellation,
    confirmCancellation
  }
}

describe('ComputeJobDeletionOwner', () => {
  it('persists cancellation before cleaning an active Job and settles only after success', async () => {
    const harness = createHarness([job()])

    await expect(
      harness.owner.cleanupJobRemote({
        jobId: 'job-1',
        providerId: 'ssh:cluster',
        projectId: 'project-1',
        sessionId: 'session-1',
        disposition: 'cleaned'
      })
    ).resolves.toMatchObject({ remote_cleanup_disposition: 'cleaned' })

    expect(harness.order).toEqual([
      'queue-paused',
      'poller-paused',
      'cancel-requested',
      'dispatch-drained',
      'remote-cleanup',
      'cancel-confirmed',
      'poller-resumed',
      'queue-resumed'
    ])
    expect(harness.jobRepository.settleRemoteCleanup).toHaveBeenCalledOnce()
  })

  it('cleans a queued Job that is promoted while cleanup pauses its owner', async () => {
    const jobs = [job({ status: 'queued', remote_handle: undefined })]
    const harness = createHarness(jobs)
    harness.queueManager.pauseOwner.mockImplementationOnce(async () => {
      harness.order.push('queue-paused')
      jobs[0] = job()
    })

    await expect(
      harness.owner.cleanupJobRemote({
        jobId: 'job-1',
        providerId: 'ssh:cluster',
        projectId: 'project-1',
        sessionId: 'session-1',
        disposition: 'cleaned'
      })
    ).resolves.toMatchObject({ remote_cleanup_disposition: 'cleaned' })

    expect(harness.jobRepository.get).toHaveBeenCalledTimes(2)
    expect(harness.runner.run).toHaveBeenCalledOnce()
    expect(String(harness.runner.run.mock.calls[0]?.[1])).toContain('cleanup_job_pid 123 || exit 1')
    expect(harness.order).toEqual([
      'queue-paused',
      'poller-paused',
      'cancel-requested',
      'dispatch-drained',
      'remote-cleanup',
      'cancel-confirmed',
      'poller-resumed',
      'queue-resumed'
    ])
  })

  it('settles an explicitly abandoned cleanup without touching the remote Job', async () => {
    const harness = createHarness([job({ status: 'success' })])

    await expect(
      harness.owner.abandonJobRemoteCleanup({
        jobId: 'job-1',
        providerId: 'ssh:cluster',
        projectId: 'project-1',
        sessionId: 'session-1',
        disposition: 'abandoned'
      })
    ).resolves.toMatchObject({ remote_cleanup_disposition: 'abandoned' })

    expect(harness.order).toEqual([])
    expect(harness.jobRepository.settleRemoteCleanup).toHaveBeenCalledOnce()
  })

  it('does not clean a terminal Job before its remote results are harvested', async () => {
    const harness = createHarness([job({ status: 'success', harvested_at: undefined })])

    await expect(
      harness.owner.cleanupJobRemote({
        jobId: 'job-1',
        providerId: 'ssh:cluster',
        projectId: 'project-1',
        sessionId: 'session-1',
        disposition: 'cleaned'
      })
    ).rejects.toThrow('Compute Job results must be harvested before remote cleanup.')

    expect(harness.runner.run).not.toHaveBeenCalled()
    expect(harness.jobRepository.settleRemoteCleanup).not.toHaveBeenCalled()
  })

  it('requires active Jobs to use cancellation and remote cleanup', async () => {
    const harness = createHarness([job({ status: 'running' })])

    await expect(
      harness.owner.abandonJobRemoteCleanup({
        jobId: 'job-1',
        providerId: 'ssh:cluster',
        projectId: 'project-1',
        sessionId: 'session-1',
        disposition: 'abandoned'
      })
    ).rejects.toThrow('Active Compute Jobs must be cancelled and cleaned remotely.')

    expect(harness.jobRepository.settleRemoteCleanup).not.toHaveBeenCalled()
  })

  it('kills only a process still owned by the generated directory, then removes it', () => {
    const rawHandle = job().remote_handle ?? ''
    const handle = JSON.parse(rawHandle) as Parameters<typeof cleanupCommand>[1]
    const command = cleanupCommand('~/.openscience/jobs/job-1', handle)
    expect(command).toContain('kill_job_pid() {')
    expect(command).toContain('process_workdir=$(readlink "/proc/$pid/cwd"')
    expect(command).toContain('command -v lsof')
    expect(command).toContain('lsof -a -p "$pid" -d cwd -Fn')
    expect(command).not.toContain('job_pid_is_owned "$pid" || return 0')
    expect(command).toContain('cleanup_job_pid() {')
    expect(command).toContain('case $ownership in 0|1|3) return 0 ;; *) return 2 ;; esac')
    expect(command).toContain('cleanup_job_pid 123 || exit 1')
    expect(command).not.toContain('kill -TERM -- -123')
    expect(command).toContain('[ ! -L ')
    expect(command).toContain('scratch_root=')
    expect(command).toContain('expected_workdir=')
    expect(command).toContain('[ "$workdir" = "$expected_workdir" ]')
    expect(command).toContain('job.pid')
    expect(command).toContain('rm -rf -- "$workdir"')
    expect(command).toContain("test ! -e ~/'.openscience/jobs/job-1'")
    expect(command).not.toContain("rm -rf -- ~/'.openscience/jobs/job-1'")
  })

  it.skipIf(process.platform === 'win32')(
    'distinguishes an invalid remote workdir from an explicitly absent one',
    () => {
      const scratchRoot = mkdtempSync(join(tmpdir(), 'compute-cleanup-'))
      const jobsRoot = join(scratchRoot, '.openscience', 'jobs')
      const workdir = join(jobsRoot, 'job-1')
      mkdirSync(jobsRoot, { recursive: true })
      writeFileSync(workdir, 'not a directory')

      try {
        const result = spawnSync('/bin/sh', ['-c', cleanupCommand(workdir, undefined)])
        expect(result.status).not.toBe(0)
        expect(existsSync(workdir)).toBe(true)

        rmSync(workdir)
        const missingResult = spawnSync('/bin/sh', ['-c', cleanupCommand(workdir, undefined)])
        expect(missingResult.status).toBe(0)
      } finally {
        rmSync(scratchRoot, { recursive: true, force: true })
      }
    }
  )

  it.each(['ssh_config', 'password'] as const)(
    'cancels and cleans up an active %s job only after owner authority commits',
    async () => {
      const harness = createHarness([job()])
      await harness.owner.prepareSessionJobDeletion('project-1', 'session-1')
      expect(harness.dispatchTracker.waitFor).toHaveBeenCalledWith(['job-1'])
      expect(harness.runner.run).not.toHaveBeenCalled()
      expect(harness.lifecycle.deleteOwnerRows).not.toHaveBeenCalled()
      expect(harness.runtime.resume).toHaveBeenCalledOnce()

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
        'poller-resumed',
        'owner-authority',
        'remote-cleanup',
        'delete-rows',
        'queue-resumed'
      ])
      expect(harness.connectionBroker.acquire).toHaveBeenCalledWith('ssh:cluster', {
        intent: 'job_cleanup'
      })
      const cleanup = String(harness.runner.run.mock.calls[0]?.[1])
      expect(cleanup).toContain('cleanup_job_pid 123 || exit 1')
      expect(cleanup).toContain('rm -rf -- "$workdir"')
    }
  )

  it('deletes queued jobs without contacting the remote host', async () => {
    const harness = createHarness([job({ status: 'queued', remote_handle: undefined })])
    await harness.owner.prepareSessionJobDeletion('project-1', 'session-1')
    await harness.owner.commitSessionJobDeletion('project-1', 'session-1')
    expect(harness.hostRepository.get).not.toHaveBeenCalled()
    expect(harness.runner.run).not.toHaveBeenCalled()
    expect(harness.lifecycle.deleteOwnerRows).toHaveBeenCalledOnce()
  })

  it('cleans up a submitted Job without a remote handle or handle-derived PID kill', async () => {
    const harness = createHarness([job({ status: 'submitted', remote_handle: undefined })])

    await harness.owner.prepareSessionJobDeletion('project-1', 'session-1')
    await harness.owner.commitSessionJobDeletion('project-1', 'session-1')

    expect(harness.runner.run).toHaveBeenCalledOnce()
    const cleanup = String(harness.runner.run.mock.calls[0]?.[1])
    expect(cleanup).not.toContain('cleanup_job_pid 123')
    expect(cleanup).toContain('cleanup_job_pid "$(cat ')
    expect(harness.lifecycle.deleteOwnerRows).toHaveBeenCalledOnce()
  })

  it.skipIf(process.platform === 'win32')(
    'refuses to clean a submitted Job whose existing workdir has no PID witness',
    async () => {
      const scratchRoot = mkdtempSync(join(tmpdir(), 'compute-submitted-cleanup-'))
      const workdir = join(scratchRoot, '.openscience', 'jobs', 'job-1')
      mkdirSync(workdir, { recursive: true })
      const harness = createHarness([
        job({ status: 'submitted', remote_handle: undefined, remote_workdir: workdir })
      ])
      harness.runner.run.mockImplementationOnce(async (_host, command) => {
        const result = spawnSync('/bin/sh', ['-c', command])
        return {
          exitCode: result.status ?? 1,
          stdout: '',
          stderr: result.stderr.toString(),
          truncated: false,
          timedOut: false
        }
      })

      try {
        await expect(
          harness.owner.cleanupJobRemote({
            jobId: 'job-1',
            providerId: 'ssh:cluster',
            projectId: 'project-1',
            sessionId: 'session-1',
            disposition: 'cleaned'
          })
        ).rejects.toThrow(/remote compute job cleanup failed/i)
        expect(existsSync(workdir)).toBe(true)
        expect(harness.jobRepository.settleRemoteCleanup).not.toHaveBeenCalled()
      } finally {
        rmSync(scratchRoot, { recursive: true, force: true })
      }
    }
  )

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

    expect(harness.runner.run).not.toHaveBeenCalled()
    await harness.owner.commitSessionJobDeletion('project-1', 'session-1')
    expect(harness.connectionBroker.acquire).toHaveBeenCalledWith('ssh:cluster', {
      intent: 'job_cleanup'
    })
    expect(harness.runner.run).toHaveBeenCalledOnce()
  })

  it.each(['cleaned', 'abandoned'] as const)(
    'deletes an owner without repeating %s remote cleanup after Host removal',
    async (remoteCleanupDisposition) => {
      const harness = createHarness([
        job({
          status: 'success',
          remote_handle: undefined,
          remote_cleanup_disposition: remoteCleanupDisposition
        })
      ])
      harness.hostRepository.get.mockResolvedValue(null)

      await harness.owner.prepareSessionJobDeletion('project-1', 'session-1')
      await harness.owner.commitSessionJobDeletion('project-1', 'session-1')

      expect(harness.hostRepository.get).not.toHaveBeenCalled()
      expect(harness.connectionBroker.acquire).not.toHaveBeenCalled()
      expect(harness.lifecycle.deleteOwnerRows).toHaveBeenCalledOnce()
    }
  )

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
    expect(harness.runner.run.mock.calls[0]?.[1]).toContain(
      "scratch_root=$(cd -- '/scratch/scientist' 2>/dev/null && pwd -P) || exit 1"
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

    const cleanup = harness.owner.commitSessionJobDeletion('project-1', 'session-1')
    await expect(cleanup).rejects.toBeInstanceOf(ComputeConnectionError)
    await expect(cleanup).rejects.toMatchObject({
      code: 'host_unreachable',
      message: 'The Compute Host could not be reached.'
    })
    expect(JSON.stringify(await cleanup.catch((error) => error))).not.toContain('offline')
    expect(harness.lifecycle.deleteOwnerRows).not.toHaveBeenCalled()
    expect(harness.lifecycle.abortOwnerDeletion).not.toHaveBeenCalled()
    expect(harness.queueManager.resumeOwner).not.toHaveBeenCalled()
    expect(harness.runtime.resume).toHaveBeenCalledOnce()
  })

  it('recovers a retained child Session plan before preparing its parent Project', async () => {
    const harness = createHarness([job()])
    harness.runner.run.mockResolvedValueOnce({
      exitCode: 255,
      stdout: '',
      stderr: 'offline',
      truncated: false,
      timedOut: false
    })
    await harness.owner.prepareSessionJobDeletion('project-1', 'session-1')
    await expect(harness.owner.commitSessionJobDeletion('project-1', 'session-1')).rejects.toThrow(
      'The Compute Host could not be reached.'
    )

    await expect(harness.owner.abortProjectJobDeletion('project-1')).resolves.toBeUndefined()
    expect(harness.lifecycle.abortOwnerDeletion).not.toHaveBeenCalled()
    expect(harness.queueManager.resumeOwner).not.toHaveBeenCalled()

    const isOwnerLive = vi.fn(async () => false)
    await harness.owner.reconcileProjectOrphanJobs('project-1', isOwnerLive)

    expect(isOwnerLive).toHaveBeenCalledWith({
      projectId: 'project-1',
      sessionId: 'session-1'
    })
    expect(harness.lifecycle.deleteOwnerRows).toHaveBeenCalledWith({
      projectId: 'project-1',
      sessionId: 'session-1'
    })
    await expect(harness.owner.prepareProjectJobDeletion('project-1')).resolves.toBeUndefined()
    expect(harness.lifecycle.beginOwnerDeletion).toHaveBeenLastCalledWith({
      projectId: 'project-1'
    })
  })

  it('waits for a prepared Session plan before preparing its parent Project', async () => {
    const harness = createHarness([job()])
    await harness.owner.prepareSessionJobDeletion('project-1', 'session-1')

    const projectPreparation = expect(
      harness.owner.prepareProjectJobDeletion('project-1')
    ).resolves.toBeUndefined()
    await harness.owner.commitSessionJobDeletion('project-1', 'session-1')
    await projectPreparation

    expect(harness.lifecycle.beginOwnerDeletion).toHaveBeenLastCalledWith({
      projectId: 'project-1'
    })
  })

  it('reports a retained Session cleanup failure to a waiting Project prepare', async () => {
    const harness = createHarness([job()])
    harness.runner.run.mockResolvedValueOnce({
      exitCode: 255,
      stdout: '',
      stderr: 'offline',
      truncated: false,
      timedOut: false
    })
    await harness.owner.prepareSessionJobDeletion('project-1', 'session-1')

    const projectPreparation = expect(
      harness.owner.prepareProjectJobDeletion('project-1')
    ).rejects.toThrow('The Compute Host could not be reached.')
    await expect(harness.owner.commitSessionJobDeletion('project-1', 'session-1')).rejects.toThrow(
      'The Compute Host could not be reached.'
    )
    await projectPreparation

    expect(harness.lifecycle.beginOwnerDeletion).not.toHaveBeenCalledWith({
      projectId: 'project-1'
    })
  })

  it('limits pre-Project recovery to orphan Sessions from that Project', async () => {
    const harness = createHarness([job()])
    harness.jobRepository.listOwners.mockResolvedValueOnce([
      { projectId: 'project-2', sessionId: 'session-2' },
      { projectId: 'project-1', sessionId: 'session-1' }
    ])
    const isOwnerLive = vi.fn(async () => false)

    await harness.owner.reconcileProjectOrphanJobs('project-1', isOwnerLive)

    expect(isOwnerLive).toHaveBeenCalledOnce()
    expect(isOwnerLive).toHaveBeenCalledWith({
      projectId: 'project-1',
      sessionId: 'session-1'
    })
    expect(harness.lifecycle.beginOwnerDeletion).toHaveBeenCalledWith({
      projectId: 'project-1',
      sessionId: 'session-1'
    })
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
      'The Compute Host could not be reached.'
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

  it('keeps unreadable owner authority fail-closed until it becomes live', async () => {
    const harness = createHarness([job()])
    const unknownOwner = vi.fn(async () => 'unknown' as const)

    await harness.owner.restoreOrphanJobDeletionBarriers(unknownOwner)
    await harness.owner.reconcileOrphanJobs(unknownOwner)

    expect(harness.lifecycle.beginOwnerDeletion).toHaveBeenCalledWith({
      projectId: 'project-1',
      sessionId: 'session-1'
    })
    expect(harness.lifecycle.abortOwnerDeletion).not.toHaveBeenCalled()
    expect(harness.jobRepository.findByOwner).not.toHaveBeenCalled()

    await harness.owner.reconcileOrphanJobs(async () => true)

    expect(harness.lifecycle.abortOwnerDeletion).toHaveBeenCalledWith({
      projectId: 'project-1',
      sessionId: 'session-1'
    })
    expect(harness.queueManager.resumeOwner).toHaveBeenCalledOnce()
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
      'The Compute Host could not be reached.'
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

  it('rejects an active handle whose derived paths escape the durable workdir', async () => {
    const unsafe = job()
    const handle = JSON.parse(unsafe.remote_handle ?? '{}') as Record<string, unknown>
    handle.stderr_path = '/tmp/stderr'
    const harness = createHarness([job({ remote_handle: JSON.stringify(handle) })])

    await expect(harness.owner.prepareSessionJobDeletion('project-1', 'session-1')).rejects.toThrow(
      /invalid remote handle/i
    )
    expect(harness.runner.run).not.toHaveBeenCalled()
    expect(harness.lifecycle.deleteOwnerRows).not.toHaveBeenCalled()
  })
})
