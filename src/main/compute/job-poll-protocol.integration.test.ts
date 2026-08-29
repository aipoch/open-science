import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it, vi } from 'vitest'

import type { ComputeJob } from '../../shared/compute'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { ComputeService } from './compute-service'
import type { ComputeConnectionBrokerAcquirer } from './connection-broker'
import { ComputeJobRepository } from './job-repository'
import { JobPoller } from './job-poller'
import type { ComputeHostRepository } from './repository'
import type { SshRunner } from './ssh-runner'

const nonce = 'INTEGRITY_'
const providerId = 'ssh:cluster'
const remoteHandle = (jobId: string): string =>
  JSON.stringify({
    pid: jobId === 'damaged-job' ? 101 : 202,
    exit_code_path: `~/.openscience/jobs/${jobId}/exit_code`,
    stdout_path: `~/.openscience/jobs/${jobId}/stdout`,
    stderr_path: `~/.openscience/jobs/${jobId}/stderr`,
    workdir: `~/.openscience/jobs/${jobId}`
  })

it('isolates incomplete poll protocol while another Compute Job completes', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-poll-integrity-'))
  const client = createProjectDbClient(storageRoot)
  try {
    await migrateApplicationDatabase(client)
    const jobRepository = new ComputeJobRepository(() => Promise.resolve(client))
    for (const jobId of ['damaged-job', 'healthy-job']) {
      await jobRepository.create({
        allowUnencryptedPersistence: true,
        id: jobId,
        providerId,
        shape: 'direct_ssh',
        sessionId: 'session-1',
        projectId: 'project-1',
        intent: 'protocol integrity',
        command: 'echo done',
        commandHash: `${jobId}-hash`,
        remoteWorkdir: `~/.openscience/jobs/${jobId}`,
        initialStatus: 'running'
      })
      await jobRepository.update(jobId, { remoteHandle: remoteHandle(jobId) })
    }

    const updates: ComputeJob[] = []
    const connectionBroker: ComputeConnectionBrokerAcquirer = {
      acquire: vi.fn(async () => ({
        run: vi.fn(async () => ({
          exitCode: 0,
          stdout: [
            `${nonce}JOB_START:damaged-job`,
            'missing-alive-marker',
            `${nonce}exit:`,
            `${nonce}STDOUT_END:damaged-job`,
            `${nonce}STDERR_END:damaged-job`,
            `${nonce}JOB_START:healthy-job`,
            `${nonce}alive:0`,
            `${nonce}exit:0`,
            'first output line',
            'second output line',
            `${nonce}STDOUT_END:healthy-job`,
            '',
            `${nonce}STDERR_END:healthy-job`
          ].join('\n'),
          stderr: '',
          truncated: false,
          timedOut: false
        })),
        upload: vi.fn(async () => undefined),
        download: vi.fn()
      }))
    }
    const hostRepository = { get: vi.fn(async () => null) } as unknown as ComputeHostRepository
    await new JobPoller({
      connectionBroker,
      hostRepository,
      jobRepository,
      onJobUpdated: (job) => updates.push(job),
      makeNonce: () => nonce
    }).tick()

    const service = new ComputeService({
      runner: {} as SshRunner,
      repository: hostRepository,
      jobRepository
    })
    await expect(service.getJobStatus('damaged-job')).resolves.toMatchObject({ status: 'running' })
    expect(await jobRepository.get('damaged-job')).toMatchObject({
      status: 'running',
      last_poll_error: 'poll_protocol_incomplete'
    })
    await expect(service.getJobStatus('healthy-job')).resolves.toMatchObject({
      status: 'success',
      exit_code: 0,
      stdout_tail: 'first output line\nsecond output line'
    })
    expect(updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ job_id: 'damaged-job', status: 'running' }),
        expect.objectContaining({ job_id: 'healthy-job', status: 'success' })
      ])
    )
  } finally {
    await client.$disconnect()
    await rm(storageRoot, { recursive: true, force: true })
  }
})

it('recovers malformed handles from durable workdirs without blocking a healthy sibling', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-handle-recovery-'))
  const client = createProjectDbClient(storageRoot)
  try {
    await migrateApplicationDatabase(client)
    const jobRepository = new ComputeJobRepository(() => Promise.resolve(client))
    for (const jobId of ['malformed-json', 'invalid-shape', 'healthy-job']) {
      await jobRepository.create({
        allowUnencryptedPersistence: true,
        id: jobId,
        providerId,
        shape: 'direct_ssh',
        sessionId: 'session-1',
        projectId: 'project-1',
        intent: 'handle recovery',
        command: 'echo done',
        commandHash: `${jobId}-hash`,
        remoteWorkdir: `~/.openscience/jobs/${jobId}`,
        initialStatus: 'running'
      })
    }
    await jobRepository.update('malformed-json', { remoteHandle: JSON.stringify({}) })
    await jobRepository.update('invalid-shape', {
      remoteHandle: JSON.stringify({
        pid: '202',
        exit_code_path: '/wrong/exit_code',
        stdout_path: '/wrong/stdout',
        stderr_path: '/wrong/stderr',
        workdir: '/wrong'
      })
    })
    await jobRepository.update('healthy-job', { remoteHandle: remoteHandle('healthy-job') })

    const run = vi.fn(async (command: string) => {
      if (command.includes('OPEN_SCIENCE_DISPATCH_RECOVERY_V1')) {
        const jobId = command.includes('malformed-json') ? 'malformed-json' : 'invalid-shape'
        const pid = jobId === 'malformed-json' ? 301 : 302
        return {
          exitCode: 0,
          stdout: [
            'OPEN_SCIENCE_DISPATCH_RECOVERY_V1',
            'workdir:1',
            'exit_code:',
            `pid:${pid}`,
            'cwd_match:1'
          ].join('\n'),
          stderr: '',
          truncated: false,
          timedOut: false
        }
      }
      return {
        exitCode: 0,
        stdout: [
          `${nonce}JOB_START:healthy-job`,
          `${nonce}alive:0`,
          `${nonce}exit:0`,
          'healthy output',
          `${nonce}STDOUT_END:healthy-job`,
          '',
          `${nonce}STDERR_END:healthy-job`
        ].join('\n'),
        stderr: '',
        truncated: false,
        timedOut: false
      }
    })
    const connectionBroker: ComputeConnectionBrokerAcquirer = {
      acquire: vi.fn(async () => ({ run, upload: vi.fn(), download: vi.fn() }))
    }

    await new JobPoller({
      connectionBroker,
      hostRepository: { get: vi.fn(async () => null) } as unknown as ComputeHostRepository,
      jobRepository,
      makeNonce: () => nonce
    }).tick()

    for (const [jobId, pid] of [
      ['malformed-json', 301],
      ['invalid-shape', 302]
    ] as const) {
      const recovered = await jobRepository.get(jobId)
      expect(recovered?.status).toBe('running')
      expect(JSON.parse(recovered?.remote_handle ?? '')).toEqual({
        pid,
        exit_code_path: `~/.openscience/jobs/${jobId}/exit_code`,
        stdout_path: `~/.openscience/jobs/${jobId}/stdout`,
        stderr_path: `~/.openscience/jobs/${jobId}/stderr`,
        workdir: `~/.openscience/jobs/${jobId}`
      })
    }
    expect(await jobRepository.get('healthy-job')).toMatchObject({
      status: 'success',
      exit_code: 0,
      stdout_tail: 'healthy output'
    })
  } finally {
    await client.$disconnect()
    await rm(storageRoot, { recursive: true, force: true })
  }
})

it('safely converges a persistently ambiguous malformed handle across poller restart', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-handle-convergence-'))
  const client = createProjectDbClient(storageRoot)
  try {
    await migrateApplicationDatabase(client)
    const jobRepository = new ComputeJobRepository(() => Promise.resolve(client))
    for (const jobId of ['ambiguous-handle', 'healthy-sibling']) {
      await jobRepository.create({
        allowUnencryptedPersistence: true,
        id: jobId,
        providerId,
        shape: 'direct_ssh',
        sessionId: 'session-1',
        projectId: 'project-1',
        intent: 'handle convergence',
        command: 'echo done',
        commandHash: `${jobId}-hash`,
        remoteWorkdir: `~/.openscience/jobs/${jobId}`,
        initialStatus: 'running'
      })
    }
    await jobRepository.update('ambiguous-handle', { remoteHandle: JSON.stringify({}) })
    await jobRepository.update('healthy-sibling', { remoteHandle: remoteHandle('healthy-sibling') })

    const run = vi.fn(async (command: string) => {
      if (command.includes('OPEN_SCIENCE_DISPATCH_RECOVERY_V1')) {
        return {
          exitCode: 0,
          stdout: [
            'OPEN_SCIENCE_DISPATCH_RECOVERY_V1',
            'workdir:1',
            'exit_code:',
            'pid:not-a-pid',
            'cwd_match:1'
          ].join('\n'),
          stderr: '',
          truncated: false,
          timedOut: false
        }
      }
      return {
        exitCode: 0,
        stdout: [
          `${nonce}JOB_START:healthy-sibling`,
          `${nonce}alive:0`,
          `${nonce}exit:0`,
          'healthy output',
          `${nonce}STDOUT_END:healthy-sibling`,
          '',
          `${nonce}STDERR_END:healthy-sibling`
        ].join('\n'),
        stderr: '',
        truncated: false,
        timedOut: false
      }
    })
    const connectionBroker: ComputeConnectionBrokerAcquirer = {
      acquire: vi.fn(async () => ({ run, upload: vi.fn(), download: vi.fn() }))
    }
    const makePoller = (): JobPoller =>
      new JobPoller({
        connectionBroker,
        hostRepository: { get: vi.fn(async () => null) } as unknown as ComputeHostRepository,
        jobRepository,
        makeNonce: () => nonce
      })

    await makePoller().tick()
    expect(await jobRepository.get('ambiguous-handle')).toMatchObject({
      status: 'running',
      last_poll_error: 'remote_handle_recovery_ambiguous'
    })
    expect(await jobRepository.get('healthy-sibling')).toMatchObject({
      status: 'success',
      exit_code: 0
    })

    // A fresh poller must use the durable first observation rather than an in-memory counter.
    await makePoller().tick()
    expect(await jobRepository.get('ambiguous-handle')).toMatchObject({
      status: 'error',
      error_code: 'dispatch_failed',
      last_poll_error: 'remote_handle_recovery_ambiguous'
    })
    expect(run.mock.calls.map(([command]) => command)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/kill\s+-(?:TERM|KILL)/)])
    )
  } finally {
    await client.$disconnect()
    await rm(storageRoot, { recursive: true, force: true })
  }
})
