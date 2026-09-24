import { describe, expect, it, vi } from 'vitest'
import { createAutoPlanApproval } from './configuration-plan-approval'

describe('concrete Auto plans', () => {
  it('requires a fresh decision in Auto despite prior grants and changes modes without caching', async () => {
    let profile: 'ask' | 'auto' | 'full' = 'auto'
    const request = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true)
    const approve = createAutoPlanApproval({ profile: () => profile, request })
    const context = { sessionId: 'trusted' }
    expect(await approve({ target: 'a', content: 'v1' }, context)).toBe(false)
    expect(await approve({ target: 'a', content: 'v2' }, context)).toBe(true)
    profile = 'full'
    expect(await approve({ target: 'a' }, context)).toBe(true)
    profile = 'ask'
    expect(await approve({ target: 'a' }, context)).toBe(true)
    expect(request).toHaveBeenCalledTimes(2)
    profile = 'auto'
    await approve({ target: 'b' }, context)
    expect(request).toHaveBeenCalledTimes(3)
  })
  it('fails closed without a trusted session or resolved profile', async () => {
    const request = vi.fn()
    const approve = createAutoPlanApproval({ profile: () => undefined, request })
    expect(await approve({}, {})).toBe(false)
    expect(await approve({}, { sessionId: 'unknown' })).toBe(false)
    expect(request).not.toHaveBeenCalled()
  })
})
