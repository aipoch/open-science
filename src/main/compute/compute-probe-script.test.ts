import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ComputeHost } from '../../shared/compute'
import { ComputeHostProfileOwner } from './compute-host-profile-owner'
import type { ComputeConnectionBrokerAcquirer } from './connection-broker'
import type { ComputeHostRepository } from './repository'

describe('compute probe shell protocol', () => {
  it('detects a scheduler executable without leaking its path into the boolean field', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'compute-probe-bin-'))
    try {
      writeFileSync(join(bin, 'sbatch'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
      const host = { providerId: 'ssh:probe', scratchPinned: true } as ComputeHost
      const repository = {
        get: vi.fn(async () => host),
        updateProbeResult: vi.fn()
      } as unknown as ComputeHostRepository
      const broker = {
        acquire: async () => ({
          run: async (script: string) => ({
            stdout: execFileSync('/bin/bash', ['-c', script], {
              env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
              encoding: 'utf8'
            }),
            stderr: '',
            exitCode: 0,
            timedOut: false,
            truncated: false
          })
        })
      } as unknown as ComputeConnectionBrokerAcquirer
      const owner = new ComputeHostProfileOwner(broker, repository)
      const result = await owner.probe('ssh:probe')
      expect(result.detectedScheduler).toBe('slurm')
      host.probeResult = result
      const details = await owner.getDetails('ssh:probe')
      expect(details.doc).toContain('SSH login host, not a scheduler allocation')
    } finally {
      rmSync(bin, { recursive: true, force: true })
    }
  })
})
