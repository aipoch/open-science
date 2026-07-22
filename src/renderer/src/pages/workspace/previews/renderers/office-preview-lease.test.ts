import { describe, expect, it, vi } from 'vitest'

import { OfficePreviewHostLeaseCoordinator } from './office-preview-lease'

describe('OfficePreviewHostLeaseCoordinator', () => {
  it('restores the previous host after the top host releases the single runtime lease', () => {
    const coordinator = new OfficePreviewHostLeaseCoordinator()
    const first = vi.fn()
    const second = vi.fn()

    const releaseFirst = coordinator.register(first)
    const releaseSecond = coordinator.register(second)

    expect(first.mock.calls).toEqual([[true], [false]])
    expect(second.mock.calls).toEqual([[true]])

    releaseSecond()
    expect(first).toHaveBeenLastCalledWith(true)

    releaseFirst()
  })
})
