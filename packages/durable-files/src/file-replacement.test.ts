import { describe, expect, it, vi } from 'vitest'
import { retryFileReplacement } from './index'

describe('replacement retries', () => {
  it.each(['EPERM', 'EACCES', 'EBUSY'])(
    'bounds retries for %s and preserves the failure',
    async (code) => {
      const failure = Object.assign(new Error(code), { code })
      const replace = vi.fn().mockRejectedValue(failure)
      const wait = vi.fn().mockResolvedValue(undefined)
      await expect(retryFileReplacement(replace, wait)).rejects.toBe(failure)
      expect(replace).toHaveBeenCalledTimes(6)
      expect(wait.mock.calls.flat()).toEqual([25, 50, 100, 200, 400])
    }
  )

  it.each(['EIO', 'ENOENT', 'EEXIST'])('does not retry %s', async (code) => {
    const failure = Object.assign(new Error(code), { code })
    const replace = vi.fn().mockRejectedValue(failure)
    const wait = vi.fn()
    await expect(retryFileReplacement(replace, wait)).rejects.toBe(failure)
    expect(replace).toHaveBeenCalledOnce()
    expect(wait).not.toHaveBeenCalled()
  })
})
