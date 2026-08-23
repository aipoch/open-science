import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
    expect(['typical', 'likely-slow-disk', 'slow-disk-or-scanner', 'unknown']).toContain(
      result.kind
    )
    expect(JSON.stringify(result)).not.toContain(probeDir)
  })

  it('does not overwrite or delete an existing file in the probe directory', async () => {
    probeDir = await mkdtemp(join(tmpdir(), 'os-startup-probe-keep-'))
    const sentinel = join(probeDir, '.open-science-startup-probe')
    await writeFile(sentinel, 'keep-me')
    await probeStartupStorage({ probeDir })
    await timedStartupStorageProbe({ probeDir }, 1_500)
    expect(await readFile(sentinel, 'utf8')).toBe('keep-me')
  })

  it('does not delete a pre-existing file at a supplied probe path', async () => {
    probeDir = await mkdtemp(join(tmpdir(), 'os-startup-probe-existing-'))
    const existing = join(probeDir, '.open-science-startup-probe-existing')
    await writeFile(existing, 'keep-me')
    await expect(probeStartupStorage({ probeDir, probePath: existing })).resolves.toEqual({
      sequentialMs: 0,
      syncWriteMs: 0,
      kind: 'unknown'
    })
    await expect(
      timedStartupStorageProbe({ probeDir, probePath: existing }, 1_500)
    ).resolves.toEqual({
      sequentialMs: 0,
      syncWriteMs: 0,
      kind: 'unknown'
    })
    expect(await readFile(existing, 'utf8')).toBe('keep-me')
  })

  it('returns unknown when the probe directory cannot be written', async () => {
    const result = await probeStartupStorage({
      probeDir: join(tmpdir(), 'os-startup-probe-missing', 'no-such-dir')
    })
    expect(result).toEqual({ sequentialMs: 0, syncWriteMs: 0, kind: 'unknown' })
  })

  it('runs the default isolated probe to completion', async () => {
    probeDir = await mkdtemp(join(tmpdir(), 'os-startup-probe-worker-'))
    const result = await timedStartupStorageProbe({ probeDir }, 1_500)
    expect(result.timedOut).toBeUndefined()
    expect(['typical', 'likely-slow-disk', 'slow-disk-or-scanner', 'unknown']).toContain(
      result.kind
    )
    expect(JSON.stringify(result)).not.toContain(probeDir)
  })

  it('terminates an isolated probe when the timeout fires', async () => {
    probeDir = await mkdtemp(join(tmpdir(), 'os-startup-probe-timeout-'))
    let terminated = 0
    const result = await timedStartupStorageProbe(
      {
        probeDir,
        isolate: () => ({
          result: new Promise(() => undefined),
          terminate: async () => {
            terminated += 1
          }
        })
      },
      20
    )
    expect(result).toEqual({
      sequentialMs: 20,
      syncWriteMs: 20,
      kind: 'slow-disk-or-scanner',
      timedOut: true
    })
    expect(terminated).toBe(1)
  })
})
