import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ComputeHost } from '../../shared/compute'
import { ComputeHostProfileOwner } from './compute-host-profile-owner'
import type { ComputeConnectionBrokerAcquirer } from './connection-broker'
import type { ComputeHostRepository } from './repository'

describe('compute probe shell protocol', () => {
  it.each([true, false])(
    'records independent checks for a pinned scratch path and scheduler availability=%s',
    async (available) => {
      const root = mkdtempSync(join(tmpdir(), 'compute-health-'))
      const bin = join(root, 'bin')
      const scratch = join(root, "scratch ' quoted")
      mkdirSync(bin)
      mkdirSync(scratch)
      for (const command of ['sbatch', 'sacct', 'scancel', 'squeue']) {
        writeFileSync(
          join(bin, command),
          `#!/bin/sh\nexit ${command === 'squeue' && !available ? 1 : 0}\n`,
          { mode: 0o755 }
        )
      }
      let checkedScratch = scratch
      const host = {
        id: 'host',
        providerId: 'ssh:probe',
        scratchPinned: true,
        executionMode: 'slurm'
      } as ComputeHost
      const repository = {
        get: async () => ({ ...host, scratchRoot: checkedScratch }),
        updateProbeResult: vi.fn(async () => true)
      } as unknown as ComputeHostRepository
      const broker = {
        acquire: async () => ({
          run: async (script: string) => ({
            stdout: execFileSync('/bin/bash', ['-c', script], {
              env: {
                ...process.env,
                PATH: `${bin}:/usr/bin:/bin`,
                SCRATCH: '/wrong/unpinned/path'
              },
              encoding: 'utf8'
            }),
            stderr: '',
            exitCode: 0,
            timedOut: false,
            truncated: false
          })
        })
      } as unknown as ComputeConnectionBrokerAcquirer
      try {
        const owner = new ComputeHostProfileOwner(broker, repository)
        expect(await owner.probe('ssh:probe')).toMatchObject({
          ok: available,
          sshConnected: true,
          commandExecutable: true,
          scratchWritable: true,
          scratchPath: scratch,
          schedulerAvailable: available
        })
        expect(readdirSync(scratch)).toEqual([])
        chmodSync(scratch, 0o500)
        checkedScratch = scratch
        expect(await owner.probe('ssh:probe')).toMatchObject({
          ok: false,
          sshConnected: true,
          commandExecutable: true,
          scratchWritable: false,
          schedulerAvailable: available
        })
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  )

  it('detects a scheduler executable without leaking its path into the boolean field', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'compute-probe-bin-'))
    try {
      writeFileSync(join(bin, 'sbatch'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
      const host = { providerId: 'ssh:probe', scratchPinned: true } as ComputeHost
      const repository = {
        get: vi.fn(async () => host),
        updateProbeResult: vi.fn(async () => true)
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
    } finally {
      rmSync(bin, { recursive: true, force: true })
    }
  })
})
