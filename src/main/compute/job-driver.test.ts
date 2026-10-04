import { describe, expect, it } from 'vitest'

import type { ComputeHost } from '../../shared/compute'
import {
  UnsupportedSchedulerDriverError,
  computeJobDriverId,
  resolveComputeDriverId
} from './job-driver'

const host = (
  executionMode: 'auto' | 'direct_ssh' | 'slurm',
  detectedScheduler?: 'slurm' | 'pbs' | 'lsf' | 'none'
): Pick<ComputeHost, 'executionMode' | 'probeResult'> => ({
  executionMode,
  probeResult: detectedScheduler
    ? {
        ok: true,
        probedAt: '2026-09-01T00:00:00.000Z',
        exitCode: 0,
        errorTail: null,
        detectedScheduler
      }
    : undefined
})

describe('compute driver selection', () => {
  it('auto-selects Slurm from the existing probe result', () => {
    expect(resolveComputeDriverId(host('auto', 'slurm'))).toBe('slurm')
  })

  it('falls back to Direct SSH when auto detects no scheduler', () => {
    expect(resolveComputeDriverId(host('auto', 'none'))).toBe('direct_ssh')
    expect(resolveComputeDriverId(host('auto'))).toBe('direct_ssh')
  })

  it('keeps explicit host overrides authoritative', () => {
    expect(resolveComputeDriverId(host('direct_ssh', 'slurm'))).toBe('direct_ssh')
    expect(resolveComputeDriverId(host('slurm', 'none'))).toBe('slurm')
  })

  it.each(['pbs', 'lsf'] as const)('fails closed for detected %s without a driver', (scheduler) => {
    expect(() => resolveComputeDriverId(host('auto', scheduler))).toThrow(
      UnsupportedSchedulerDriverError
    )
  })

  it('uses the durable job driver for reconnect and polling', () => {
    expect(computeJobDriverId({ execution_mode: 'slurm' })).toBe('slurm')
    expect(computeJobDriverId({ execution_mode: 'direct_ssh' })).toBe('direct_ssh')
    expect(computeJobDriverId({})).toBe('direct_ssh')
  })
})
