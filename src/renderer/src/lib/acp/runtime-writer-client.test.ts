import { describe, expect, it, vi } from 'vitest'
import { RuntimeWriterClient, runtimeWriterSaveOptions } from './runtime-writer-client'
describe('runtime writer client', () => {
  it('does not produce save options without the active lease', () => {
    expect(runtimeWriterSaveOptions()).toBeUndefined()
  })

  it('deduplicates claims and keeps observer decisions read-only', async () => {
    const claim = vi.fn(async () => ({ validForMs: 4000 }))
    const client = new RuntimeWriterClient(claim, () => 0)
    expect(await Promise.all([client.ensure(), client.ensure()])).toEqual([false, false])
    expect(claim).toHaveBeenCalledTimes(1)
    expect(client.token).toBeUndefined()
  })
  it('counts network transit against its lease and never uses an expired token', async () => {
    let now = 0
    const client = new RuntimeWriterClient(
      async () => {
        now = 21000
        return { token: 'token', validForMs: 20000 }
      },
      () => now
    )
    expect(await client.ensure()).toBe(false)
    expect(client.token).toBeUndefined()
  })
  it('stops writing on failed renewal instead of continuing with a stale lease', async () => {
    let now = 0
    const claim = vi
      .fn()
      .mockResolvedValueOnce({ token: 'first', validForMs: 20000 })
      .mockRejectedValueOnce(new Error('offline'))
    const client = new RuntimeWriterClient(claim, () => now)
    expect(await client.ensure()).toBe(true)
    now = 5000
    expect(await client.ensure()).toBe(false)
    expect(client.token).toBeUndefined()
  })
})
