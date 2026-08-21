import { afterEach, describe, expect, it, vi } from 'vitest'

import { previewLeaveGuards } from './preview-leave-guard'

describe('preview leave guard coordinator', () => {
  afterEach(() => previewLeaveGuards.clear())

  it('allows an action only when the current scope guard accepts leaving', () => {
    const action = vi.fn()
    const unregister = previewLeaveGuards.register('workbench:project-1:file-1', () => false)

    expect(previewLeaveGuards.request('workbench:project-1:file-1', action)).toBe(false)
    expect(action).not.toHaveBeenCalled()

    unregister()
    expect(previewLeaveGuards.request('workbench:project-1:file-1', action)).toBe(true)
    expect(action).toHaveBeenCalledOnce()
  })
})
