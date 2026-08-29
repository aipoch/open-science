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
  notified_at: undefined,
  notification_consumed_at: undefined,
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

  it('keeps each Session partition when another Session hydrates', async () => {
    const first = [makeJob({ job_id: 'old', session_id: 'sess-1' })]
    const second = [makeJob({ job_id: 'new', session_id: 'sess-2' })]
    setJobsApi({
      jobsList: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    })

    await useSessionJobStore.getState().hydrate('sess-1')
    await useSessionJobStore.getState().hydrate('sess-2')

    const state = useSessionJobStore.getState()
    expect(state.jobsById.has('old')).toBe(true)
    expect(state.jobsById.has('new')).toBe(true)
    expect(state.hydratedSessionId).toBe('sess-2')
  })

  it('does not let an older Session hydrate completion switch the active Session back', async () => {
    let resolveFirst!: (jobs: JobSummary[]) => void
    const first = new Promise<JobSummary[]>((resolve) => {
      resolveFirst = resolve
    })
    setJobsApi({
      jobsList: vi
        .fn()
        .mockReturnValueOnce(first)
        .mockResolvedValueOnce([makeJob({ job_id: 'second', session_id: 'sess-2' })])
    })

    const firstHydrate = useSessionJobStore.getState().hydrate('sess-1')
    await useSessionJobStore.getState().hydrate('sess-2')
    resolveFirst([makeJob({ job_id: 'first', session_id: 'sess-1' })])
    await firstHydrate

    expect(useSessionJobStore.getState().hydratedSessionId).toBe('sess-2')
    expect(useSessionJobStore.getState().jobsById.has('first')).toBe(true)
  })

  it('does not overwrite a newer terminal broadcast with an older hydrate response', async () => {
    let resolveHydrate!: (jobs: JobSummary[]) => void
    setJobsApi({
      jobsList: vi.fn(
        () =>
          new Promise<JobSummary[]>((resolve) => {
            resolveHydrate = resolve
          })
      )
    })

    const hydrating = useSessionJobStore.getState().hydrate('sess-1')
    useSessionJobStore
      .getState()
      .applyUpdate(makeJob({ job_id: 'job-race', session_id: 'sess-1', status: 'success' }))
    resolveHydrate([makeJob({ job_id: 'job-race', session_id: 'sess-1', status: 'running' })])
    await hydrating

    expect(useSessionJobStore.getState().jobsById.get('job-race')?.status).toBe('success')
  })

  it('background ACK hydration does not change the active Session', async () => {
    setJobsApi({ jobsList: vi.fn().mockResolvedValue([]) })
    await useSessionJobStore.getState().hydrate('sess-active')
    await useSessionJobStore.getState().hydrate('sess-background', { activate: false })
    expect(useSessionJobStore.getState().hydratedSessionId).toBe('sess-active')
  })

  it('exposes hydrate errors and clears them after a successful retry', async () => {
    setJobsApi({
      jobsList: vi
        .fn()
        .mockRejectedValueOnce(new Error('database busy'))
        .mockResolvedValueOnce([makeJob({ session_id: 'sess-1' })])
    })

    await expect(useSessionJobStore.getState().hydrate('sess-1')).resolves.toBeUndefined()
    expect(useSessionJobStore.getState().loadErrorBySession.get('sess-1')).toBe('database busy')
    await useSessionJobStore.getState().hydrate('sess-1')
    expect(useSessionJobStore.getState().loadErrorBySession.has('sess-1')).toBe(false)
  })
})

describe('session job store — global activity projection', () => {
  it('hydrates persisted non-terminal jobs across Sessions', async () => {
    const jobs = [
      makeJob({ job_id: 'job-a', session_id: 'session-a', status: 'queued' }),
      makeJob({ job_id: 'job-b', session_id: 'session-b', status: 'running' })
    ]
    const jobsList = vi.fn().mockResolvedValue(jobs)
    setJobsApi({ jobsList })

    await useSessionJobStore.getState().hydrateNonTerminal()

    expect(jobsList).toHaveBeenCalledWith({ nonTerminal: true })
    expect(Array.from(useSessionJobStore.getState().nonTerminalJobsById.values())).toEqual(jobs)
  })

  it('does not resurrect a job that becomes terminal while global hydration is pending', async () => {
    let resolveHydration: ((jobs: JobSummary[]) => void) | undefined
    setJobsApi({
      jobsList: vi.fn(() => new Promise<JobSummary[]>((resolve) => (resolveHydration = resolve)))
    })
    const running = makeJob({ job_id: 'job-race', status: 'running' })

    const hydration = useSessionJobStore.getState().hydrateNonTerminal()
    useSessionJobStore.getState().applyUpdate({ ...running, status: 'success' })
    resolveHydration?.([running])
    await hydration

    expect(useSessionJobStore.getState().nonTerminalJobsById.has('job-race')).toBe(false)
  })

  it('keeps global activity when a Workspace hydrates one Session history', async () => {
    const active = makeJob({ job_id: 'global-job', session_id: 'other-session' })
    setJobsApi({
      jobsList: vi.fn().mockResolvedValueOnce([active]).mockResolvedValueOnce([])
    })

    await useSessionJobStore.getState().hydrateNonTerminal()
    await useSessionJobStore.getState().hydrate('workspace-session')

    expect(useSessionJobStore.getState().nonTerminalJobsById.get(active.job_id)).toEqual(active)
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

  it('never regresses terminal, notified, or consumed state on an out-of-order update', () => {
    useSessionJobStore.getState().applyUpdate(
      makeJob({
        job_id: 'j',
        status: 'success',
        notified_at: 200,
        notification_consumed_at: 300
      })
    )
    useSessionJobStore
      .getState()
      .applyUpdate(makeJob({ job_id: 'j', status: 'running', notified_at: undefined }))

    expect(useSessionJobStore.getState().jobsById.get('j')).toMatchObject({
      status: 'success',
      notified_at: 200,
      notification_consumed_at: 300
    })
  })

  it('does not let a late pre-harvest terminal projection erase harvested details', () => {
    useSessionJobStore.getState().applyUpdate(
      makeJob({
        job_id: 'j',
        status: 'failed',
        finished_at: 150,
        notified_at: 200,
        harvest_error: 'harvest_failed: connection reset',
        featured_files: ['hpc/j/featured/current.csv'],
        featured_file_count: 1,
        left_on_remote: [
          { uri: 'ssh://biowulf/current.dat', size_mb: 20, reason: 'exceeds_max_file_mb' }
        ],
        left_on_remote_count: 1
      })
    )
    useSessionJobStore.getState().applyUpdate(
      makeJob({
        job_id: 'j',
        status: 'failed',
        finished_at: 150,
        featured_files: [],
        featured_file_count: 0,
        left_on_remote: [],
        left_on_remote_count: 0
      })
    )

    expect(useSessionJobStore.getState().jobsById.get('j')).toMatchObject({
      notified_at: 200,
      harvest_error: 'harvest_failed: connection reset',
      featured_files: ['hpc/j/featured/current.csv'],
      featured_file_count: 1,
      left_on_remote: [
        { uri: 'ssh://biowulf/current.dat', size_mb: 20, reason: 'exceeds_max_file_mb' }
      ],
      left_on_remote_count: 1
    })
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

describe('session job store — allJobsForSession', () => {
  it('returns all jobs for the session regardless of status, sorted by created_at descending', () => {
    const job1 = makeJob({
      job_id: 'j1',
      session_id: 'sess-A',
      status: 'success',
      created_at: 1000
    })
    const job2 = makeJob({
      job_id: 'j2',
      session_id: 'sess-A',
      status: 'running',
      created_at: 3000
    })
    const job3 = makeJob({ job_id: 'j3', session_id: 'sess-A', status: 'failed', created_at: 2000 })
    const otherSession = makeJob({
      job_id: 'o',
      session_id: 'sess-B',
      status: 'success',
      created_at: 4000
    })

    useSessionJobStore.getState().applyUpdate(job1)
    useSessionJobStore.getState().applyUpdate(job2)
    useSessionJobStore.getState().applyUpdate(job3)
    useSessionJobStore.getState().applyUpdate(otherSession)

    const result = useSessionJobStore.getState().allJobsForSession('sess-A')
    expect(result).toHaveLength(3)
    expect(result[0]!.job_id).toBe('j2') // created_at: 3000
    expect(result[1]!.job_id).toBe('j3') // created_at: 2000
    expect(result[2]!.job_id).toBe('j1') // created_at: 1000
  })

  it('returns an empty array when session has no jobs', () => {
    useSessionJobStore.getState().applyUpdate(makeJob({ session_id: 'sess-A' }))
    expect(useSessionJobStore.getState().allJobsForSession('sess-B')).toHaveLength(0)
  })
})
