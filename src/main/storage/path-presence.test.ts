import { mkdtemp, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { isDataRootMissing } from './path-presence'

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

  it('regression: a non-ASCII (CJK) path whose stat throws a non-ENOENT error is not missing', async () => {
    const logger = { warn: vi.fn() }
    const cjkPath = 'F:\\openscience产生数据\\OpenScience'
    const statFn = vi.fn().mockRejectedValue(errno('EINVAL'))

    expect(await isDataRootMissing(cjkPath, { statFn, logger })).toBe(false)
    // The diagnostic logs code points so a non-ASCII path failure is decodable from a packaged log.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ code: 'EINVAL', pathCodePoints: expect.stringContaining('U+4EA7') })
    )
  })

  it('reports missing for a CJK path that genuinely does not exist (ENOENT)', async () => {
    const statFn = vi.fn().mockRejectedValue(errno('ENOENT'))

    expect(await isDataRootMissing('F:\\openscience产生数据\\OpenScience', { statFn })).toBe(true)
  })
})
