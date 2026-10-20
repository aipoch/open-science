import { describe, expect, it, vi } from 'vitest'

import { createFileDurability } from './file-durability'

describe('file durability', () => {
  it('opens ordinary files with a write-capable handle before syncing', async () => {
    const sync = vi.fn().mockResolvedValue(undefined)
    const close = vi.fn().mockResolvedValue(undefined)
    const openHandle = vi.fn().mockResolvedValue({ sync, close })
    const durability = createFileDurability({ openHandle, platform: 'win32' })

    await durability.syncFile('C:\\artifacts\\version.content')

    expect(openHandle).toHaveBeenCalledWith('C:\\artifacts\\version.content', 'r+')
    expect(sync).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })

  it('keeps directory handles read-only and tolerates unsupported Windows directory sync', async () => {
    const error = Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
    const openHandle = vi.fn().mockRejectedValue(error)
    const durability = createFileDurability({ openHandle, platform: 'win32' })

    await expect(durability.syncDirectory('C:\\artifacts')).resolves.toBeUndefined()
    expect(openHandle).toHaveBeenCalledWith('C:\\artifacts', 'r')
  })
})

it.each(['EISDIR', 'EPERM', 'EINVAL', 'ENOTSUP'])(
  'tolerates only Windows directory %s',
  async (code) => {
    const failure = Object.assign(new Error(code), { code })
    const close = vi.fn().mockResolvedValue(undefined)
    const openHandle = vi
      .fn()
      .mockResolvedValue({ sync: vi.fn().mockRejectedValue(failure), close })
    await expect(
      createFileDurability({ openHandle, platform: 'win32' }).syncDirectory('directory')
    ).resolves.toBeUndefined()
    expect(close).toHaveBeenCalledOnce()
    await expect(
      createFileDurability({ openHandle, platform: 'linux' }).syncDirectory('directory')
    ).rejects.toBe(failure)
    await expect(
      createFileDurability({ openHandle, platform: 'win32' }).syncFile('file')
    ).rejects.toBe(failure)
    expect(close).toHaveBeenCalledTimes(3)
  }
)

it('propagates unexpected directory sync failures and still closes the handle', async () => {
  const failure = Object.assign(new Error('disk failure'), { code: 'EIO' })
  const close = vi.fn().mockResolvedValue(undefined)
  const openHandle = vi.fn().mockResolvedValue({ sync: vi.fn().mockRejectedValue(failure), close })
  await expect(
    createFileDurability({ openHandle, platform: 'win32' }).syncDirectory('directory')
  ).rejects.toBe(failure)
  expect(close).toHaveBeenCalledOnce()
})
