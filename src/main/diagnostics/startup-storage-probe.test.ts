import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { probeStartupStorage, timedStartupStorageProbe } from './startup-storage-probe'

let probeDir: string | undefined

afterEach(async () => {
  if (probeDir) await rm(probeDir, { recursive: true, force: true })
  probeDir = undefined
})

describe('probeStartupStorage', () => {
  it('reports numeric timings and a coarse kind without paths', async () => {
    probeDir = await mkdtemp(join(tmpdir(), 'os-startup-probe-'))
    const result = await probeStartupStorage({ probeDir })
    expect(result.sequentialMs).toBeGreaterThanOrEqual(0)
    expect(result.syncWriteMs).toBeGreaterThanOrEqual(0)
    expect(['typical', 'likely-slow-disk', 'slow-disk-or-scanner', 'unknown']).toContain(result.kind)
    expect(JSON.stringify(result)).not.toContain(probeDir)
    await expect(readFile(join(probeDir, '.open-science-startup-probe'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('returns unknown when the probe directory cannot be written', async () => {
    const result = await probeStartupStorage({
      probeDir: join(tmpdir(), 'os-startup-probe-missing', 'no-such-dir')
    })
    expect(result).toEqual({ sequentialMs: 0, syncWriteMs: 0, kind: 'unknown' })
  })

  it('caps a hung probe as slow-disk-or-scanner', async () => {
    probeDir = await mkdtemp(join(tmpdir(), 'os-startup-probe-timeout-'))
    const result = await timedStartupStorageProbe(
      {
        probeDir,
        probe: () => new Promise(() => undefined)
      },
      20
    )
    expect(result).toEqual({
      sequentialMs: 20,
      syncWriteMs: 20,
      kind: 'slow-disk-or-scanner',
      timedOut: true
    })
  })
})
