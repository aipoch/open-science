import { platform } from 'node:os'
import { describe, expect, it } from 'vitest'

import { parseProbeOutput } from './compute-service'
import { resolveSshBinary } from './ssh-runner'

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
