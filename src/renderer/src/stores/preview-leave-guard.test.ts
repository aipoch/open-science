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

  it('lets a guard resume the exact deferred action after confirmation', () => {
    const action = vi.fn()
    let deferredAction: (() => boolean | void) | undefined
    previewLeaveGuards.register('workbench:project-1:file-1', (requestedAction) => {
      deferredAction = requestedAction
      return false
    })

    expect(previewLeaveGuards.request('workbench:project-1:file-1', action)).toBe(false)
    expect(action).not.toHaveBeenCalled()

    deferredAction?.()
    expect(action).toHaveBeenCalledOnce()
  })

  it('bypasses only the approved scope once when a deferred action re-enters its guard', () => {
    const firstAction = vi.fn()
    const secondAction = vi.fn()
    const guard = vi.fn(() => false)
    previewLeaveGuards.register('workbench:project-1:file-1', guard)

    expect(
      previewLeaveGuards.runApproved('workbench:project-1:file-1', () =>
        previewLeaveGuards.request('workbench:project-1:file-1', firstAction)
      )
    ).toBe(true)
    expect(firstAction).toHaveBeenCalledOnce()
    expect(guard).not.toHaveBeenCalled()

    expect(previewLeaveGuards.request('workbench:project-1:file-1', secondAction)).toBe(false)
    expect(secondAction).not.toHaveBeenCalled()
    expect(guard).toHaveBeenCalledOnce()
  })

  it('does not bypass a different dirty preview scope', () => {
    const otherAction = vi.fn()
    const otherGuard = vi.fn(() => false)
    previewLeaveGuards.register('dialog:project-1:file-2', otherGuard)

    previewLeaveGuards.runApproved('workbench:project-1:file-1', () =>
      previewLeaveGuards.request('dialog:project-1:file-2', otherAction)
    )

    expect(otherAction).not.toHaveBeenCalled()
    expect(otherGuard).toHaveBeenCalledOnce()
  })
})
