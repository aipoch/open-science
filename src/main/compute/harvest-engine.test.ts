/**
 * harvest-engine.test.ts — injected-fake tests for the harvest download engine.
 *
 * Pattern mirrors job-dispatcher.test.ts / job-poller.test.ts:
 * - Fake SshRunner returns canned `find -printf` output.
 * - Fake ScpRunner records copy() calls and optionally throws.
 * - Real fs writes go to a tmp dir via the mkdtemp helper.
 *
 * Design ref: design.md §4 (harvest dir layout), §5 (classification),
 *             §6 (enumeration), §9 (harvest_failed).
 */

import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import type { ComputeJob } from '../../shared/compute'
import type { SshRunner } from './ssh-runner'
import type { ScpRunner, ScpResult } from './scp-runner'
import type { ComputeJobRepository } from './job-repository'
import type { ComputeHostRepository } from './repository'
import { getJobHarvestDir, harvestJob } from './harvest-engine'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mkTmp = async (): Promise<string> => {
  const base = join(tmpdir(), `harvest-test-${randomBytes(6).toString('hex')}`)
  await mkdir(base, { recursive: true })
  return base
}

const makeJob = (overrides: Partial<ComputeJob> = {}): ComputeJob => ({
  job_id: 'job-1',
  provider_id: 'ssh:biowulf',
  shape: 'direct_ssh',
  session_id: 'sess-1',
  project_id: 'proj-1',
  status: 'success',
  intent: 'test',
  command: 'echo hello',
  command_hash: 'abc',
  environment: undefined,
  resource_request: undefined,
  input_manifest: undefined,
  output_manifest: undefined,
  harvest_config: undefined,
  timeout_seconds: 3600,
  remote_workdir: '~/.openscience/jobs/job-1',
  remote_handle: undefined,
  exit_code: 0,
  stdout_tail: 'hello',
  stderr_tail: '',
  error_code: undefined,
  created_at: Date.now(),
  submitted_at: Date.now(),
  started_at: Date.now() - 5000,
  finished_at: Date.now(),
  harvested_at: undefined,
  ...overrides
})

const sampleHost = (): import('../../shared/compute').ComputeHost => ({
  id: 'host-1',
  providerId: 'ssh:biowulf',
  displayName: 'biowulf',
  shape: 'direct_ssh',
  sshAlias: 'biowulf',
  sshOverrides: undefined,
  scratchRoot: undefined,
  scratchPinned: false,
  concurrencyLimit: undefined,
  probeResult: undefined,
  detailsDoc: '',
  detailsUpdatedAt: undefined,
  detailsUpdatedBy: undefined,
  createdAt: Date.now(),
  updatedAt: Date.now()
})

/** Builds a fake SSH runner that returns the given stdout for the find command. */
const makeSshRunner = (findOutput: string, sshError?: string): SshRunner => ({
  run: vi.fn(() =>
    Promise.resolve({
      exitCode: sshError ? 1 : 0,
      stdout: findOutput,
      stderr: sshError ?? '',
      truncated: false,
      timedOut: false
    })
  )
})

/** Builds a fake SCP runner. Optionally throws on the nth call (1-indexed). */
const makeScpRunner = (failOnCall?: number): ScpRunner & { calls: string[][] } => {
  let callCount = 0
  const calls: string[][] = []
  return {
    calls,
    copy: vi.fn((_bin: string, args: string[]): Promise<ScpResult> => {
      callCount++
      calls.push(args)
      if (failOnCall !== undefined && callCount === failOnCall) {
        return Promise.resolve({ exitCode: 1, stderr: 'scp: connection refused', timedOut: false })
      }
      return Promise.resolve({ exitCode: 0, stderr: '', timedOut: false })
    })
  }
}

const makeHostRepo = (host: ReturnType<typeof sampleHost> | null): ComputeHostRepository =>
  ({
    get: vi.fn(() => Promise.resolve(host))
  }) as unknown as ComputeHostRepository

const makeJobRepo = (
  job: ComputeJob
): {
  repo: Pick<ComputeJobRepository, 'update'>
  updates: { jobId: string; data: unknown }[]
} => {
  const updates: { jobId: string; data: unknown }[] = []
  const repo = {
    update: vi.fn((jobId: string, data: unknown) => {
      updates.push({ jobId, data })
      return Promise.resolve({ ...job, ...(data as object) })
    })
  } as unknown as Pick<ComputeJobRepository, 'update'>
  return { repo, updates }
}

// Build a find-printf output string from an array of {path, size_bytes} entries.
const findOutput = (entries: { path: string; size_bytes: number }[]): string =>
  entries.map((e) => `${e.path}\t${e.size_bytes}`).join('\n')

// ---------------------------------------------------------------------------
// Path helper: getJobHarvestDir
// ---------------------------------------------------------------------------

describe('getJobHarvestDir', () => {
  it('returns <storageRoot>/notebooks/<project>/<sessionId>/hpc/<jobId>', () => {
    const dir = getJobHarvestDir('/storage', 'myproject', 'sess-abc', 'job-xyz')
    expect(dir).toBe('/storage/notebooks/myproject/sess-abc/hpc/job-xyz')
  })

  it('rejects path-traversal in project segment', () => {
    expect(() => getJobHarvestDir('/storage', '../evil', 'sess-1', 'job-1')).toThrow()
  })

  it('rejects path-traversal in sessionId segment', () => {
    expect(() => getJobHarvestDir('/storage', 'proj', '../evil', 'job-1')).toThrow()
  })
})

// ---------------------------------------------------------------------------
// Clean harvest: featured + hidden files downloaded, harvestedAt set
// ---------------------------------------------------------------------------

describe('harvestJob — clean harvest', () => {
  it('downloads featured and hidden files to correct subdirs, sets harvestedAt', async () => {
    const storageRoot = await mkTmp()
    const job = makeJob({
      output_manifest: JSON.stringify(['*.result', { glob: '*.log', visibility: 'hidden' }])
    })
    const host = sampleHost()
    const ssh = makeSshRunner(
      findOutput([
        { path: 'stdout', size_bytes: 50 },
        { path: 'stderr', size_bytes: 10 },
        { path: 'run.result', size_bytes: 100 },
        { path: 'train.log', size_bytes: 200 },
        { path: 'command.sh', size_bytes: 30 }
      ])
    )
    const scp = makeScpRunner()
    const { repo: jobRepo, updates } = makeJobRepo(job)

    await harvestJob(job, {
      sshRunner: ssh,
      scpRunner: scp,
      hostRepository: makeHostRepo(host),
      jobRepository: jobRepo,
      storageRoot
    })

    // 3 scp copies: stdout, stderr, run.result, train.log  (4 total)
    // stdout + stderr go to harvestDir root, others to featured/ or hidden/
    expect(scp.calls.length).toBe(4)

    // Exactly one DB update — the final write with harvestedAt
    expect(updates.length).toBe(1)
    const finalUpdate = updates[0]!.data as Record<string, unknown>
    expect(finalUpdate.harvestedAt).toBeInstanceOf(Date)
    expect(finalUpdate.harvestError).toBeNull()
  })

  it('sets leftOnRemote to null (empty array JSON) when nothing is left on remote', async () => {
    const storageRoot = await mkTmp()
    const job = makeJob({
      output_manifest: JSON.stringify(['*.result'])
    })
    const ssh = makeSshRunner(findOutput([{ path: 'run.result', size_bytes: 100 }]))
    const scp = makeScpRunner()
    const { repo: jobRepo, updates } = makeJobRepo(job)

    await harvestJob(job, {
      sshRunner: ssh,
      scpRunner: scp,
      hostRepository: makeHostRepo(sampleHost()),
      jobRepository: jobRepo,
      storageRoot
    })

    const finalUpdate = updates[0]!.data as Record<string, unknown>
    expect(JSON.parse(finalUpdate.leftOnRemote as string)).toEqual([])
    expect(finalUpdate.harvestError).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// harvest_failed: partial harvest when scp fails mid-way
// ---------------------------------------------------------------------------

describe('harvestJob — harvest_failed', () => {
  it('sets harvestError on scp failure, still sets harvestedAt, keeps partial files', async () => {
    const storageRoot = await mkTmp()
    const job = makeJob({
      output_manifest: JSON.stringify(['*.result', { glob: '*.log', visibility: 'hidden' }])
    })
    const ssh = makeSshRunner(
      findOutput([
        { path: 'stdout', size_bytes: 50 },
        { path: 'run.result', size_bytes: 100 },
        { path: 'train.log', size_bytes: 200 }
      ])
    )
    // scp fails on 2nd copy call (run.result)
    const scp = makeScpRunner(2)
    const { repo: jobRepo, updates } = makeJobRepo(job)

    await harvestJob(job, {
      sshRunner: ssh,
      scpRunner: scp,
      hostRepository: makeHostRepo(sampleHost()),
      jobRepository: jobRepo,
      storageRoot
    })

    const finalUpdate = updates[0]!.data as Record<string, unknown>
    expect(finalUpdate.harvestedAt).toBeInstanceOf(Date)
    expect(typeof finalUpdate.harvestError).toBe('string')
    expect((finalUpdate.harvestError as string).length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Single file exceeds max_file_mb threshold → left_on_remote
// ---------------------------------------------------------------------------

describe('harvestJob — single-file threshold', () => {
  it('puts file in left_on_remote when it exceeds max_file_mb', async () => {
    const storageRoot = await mkTmp()
    // 200 MB file, default max_file_mb = 100
    const job = makeJob({
      output_manifest: JSON.stringify(['*.bin'])
    })
    const ssh = makeSshRunner(findOutput([{ path: 'model.bin', size_bytes: 200 * 1024 * 1024 }]))
    const scp = makeScpRunner()
    const { repo: jobRepo, updates } = makeJobRepo(job)

    await harvestJob(job, {
      sshRunner: ssh,
      scpRunner: scp,
      hostRepository: makeHostRepo(sampleHost()),
      jobRepository: jobRepo,
      storageRoot
    })

    // model.bin should NOT be downloaded
    expect(scp.calls.length).toBe(0)

    const finalUpdate = updates[0]!.data as Record<string, unknown>
    const leftOnRemote = JSON.parse(finalUpdate.leftOnRemote as string) as Array<{
      uri: string
      size_mb: number
      reason: string
    }>
    expect(leftOnRemote.length).toBe(1)
    expect(leftOnRemote[0]!.reason).toBe('exceeds_max_file_mb')
    expect(leftOnRemote[0]!.uri).toMatch(/^ssh:\/\/biowulf\//)
    expect(leftOnRemote[0]!.size_mb).toBeGreaterThan(100)
  })
})

// ---------------------------------------------------------------------------
// Cumulative threshold: stops pulling when exceeds max_total_mb
// ---------------------------------------------------------------------------

describe('harvestJob — cumulative threshold', () => {
  it('stops downloading when cumulative size exceeds max_total_mb', async () => {
    const storageRoot = await mkTmp()
    // Each file 60 MB (< max_file_mb=100), but together 120 MB > max_total_mb=100
    const job = makeJob({
      harvest_config: JSON.stringify({ max_total_mb: 100 }),
      output_manifest: JSON.stringify(['*.result'])
    })
    const ssh = makeSshRunner(
      findOutput([
        { path: 'part1.result', size_bytes: 60 * 1024 * 1024 },
        { path: 'part2.result', size_bytes: 60 * 1024 * 1024 }
      ])
    )
    const scp = makeScpRunner()
    const { repo: jobRepo, updates } = makeJobRepo(job)

    await harvestJob(job, {
      sshRunner: ssh,
      scpRunner: scp,
      hostRepository: makeHostRepo(sampleHost()),
      jobRepository: jobRepo,
      storageRoot
    })

    // Only first file should be downloaded (second exceeds cumulative threshold)
    // stdout/stderr are also downloaded but no stdout/stderr in this listing
    expect(scp.calls.length).toBe(1)

    const finalUpdate = updates[0]!.data as Record<string, unknown>
    const leftOnRemote = JSON.parse(finalUpdate.leftOnRemote as string) as Array<{
      reason: string
    }>
    expect(leftOnRemote.some((e) => e.reason === 'exceeds_max_total_mb')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Idempotency: second harvest overwrites, no error
// ---------------------------------------------------------------------------

describe('harvestJob — idempotency', () => {
  it('second harvest on same job does not throw and overwrites', async () => {
    const storageRoot = await mkTmp()
    const job = makeJob({
      output_manifest: JSON.stringify(['*.result']),
      harvested_at: Date.now() - 10000 // already harvested once
    })
    const ssh = makeSshRunner(findOutput([{ path: 'run.result', size_bytes: 100 }]))
    const scp = makeScpRunner()
    const { repo: jobRepo, updates } = makeJobRepo(job)

    // Should not throw
    await expect(
      harvestJob(job, {
        sshRunner: ssh,
        scpRunner: scp,
        hostRepository: makeHostRepo(sampleHost()),
        jobRepository: jobRepo,
        storageRoot
      })
    ).resolves.not.toThrow()

    const finalUpdate = updates[0]!.data as Record<string, unknown>
    expect(finalUpdate.harvestedAt).toBeInstanceOf(Date)
  })
})

// ---------------------------------------------------------------------------
// SSH enumeration failure → harvest_failed
// ---------------------------------------------------------------------------

describe('harvestJob — SSH enumeration failure', () => {
  it('records harvestError when SSH find command fails', async () => {
    const storageRoot = await mkTmp()
    const job = makeJob()
    const ssh = makeSshRunner('', 'ssh: connection refused')
    const scp = makeScpRunner()
    const { repo: jobRepo, updates } = makeJobRepo(job)

    await harvestJob(job, {
      sshRunner: ssh,
      scpRunner: scp,
      hostRepository: makeHostRepo(sampleHost()),
      jobRepository: jobRepo,
      storageRoot
    })

    const finalUpdate = updates[0]!.data as Record<string, unknown>
    expect(finalUpdate.harvestedAt).toBeInstanceOf(Date)
    expect(typeof finalUpdate.harvestError).toBe('string')
    expect((finalUpdate.harvestError as string).length).toBeGreaterThan(0)
    // No scp calls — we never got to download phase
    expect(scp.calls.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Missing host → harvest_failed
// ---------------------------------------------------------------------------

describe('harvestJob — missing host', () => {
  it('records harvestError when host is not found', async () => {
    const storageRoot = await mkTmp()
    const job = makeJob()
    const ssh = makeSshRunner('')
    const scp = makeScpRunner()
    const { repo: jobRepo, updates } = makeJobRepo(job)

    await harvestJob(job, {
      sshRunner: ssh,
      scpRunner: scp,
      hostRepository: makeHostRepo(null), // host not found
      jobRepository: jobRepo,
      storageRoot
    })

    const finalUpdate = updates[0]!.data as Record<string, unknown>
    expect(finalUpdate.harvestedAt).toBeInstanceOf(Date)
    expect(typeof finalUpdate.harvestError).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// Notification trigger: harvestJob emits compute_done (issue 06)
// ---------------------------------------------------------------------------

describe('harvestJob — compute_done notification (issue 06)', () => {
  it('calls broadcast after successful harvest (harvest_clean)', async () => {
    const storageRoot = await mkTmp()
    const job = makeJob({ status: 'success', exit_code: 0 })

    // Provide a featured file in the listing so featured_files is non-empty.
    const ssh = makeSshRunner('result.csv\t1024\nstdout\t512')
    const scp = makeScpRunner()
    // Use a repo that maps notifiedAt -> notified_at in the response (simulating toJob mapping).
    const updates: { jobId: string; data: unknown }[] = []
    const jobRepo = {
      update: vi.fn((jobId: string, data: Record<string, unknown>) => {
        updates.push({ jobId, data })
        const result: ComputeJob = {
          ...job,
          ...(data as Partial<ComputeJob>),
          // Map Prisma-style notifiedAt -> shared type notified_at
          notified_at: data.notifiedAt instanceof Date ? data.notifiedAt.getTime() : job.notified_at
        }
        return Promise.resolve(result)
      })
    } as unknown as Pick<ComputeJobRepository, 'update'>

    const broadcast = vi.fn()

    await harvestJob(job, {
      sshRunner: ssh,
      scpRunner: scp,
      hostRepository: makeHostRepo(sampleHost()),
      jobRepository: jobRepo,
      storageRoot,
      broadcast
    })

    // harvestedAt written (first update)
    expect(updates.length).toBeGreaterThanOrEqual(1)
    expect(updates[0]!.data).toHaveProperty('harvestedAt')

    // Broadcast was called (notification emitted)
    expect(broadcast).toHaveBeenCalled()
    const summary = broadcast.mock.calls[0][0]
    expect(summary.job_id).toBe('job-1')
    expect(summary.notified_at).toBeDefined()
  })

  it('calls broadcast after harvest_failed outcome', async () => {
    const storageRoot = await mkTmp()
    const job = makeJob({ status: 'failed', exit_code: 1 })

    // SSH enumerate throws → harvest_failed
    const ssh = {
      run: vi.fn().mockRejectedValue(new Error('SSH timeout'))
    } as unknown as import('./ssh-runner').SshRunner
    const scp = makeScpRunner()

    // Repo maps notifiedAt → notified_at
    const jobRepo = {
      update: vi.fn((jobId: string, data: Record<string, unknown>) => {
        const result: ComputeJob = {
          ...job,
          ...(data as Partial<ComputeJob>),
          notified_at: data.notifiedAt instanceof Date ? data.notifiedAt.getTime() : job.notified_at
        }
        return Promise.resolve(result)
      })
    } as unknown as Pick<ComputeJobRepository, 'update'>

    const broadcast = vi.fn()

    await harvestJob(job, {
      sshRunner: ssh,
      scpRunner: scp,
      hostRepository: makeHostRepo(sampleHost()),
      jobRepository: jobRepo,
      storageRoot,
      resolveSshTargetFn: vi.fn().mockResolvedValue({
        sshBinary: '/usr/bin/ssh',
        host: 'biowulf.nih.gov',
        extraArgs: []
      }),
      broadcast
    })

    // Broadcast still called despite harvest failure
    expect(broadcast).toHaveBeenCalled()
    const summary = broadcast.mock.calls[0][0]
    expect(summary.notified_at).toBeDefined()
    // Error path: featured_files are empty (no files were downloaded)
    expect(summary.featured_files).toEqual([])
    expect(summary.output_file_count).toBe(0)
  })

  it('does NOT call broadcast when broadcast is not wired', async () => {
    const storageRoot = await mkTmp()
    const job = makeJob()
    const ssh = makeSshRunner('')
    const scp = makeScpRunner()
    const { repo: jobRepo } = makeJobRepo(job)

    await harvestJob(job, {
      sshRunner: ssh,
      scpRunner: scp,
      hostRepository: makeHostRepo(sampleHost()),
      jobRepository: jobRepo,
      storageRoot
      // no broadcast
    })

    // No crash — just silent, no broadcast
  })
})
