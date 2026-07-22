import { mkdirSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { parseProbeOutput } from './compute-service'
import { CappedOutput, controlMasterArgs, resolveSshBinary } from './ssh-runner'

// Mock only mkdirSync so we can assert the ~/.ssh/ctrl dir is created; everything else stays real.
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  mkdirSync: vi.fn()
}))

// ---------------------------------------------------------------------------
// resolveSshBinary — on the current platform
// ---------------------------------------------------------------------------

describe('resolveSshBinary', () => {
  it('returns "ssh" on non-Windows platforms', () => {
    if (platform() === 'win32') return // skip on actual Windows CI
    expect(resolveSshBinary()).toBe('ssh')
  })
})

// ---------------------------------------------------------------------------
// controlMasterArgs — ControlPath injection + ctrl dir creation
// (regression guard for the "unix_listener: cannot bind ... No such file" bug)
// ---------------------------------------------------------------------------

describe('controlMasterArgs', () => {
  afterEach(() => vi.mocked(mkdirSync).mockReset())

  it('creates ~/.ssh/ctrl (0700) and injects a per-alias ControlPath on non-Windows', () => {
    if (platform() === 'win32') return // Windows returns [] — asserted separately below
    const args = controlMasterArgs('myhost')
    const ctrlDir = join(homedir(), '.ssh', 'ctrl')

    expect(mkdirSync).toHaveBeenCalledWith(ctrlDir, { recursive: true, mode: 0o700 })
    expect(args).toEqual([
      '-o',
      'ControlMaster=auto',
      '-o',
      `ControlPath=${join(ctrlDir, '%r@%h:%p.myhost')}`,
      '-o',
      'ControlPersist=60'
    ])
  })

  it('still returns control args when mkdir fails (best-effort)', () => {
    if (platform() === 'win32') return
    vi.mocked(mkdirSync).mockImplementationOnce(() => {
      throw new Error('EACCES')
    })
    const args = controlMasterArgs('h')
    expect(args).toContain('ControlMaster=auto')
    expect(args.some((a) => a.startsWith('ControlPath='))).toBe(true)
  })

  it('returns no args and creates no dir on Windows', () => {
    if (platform() !== 'win32') return // only meaningful on real Windows (see learnings.md)
    expect(controlMasterArgs('h')).toEqual([])
    expect(mkdirSync).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// CappedOutput — accumulates stream chunks up to maxBytes and records when any
// bytes were dropped, so the ExecResult.truncated flag actually fires (design.md
// §5 "超出标 truncated=true"). Regression guard for the dead-flag bug where the
// stream handler capped bytes but truncation was re-checked against the already-
// capped buffer (which can never exceed maxBytes).
// ---------------------------------------------------------------------------

describe('CappedOutput', () => {
  it('keeps content and reports no truncation when total stays within the cap', () => {
    const out = new CappedOutput(10)
    out.push(Buffer.from('abc'))
    out.push(Buffer.from('def'))
    expect(out.toString()).toBe('abcdef')
    expect(out.wasTruncated()).toBe(false)
  })

  it('reports no truncation when total exactly equals the cap', () => {
    const out = new CappedOutput(6)
    out.push(Buffer.from('abc'))
    out.push(Buffer.from('def'))
    expect(out.toString()).toBe('abcdef')
    expect(out.wasTruncated()).toBe(false)
  })

  it('caps content and sets truncated when a single chunk exceeds the cap', () => {
    const out = new CappedOutput(4)
    out.push(Buffer.from('abcdefgh'))
    expect(out.toString()).toBe('abcd')
    expect(out.wasTruncated()).toBe(true)
  })

  it('caps content and sets truncated when a later chunk crosses the cap', () => {
    const out = new CappedOutput(5)
    out.push(Buffer.from('abc'))
    out.push(Buffer.from('defgh')) // only 'de' fits; the rest is dropped
    expect(out.toString()).toBe('abcde')
    expect(out.wasTruncated()).toBe(true)
  })

  it('drops chunks that arrive after the cap is already reached', () => {
    const out = new CappedOutput(3)
    out.push(Buffer.from('abc'))
    out.push(Buffer.from('def'))
    expect(out.toString()).toBe('abc')
    expect(out.wasTruncated()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// parseProbeOutput contract stability (probe output format must stay stable
// across ssh-runner and compute-service)
// ---------------------------------------------------------------------------

describe('parseProbeOutput probe output contract', () => {
  it('parses all fields from a complete Linux/Slurm probe output', () => {
    const out = [
      'os=Linux',
      'cpus=32',
      'mem_mib=128000',
      'gpus=A100 80GB;A100 80GB;',
      'sbatch=yes',
      'qsub=no',
      'bsub=no',
      'scratch=/scratch/user'
    ].join('\n')

    expect(parseProbeOutput(out)).toMatchObject({
      os: 'Linux',
      cpus: 32,
      memMib: 128000,
      gpus: [{ type: 'A100 80GB', count: 2 }],
      detectedScheduler: 'slurm',
      scratchEnv: '/scratch/user'
    })
  })

  it('parses a macOS direct-ssh host (no scheduler, no GPUs)', () => {
    const out = [
      'os=Darwin',
      'cpus=16',
      'mem_mib=65536',
      'gpus=',
      'sbatch=no',
      'qsub=no',
      'bsub=no',
      'scratch='
    ].join('\n')

    const result = parseProbeOutput(out)
    expect(result.detectedScheduler).toBe('none')
    expect(result.gpus).toEqual([])
    expect(result.scratchEnv).toBeUndefined()
  })
})
