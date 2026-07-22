import { describe, expect, it } from 'vitest'

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
})
