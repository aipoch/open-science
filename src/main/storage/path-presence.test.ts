import { mkdtemp, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { hasAnyExistingPath, isDataRootMissing } from './path-presence'

// An errno error the way node's fs surfaces it.
const errno = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(code), { code }) as NodeJS.ErrnoException

describe('isDataRootMissing', () => {
  const created: string[] = []

  afterEach(async () => {
    for (const dir of created.splice(0)) await rmdir(dir).catch(() => undefined)
  })

  it('reports not missing when the directory exists (real fs)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'os-presence-'))
    created.push(dir)

    expect(await isDataRootMissing(dir)).toBe(false)
  })

  it('reports missing when the directory is gone (real fs, ENOENT)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'os-presence-'))
    await rmdir(dir)

    expect(await isDataRootMissing(dir)).toBe(true)
  })

  it('treats ENOTDIR (a file where a dir was expected) as missing', async () => {
    const statFn = vi.fn().mockRejectedValue(errno('ENOTDIR'))

    expect(await isDataRootMissing('/whatever/OpenScience', { statFn })).toBe(true)
  })

  it('does NOT treat a non-ENOENT stat error as missing, and logs it', async () => {
    const logger = { warn: vi.fn() }
    // EPERM / EBUSY / EINVAL / encoding-class failures must not be collapsed into "deleted": doing so
    // would nag the user to abandon real data. This is the regression the fix targets.
    for (const code of ['EPERM', 'EBUSY', 'EINVAL', 'EIO']) {
      const statFn = vi.fn().mockRejectedValue(errno(code))
      expect(await isDataRootMissing('/mnt/data/OpenScience', { statFn, logger })).toBe(false)
    }

    expect(logger.warn).toHaveBeenCalledTimes(4)
  })

  it('does not let a diagnostic sink failure change an indeterminate result', async () => {
    const statFn = vi.fn().mockRejectedValue(errno('EIO'))

    await expect(
      isDataRootMissing('/mnt/data/OpenScience', {
        statFn,
        logger: {
          warn: () => {
            throw new Error('sink unavailable')
          }
        }
      })
    ).resolves.toBe(false)
  })

  it('regression: a non-ASCII (CJK) path whose stat throws a non-ENOENT error is not missing', async () => {
    const logger = { warn: vi.fn() }
    const cjkPath = 'F:\\openscience产生数据\\OpenScience'
    const statFn = vi.fn().mockRejectedValue(errno('EINVAL'))

    expect(await isDataRootMissing(cjkPath, { statFn, logger })).toBe(false)
    // Diagnostics retain only a fixed category: code points are reversible and would still disclose
    // the user's absolute data-root path.
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { errorCategory: 'system' })
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(cjkPath)
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('U+4EA7')
  })

  it('reports missing for a CJK path that genuinely does not exist (ENOENT)', async () => {
    const statFn = vi.fn().mockRejectedValue(errno('ENOENT'))

    expect(await isDataRootMissing('F:\\openscience产生数据\\OpenScience', { statFn })).toBe(true)
  })
})

describe('hasAnyExistingPath', () => {
  it('returns false only when every path is proven absent', async () => {
    const statFn = vi.fn().mockRejectedValue(errno('ENOENT'))

    await expect(
      hasAnyExistingPath(['/data/artifacts', '/data/runtime'], { statFn })
    ).resolves.toBe(false)
    expect(statFn).toHaveBeenCalledTimes(2)
  })

  it('returns true as soon as one path is present', async () => {
    const statFn = vi
      .fn()
      .mockRejectedValueOnce(errno('ENOENT'))
      .mockResolvedValueOnce({ isDirectory: () => true })

    await expect(
      hasAnyExistingPath(['/data/artifacts', '/data/runtime'], { statFn })
    ).resolves.toBe(true)
  })

  it.each(['EPERM', 'EBUSY', 'EINVAL', 'EIO'])(
    'rejects an inconclusive %s check so callers can fail closed',
    async (code) => {
      const statFn = vi.fn().mockRejectedValue(errno(code))

      await expect(hasAnyExistingPath(['/data/artifacts'], { statFn })).rejects.toMatchObject({
        code
      })
    }
  )
})
