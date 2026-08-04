import { describe, expect, it, vi } from 'vitest'

import { AcpGenerationActivityOwner } from './generation-activity-owner'

const createDeferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('AcpGenerationActivityOwner', () => {
  it('holds immutable reconnect and retirement blockers for a balanced activity scope', async () => {
    const activityChanged = vi.fn()
    const owner = new AcpGenerationActivityOwner({
      activityChanged,
      hasActivePrompts: () => false,
      hasActiveReviewerSessions: () => false
    })
    const release = createDeferred()

    const activity = owner.withActivity(() => release.promise)

    expect(owner.blockers()).toEqual({ reconnect: true, retirement: true })
    expect(Object.isFrozen(owner.blockers())).toBe(true)

    release.resolve()
    await activity

    expect(owner.blockers()).toEqual({ reconnect: false, retirement: false })
    expect(activityChanged).toHaveBeenCalledOnce()
  })

  it('blocks only retirement during an operation and releases the lease when work throws', async () => {
    const activityChanged = vi.fn()
    const owner = new AcpGenerationActivityOwner({
      activityChanged,
      hasActivePrompts: () => false,
      hasActiveReviewerSessions: () => false
    })
    const boom = new Error('operation failed')
    let reject!: (error: Error) => void
    const failed = new Promise<void>((_resolve, fail) => {
      reject = fail
    })

    const operation = owner.withOperation(() => failed)

    expect(owner.blockers()).toEqual({ reconnect: false, retirement: true })
    reject(boom)
    await expect(operation).rejects.toBe(boom)

    expect(owner.blockers()).toEqual({ reconnect: false, retirement: false })
    expect(activityChanged).toHaveBeenCalledOnce()
  })

  it('keeps nested activity scopes blocked until the final release', async () => {
    const activityChanged = vi.fn()
    const owner = new AcpGenerationActivityOwner({
      activityChanged,
      hasActivePrompts: () => false,
      hasActiveReviewerSessions: () => false
    })
    const releaseInner = createDeferred()
    const releaseOuter = createDeferred()

    const inner = owner.withActivity(() => releaseInner.promise)
    const outer = owner.withActivity(() => releaseOuter.promise)

    releaseInner.resolve()
    await inner
    expect(owner.blockers()).toEqual({ reconnect: true, retirement: true })

    releaseOuter.resolve()
    await outer
    expect(owner.blockers()).toEqual({ reconnect: false, retirement: false })
    expect(activityChanged).toHaveBeenCalledTimes(2)
  })

  it('acquires and releases an opaque startup blocker exactly once', () => {
    const activityChanged = vi.fn()
    const owner = new AcpGenerationActivityOwner({
      activityChanged,
      hasActivePrompts: () => false,
      hasActiveReviewerSessions: () => false
    })
    const token = Symbol('session-startup')

    owner.acquireStartup(token)
    expect(owner.blockers()).toEqual({ reconnect: true, retirement: true })

    owner.releaseStartup(token)
    owner.releaseStartup(token)

    expect(owner.blockers()).toEqual({ reconnect: false, retirement: false })
    expect(activityChanged).toHaveBeenCalledTimes(2)
  })

  it('invalidates every startup blocker and ignores their late releases', () => {
    const activityChanged = vi.fn()
    const owner = new AcpGenerationActivityOwner({
      activityChanged,
      hasActivePrompts: () => false,
      hasActiveReviewerSessions: () => false
    })
    const primary = Symbol('primary-startup')
    const reviewer = Symbol('reviewer-startup')
    owner.acquireStartup(primary)
    owner.acquireStartup(reviewer)

    owner.invalidateStartups()
    owner.releaseStartup(primary)
    owner.releaseStartup(reviewer)

    expect(owner.blockers()).toEqual({ reconnect: false, retirement: false })
    expect(activityChanged).toHaveBeenCalledTimes(2)
  })

  it('does not publish the transient gap in a Reviewer startup handoff', async () => {
    let reviewerActive = false
    const activityChanged = vi.fn()
    const owner = new AcpGenerationActivityOwner({
      activityChanged,
      hasActivePrompts: () => false,
      hasActiveReviewerSessions: () => reviewerActive
    })
    const token = Symbol('reviewer-startup')

    await owner.withOperation(async () => {
      owner.acquireStartup(token)
      activityChanged.mockClear()
      owner.releaseStartup(token)
      reviewerActive = true
    })

    expect(owner.blockers()).toEqual({ reconnect: true, retirement: true })
    expect(activityChanged).toHaveBeenCalledOnce()

    reviewerActive = false
    expect(owner.blockers()).toEqual({ reconnect: false, retirement: false })
  })

  it('notifies when one operation releases startup activity while another operation remains', async () => {
    const activityChanged = vi.fn()
    const owner = new AcpGenerationActivityOwner({
      activityChanged,
      hasActivePrompts: () => false,
      hasActiveReviewerSessions: () => false
    })
    const releaseOtherOperation = createDeferred()
    const otherOperation = owner.withOperation(() => releaseOtherOperation.promise)
    activityChanged.mockClear()

    await owner.withOperation(async () => {
      const token = Symbol('failed-startup')
      owner.acquireStartup(token)
      owner.releaseStartup(token)
    })

    expect(owner.blockers()).toEqual({ reconnect: false, retirement: true })
    expect(activityChanged).toHaveBeenCalledOnce()

    releaseOtherOperation.resolve()
    await otherOperation
    expect(owner.blockers()).toEqual({ reconnect: false, retirement: false })
    expect(activityChanged).toHaveBeenCalledTimes(2)
  })
})
