import { describe, expect, it, vi } from 'vitest'
import { previewCloseGuards } from './preview-close-guard'

describe('transient preview close confirmation', () => {
  it('defers a bulk close until every affected chat is approved', () => {
    let approveFirst!: () => void
    let approveSecond!: () => void
    const first = vi.fn((approve: () => void) => {
      approveFirst = approve
    })
    const second = vi.fn((approve: () => void) => {
      approveSecond = approve
    })
    const disposeFirst = previewCloseGuards.register('chat-a', first)
    const disposeSecond = previewCloseGuards.register('chat-b', second)
    const removed = vi.fn()
    const close = (): void => {
      if (previewCloseGuards.request(['chat-a', 'file', 'chat-b'], close)) removed()
    }
    close()
    expect(removed).not.toHaveBeenCalled()
    expect(second).not.toHaveBeenCalled()
    approveFirst()
    expect(removed).not.toHaveBeenCalled()
    approveSecond()
    expect(removed).toHaveBeenCalledOnce()
    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledOnce()
    disposeFirst()
    disposeSecond()
  })

  it('does not retain approval after an operation and releases unmounted targets', () => {
    let approve!: () => void
    const confirmation = vi.fn((action: () => void) => {
      approve = action
    })
    const unregister = previewCloseGuards.register('chat', confirmation)
    const removed = vi.fn()
    const close = (): void => {
      if (previewCloseGuards.request(['chat'], close)) removed()
    }
    close()
    approve()
    close()
    expect(removed).toHaveBeenCalledOnce()
    expect(confirmation).toHaveBeenCalledTimes(2)
    unregister()
    close()
    expect(removed).toHaveBeenCalledTimes(2)
  })
})
