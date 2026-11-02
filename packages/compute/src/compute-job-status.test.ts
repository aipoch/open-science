import { describe, expect, it } from 'vitest'
import type { ComputeJob } from './model'
import { isComputeJobResultFinal, projectJobStatus } from './compute-job-status'

const job = (overrides: Partial<ComputeJob> = {}): ComputeJob => ({
  job_id: 'job-1',
  provider_id: 'ssh:cluster',
  shape: 'scheduler_cluster',
  project_id: 'project-1',
  session_id: 'session-1',
  status: 'running',
  intent: 'Run analysis',
  command: 'analysis',
  command_hash: 'hash',
  environment: undefined,
  resource_request: undefined,
  input_manifest: undefined,
  output_manifest: undefined,
  harvest_config: undefined,
  timeout_seconds: undefined,
  remote_workdir: '/scratch/job-1',
  remote_handle: undefined,
  exit_code: undefined,
  stdout_tail: undefined,
  stderr_tail: undefined,
  error_code: undefined,
  created_at: 1,
  submitted_at: 2,
  started_at: 3,
  finished_at: undefined,
  harvested_at: undefined,
  ...overrides
})

describe('Agent Compute Job projection', () => {
  it.each([
    { status: 'failed', cancellation_status: 'cancelled' },
    { status: 'failed', error_code: 'job_cancelled' }
  ] as const)('delivers cancellation without waiting for harvest: %j', (overrides) => {
    const cancelled = job(overrides)
    expect(isComputeJobResultFinal(cancelled)).toBe(true)
    const snapshot = projectJobStatus(cancelled)
    expect(snapshot).toMatchObject({ status: 'cancelled', result_final: true })
    expect(snapshot).not.toHaveProperty('error')
    expect(snapshot).not.toHaveProperty('cancellation')
    expect(snapshot).not.toHaveProperty('cancellation_status')
    expect(snapshot).not.toHaveProperty('error_code')
  })

  it('keeps rejected cancellation separate from a running computation', () => {
    const failure = { code: 'cancel_request_rejected', message: 'Permission denied.' }
    const snapshot = projectJobStatus(
      job({ cancellation_status: 'failed', cancellation_error: failure })
    )
    expect(snapshot).toMatchObject({
      status: 'running',
      result_final: false,
      cancellation: { status: 'failed', error: failure }
    })
    expect(snapshot).not.toHaveProperty('error')
  })

  it('delivers a complete task error together with the failed cancellation', () => {
    expect(
      projectJobStatus(
        job({
          status: 'error',
          error_code: 'job_status_unavailable',
          error_message:
            'No scheduler record; accounting is disabled. The remote process may still be running.',
          last_poll_error: 'last transient diagnostic',
          cancellation_status: 'failed',
          cancellation_error: {
            code: 'cancel_confirmation_failed',
            message: 'No confirmation source remains.'
          }
        })
      )
    ).toMatchObject({
      status: 'error',
      result_final: true,
      error: {
        code: 'job_status_unavailable',
        message: expect.stringContaining('may still be running')
      },
      cancellation: { status: 'failed', error: { code: 'cancel_confirmation_failed' } }
    })
  })

  it('keeps natural completion authoritative after a failed cancellation', () => {
    const completed = job({
      status: 'success',
      harvested_at: 5,
      cancellation_status: 'failed',
      cancellation_error: { code: 'cancel_request_rejected', message: 'Permission denied.' }
    })
    expect(projectJobStatus(completed)).toMatchObject({ status: 'success', result_final: true })
    expect(projectJobStatus(completed)).not.toHaveProperty('cancellation')
  })

  it.each(['success', 'failed', 'timeout'] as const)(
    'preserves harvest finality for %s',
    (status) => {
      expect(projectJobStatus(job({ status })).result_final).toBe(false)
      expect(projectJobStatus(job({ status, harvested_at: 5 })).result_final).toBe(true)
    }
  )
})
