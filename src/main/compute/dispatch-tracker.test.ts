import { describe, expect, it, vi } from 'vitest'

import { DispatchTracker } from './dispatch-tracker'

describe('DispatchTracker', () => {
  it('reports a job as in-flight between begin and end', () => {
    const tracker = new DispatchTracker()
    expect(tracker.has('job-1')).toBe(false)
    tracker.begin('job-1')
    expect(tracker.has('job-1')).toBe(true)
    tracker.end('job-1')
    expect(tracker.has('job-1')).toBe(false)
  })

  it('tracks multiple jobs independently', () => {
    const tracker = new DispatchTracker()
    tracker.begin('job-1')
    tracker.begin('job-2')
    tracker.end('job-1')
    expect(tracker.has('job-1')).toBe(false)
    expect(tracker.has('job-2')).toBe(true)
  })

  it('end is idempotent for an unknown job', () => {
    const tracker = new DispatchTracker()
    expect(() => tracker.end('never-began')).not.toThrow()
    expect(tracker.has('never-began')).toBe(false)
  })

  it('waits until every selected in-flight dispatch has ended', async () => {
    const tracker = new DispatchTracker()
    tracker.begin('job-1')
    tracker.begin('job-2')
    const settled = vi.fn()
    const waiting = tracker.waitFor(['job-1', 'job-2']).then(settled)

    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    tracker.end('job-1')
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    tracker.end('job-2')

    await waiting
    expect(settled).toHaveBeenCalledOnce()
  })

  it('waits for overlapping handoff and dispatch leases', async () => {
    const tracker = new DispatchTracker()
    tracker.begin('job-1')
    tracker.begin('job-1')
    const settled = vi.fn()
    const waiting = tracker.waitFor(['job-1']).then(settled)

    tracker.end('job-1')
    await Promise.resolve()
    expect(tracker.has('job-1')).toBe(true)
    expect(settled).not.toHaveBeenCalled()

    tracker.end('job-1')
    await waiting
    expect(tracker.has('job-1')).toBe(false)
    expect(settled).toHaveBeenCalledOnce()
  })
})
