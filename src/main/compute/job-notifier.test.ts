/**
 * job-notifier.test.ts — unit tests for the compute_done notification emitter.
 *
 * Three outcome tests (design §8):
 *  - harvest_clean: harvestedAt set, harvestError null
 *  - harvest_failed: harvestedAt set, harvestError non-null
 *  - execution_error: status='error', no harvest dir
 *
 * Idempotency: already-notified jobs must not re-emit.
 * Payload shape: aligned with spec §11.3.
 * Broadcast: reuses broadcastJobUpdated (no new IPC channel).
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import type { ComputeJob } from '../../shared/compute'
import type { ComputeJobRepository } from './job-repository'
import type { ComputeHostRepository } from './repository'
import { emitJobNotification } from './job-notifier'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mkTmp = async (): Promise<string> => {
  const base = join(tmpdir(), `notifier-test-${randomBytes(6).toString('hex')}`)
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
  notified_at: undefined,
  notification_consumed_at: undefined,
  created_at: Date.now(),
  submitted_at: Date.now(),
  started_at: Date.now() - 5000,
  finished_at: Date.now(),
  harvested_at: Date.now(),
  ...overrides
})

const makeMockHostRepository = (): Pick<ComputeHostRepository, 'get'> => ({
  get: vi.fn().mockResolvedValue({ providerId: 'ssh:biowulf', displayName: 'Biowulf HPC' })
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('emitJobNotification', () => {
  it('harvest_clean: sets notifiedAt, broadcasts correct payload shape', async () => {
    const storageRoot = await mkTmp()

    // Create a harvest directory with featured files
    const harvestDir = join(storageRoot, 'notebooks', 'proj-1', 'sess-1', 'hpc', 'job-1')
    const featuredDir = join(harvestDir, 'featured')
    await mkdir(featuredDir, { recursive: true })
    await writeFile(join(featuredDir, 'result.csv'), 'col1,col2\n1,2')
    await writeFile(join(featuredDir, 'fig1.png'), 'PNG data')

    const job = makeJob({
      status: 'success',
      exit_code: 0,
      left_on_remote: JSON.stringify([
        {
          uri: 'ssh://biowulf/~/.openscience/jobs/job-1/big.tar',
          size_mb: 200,
          reason: 'exceeds_max_file_mb'
        }
      ])
    })

    const updatedJob = { ...job, notified_at: Date.now() }
    const mockUpdate = vi.fn().mockResolvedValue(updatedJob)
    const jobRepo: Pick<ComputeJobRepository, 'update'> = { update: mockUpdate }
    const hostRepo = makeMockHostRepository()
    const broadcast = vi.fn()

    await emitJobNotification(job, {
      jobRepository: jobRepo,
      hostRepository: hostRepo,
      storageRoot,
      broadcast
    })

    // notifiedAt should be written
    expect(mockUpdate).toHaveBeenCalledOnce()
    const updateArg = mockUpdate.mock.calls[0][1]
    expect(updateArg.notifiedAt).toBeInstanceOf(Date)

    // broadcast should be called with a JobSummary carrying notification payload fields
    expect(broadcast).toHaveBeenCalledOnce()
    const summary = broadcast.mock.calls[0][0]
    expect(summary.job_id).toBe('job-1')
    expect(summary.status).toBe('success')
    expect(summary.display_name).toBe('Biowulf HPC') // should use host displayName, not raw provider_id
    expect(summary.notified_at).toBeDefined()
    // payload fields embedded in broadcast
    expect(summary.featured_files).toEqual(
      expect.arrayContaining(['hpc/job-1/featured/result.csv', 'hpc/job-1/featured/fig1.png'])
    )
    expect(summary.featured_file_count).toBe(2)
    expect(summary.left_on_remote_count).toBe(1)
    expect(summary.left_on_remote).toHaveLength(1)
    expect(summary.notification_consumed_at).toBeUndefined()
  })

  it('harvest_failed: sets notifiedAt, featured_files from partial harvest dir', async () => {
    const storageRoot = await mkTmp()

    // Only one file was harvested before error
    const harvestDir = join(storageRoot, 'notebooks', 'proj-1', 'sess-1', 'hpc', 'job-1')
    const featuredDir = join(harvestDir, 'featured')
    await mkdir(featuredDir, { recursive: true })
    await writeFile(join(featuredDir, 'partial.csv'), 'data')

    const job = makeJob({
      status: 'failed',
      exit_code: 1,
      harvest_error: 'harvest_failed: scp timed out for big.dat',
      harvested_at: Date.now()
    })

    const updatedJob = { ...job, notified_at: Date.now() }
    const mockUpdate = vi.fn().mockResolvedValue(updatedJob)
    const jobRepo: Pick<ComputeJobRepository, 'update'> = { update: mockUpdate }
    const hostRepo = makeMockHostRepository()
    const broadcast = vi.fn()

    await emitJobNotification(job, {
      jobRepository: jobRepo,
      hostRepository: hostRepo,
      storageRoot,
      broadcast
    })

    expect(mockUpdate).toHaveBeenCalledOnce()
    const summary = broadcast.mock.calls[0][0]
    expect(summary.status).toBe('failed')
    expect(summary.featured_files).toEqual(['hpc/job-1/featured/partial.csv'])
    expect(summary.featured_file_count).toBe(1)
    expect(summary.notified_at).toBeDefined()
  })

  it('execution error: sets notifiedAt, featured_files empty, featured_file_count 0', async () => {
    const storageRoot = await mkTmp()

    // No harvest dir — error jobs skip harvest entirely
    const job = makeJob({
      status: 'error',
      exit_code: undefined,
      error_code: 'dispatch_failed',
      harvested_at: undefined,
      harvest_error: undefined
    })

    const updatedJob = { ...job, notified_at: Date.now() }
    const mockUpdate = vi.fn().mockResolvedValue(updatedJob)
    const jobRepo: Pick<ComputeJobRepository, 'update'> = { update: mockUpdate }
    const hostRepo = makeMockHostRepository()
    const broadcast = vi.fn()

    await emitJobNotification(job, {
      jobRepository: jobRepo,
      hostRepository: hostRepo,
      storageRoot,
      broadcast
    })

    expect(mockUpdate).toHaveBeenCalledOnce()
    const summary = broadcast.mock.calls[0][0]
    expect(summary.status).toBe('error')
    expect(summary.featured_files).toEqual([])
    expect(summary.featured_file_count).toBe(0)
    expect(summary.left_on_remote_count).toBe(0)
    expect(summary.left_on_remote).toEqual([])
    expect(summary.notified_at).toBeDefined()
  })

  it('idempotent: already-notified job is not re-emitted', async () => {
    const storageRoot = await mkTmp()

    const job = makeJob({
      notified_at: Date.now() - 1000 // already notified
    })

    const mockUpdate = vi.fn()
    const jobRepo: Pick<ComputeJobRepository, 'update'> = { update: mockUpdate }
    const hostRepo: Pick<ComputeHostRepository, 'get'> = { get: vi.fn() }
    const broadcast = vi.fn()

    await emitJobNotification(job, { jobRepository: jobRepo, hostRepository: hostRepo, storageRoot, broadcast })

    // Neither update nor broadcast should be called
    expect(mockUpdate).not.toHaveBeenCalled()
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('paths are workspace-relative (hpc/<jobId>/featured/...)', async () => {
    const storageRoot = await mkTmp()

    const harvestDir = join(storageRoot, 'notebooks', 'proj-1', 'sess-1', 'hpc', 'job-1')
    const featuredDir = join(harvestDir, 'featured')
    await mkdir(featuredDir, { recursive: true })
    await writeFile(join(featuredDir, 'out.result'), 'data')

    const job = makeJob({ status: 'success' })

    const updatedJob = { ...job, notified_at: Date.now() }
    const mockUpdate = vi.fn().mockResolvedValue(updatedJob)
    const jobRepo: Pick<ComputeJobRepository, 'update'> = { update: mockUpdate }
    const hostRepo = makeMockHostRepository()
    const broadcast = vi.fn()

    await emitJobNotification(job, {
      jobRepository: jobRepo,
      hostRepository: hostRepo,
      storageRoot,
      broadcast
    })

    const summary = broadcast.mock.calls[0][0]
    // All paths should be relative (no absolute path prefix)
    for (const p of summary.featured_files) {
      expect(p.startsWith('hpc/')).toBe(true)
      expect(p.startsWith('/')).toBe(false)
    }
  })
})
