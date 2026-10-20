import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'

import type { ResolvedSshTarget, SshRunner } from '@aipoch/compute/node'
import {
  runScpUpload,
  type ComputeConnectionBrokerAcquirer,
  type ComputeConnectionLease,
  type ScpRunner
} from '@aipoch/compute/node'
import type { ComputeJob } from '../../shared/compute'
import type { ComputeJobRepository } from './job-repository'
import type { ComputeHostRepository } from './repository'

import { dispatchComputeJob as dispatchJob } from './dispatch-evidence'

// Mock resolveSshTarget at module level so all tests bypass the real ssh -G call.
vi.mock('@aipoch/compute/node', async (importOriginal) => {
  const original = await importOriginal<typeof import('@aipoch/compute/node')>()
  return {
    ...original,
    resolveSshTarget: vi.fn(() =>
      Promise.resolve({
        sshBinary: '/usr/bin/ssh',
        host: 'biowulf.nih.gov',
        extraArgs: ['-o', 'BatchMode=yes']
      } as ResolvedSshTarget)
    )
  }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeSshRunner = (result: Awaited<ReturnType<SshRunner['run']>>): SshRunner => ({
  run: vi.fn(() => Promise.resolve(result))
})

const fakeTarget: ResolvedSshTarget = {
  sshBinary: '/usr/bin/ssh',
  host: 'biowulf.nih.gov',
  extraArgs: ['-o', 'BatchMode=yes']
}

const leaseFromRunners = (runner: SshRunner, scpRunner?: ScpRunner): ComputeConnectionLease => ({
  run: (command, options) => runner.run(fakeTarget, command, options),
  upload: async (localPath, remotePath) => {
    if (!scpRunner) throw new Error('upload unavailable')
    await runScpUpload(scpRunner, fakeTarget, localPath, remotePath)
  },
  download: vi.fn(async () => ({
    exitCode: 0,
    stderr: '',
    timedOut: false,
    bytesWritten: 0,
    exceeded: false
  }))
})

const brokerFromRunners = (
  runner: SshRunner,
  scpRunner?: ScpRunner
): ComputeConnectionBrokerAcquirer => ({
  acquire: vi.fn(async () => leaseFromRunners(runner, scpRunner))
})

const makeJob = (overrides: Partial<ComputeJob> = {}): ComputeJob => ({
  job_id: 'job-1',
  provider_id: 'ssh:biowulf',
  shape: 'direct_ssh',
  session_id: 'sess-1',
  project_id: 'proj-1',
  status: 'submitted',
  intent: 'smoke test',
  command: 'echo hello',
  command_hash: 'abc',
  environment: undefined,
  resource_request: undefined,
  input_manifest: undefined,
  output_manifest: undefined,
  harvest_config: undefined,
  timeout_seconds: 3600,
  remote_workdir: '~/.open-science/jobs/job-1',
  remote_handle: undefined,
  exit_code: undefined,
  stdout_tail: undefined,
  stderr_tail: undefined,
  error_code: undefined,
  created_at: Date.now(),
  submitted_at: Date.now(),
  started_at: undefined,
  finished_at: undefined,
  harvested_at: undefined,
  ...overrides
})

type HostRepo = Pick<ComputeHostRepository, 'get'>
type JobRepo = Pick<ComputeJobRepository, 'get' | 'updateIfStatus'>

const makeHostRepo = (host: import('@aipoch/compute').ComputeHost | null): HostRepo => ({
  get: vi.fn(() => Promise.resolve(host))
})

const makeJobRepo = (
  job: ComputeJob | null
): {
  repo: JobRepo
  transition: ReturnType<typeof vi.fn>
  get: ReturnType<typeof vi.fn>
} => {
  const transition = vi.fn((_id: string, _expectedStatuses: unknown, updates: unknown) =>
    Promise.resolve({ ...job!, ...(updates as object), job_id: _id })
  )
  const get = vi.fn(() => Promise.resolve(job))
  return { repo: { get, updateIfStatus: transition } as unknown as JobRepo, transition, get }
}

const sampleHost = (): import('@aipoch/compute').ComputeHost => ({
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
  createdAt: 1,
  updatedAt: 1
})

const launcherFixtures: string[] = []

afterEach(() => {
  for (const fixture of launcherFixtures.splice(0)) {
    rmSync(fixture, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Pure function tests
// ---------------------------------------------------------------------------

describe('dispatch evidence and storage contract', () => {
  it('keeps published dispatch-error evidence when its database update fails', async () => {
    const storageRoot = mkdtempSync(join(tmpdir(), 'open-science-dispatch-evidence-'))
    launcherFixtures.push(storageRoot)
    let current = makeJob()
    const repository = {
      get: vi.fn(async () => current),
      updateIfStatus: vi.fn(
        async (_id: string, _expectedStatuses: unknown, updates: Partial<ComputeJob>) => {
          current = { ...current, ...updates }
          return current
        }
      ),
      update: vi.fn(async () => {
        throw new Error('simulated database update failure')
      })
    } as unknown as ComputeJobRepository
    const runner = makeSshRunner({
      exitCode: 255,
      stdout: '',
      stderr: 'Connection refused',
      truncated: false,
      timedOut: false
    })

    await dispatchJob(current.job_id, {
      connectionBroker: brokerFromRunners(runner),
      hostRepository: makeHostRepo(sampleHost()) as unknown as ComputeHostRepository,
      jobRepository: repository,
      storageRoot
    })

    expect(
      readFileSync(
        join(
          storageRoot,
          'execution-file-evidence',
          current.project_id,
          current.session_id,
          `activity-${current.job_id}`,
          'evidence.json'
        ),
        'utf8'
      )
    ).toContain('remote-output-not-harvested')
    expect(
      readFileSync(
        join(
          storageRoot,
          'execution-file-evidence',
          current.project_id,
          current.session_id,
          `receipt-${current.job_id}.json`
        ),
        'utf8'
      )
    ).toContain('"phase": "published"')
  })

  it('resolves frozen input paths against the current data root after relocation', async () => {
    const storageRoot = join(tmpdir(), 'relocated-data-root')
    const job = makeJob({
      input_manifest: JSON.stringify([
        {
          kind: 'upload',
          localPath: '$DATA/execution-file-evidence/proj-1/sess-1/staging-job-1/blobs/sha256-a',
          dstFilename: 'a.csv',
          label: 'a.csv'
        }
      ])
    })
    const runner = makeSshRunner({
      exitCode: 0,
      stdout: '123\n',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const scpRunner: ScpRunner = {
      copy: vi.fn(async () => ({ exitCode: 0, stderr: '', timedOut: false }))
    }
    const { repo } = makeJobRepo(job)

    await dispatchJob(job.job_id, {
      connectionBroker: brokerFromRunners(runner, scpRunner),
      hostRepository: makeHostRepo(sampleHost()) as unknown as ComputeHostRepository,
      jobRepository: repo as unknown as ComputeJobRepository,
      storageRoot
    })

    const [, args] = (scpRunner.copy as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string[]
    ]
    expect(args).toContain(
      join(
        storageRoot,
        'execution-file-evidence',
        'proj-1',
        'sess-1',
        'staging-job-1',
        'blobs',
        'sha256-a'
      )
    )
  })
})
configureTestRuntimeMetadata()
