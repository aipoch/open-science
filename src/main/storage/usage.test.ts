import { link, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { availableBytes, computeStorageUsage } from './usage'

let dataRoot: string

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), 'ds-usage-'))
})

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true })
})

// Writes a file of exactly `bytes` size at `path`, creating parent dirs as needed.
const writeSized = async (path: string, bytes: number): Promise<void> => {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, Buffer.alloc(bytes))
}

describe('computeStorageUsage', () => {
  it('sums per-category bytes and gives runtime a sorted children breakdown', async () => {
    await writeSized(join(dataRoot, 'artifacts', 'a.bin'), 100)
    await writeSized(join(dataRoot, 'uploads', 'b.bin'), 50)
    await writeSized(join(dataRoot, 'workspaces', 'session-1', 'repo', 'data.bin'), 25)
    await writeSized(join(dataRoot, 'runtime', 'python', 'p.bin'), 200)
    await writeSized(join(dataRoot, 'runtime', 'r', 'r.bin'), 300)
    // notebooks/ left absent.

    const usage = await computeStorageUsage(dataRoot)

    expect(usage.categories).toEqual([
      { key: 'artifacts', bytes: 100 },
      { key: 'uploads', bytes: 50 },
      {
        key: 'runtime',
        bytes: 500,
        children: [
          { name: 'r', bytes: 300 },
          { name: 'python', bytes: 200 }
        ]
      },
      { key: 'notebooks', bytes: 0 },
      { key: 'workspaces', bytes: 25 }
    ])
    expect(usage.totalBytes).toBe(675)
  })

  it('labels default-python/-r as python/r and the shared pkgs cache as conda', async () => {
    await writeSized(join(dataRoot, 'runtime', 'envs', 'default-python', 'p.bin'), 200)
    await writeSized(join(dataRoot, 'runtime', 'envs', 'default-r', 'r.bin'), 300)
    await writeSized(join(dataRoot, 'runtime', 'envs', 'my-analysis', 'm.bin'), 50)
    await writeSized(join(dataRoot, 'runtime', 'pkgs', 'cache.bin'), 400)

    const usage = await computeStorageUsage(dataRoot)
    const runtime = usage.categories.find((c) => c.key === 'runtime')

    expect(runtime).toEqual({
      key: 'runtime',
      bytes: 950,
      children: [
        { name: 'conda', bytes: 400 },
        { name: 'r', bytes: 300 },
        { name: 'python', bytes: 200 },
        { name: 'my-analysis', bytes: 50 }
      ]
    })
  })

  it('counts envs.lock toward the runtime total but does not show it as its own row', async () => {
    await writeSized(join(dataRoot, 'runtime', 'envs', 'default-python', 'p.bin'), 200)
    await writeSized(join(dataRoot, 'runtime', 'envs.lock', 'default-r.lock'), 10)

    const usage = await computeStorageUsage(dataRoot)
    const runtime = usage.categories.find((c) => c.key === 'runtime')

    expect(runtime?.children?.map((c) => c.name)).toEqual(['python'])
    // 200 (python) + 10 (hidden envs.lock) still in the total.
    expect(runtime?.bytes).toBe(210)
  })

  // Hard links (inode dedup) are Unix-only; Windows stat ino isn't reliable for this.
  it.skipIf(process.platform === 'win32')(
    'counts a package hard-linked from pkgs into an env once (attributed to conda, not the env)',
    async () => {
      // The shared package lives in the cache; the env hard-links it (as micromamba does) + 24B unique.
      await writeSized(join(dataRoot, 'runtime', 'pkgs', 'libbig.bin'), 1000)
      await mkdir(join(dataRoot, 'runtime', 'envs', 'default-r', 'lib'), { recursive: true })
      await link(
        join(dataRoot, 'runtime', 'pkgs', 'libbig.bin'),
        join(dataRoot, 'runtime', 'envs', 'default-r', 'lib', 'libbig.bin')
      )
      await writeSized(join(dataRoot, 'runtime', 'envs', 'default-r', 'unique.bin'), 24)

      const usage = await computeStorageUsage(dataRoot)
      const runtime = usage.categories.find((c) => c.key === 'runtime')

      // conda counts the shared 1000B once; r shows only its 24B unique; total = 1024 (matches `du`).
      expect(runtime).toEqual({
        key: 'runtime',
        bytes: 1024,
        children: [
          { name: 'conda', bytes: 1000 },
          { name: 'r', bytes: 24 }
        ]
      })
    }
  )

  it('includes loose top-level files under runtime alongside its subdirectory children', async () => {
    await writeSized(join(dataRoot, 'runtime', 'python', 'p.bin'), 200)
    await writeSized(join(dataRoot, 'runtime', 'lockfile'), 10)

    const usage = await computeStorageUsage(dataRoot)
    const runtime = usage.categories.find((c) => c.key === 'runtime')

    expect(runtime).toEqual({
      key: 'runtime',
      bytes: 210,
      children: [{ name: 'python', bytes: 200 }]
    })
  })

  it('tolerates an empty or missing data root without throwing', async () => {
    const missingRoot = join(dataRoot, 'does-not-exist')

    const usage = await computeStorageUsage(missingRoot)

    expect(usage.categories).toEqual([
      { key: 'artifacts', bytes: 0 },
      { key: 'uploads', bytes: 0 },
      { key: 'runtime', bytes: 0, children: [] },
      { key: 'notebooks', bytes: 0 },
      { key: 'workspaces', bytes: 0 }
    ])
    expect(usage.totalBytes).toBe(0)
  })
})

describe('availableBytes', () => {
  it('returns a positive finite number for an existing path', async () => {
    const bytes = await availableBytes(tmpdir())

    expect(Number.isFinite(bytes)).toBe(true)
    expect(bytes).toBeGreaterThan(0)
  })
})
