import { describe, expect, it, vi } from 'vitest'

import type { ComputeHost } from '../../shared/compute'
import { ComputeConnectionError, type ComputeConnectionBrokerAcquirer } from './connection-broker'
import { ComputeHostProfileOwner, parseProbeOutput } from './compute-host-profile-owner'
import type { ComputeHostRepository } from './repository'
import type { SshRunner } from './ssh-runner'

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

// Public Broker-seam fake — transport resolution and authentication selection stay outside these
// application-owner tests.
const makeFakeRunner = (
  result: Awaited<ReturnType<SshRunner['run']>>
): ComputeConnectionBrokerAcquirer => ({
  acquire: vi.fn(async () => ({
    run: vi.fn(async () => result),
    upload: vi.fn(async () => undefined),
    download: vi.fn(async () => ({
      exitCode: 0,
      stderr: '',
      timedOut: false,
      bytesWritten: 0,
      exceeded: false
    }))
  }))
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
// ComputeHostProfileOwner.probe — integration through the public Broker seam
// ---------------------------------------------------------------------------

describe('ComputeHostProfileOwner.probe', () => {
  it('binds Probe persistence to the authentication revision it observed', async () => {
    const observedHost = sampleHost({
      authentication: {
        mode: 'password',
        credentialStatus: 'configured',
        revision: 7,
        lastVerifiedAt: undefined
      }
    })
    const { repo, updateProbeResult } = makeRepo(observedHost)
    const service = new ComputeHostProfileOwner(
      makeFakeRunner({
        exitCode: 0,
        stdout: SLURM_STDOUT,
        stderr: '',
        truncated: false,
        timedOut: false
      }),
      repo
    )

    await service.probe(observedHost.providerId)

    expect(updateProbeResult).toHaveBeenCalledWith(
      observedHost.providerId,
      expect.objectContaining({ authenticationRevision: 7 }),
      'scheduler_cluster'
    )
  })

  it('returns ok:true and persists probeResult + shape on a successful probe', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: SLURM_STDOUT,
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo, updateProbeResult, updateScratchRoot } = makeRepo()
    const service = new ComputeHostProfileOwner(runner, repo)

    const result = await service.probe('ssh:biowulf')

    expect(runner.acquire).toHaveBeenCalledWith('ssh:biowulf', {
      intent: 'probe',
      interactive: true
    })
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
    const service = new ComputeHostProfileOwner(runner, repo)

    const result = await service.probe('ssh:biowulf')

    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(255)
    expect(result.errorTail).toBe('The Compute Host could not be reached.')
    expect(result.authenticationCode).toBe('host_unreachable')
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
    const service = new ComputeHostProfileOwner(runner, repo)

    const result = await service.probe('ssh:biowulf')

    expect(result.ok).toBe(false)
    expect(updateProbeResult).toHaveBeenCalledWith(
      'ssh:biowulf',
      expect.objectContaining({ ok: false }),
      'direct_ssh'
    )
  })

  it('persists a safe failed Probe when password authentication is rejected during execution', async () => {
    const broker: ComputeConnectionBrokerAcquirer = {
      acquire: vi.fn(async () => ({
        run: vi.fn(async () => {
          throw new ComputeConnectionError('authentication_failed')
        }),
        upload: vi.fn(),
        download: vi.fn()
      }))
    }
    const previousSuccess = sampleHost({
      probeResult: {
        ok: true,
        probedAt: new Date(0).toISOString(),
        exitCode: 0,
        errorTail: null
      }
    })
    const { repo, updateProbeResult } = makeRepo(previousSuccess)

    const result = await new ComputeHostProfileOwner(broker, repo).probe('ssh:biowulf')

    expect(result).toMatchObject({
      ok: false,
      errorTail: 'Authentication failed. Verify the username and password.',
      authenticationCode: 'authentication_failed'
    })
    expect(updateProbeResult).toHaveBeenCalledWith(
      'ssh:biowulf',
      expect.objectContaining({ ok: false, authenticationCode: 'authentication_failed' }),
      'direct_ssh'
    )
  })

  it('preserves the bounded network retry on the same Broker lease', async () => {
    vi.useFakeTimers()
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        exitCode: 255,
        stdout: '',
        stderr: 'ssh: connect to host cluster: No route to host',
        truncated: false,
        timedOut: false
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: SLURM_STDOUT,
        stderr: '',
        truncated: false,
        timedOut: false
      })
    const broker: ComputeConnectionBrokerAcquirer = {
      acquire: vi.fn(async () => ({
        run,
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
    const { repo } = makeRepo()
    const service = new ComputeHostProfileOwner(broker, repo)

    const probing = service.probe('ssh:biowulf')
    await vi.advanceTimersByTimeAsync(3000)

    await expect(probing).resolves.toMatchObject({ ok: true })
    expect(broker.acquire).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('propagates cancellation without persisting a failed Probe result', async () => {
    const controller = new AbortController()
    const run = vi.fn(async () => {
      controller.signal.throwIfAborted()
      return {
        exitCode: 0,
        stdout: SLURM_STDOUT,
        stderr: '',
        truncated: false,
        timedOut: false
      }
    })
    const broker: ComputeConnectionBrokerAcquirer = {
      acquire: vi.fn(async () => ({
        run,
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
    const { repo, updateProbeResult } = makeRepo()
    const service = new ComputeHostProfileOwner(broker, repo)
    controller.abort()

    await expect(service.probe('ssh:biowulf', controller.signal)).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(broker.acquire).toHaveBeenCalledWith('ssh:biowulf', {
      intent: 'probe',
      interactive: true,
      signal: controller.signal
    })
    expect(updateProbeResult).not.toHaveBeenCalled()
  })

  it('re-throws an acquire-time AbortError without persisting a failed Probe result', async () => {
    const controller = new AbortController()
    controller.abort()
    const broker: ComputeConnectionBrokerAcquirer = {
      acquire: vi.fn(async () => {
        throw controller.signal.reason
      })
    }
    const { repo, updateProbeResult } = makeRepo()
    const service = new ComputeHostProfileOwner(broker, repo)

    await expect(service.probe('ssh:biowulf', controller.signal)).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(updateProbeResult).not.toHaveBeenCalled()
  })

  it('cancels the retry backoff without a second SSH attempt or failed Probe persistence', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const run = vi.fn(async () => ({
      exitCode: 255,
      stdout: '',
      stderr: 'ssh: connect to host cluster: Network is unreachable',
      truncated: false,
      timedOut: false
    }))
    const broker: ComputeConnectionBrokerAcquirer = {
      acquire: vi.fn(async () => ({
        run,
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
    const { repo, updateProbeResult } = makeRepo()
    const service = new ComputeHostProfileOwner(broker, repo)

    const probing = service.probe('ssh:biowulf', controller.signal)
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledOnce()
    controller.abort()
    const cancellation = expect(probing).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(3000)

    await cancellation
    expect(run).toHaveBeenCalledOnce()
    expect(updateProbeResult).not.toHaveBeenCalled()
    vi.useRealTimers()
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
    const service = new ComputeHostProfileOwner(runner, repo)

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
    const service = new ComputeHostProfileOwner(runner, repo)

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
    const service = new ComputeHostProfileOwner(runner, repo)

    await service.probe('ssh:biowulf')

    expect(updateScratchRoot).not.toHaveBeenCalled()
  })

  it('does NOT persist an invalid $SCRATCH value from a successful probe', async () => {
    const stdout = [
      'os=Linux',
      'cpus=8',
      'mem_mib=16000',
      'gpus=',
      'sbatch=no',
      'qsub=no',
      'bsub=no',
      'scratch=../../$(touch /tmp/not-approved)'
    ].join('\n')
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout,
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo, updateScratchRoot } = makeRepo()
    const service = new ComputeHostProfileOwner(runner, repo)

    await expect(service.probe('ssh:biowulf')).resolves.toMatchObject({ ok: true })
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
    const service = new ComputeHostProfileOwner(runner, repo)

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
    const service = new ComputeHostProfileOwner(runner, repo)

    await expect(service.probe('ssh:nonexistent')).rejects.toThrow(/not found|no compute host/i)
  })
})

// ---------------------------------------------------------------------------
// ComputeHostProfileOwner.getDetails — skeleton synthesis and pass-through
// ---------------------------------------------------------------------------

describe('ComputeHostProfileOwner.getDetails', () => {
  const fakeRunner = makeFakeRunner({
    exitCode: 0,
    stdout: '',
    stderr: '',
    truncated: false,
    timedOut: false
  })

  it('returns detailsDoc as-is when it is non-empty', async () => {
    const { repo } = makeRepo(sampleHost({ detailsDoc: '## Resources\ncpus: 8' }))
    const service = new ComputeHostProfileOwner(fakeRunner, repo)
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
    const service = new ComputeHostProfileOwner(fakeRunner, repo)
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
    const service = new ComputeHostProfileOwner(fakeRunner, repo)
    const result = await service.getDetails('ssh:biowulf')
    expect(result.isSkeleton).toBe(true)
    expect(result.doc).toContain('cpus: 8')
    expect(result.doc).not.toContain('gpus:')
    expect(result.doc).not.toContain('mem:')
  })

  it('returns empty string with isSkeleton=false when no probeResult and detailsDoc is empty', async () => {
    const { repo } = makeRepo(sampleHost({ detailsDoc: '', probeResult: undefined }))
    const service = new ComputeHostProfileOwner(fakeRunner, repo)
    const result = await service.getDetails('ssh:biowulf')
    expect(result.doc).toBe('')
    expect(result.isSkeleton).toBe(false)
  })

  it('throws when the host does not exist', async () => {
    const { repo } = makeRepo(null)
    const service = new ComputeHostProfileOwner(fakeRunner, repo)
    await expect(service.getDetails('ssh:nonexistent')).rejects.toThrow(
      /not found|no compute host/i
    )
  })
})

// ---------------------------------------------------------------------------
// ComputeHostProfileOwner.replaceDetails — old_text guard and persistence
// ---------------------------------------------------------------------------

describe('ComputeHostProfileOwner.replaceDetails', () => {
  const fakeRunner = makeFakeRunner({
    exitCode: 0,
    stdout: '',
    stderr: '',
    truncated: false,
    timedOut: false
  })

  it('replaces matching text and persists with author=user', async () => {
    const { repo, updateDetails } = makeRepo(sampleHost({ detailsDoc: 'hello world' }))
    const service = new ComputeHostProfileOwner(fakeRunner, repo)
    await service.replaceDetails('ssh:biowulf', {
      text: 'hello friend',
      oldText: 'hello world',
      author: 'user'
    })
    expect(updateDetails).toHaveBeenCalledWith('ssh:biowulf', 'hello friend', 'user')
  })

  it('returns error and does not write when oldText does not match', async () => {
    const { repo, updateDetails } = makeRepo(sampleHost({ detailsDoc: 'hello world' }))
    const service = new ComputeHostProfileOwner(fakeRunner, repo)
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
    const service = new ComputeHostProfileOwner(fakeRunner, repo)
    const bigText = 'x'.repeat(32769)
    await expect(
      service.replaceDetails('ssh:biowulf', { text: bigText, oldText: 'short', author: 'user' })
    ).rejects.toThrow(/32768|too long|limit/i)
    expect(updateDetails).not.toHaveBeenCalled()
  })

  it('works with author=agent', async () => {
    const { repo, updateDetails } = makeRepo(sampleHost({ detailsDoc: 'original text' }))
    const service = new ComputeHostProfileOwner(fakeRunner, repo)
    await service.replaceDetails('ssh:biowulf', {
      text: 'new text',
      oldText: 'original text',
      author: 'agent'
    })
    expect(updateDetails).toHaveBeenCalledWith('ssh:biowulf', 'new text', 'agent')
  })
})

// ---------------------------------------------------------------------------
// ComputeHostProfileOwner.setScratchRoot — sets scratchPinned=true
// ---------------------------------------------------------------------------

describe('ComputeHostProfileOwner.setScratchRoot', () => {
  const fakeRunner = makeFakeRunner({
    exitCode: 0,
    stdout: '',
    stderr: '',
    truncated: false,
    timedOut: false
  })

  it('sets scratch root and marks pinned', async () => {
    const { repo, updateScratchPinned } = makeRepo()
    const service = new ComputeHostProfileOwner(fakeRunner, repo)
    await service.setScratchRoot('ssh:biowulf', '/my/scratch')
    expect(updateScratchPinned).toHaveBeenCalledWith('ssh:biowulf', '/my/scratch')
  })

  it('accepts a canonical home-relative scratch root', async () => {
    const { repo, updateScratchPinned } = makeRepo()
    const service = new ComputeHostProfileOwner(fakeRunner, repo)

    await service.setScratchRoot('ssh:biowulf', '~/scratch path/$literal')

    expect(updateScratchPinned).toHaveBeenCalledWith('ssh:biowulf', '~/scratch path/$literal')
  })

  it.each([
    'relative/path',
    '/scratch/../other',
    '/scratch/./other',
    '/scratch//other',
    '/scratch/other/',
    '/scratch\nother',
    `/${'a'.repeat(4096)}`
  ])('rejects an invalid scratch root before persistence: %j', async (path) => {
    const { repo, updateScratchPinned } = makeRepo()
    const service = new ComputeHostProfileOwner(fakeRunner, repo)

    await expect(service.setScratchRoot('ssh:biowulf', path)).rejects.toThrow(/scratch root/i)
    expect(updateScratchPinned).not.toHaveBeenCalled()
  })

  it('throws when the host does not exist', async () => {
    const { repo } = makeRepo(null)
    const service = new ComputeHostProfileOwner(fakeRunner, repo)
    await expect(service.setScratchRoot('ssh:nonexistent', '/path')).rejects.toThrow(
      /not found|no compute host/i
    )
  })
})

// ---------------------------------------------------------------------------
// ComputeHostProfileOwner.setConcurrencyLimit — validates 1..500
// ---------------------------------------------------------------------------

describe('ComputeHostProfileOwner.setConcurrencyLimit', () => {
  const fakeRunner = makeFakeRunner({
    exitCode: 0,
    stdout: '',
    stderr: '',
    truncated: false,
    timedOut: false
  })

  it('persists a valid concurrency limit', async () => {
    const { repo, updateConcurrencyLimit } = makeRepo()
    const service = new ComputeHostProfileOwner(fakeRunner, repo)
    await service.setConcurrencyLimit('ssh:biowulf', 10)
    expect(updateConcurrencyLimit).toHaveBeenCalledWith('ssh:biowulf', 10)
  })

  it('rejects 0 (below minimum)', async () => {
    const { repo } = makeRepo()
    const service = new ComputeHostProfileOwner(fakeRunner, repo)
    await expect(service.setConcurrencyLimit('ssh:biowulf', 0)).rejects.toThrow(
      /1.*500|range|invalid/i
    )
  })

  it('rejects 501 (above maximum)', async () => {
    const { repo } = makeRepo()
    const service = new ComputeHostProfileOwner(fakeRunner, repo)
    await expect(service.setConcurrencyLimit('ssh:biowulf', 501)).rejects.toThrow(
      /1.*500|range|invalid/i
    )
  })

  it('accepts the boundary values 1 and 500', async () => {
    const { repo, updateConcurrencyLimit } = makeRepo()
    const service = new ComputeHostProfileOwner(fakeRunner, repo)
    await service.setConcurrencyLimit('ssh:biowulf', 1)
    await service.setConcurrencyLimit('ssh:biowulf', 500)
    expect(updateConcurrencyLimit).toHaveBeenCalledTimes(2)
  })

  it('throws when the host does not exist', async () => {
    const { repo } = makeRepo(null)
    const service = new ComputeHostProfileOwner(fakeRunner, repo)
    await expect(service.setConcurrencyLimit('ssh:nonexistent', 10)).rejects.toThrow(
      /not found|no compute host/i
    )
  })
})
// ---------------------------------------------------------------------------
// ComputeHostProfileOwner.appendDetails — issue 06
// ---------------------------------------------------------------------------

describe('ComputeHostProfileOwner.appendDetails', () => {
  it('appends text to an empty doc', async () => {
    const runner = makeFakeRunner({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false
    })
    const { repo, updateDetails } = makeRepo(sampleHost({ detailsDoc: '' }))
    const service = new ComputeHostProfileOwner(runner, repo)

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
    const service = new ComputeHostProfileOwner(runner, repo)

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
    const service = new ComputeHostProfileOwner(runner, repo)

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
    const service = new ComputeHostProfileOwner(runner, repo)

    await expect(
      service.appendDetails('ssh:ghost', { text: 'hello', author: 'agent' })
    ).rejects.toThrow(/no compute host found/i)
  })
})
