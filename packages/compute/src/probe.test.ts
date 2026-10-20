import { describe, expect, it } from 'vitest'
import { parseProbeOutput } from './probe'
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
