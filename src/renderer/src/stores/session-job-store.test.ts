import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { JobSummary } from '../../../shared/compute'
import { createInitialSessionJobState, useSessionJobStore } from './session-job-store'

// Builds a minimal JobSummary for testing.
const makeJob = (overrides: Partial<JobSummary> = {}): JobSummary => ({
  job_id: 'job-1',
  provider_id: 'ssh:biowulf',
  display_name: 'biowulf',
  shape: 'direct_ssh',
  session_id: 'session-abc',
  status: 'running',
  intent: 'Salary analysis',
  created_at: 1000,
  started_at: 1000,
  finished_at: undefined,
  exit_code: undefined,
  error_code: undefined,
  remote_workdir: undefined,
  stdout_tail: undefined,
  stderr_tail: undefined,
  ...overrides
})

// Sets up a minimal window.api.compute mock for the store's hydrate action.
const setJobsApi = (api: Partial<Window['api']['compute']>): void => {
  ;(globalThis as unknown as { window: { api: { compute: unknown } } }).window = {
    api: { compute: api }
  } as never
}

beforeEach(() => {
  useSessionJobStore.setState(createInitialSessionJobState())
})

describe('session job store — hydrate', () => {
  it('loads jobs for a session and sets isLoaded', async () => {
    const jobs = [makeJob({ job_id: 'job-1', session_id: 'sess-1' })]
    setJobsApi({ jobsList: vi.fn().mockResolvedValue(jobs) })

    await useSessionJobStore.getState().hydrate('sess-1')

    const state = useSessionJobStore.getState()
    expect(state.isLoaded).toBe(true)
    expect(state.hydratedSessionId).toBe('sess-1')
    expect(state.jobsById.get('job-1')).toEqual(jobs[0])
  })

  it('replaces the existing job map on each hydrate call', async () => {
    const first = [makeJob({ job_id: 'old', session_id: 'sess-1' })]
    const second = [makeJob({ job_id: 'new', session_id: 'sess-2' })]
    setJobsApi({
      jobsList: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    })

    await useSessionJobStore.getState().hydrate('sess-1')
    await useSessionJobStore.getState().hydrate('sess-2')

    const state = useSessionJobStore.getState()
    expect(state.jobsById.has('old')).toBe(false)
    expect(state.jobsById.has('new')).toBe(true)
    expect(state.hydratedSessionId).toBe('sess-2')
  })
})

describe('session job store — applyUpdate', () => {
  it('inserts a new job into the map', () => {
    const job = makeJob({ job_id: 'job-x', status: 'running' })
    useSessionJobStore.getState().applyUpdate(job)

    expect(useSessionJobStore.getState().jobsById.get('job-x')).toEqual(job)
  })

  it('overwrites an existing job with the updated version', () => {
    useSessionJobStore.getState().applyUpdate(makeJob({ job_id: 'j', status: 'running' }))
    useSessionJobStore.getState().applyUpdate(makeJob({ job_id: 'j', status: 'success' }))

    expect(useSessionJobStore.getState().jobsById.get('j')?.status).toBe('success')
  })
})

describe('session job store — runningJobsForSession', () => {
  it('returns only running jobs for the given session', () => {
    const running = makeJob({ job_id: 'r', session_id: 'sess-A', status: 'running' })
    const success = makeJob({ job_id: 's', session_id: 'sess-A', status: 'success' })
    const otherSession = makeJob({ job_id: 'o', session_id: 'sess-B', status: 'running' })

    useSessionJobStore.getState().applyUpdate(running)
    useSessionJobStore.getState().applyUpdate(success)
    useSessionJobStore.getState().applyUpdate(otherSession)

    const result = useSessionJobStore.getState().runningJobsForSession('sess-A')
    expect(result).toHaveLength(1)
    expect(result[0]!.job_id).toBe('r')
  })

  it('returns an empty array when there are no running jobs', () => {
    const job = makeJob({ job_id: 'j', session_id: 'sess-A', status: 'success' })
    useSessionJobStore.getState().applyUpdate(job)

    expect(useSessionJobStore.getState().runningJobsForSession('sess-A')).toHaveLength(0)
  })

  it('returns an empty array for an unknown session id', () => {
    useSessionJobStore.getState().applyUpdate(makeJob({ session_id: 'sess-A', status: 'running' }))
    expect(useSessionJobStore.getState().runningJobsForSession('sess-UNKNOWN')).toHaveLength(0)
  })
})
