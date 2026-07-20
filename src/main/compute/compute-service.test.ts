import { describe, expect, it, vi } from 'vitest'

import type { ComputeHost } from '../../shared/compute'
import { ComputeService, parseProbeOutput } from './compute-service'
import type { ComputeHostRepository } from './repository'
import type { ResolvedSshTarget, SshRunner } from './ssh-runner'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sampleHost = (overrides: Partial<ComputeHost> = {}): ComputeHost => ({
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
  updatedAt: 1,
  ...overrides
})

// A fake target returned by the real resolveSshTarget helper — tests bypass that step by mocking the
// entire runner (which already has the target baked in).
const fakeTarget: ResolvedSshTarget = {
  sshBinary: '/usr/bin/ssh',
  host: 'biowulf.nih.gov',
  extraArgs: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10']
}

// Minimal fake runner — always resolves with a success result by default.
const makeFakeRunner = (result: Awaited<ReturnType<SshRunner['run']>>): SshRunner => ({
  run: vi.fn(() => Promise.resolve(result))
})

// Minimal repository double.
const makeRepo = (
  host: ComputeHost | null = sampleHost()
): {
  repo: ComputeHostRepository
  updateProbeResult: ReturnType<typeof vi.fn>
  updateScratchRoot: ReturnType<typeof vi.fn>
} => {
  const updateProbeResult = vi.fn(() => Promise.resolve())
  const updateScratchRoot = vi.fn(() => Promise.resolve())
  const repo: ComputeHostRepository = {
    get: vi.fn(() => Promise.resolve(host)),
    list: vi.fn(() => Promise.resolve([])),
    create: vi.fn(),
    delete: vi.fn(),
    updateProbeResult,
    updateScratchRoot
  } as unknown as ComputeHostRepository
  return { repo, updateProbeResult, updateScratchRoot }
}

// A successful probe script output representing a Linux slurm cluster.
const SLURM_STDOUT = [
  'os=Linux',
  'cpus=64',
  'mem_mib=256000',
  'gpus=Tesla V100 SXM2 32GB;Tesla V100 SXM2 32GB;',
  'sbatch=yes',
  'qsub=no',
  'bsub=no',
  'scratch=/gpfs/scratch/user123'
].join('\n')

// ---------------------------------------------------------------------------
// parseProbeOutput — pure function tests
// ---------------------------------------------------------------------------

describe('parseProbeOutput', () => {
  it('parses a complete slurm linux output', () => {
    const result = parseProbeOutput(SLURM_STDOUT)
    expect(result.os).toBe('Linux')
    expect(result.cpus).toBe(64)
    expect(result.memMib).toBe(256000)
    expect(result.gpus).toEqual([{ type: 'Tesla V100 SXM2 32GB', count: 2 }])
    expect(result.detectedScheduler).toBe('slurm')
    expect(result.scratchEnv).toBe('/gpfs/scratch/user123')
  })

  it('detects PBS (qsub) scheduler', () => {
    const out = 'os=Linux\ncpus=8\nmem_mib=32000\ngpus=\nsbatch=no\nqsub=yes\nbsub=no\nscratch='
    const result = parseProbeOutput(out)
    expect(result.detectedScheduler).toBe('pbs')
  })

  it('detects LSF (bsub) scheduler', () => {
    const out = 'os=Linux\ncpus=8\nmem_mib=32000\ngpus=\nsbatch=no\nqsub=no\nbsub=yes\nscratch='
    const result = parseProbeOutput(out)
    expect(result.detectedScheduler).toBe('lsf')
  })

  it('returns none when no scheduler is detected', () => {
    const out = 'os=Darwin\ncpus=16\nmem_mib=65536\ngpus=\nsbatch=no\nqsub=no\nbsub=no\nscratch='
    const result = parseProbeOutput(out)
    expect(result.detectedScheduler).toBe('none')
  })

  it('handles empty GPU list gracefully', () => {
    const out = 'os=Linux\ncpus=4\nmem_mib=8000\ngpus=\nsbatch=no\nqsub=no\nbsub=no\nscratch='
    const result = parseProbeOutput(out)
    expect(result.gpus).toEqual([])
  })

  it('leaves undefined for missing / non-numeric cpus and mem', () => {
    const result = parseProbeOutput('os=Linux\ngpus=\nsbatch=no\nqsub=no\nbsub=no\nscratch=')
    expect(result.cpus).toBeUndefined()
    expect(result.memMib).toBeUndefined()
  })

  it('ignores lines without an equals sign', () => {
    const result = parseProbeOutput('this is garbage\nos=Linux\ncpus=4\n')
    expect(result.os).toBe('Linux')
    expect(result.cpus).toBe(4)
  })

  it('leaves scratchEnv undefined when the env var is empty', () => {
    const out = 'os=Linux\ncpus=8\nmem_mib=16000\ngpus=\nsbatch=no\nqsub=no\nbsub=no\nscratch='
    const result = parseProbeOutput(out)
    expect(result.scratchEnv).toBeUndefined()
  })

  it('aggregates multiple identical GPU models into one entry', () => {
    const out = 'gpus=A100 80GB;A100 80GB;A100 80GB;\nsbatch=no\nqsub=no\nbsub=no\nscratch='
    const result = parseProbeOutput(out)
    expect(result.gpus).toEqual([{ type: 'A100 80GB', count: 3 }])
  })
})

// ---------------------------------------------------------------------------
// ComputeService.probe — integration with fake SshRunner
// ---------------------------------------------------------------------------

// We use vi.mock for resolveSshTarget so the tests don't spawn ssh.
vi.mock('./ssh-runner', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./ssh-runner')>()
  return {
    ...orig,
    resolveSshTarget: vi.fn(() => Promise.resolve(fakeTarget))
  }
})

describe('ComputeService.probe', () => {
  it('returns ok:true and persists probeResult + shape on a successful probe', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: SLURM_STDOUT,
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo, updateProbeResult, updateScratchRoot } = makeRepo()
    const service = new ComputeService(runner, repo)

    const result = await service.probe('ssh:biowulf')

    expect(result.ok).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.cpus).toBe(64)
    expect(result.detectedScheduler).toBe('slurm')
    expect(updateProbeResult).toHaveBeenCalledWith(
      'ssh:biowulf',
      expect.objectContaining({ ok: true, cpus: 64 }),
      'scheduler_cluster'
    )
    // scratchRoot should be set because scratchPinned=false and scratch is provided.
    expect(updateScratchRoot).toHaveBeenCalledWith('ssh:biowulf', '/gpfs/scratch/user123')
  })

  it('returns ok:false and maps exit 255 to host_unreachable (connection failure)', async () => {
    const runner = makeFakeRunner({
      exitCode: 255,
      stdout: '',
      stderr: 'ssh: connect to host biowulf.nih.gov port 22: Connection refused',
      truncated: false,
      timedOut: false
    })
    const { repo, updateProbeResult, updateScratchRoot } = makeRepo()
    const service = new ComputeService(runner, repo)

    const result = await service.probe('ssh:biowulf')

    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(255)
    expect(result.errorTail).toContain('Connection refused')
    expect(updateProbeResult).toHaveBeenCalledWith(
      'ssh:biowulf',
      expect.objectContaining({ ok: false }),
      'direct_ssh'
    )
    expect(updateScratchRoot).not.toHaveBeenCalled()
  })

  it('returns ok:false on timeout and sets timedOut flag', async () => {
    const runner = makeFakeRunner({
      exitCode: null,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: true
    })
    const { repo, updateProbeResult } = makeRepo()
    const service = new ComputeService(runner, repo)

    const result = await service.probe('ssh:biowulf')

    expect(result.ok).toBe(false)
    expect(updateProbeResult).toHaveBeenCalledWith(
      'ssh:biowulf',
      expect.objectContaining({ ok: false }),
      'direct_ssh'
    )
  })

  it('probes ok but detectedScheduler=none → shape=direct_ssh', async () => {
    const stdout = [
      'os=Darwin',
      'cpus=16',
      'mem_mib=32000',
      'gpus=',
      'sbatch=no',
      'qsub=no',
      'bsub=no',
      'scratch='
    ].join('\n')
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout,
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo, updateProbeResult } = makeRepo()
    const service = new ComputeService(runner, repo)

    const result = await service.probe('ssh:biowulf')

    expect(result.ok).toBe(true)
    expect(result.detectedScheduler).toBe('none')
    expect(updateProbeResult).toHaveBeenCalledWith(
      'ssh:biowulf',
      expect.objectContaining({ ok: true }),
      'direct_ssh'
    )
  })

  it('does NOT update scratchRoot when scratchPinned=true', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: SLURM_STDOUT,
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const pinnedHost = sampleHost({ scratchPinned: true, scratchRoot: '/my/custom/scratch' })
    const { repo, updateScratchRoot } = makeRepo(pinnedHost)
    const service = new ComputeService(runner, repo)

    await service.probe('ssh:biowulf')

    expect(updateScratchRoot).not.toHaveBeenCalled()
  })

  it('does NOT update scratchRoot when $SCRATCH is empty', async () => {
    const stdout = 'os=Linux\ncpus=8\nmem_mib=16000\ngpus=\nsbatch=no\nqsub=no\nbsub=no\nscratch='
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout,
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo, updateScratchRoot } = makeRepo()
    const service = new ComputeService(runner, repo)

    await service.probe('ssh:biowulf')

    expect(updateScratchRoot).not.toHaveBeenCalled()
  })

  it('does NOT write detailsDoc', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: SLURM_STDOUT,
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo, updateProbeResult } = makeRepo()
    const service = new ComputeService(runner, repo)

    await service.probe('ssh:biowulf')

    // Verify that probeResult is the only "content" written.
    const probeCall = updateProbeResult.mock.calls[0]
    const writtenResult = probeCall?.[1] as Record<string, unknown>
    expect(Object.keys(writtenResult)).not.toContain('detailsDoc')
  })

  it('throws when the host does not exist', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo(null)
    const service = new ComputeService(runner, repo)

    await expect(service.probe('ssh:nonexistent')).rejects.toThrow(/not found|no compute host/i)
  })
})
