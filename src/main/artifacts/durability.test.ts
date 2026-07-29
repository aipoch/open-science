import { describe, expect, it, vi } from 'vitest'

import { createArtifactDurability } from './durability'

describe('artifact durability', () => {
  it('opens ordinary files with a write-capable handle before syncing', async () => {
    const sync = vi.fn().mockResolvedValue(undefined)
    const close = vi.fn().mockResolvedValue(undefined)
    const openHandle = vi.fn().mockResolvedValue({ sync, close })
    const durability = createArtifactDurability({ openHandle, platform: 'win32' })

    await durability.syncFile('C:\\artifacts\\version.content')

    expect(openHandle).toHaveBeenCalledWith('C:\\artifacts\\version.content', 'r+')
    expect(sync).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })

  it('keeps directory handles read-only and tolerates unsupported Windows directory sync', async () => {
    const error = Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
    const openHandle = vi.fn().mockRejectedValue(error)
    const durability = createArtifactDurability({ openHandle, platform: 'win32' })

    await expect(durability.syncDirectory('C:\\artifacts')).resolves.toBeUndefined()
    expect(openHandle).toHaveBeenCalledWith('C:\\artifacts', 'r')
  })
})
