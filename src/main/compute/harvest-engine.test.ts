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

import { mkdir, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import type { ComputeJob } from '../../shared/compute'
import type { ExecutionFileEvidenceSummary } from '../../shared/execution-file-evidence'
import type { SshRunner } from './ssh-runner'
import type { BoundedScpResult, ScpRunner, ScpResult } from './scp-runner'
import {
  ComputeConnectionError,
  type ComputeConnectionBrokerAcquirer,
  type ComputeConnectionLease
} from './connection-broker'
import type { ComputeJobRepository } from './job-repository'
import type { ComputeHostRepository } from './repository'
import {
  HARVEST_FREE_DISK_RESERVE_BYTES,
  getJobHarvestDir,
  harvestJob,
  type HarvestDeps
} from './harvest-engine'
import { beginMigration, clearMigrationPending } from '../storage/migration-state'
import {
  beginComputeJobFileEvidence,
  publishComputeJobFileEvidence
} from '../notebook/working-file-observer'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mkTmp = async (): Promise<string> => {
  const base = join(tmpdir(), `harvest-test-${randomBytes(6).toString('hex')}`)
  await mkdir(base, { recursive: true })
  return base
}

const MIB_BYTES_FOR_TEST = 1024 * 1024

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

/** Builds a fake bounded copy runner. Optionally fails on the nth call (1-indexed). */
const makeScpRunner = (failOnCall?: number): ScpRunner & { calls: string[][] } => {
  let callCount = 0
  const calls: string[][] = []
  return {
    calls,
    copy: vi.fn((): Promise<ScpResult> =>
      Promise.resolve({ exitCode: 0, stderr: '', timedOut: false })
    ),
    copyFromRemoteBounded: vi.fn(
      async (_target, remotePath, localPath): Promise<BoundedScpResult> => {
        callCount++
        calls.push([remotePath, localPath])
        if (failOnCall !== undefined && callCount === failOnCall) {
          return {
            exitCode: 1,
            stderr: 'scp: remote copy failed',
            timedOut: false,
            bytesWritten: 0,
            exceeded: false
          }
        }
        await mkdir(dirname(localPath), { recursive: true })
        await writeFile(localPath, '')
        return {
          exitCode: 0,
          stderr: '',
          timedOut: false,
          bytesWritten: 0,
          exceeded: false
        }
      }
    )
  }
}

const makeWritingScpRunner = (): ScpRunner => ({
  copy: vi.fn((): Promise<ScpResult> =>
    Promise.resolve({ exitCode: 0, stderr: '', timedOut: false })
  ),
  copyFromRemoteBounded: vi.fn(async (_target, _remotePath, localPath) => {
    const contents = 'downloaded'
    await mkdir(dirname(localPath), { recursive: true })
    await writeFile(localPath, contents)
    return {
      exitCode: 0,
      stderr: '',
      timedOut: false,
      bytesWritten: Buffer.byteLength(contents),
      exceeded: false
    }
  })
})

const brokerFromRunners = (
  sshRunner: SshRunner,
  scpRunner: ScpRunner
): ComputeConnectionBrokerAcquirer => ({
  acquire: vi.fn(
    async () =>
      ({
        run: (command, options) => sshRunner.run({} as never, command, options),
        upload: vi.fn(async () => undefined),
        download: async (remotePath, localPath, maxBytes) => {
          if (!scpRunner.copyFromRemoteBounded)
            throw new Error('bounded remote copy is unavailable')
          return scpRunner.copyFromRemoteBounded({} as never, remotePath, localPath, maxBytes)
        }
      }) satisfies ComputeConnectionLease
  )
})

const makeHostRepo = (host: ReturnType<typeof sampleHost> | null): ComputeHostRepository =>
  ({
    get: vi.fn(() => Promise.resolve(host))
  }) as unknown as ComputeHostRepository

const makeJobRepo = (
  job: ComputeJob
): {
  repo: Pick<ComputeJobRepository, 'update' | 'claimNotification'>
  updates: { jobId: string; data: unknown }[]
} => {
  const updates: { jobId: string; data: unknown }[] = []
  const repo = {
    update: vi.fn((jobId: string, data: unknown) => {
      updates.push({ jobId, data })
      return Promise.resolve({ ...job, ...(data as object) })
    }),
    claimNotification: vi.fn((_jobId: string, notifiedAt: Date) =>
      Promise.resolve({ ...job, notified_at: notifiedAt.getTime() })
    )
  } as unknown as Pick<ComputeJobRepository, 'update' | 'claimNotification'>
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
    expect(dir).toBe(join('/storage', 'notebooks', 'myproject', 'sess-abc', 'hpc', 'job-xyz'))
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
  it('excludes staged inputs from both current and legacy input manifests', async () => {
    const storageRoot = await mkTmp()
    const job = makeJob({
      input_manifest: JSON.stringify([
        { kind: 'upload', dstFilename: 'current-input.csv' },
        { kind: 'upload', dest: 'legacy-input.csv' }
      ])
    })
    const scp = makeScpRunner()

    await harvestJob(job, {
      connectionBroker: brokerFromRunners(
        makeSshRunner(
          findOutput([
            { path: 'current-input.csv', size_bytes: 10 },
            { path: 'legacy-input.csv', size_bytes: 10 },
            { path: 'result.csv', size_bytes: 10 }
          ])
        ),
        scp
      ),
      hostRepository: makeHostRepo(sampleHost()),
      jobRepository: makeJobRepo(job).repo,
      storageRoot
    })

    expect(scp.calls.map(([remotePath]) => remotePath)).toEqual([
      '~/.openscience/jobs/job-1/result.csv'
    ])
  })

  it('publishes one complete replacement without stale files from an older harvest', async () => {
    const storageRoot = await mkTmp()
    const job = makeJob({ output_manifest: JSON.stringify(['*.result']) })
    const harvestDir = getJobHarvestDir(storageRoot, job.project_id, job.session_id, job.job_id)
    await mkdir(join(harvestDir, 'featured'), { recursive: true })
    await mkdir(join(harvestDir, 'hidden'), { recursive: true })
    await writeFile(join(harvestDir, 'featured', 'stale.result'), 'old')
    await writeFile(join(harvestDir, 'hidden', 'stale.log'), 'old')

    await harvestJob(job, {
      connectionBroker: brokerFromRunners(
        makeSshRunner(findOutput([{ path: 'fresh.result', size_bytes: 10 }])),
        makeWritingScpRunner()
      ),
      hostRepository: makeHostRepo(sampleHost()),
      jobRepository: makeJobRepo(job).repo,
      storageRoot
    })

    await expect(readFile(join(harvestDir, 'featured', 'fresh.result'), 'utf8')).resolves.toBe(
      'downloaded'
    )
    await expect(readFile(join(harvestDir, 'featured', 'stale.result'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    await expect(readFile(join(harvestDir, 'hidden', 'stale.log'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('preserves already-published file evidence when harvest is repeated', async () => {
    const storageRoot = await mkTmp()
    const fileEvidence = {
      schemaVersion: 1 as const,
      activityId: 'job-1',
      activityKind: 'compute-job' as const,
      state: 'available' as const,
      evidenceId: 'execution-file-evidence-job-1',
      checksum: 'a'.repeat(64),
      storageKey: 'execution-file-evidence/proj-1/sess-1/activity-job-1/evidence.json',
      scientificOutputCount: 1,
      initialViewState: 'complete' as const,
      managedRootsFinalState: 'complete' as const,
      scientificOutputAnalysis: 'complete' as const,
      fileReads: 'unavailable' as const,
      externalPaths: 'unavailable' as const,
      writerAttribution: 'complete' as const,
      reasonCodes: []
    }
    const job = makeJob({ file_evidence: fileEvidence, harvested_at: Date.now() })
    const { repo, updates } = makeJobRepo(job)

    await harvestJob(job, {
      connectionBroker: brokerFromRunners(makeSshRunner(''), makeScpRunner()),
      hostRepository: makeHostRepo(sampleHost()),
      jobRepository: repo,
      storageRoot
    })

    expect(updates[0]?.data).toMatchObject({ fileEvidence })
  })

  it('freezes featured and hidden outputs without treating stdout as a scientific output', async () => {
    const storageRoot = await mkTmp()
    const job = makeJob({ output_manifest: JSON.stringify(['*.result']) })
    await beginComputeJobFileEvidence({
      storageRoot,
      projectId: job.project_id,
      sessionId: job.session_id,
      jobId: job.job_id,
      inputs: []
    })

    await harvestJob(job, {
      connectionBroker: brokerFromRunners(
        makeSshRunner(
          findOutput([
            { path: 'run.result', size_bytes: 10 },
            { path: 'stdout', size_bytes: 10 }
          ])
        ),
        makeWritingScpRunner()
      ),
      hostRepository: makeHostRepo(sampleHost()),
      jobRepository: makeJobRepo(job).repo,
      storageRoot
    })

    const sidecar = JSON.parse(
      await readFile(
        join(
          storageRoot,
          'execution-file-evidence',
          job.project_id,
          job.session_id,
          `activity-${job.job_id}`,
          'evidence.json'
        ),
        'utf8'
      )
    ) as { relations: Array<{ relation: string; relativePath: string }> }
    expect(sidecar.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relation: 'harvested-output',
          relativePath: `hpc/${job.job_id}/featured/run.result`
        })
      ])
    )
    expect(sidecar.relations).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relativePath: `hpc/${job.job_id}/stdout` })
      ])
    )
  })

  it('writes and reports harvest files from the data-root session workspace, never the config root', async () => {
    const configRoot = await mkTmp()
    const dataRoot = await mkTmp()
    const job = makeJob({
      output_manifest: JSON.stringify(['*.result', { glob: '*.log', visibility: 'hidden' }])
    })
    const broadcasts: import('../../shared/compute').JobSummary[] = []

    await harvestJob(job, {
      connectionBroker: brokerFromRunners(
        makeSshRunner(
          findOutput([
            { path: 'stdout', size_bytes: 10 },
            { path: 'stderr', size_bytes: 10 },
            { path: 'run.result', size_bytes: 10 },
            { path: 'debug.log', size_bytes: 10 }
          ])
        ),
        makeWritingScpRunner()
      ),
      hostRepository: makeHostRepo(sampleHost()),
      jobRepository: makeJobRepo(job).repo,
      storageRoot: dataRoot,
      broadcast: (summary) => broadcasts.push(summary)
    })

    const dataHarvestDir = join(dataRoot, 'notebooks', 'proj-1', 'sess-1', 'hpc', 'job-1')
    const configHarvestDir = join(configRoot, 'notebooks', 'proj-1', 'sess-1', 'hpc', 'job-1')
    await expect(readFile(join(dataHarvestDir, 'featured', 'run.result'), 'utf8')).resolves.toBe(
      'downloaded'
    )
    await expect(readFile(join(dataHarvestDir, 'stdout'), 'utf8')).resolves.toBe('downloaded')
    await expect(readFile(join(dataHarvestDir, 'stderr'), 'utf8')).resolves.toBe('downloaded')
    await expect(readFile(join(dataHarvestDir, 'hidden', 'debug.log'), 'utf8')).resolves.toBe(
      'downloaded'
    )
    await expect(readdir(configHarvestDir)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(broadcasts).toHaveLength(1)
    expect(broadcasts[0]?.featured_files).toEqual(['hpc/job-1/featured/run.result'])
  })

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
    const connectionBroker = brokerFromRunners(ssh, scp)
    const signal = new AbortController().signal

    await harvestJob(job, {
      connectionBroker,
      hostRepository: makeHostRepo(host),
      jobRepository: jobRepo,
      storageRoot,
      signal
    })

    expect(connectionBroker.acquire).toHaveBeenCalledWith(job.provider_id, {
      intent: 'job_harvest',
      signal
    })
    expect(vi.mocked(ssh.run).mock.calls[0]?.[1]).toContain(
      "find ~/'.openscience/jobs/job-1' -type f"
    )
    // Four bounded copies: declared outputs first, then stdout and stderr with the remaining budget.
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
      connectionBroker: brokerFromRunners(ssh, scp),
      hostRepository: makeHostRepo(sampleHost()),
      jobRepository: jobRepo,
      storageRoot
    })

    const finalUpdate = updates[0]!.data as Record<string, unknown>
    expect(JSON.parse(finalUpdate.leftOnRemote as string)).toEqual([])
    expect(finalUpdate.harvestError).toBeNull()
  })
})

describe('harvestJob — data-root migration gate', () => {
  it('does not start a harvest while a data-root migration is pending', async () => {
    const dataRoot = await mkTmp()
    const job = makeJob()
    const { repo: jobRepository, updates } = makeJobRepo(job)

    beginMigration()
    try {
      await expect(
        harvestJob(job, {
          connectionBroker: brokerFromRunners(makeSshRunner(''), makeScpRunner()),
          hostRepository: makeHostRepo(sampleHost()),
          jobRepository,
          storageRoot: dataRoot
        })
      ).rejects.toThrow('Open Science is moving your data')
    } finally {
      clearMigrationPending()
    }

    expect(updates).toEqual([])
    expect(await readdir(dataRoot)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// harvest_failed: partial harvest when scp fails mid-way
// ---------------------------------------------------------------------------

describe('harvestJob — harvest_failed', () => {
  it('cleans unpublished Compute evidence after output snapshot failure', async () => {
    const storageRoot = await mkTmp()
    const job = makeJob({ output_manifest: JSON.stringify(['*.result']) })
    await beginComputeJobFileEvidence({
      storageRoot,
      projectId: job.project_id,
      sessionId: job.session_id,
      jobId: job.job_id,
      inputs: []
    })
    const harvestDir = getJobHarvestDir(storageRoot, job.project_id, job.session_id, job.job_id)
    const attemptDir = `${harvestDir}.harvest-attempt`

    await harvestJob(job, {
      connectionBroker: brokerFromRunners(
        makeSshRunner(findOutput([{ path: 'run.result', size_bytes: 10 }])),
        makeWritingScpRunner()
      ),
      hostRepository: makeHostRepo(sampleHost()),
      jobRepository: makeJobRepo(job).repo,
      storageRoot,
      renameFn: async (source, destination) => {
        await rename(source, destination)
        if (String(source) === attemptDir && String(destination) === harvestDir) {
          const output = join(harvestDir, 'featured', 'run.result')
          await rename(output, `${output}.missing`)
        }
      }
    })

    await expect(
      readdir(join(storageRoot, 'execution-file-evidence', job.project_id, job.session_id))
    ).resolves.toEqual([])
  })

  it('preserves a concurrent Compute publication while cleaning a stale failure', async () => {
    const storageRoot = await mkTmp()
    const job = makeJob({ output_manifest: JSON.stringify(['*.result']) })
    const sourcePath = join(storageRoot, 'published.result')
    await writeFile(sourcePath, 'published evidence')
    await beginComputeJobFileEvidence({
      storageRoot,
      projectId: job.project_id,
      sessionId: job.session_id,
      jobId: job.job_id,
      inputs: []
    })
    const harvestDir = getJobHarvestDir(storageRoot, job.project_id, job.session_id, job.job_id)
    const attemptDir = `${harvestDir}.harvest-attempt`
    let publishedStorageKey: string | undefined
    const jobRepository = {
      update: vi.fn(async () => {
        const fileEvidence = await publishComputeJobFileEvidence({
          storageRoot,
          projectId: job.project_id,
          sessionId: job.session_id,
          jobId: job.job_id,
          outputs: [{ localPath: sourcePath, relativePath: 'published.result' }]
        })
        publishedStorageKey = fileEvidence.storageKey
        return job
      }),
      claimNotification: vi.fn()
    } as unknown as Pick<ComputeJobRepository, 'update' | 'claimNotification'>

    await harvestJob(job, {
      connectionBroker: brokerFromRunners(
        makeSshRunner(findOutput([{ path: 'run.result', size_bytes: 10 }])),
        makeWritingScpRunner()
      ),
      hostRepository: makeHostRepo(sampleHost()),
      jobRepository,
      storageRoot,
      renameFn: async (source, destination) => {
        await rename(source, destination)
        if (String(source) === attemptDir && String(destination) === harvestDir) {
          const output = join(harvestDir, 'featured', 'run.result')
          await rename(output, `${output}.missing`)
        }
      }
    })

    expect(publishedStorageKey).toBeDefined()
    await expect(
      readFile(join(storageRoot, ...publishedStorageKey!.split('/')), 'utf8')
    ).resolves.toContain('published.result')
  })

  it('freezes successful outputs without publishing a partial workspace after a sibling download fails', async () => {
    const storageRoot = await mkTmp()
    const job = makeJob({ output_manifest: JSON.stringify(['*.result']) })
    await beginComputeJobFileEvidence({
      storageRoot,
      projectId: job.project_id,
      sessionId: job.session_id,
      jobId: job.job_id,
      inputs: []
    })
    const harvestDir = getJobHarvestDir(storageRoot, job.project_id, job.session_id, job.job_id)
    const userPartial = join(harvestDir, 'featured', 'user-history.partial')
    await mkdir(dirname(userPartial), { recursive: true })
    await writeFile(userPartial, 'user-owned')
    const scp = makeScpRunner(2)
    const { repo, updates } = makeJobRepo(job)

    await harvestJob(job, {
      connectionBroker: brokerFromRunners(
        makeSshRunner(
          findOutput([
            { path: 'first.result', size_bytes: 10 },
            { path: 'second.result', size_bytes: 10 }
          ])
        ),
        scp
      ),
      hostRepository: makeHostRepo(sampleHost()),
      jobRepository: repo,
      storageRoot
    })

    await expect(readFile(userPartial, 'utf8')).resolves.toBe('user-owned')
    await expect(readFile(join(harvestDir, 'featured', 'first.result'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    const fileEvidence = (
      updates.find(({ data }) => 'fileEvidence' in (data as object))?.data as {
        fileEvidence?: ExecutionFileEvidenceSummary
      }
    ).fileEvidence
    expect(fileEvidence).toMatchObject({
      state: 'partial',
      scientificOutputCount: 1,
      reasonCodes: expect.arrayContaining(['harvest-incomplete'])
    })
    const sidecar = await readFile(
      join(storageRoot, ...(fileEvidence!.storageKey as string).split('/')),
      'utf8'
    )
    expect(sidecar).toContain('first.result')
    expect(sidecar).not.toContain('second.result')
  })

  it('restores the previous complete generation when publication is interrupted', async () => {
    const storageRoot = await mkTmp()
    const job = makeJob({ output_manifest: JSON.stringify(['*.result']) })
    const harvestDir = getJobHarvestDir(storageRoot, job.project_id, job.session_id, job.job_id)
    const attemptDir = `${harvestDir}.harvest-attempt`
    await mkdir(join(harvestDir, 'featured'), { recursive: true })
    await writeFile(join(harvestDir, 'featured', 'old.result'), 'old complete generation')
    let rejectPublish = true
    const renameFn: typeof rename = async (source, destination) => {
      if (rejectPublish && String(source) === attemptDir && String(destination) === harvestDir) {
        rejectPublish = false
        throw new Error('simulated publication interruption')
      }
      await rename(source, destination)
    }

    await expect(
      harvestJob(job, {
        connectionBroker: brokerFromRunners(
          makeSshRunner(findOutput([{ path: 'fresh.result', size_bytes: 10 }])),
          makeWritingScpRunner()
        ),
        hostRepository: makeHostRepo(sampleHost()),
        jobRepository: makeJobRepo(job).repo,
        storageRoot,
        renameFn
      })
    ).rejects.toThrow('simulated publication interruption')

    await expect(readFile(join(harvestDir, 'featured', 'old.result'), 'utf8')).resolves.toBe(
      'old complete generation'
    )
    await expect(readFile(join(harvestDir, 'featured', 'fresh.result'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('does not finalize a harvest cancelled during the initial free-space query', async () => {
    const storageRoot = await mkTmp()
    const job = makeJob()
    const controller = new AbortController()
    const { repo: jobRepo, updates } = makeJobRepo(job)
    const freeSpaceError = new Error('free-space query failed during shutdown')

    await expect(
      harvestJob(job, {
        connectionBroker: brokerFromRunners(makeSshRunner(findOutput([])), makeScpRunner()),
        hostRepository: makeHostRepo(sampleHost()),
        jobRepository: jobRepo,
        storageRoot,
        signal: controller.signal,
        getFreeDiskBytesFn: async () => {
          controller.abort()
          throw freeSpaceError
        }
      })
    ).rejects.toThrow(freeSpaceError.message)
    expect(updates).toEqual([])
  })

  it.each(['ssh_config', 'password'] as const)(
    'leaves %s connection failures unharvested so restart recovery can retry safely',
    async () => {
      const storageRoot = await mkTmp()
      const job = makeJob()
      const { repo: jobRepo, updates } = makeJobRepo(job)
      const recoveredLease: ComputeConnectionLease = {
        run: vi.fn(async () => ({
          exitCode: 0,
          stdout: '',
          stderr: '',
          truncated: false,
          timedOut: false
        })),
        upload: vi.fn(async () => undefined),
        download: vi.fn()
      }
      const connectionBroker: ComputeConnectionBrokerAcquirer = {
        acquire: vi
          .fn()
          .mockRejectedValueOnce(new ComputeConnectionError('authentication_failed'))
          .mockResolvedValueOnce(recoveredLease)
      }
      const publishJobUpdated = vi.fn()
      const deps = {
        connectionBroker,
        hostRepository: makeHostRepo(sampleHost()),
        jobRepository: jobRepo,
        storageRoot,
        publishJobUpdated
      }

      await expect(harvestJob(job, deps)).rejects.toMatchObject({
        code: 'authentication_failed'
      })

      expect(updates[0]?.data).toEqual(
        expect.objectContaining({ harvestError: 'harvest pending: authentication_failed' })
      )
      expect(updates[0]?.data).not.toHaveProperty('harvestedAt')
      expect(publishJobUpdated).toHaveBeenCalledOnce()
      expect(publishJobUpdated).toHaveBeenCalledWith(
        expect.objectContaining({ harvestError: 'harvest pending: authentication_failed' })
      )

      // Simulate the restart scan selecting the still-unharvested row after credentials are repaired.
      await harvestJob(job, deps)
      expect(updates.at(-1)?.data).toEqual(
        expect.objectContaining({ harvestedAt: expect.any(Date), harvestError: null })
      )
    }
  )

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
      connectionBroker: brokerFromRunners(ssh, scp),
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
      connectionBroker: brokerFromRunners(ssh, scp),
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
      connectionBroker: brokerFromRunners(ssh, scp),
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
        connectionBroker: brokerFromRunners(ssh, scp),
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
    const ssh = makeSshRunner('', 'find command failed')
    const scp = makeScpRunner()
    const { repo: jobRepo, updates } = makeJobRepo(job)

    await harvestJob(job, {
      connectionBroker: brokerFromRunners(ssh, scp),
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
      connectionBroker: brokerFromRunners(ssh, scp),
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
      }),
      claimNotification: vi.fn((_jobId: string, notifiedAt: Date) =>
        Promise.resolve({ ...job, notified_at: notifiedAt.getTime() })
      )
    } as unknown as Pick<ComputeJobRepository, 'update' | 'claimNotification'>

    const broadcast = vi.fn()

    await harvestJob(job, {
      connectionBroker: brokerFromRunners(ssh, scp),
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
      update: vi.fn((_jobId: string, data: Record<string, unknown>) => {
        const result: ComputeJob = {
          ...job,
          ...(data as Partial<ComputeJob>),
          notified_at: data.notifiedAt instanceof Date ? data.notifiedAt.getTime() : job.notified_at
        }
        return Promise.resolve(result)
      }),
      claimNotification: vi.fn((_jobId: string, notifiedAt: Date) =>
        Promise.resolve({ ...job, notified_at: notifiedAt.getTime() })
      )
    } as unknown as Pick<ComputeJobRepository, 'update' | 'claimNotification'>

    const broadcast = vi.fn()

    await harvestJob(job, {
      connectionBroker: brokerFromRunners(ssh, scp),
      hostRepository: makeHostRepo(sampleHost()),
      jobRepository: jobRepo,
      storageRoot,
      broadcast
    })

    // Broadcast still called despite harvest failure
    expect(broadcast).toHaveBeenCalled()
    const summary = broadcast.mock.calls[0][0]
    expect(summary.notified_at).toBeDefined()
    // Error path: featured_files are empty (no files were downloaded)
    expect(summary.featured_files).toEqual([])
    expect(summary.featured_file_count).toBe(0)
  })

  it('does NOT call broadcast when broadcast is not wired', async () => {
    const storageRoot = await mkTmp()
    const job = makeJob()
    const ssh = makeSshRunner('')
    const scp = makeScpRunner()
    const { repo: jobRepo } = makeJobRepo(job)

    await harvestJob(job, {
      connectionBroker: brokerFromRunners(ssh, scp),
      hostRepository: makeHostRepo(sampleHost()),
      jobRepository: jobRepo,
      storageRoot
      // no broadcast
    })

    // No crash — just silent, no broadcast
  })
})

describe('harvestJob - bounded logs and disk reserve', () => {
  it('allows small harvests on the same root to download concurrently', async () => {
    const storageRoot = await mkTmp()
    const jobs = [
      makeJob({
        job_id: 'job-concurrent-1',
        remote_workdir: '~/.openscience/jobs/job-concurrent-1',
        output_manifest: JSON.stringify(['*.result']),
        harvest_config: JSON.stringify({ max_file_mb: 1, max_total_mb: 1 })
      }),
      makeJob({
        job_id: 'job-concurrent-2',
        remote_workdir: '~/.openscience/jobs/job-concurrent-2',
        output_manifest: JSON.stringify(['*.result']),
        harvest_config: JSON.stringify({ max_file_mb: 1, max_total_mb: 1 })
      })
    ]
    let releaseDownloads!: () => void
    const downloadsReleased = new Promise<void>((resolve) => {
      releaseDownloads = resolve
    })
    let startedDownloads = 0
    const connection = (filename: string): ComputeConnectionLease => ({
      run: vi.fn(async () => ({
        exitCode: 0,
        stdout: findOutput([{ path: filename, size_bytes: 1 }]),
        stderr: '',
        truncated: false,
        timedOut: false
      })),
      upload: vi.fn(async () => undefined),
      download: vi.fn(async (_remotePath: string, localPath: string) => {
        startedDownloads += 1
        await downloadsReleased
        await mkdir(dirname(localPath), { recursive: true })
        await writeFile(localPath, filename)
        return {
          exitCode: 0,
          stderr: '',
          timedOut: false,
          bytesWritten: 1,
          exceeded: false
        }
      })
    })
    const connections = [connection('first.result'), connection('second.result')]
    let acquired = 0
    const deps = (job: ComputeJob): HarvestDeps => ({
      connectionBroker: {
        acquire: vi.fn(async () => connections[acquired++]!)
      },
      hostRepository: makeHostRepo(sampleHost()),
      jobRepository: makeJobRepo(job).repo,
      storageRoot,
      getFreeDiskBytesFn: async () => HARVEST_FREE_DISK_RESERVE_BYTES + 2
    })

    const harvests = jobs.map((job) => harvestJob(job, deps(job)))
    await vi.waitFor(() => expect(startedDownloads).toBe(2))
    releaseDownloads()
    await Promise.all(harvests)
  })

  it('uses one canonical budget for aliases of the same storage root', async () => {
    const storageRoot = await mkTmp()
    const aliasRoot = `${storageRoot}-alias`
    await symlink(storageRoot, aliasRoot, 'dir')
    const firstJob = makeJob({
      job_id: 'job-budget-1',
      remote_workdir: '~/.openscience/jobs/job-budget-1',
      output_manifest: JSON.stringify(['*.result']),
      harvest_config: JSON.stringify({ max_file_mb: 1, max_total_mb: 1 })
    })
    const secondJob = makeJob({
      job_id: 'job-budget-2',
      remote_workdir: '~/.openscience/jobs/job-budget-2',
      output_manifest: JSON.stringify(['*.result']),
      harvest_config: JSON.stringify({ max_file_mb: 1, max_total_mb: 1 })
    })
    let releaseFirst!: () => void
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const firstDownload = vi.fn(async (_remotePath: string, localPath: string) => {
      await firstReleased
      await mkdir(dirname(localPath), { recursive: true })
      await writeFile(localPath, 'first')
      return {
        exitCode: 0,
        stderr: '',
        timedOut: false,
        bytesWritten: 5,
        exceeded: false
      }
    })
    const secondDownload = vi.fn(async () => ({
      exitCode: 0,
      stderr: '',
      timedOut: false,
      bytesWritten: 0,
      exceeded: false
    }))
    const lease = (
      filename: string,
      sizeBytes: number,
      download: ComputeConnectionLease['download']
    ): ComputeConnectionLease => ({
      run: vi.fn(async () => ({
        exitCode: 0,
        stdout: findOutput([{ path: filename, size_bytes: sizeBytes }]),
        stderr: '',
        truncated: false,
        timedOut: false
      })),
      upload: vi.fn(async () => undefined),
      download
    })
    const freeBytes = HARVEST_FREE_DISK_RESERVE_BYTES + MIB_BYTES_FOR_TEST
    const firstHarvest = harvestJob(firstJob, {
      connectionBroker: {
        acquire: vi.fn(async () => lease('first.result', MIB_BYTES_FOR_TEST, firstDownload))
      },
      hostRepository: makeHostRepo(sampleHost()),
      jobRepository: makeJobRepo(firstJob).repo,
      storageRoot,
      getFreeDiskBytesFn: async () => freeBytes
    })
    await vi.waitFor(() => expect(firstDownload).toHaveBeenCalledOnce())

    await harvestJob(secondJob, {
      connectionBroker: {
        acquire: vi.fn(async () => lease('second.result', 1, secondDownload))
      },
      hostRepository: makeHostRepo(sampleHost()),
      jobRepository: makeJobRepo(secondJob).repo,
      storageRoot: aliasRoot,
      getFreeDiskBytesFn: async () => freeBytes
    })

    expect(secondDownload).not.toHaveBeenCalled()
    releaseFirst()
    await firstHarvest
  })
  it('fails closed when the remote copy runner cannot enforce a byte limit', async () => {
    const storageRoot = await mkTmp()
    const job = makeJob({
      output_manifest: JSON.stringify(['*.result'])
    })
    const copy = vi.fn().mockResolvedValue({ exitCode: 0, stderr: '', timedOut: false })
    const { repo: jobRepo, updates } = makeJobRepo(job)

    await harvestJob(job, {
      connectionBroker: brokerFromRunners(
        makeSshRunner(findOutput([{ path: 'small.result', size_bytes: 1 }])),
        { copy }
      ),
      hostRepository: makeHostRepo(sampleHost()),
      jobRepository: jobRepo,
      storageRoot,
      getFreeDiskBytesFn: async () => HARVEST_FREE_DISK_RESERVE_BYTES + 100 * 1024 * 1024
    })

    expect(copy).not.toHaveBeenCalled()
    expect((updates[0]!.data as Record<string, unknown>).harvestError).toContain(
      'bounded remote copy is unavailable'
    )
  })

  it('leaves oversized stdout and stderr remote under the configured budget', async () => {
    const storageRoot = await mkTmp()
    const job = makeJob({
      harvest_config: JSON.stringify({ max_file_mb: 1, max_total_mb: 1 })
    })
    const scp = makeScpRunner()
    const { repo: jobRepo, updates } = makeJobRepo(job)

    await harvestJob(job, {
      connectionBroker: brokerFromRunners(
        makeSshRunner(
          findOutput([
            { path: 'stdout', size_bytes: 2 * 1024 * 1024 },
            { path: 'stderr', size_bytes: 2 * 1024 * 1024 }
          ])
        ),
        scp
      ),
      hostRepository: makeHostRepo(sampleHost()),
      jobRepository: jobRepo,
      storageRoot,
      getFreeDiskBytesFn: async () => HARVEST_FREE_DISK_RESERVE_BYTES + 100 * 1024 * 1024
    })

    expect(scp.calls).toEqual([])
    const finalUpdate = updates[0]!.data as Record<string, unknown>
    const leftOnRemote = JSON.parse(finalUpdate.leftOnRemote as string) as Array<{
      uri: string
      reason: string
    }>
    expect(leftOnRemote).toEqual([
      expect.objectContaining({
        uri: expect.stringContaining('/stdout'),
        reason: 'exceeds_max_file_mb'
      }),
      expect.objectContaining({
        uri: expect.stringContaining('/stderr'),
        reason: 'exceeds_max_file_mb'
      })
    ])
  })

  it('uses free space above the reserve as the effective total budget', async () => {
    const storageRoot = await mkTmp()
    const job = makeJob({
      output_manifest: JSON.stringify(['*.result']),
      harvest_config: JSON.stringify({ max_file_mb: 100, max_total_mb: 500 })
    })
    const scp = makeScpRunner()
    const { repo: jobRepo, updates } = makeJobRepo(job)

    await harvestJob(job, {
      connectionBroker: brokerFromRunners(
        makeSshRunner(
          findOutput([
            { path: 'stdout', size_bytes: 60 * 1024 * 1024 },
            { path: 'run.result', size_bytes: 60 * 1024 * 1024 }
          ])
        ),
        scp
      ),
      hostRepository: makeHostRepo(sampleHost()),
      jobRepository: jobRepo,
      storageRoot,
      getFreeDiskBytesFn: async () => HARVEST_FREE_DISK_RESERVE_BYTES + 100 * 1024 * 1024
    })

    expect(scp.calls).toHaveLength(1)
    expect(scp.calls[0]?.join(' ')).toContain('run.result')
    const finalUpdate = updates[0]!.data as Record<string, unknown>
    const leftOnRemote = JSON.parse(finalUpdate.leftOnRemote as string) as Array<{
      uri: string
      reason: string
    }>
    expect(leftOnRemote).toEqual([
      expect.objectContaining({
        uri: expect.stringContaining('/stdout'),
        reason: 'exceeds_max_total_mb'
      })
    ])
  })
  it('bounds the actual transfer when a file grows after remote enumeration', async () => {
    const storageRoot = await mkTmp()
    const job = makeJob({
      output_manifest: JSON.stringify(['*.result']),
      harvest_config: JSON.stringify({ max_file_mb: 100, max_total_mb: 500 })
    })
    const copyFromRemoteBounded = vi.fn().mockResolvedValue({
      exitCode: null,
      stderr: '',
      timedOut: false,
      bytesWritten: 100 * 1024 * 1024,
      exceeded: true
    })
    const scp: ScpRunner = {
      copy: vi.fn().mockResolvedValue({ exitCode: 0, stderr: '', timedOut: false }),
      copyFromRemoteBounded
    }
    const { repo: jobRepo, updates } = makeJobRepo(job)

    await harvestJob(job, {
      connectionBroker: brokerFromRunners(
        makeSshRunner(findOutput([{ path: 'growing.result', size_bytes: 1 }])),
        scp
      ),
      hostRepository: makeHostRepo(sampleHost()),
      jobRepository: jobRepo,
      storageRoot,
      getFreeDiskBytesFn: async () => HARVEST_FREE_DISK_RESERVE_BYTES + 1024 * 1024 * 1024
    })

    expect(copyFromRemoteBounded).toHaveBeenCalledWith(
      expect.any(Object),
      expect.stringContaining('/growing.result'),
      expect.any(String),
      1
    )
    const finalUpdate = updates[0]!.data as Record<string, unknown>
    expect(finalUpdate.harvestError).toContain('download exceeded the allowed byte budget')
    expect(JSON.parse(finalUpdate.leftOnRemote as string)).toEqual([
      expect.objectContaining({
        uri: expect.stringContaining('/growing.result'),
        reason: 'exceeds_max_total_mb'
      })
    ])
  })

  it('preserves an existing local output when a retry transfer fails', async () => {
    const storageRoot = await mkTmp()
    const job = makeJob({ output_manifest: JSON.stringify(['*.result']) })
    const localPath = join(
      getJobHarvestDir(storageRoot, job.project_id, job.session_id, job.job_id),
      'featured',
      'retry.result'
    )
    await mkdir(dirname(localPath), { recursive: true })
    await writeFile(localPath, 'previous successful harvest')
    const copyFromRemoteBounded = vi.fn(async (_target, _remotePath, temporaryPath) => {
      await writeFile(temporaryPath, 'partial retry')
      return {
        exitCode: 1,
        stderr: 'connection reset',
        timedOut: false,
        bytesWritten: Buffer.byteLength('partial retry'),
        exceeded: false
      }
    })
    const scp: ScpRunner = {
      copy: vi.fn().mockResolvedValue({ exitCode: 0, stderr: '', timedOut: false }),
      copyFromRemoteBounded
    }
    const { repo: jobRepo, updates } = makeJobRepo(job)

    await harvestJob(job, {
      connectionBroker: brokerFromRunners(
        makeSshRunner(findOutput([{ path: 'retry.result', size_bytes: 13 }])),
        scp
      ),
      hostRepository: makeHostRepo(sampleHost()),
      jobRepository: jobRepo,
      storageRoot,
      getFreeDiskBytesFn: async () => HARVEST_FREE_DISK_RESERVE_BYTES + 1024 * 1024
    })

    const temporaryPath = copyFromRemoteBounded.mock.calls[0]?.[2]
    expect(temporaryPath).not.toBe(localPath)
    expect(temporaryPath).toMatch(/\.partial$/)
    await expect(readFile(localPath, 'utf8')).resolves.toBe('previous successful harvest')
    await expect(readFile(temporaryPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect((updates[0]!.data as Record<string, unknown>).harvestError).toContain(
      'remote copy failed for retry.result'
    )
  })
})
