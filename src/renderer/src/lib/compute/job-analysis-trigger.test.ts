// Tests for the analysis turn trigger: receives done-state job broadcasts and auto-fires a
// sendPrompt per session, batching same-session done jobs, queuing when a turn is in flight,
// and marking notificationConsumedAt only on success. Pure renderer logic per design §11.

import { describe, expect, it, vi } from 'vitest'

import type { ComputeSessionOwner, JobSummary } from '../../../../shared/compute'
import {
  buildAnalysisPrompt,
  createJobAnalysisTrigger,
  type JobAnalysisTriggerDeps
} from './job-analysis-trigger'

// ── helpers ──────────────────────────────────────────────────────────────────

const makeJob = (overrides: Partial<JobSummary> = {}): JobSummary => ({
  job_id: 'job-1',
  provider_id: 'ssh:biowulf',
  display_name: 'biowulf',
  shape: 'direct_ssh',
  session_id: 'sess-1',
  project_id: 'project-a',
  status: 'success',
  intent: 'Salary analysis',
  created_at: 1000,
  started_at: 1100,
  finished_at: 1200,
  exit_code: 0,
  error_code: undefined,
  remote_workdir: undefined,
  stdout_tail: undefined,
  stderr_tail: undefined,
  notified_at: 2000,
  notification_consumed_at: undefined,
  featured_files: ['hpc/job-1/featured/result.txt'],
  featured_file_count: 1,
  left_on_remote_count: 0,
  ...overrides
})

const defaultOwner: ComputeSessionOwner = { projectId: 'project-a', sessionId: 'sess-1' }

const createDeps = (overrides: Partial<JobAnalysisTriggerDeps> = {}): JobAnalysisTriggerDeps => ({
  canAddressOwner: vi.fn().mockReturnValue(true),
  isSessionInFlight: vi.fn().mockReturnValue(false),
  sendPrompt: vi.fn().mockResolvedValue({ sessionId: 'sess-1', messageId: 'msg-1' }),
  markConsumed: vi.fn().mockResolvedValue(undefined),
  onTurnEnd: vi.fn(),
  log: vi.fn(),
  ...overrides
})

const flushMicrotasks = (): Promise<void> => Promise.resolve()

// ── buildAnalysisPrompt ───────────────────────────────────────────────────────

describe('buildAnalysisPrompt', () => {
  it('produces an english prompt mentioning job_id and featured_files', () => {
    const job = makeJob({ job_id: 'job-abc', featured_files: ['hpc/job-abc/featured/out.txt'] })
    const prompt = buildAnalysisPrompt([job])
    expect(prompt).toContain('job-abc')
    expect(prompt).toContain('hpc/job-abc/featured/out.txt')
    expect(prompt).toContain('attachJob')
    expect(prompt).not.toContain('attach_job')
    expect(prompt).toContain('result()')
  })

  it('includes all job_ids when multiple jobs are batched', () => {
    const jobs = [
      makeJob({ job_id: 'job-1', session_id: 'sess-1' }),
      makeJob({ job_id: 'job-2', session_id: 'sess-1' })
    ]
    const prompt = buildAnalysisPrompt(jobs)
    expect(prompt).toContain('job-1')
    expect(prompt).toContain('job-2')
  })

  it('notes harvest_failed jobs as having incomplete harvest', () => {
    const job = makeJob({ job_id: 'job-fail', status: 'failed', featured_files: [] })
    const prompt = buildAnalysisPrompt([job])
    expect(prompt).toContain('job-fail')
  })
})

// ── createJobAnalysisTrigger ──────────────────────────────────────────────────

describe('createJobAnalysisTrigger — immediate send', () => {
  it('sends a prompt immediately when session is not in flight', async () => {
    const deps = createDeps()
    const trigger = createJobAnalysisTrigger(deps)

    trigger.onJobDone(makeJob())
    await flushMicrotasks()

    expect(deps.sendPrompt).toHaveBeenCalledTimes(1)
    const [owner, text] = (deps.sendPrompt as ReturnType<typeof vi.fn>).mock.calls[0] as [
      ComputeSessionOwner,
      string
    ]
    expect(owner).toEqual(defaultOwner)
    expect(text).toContain('job-1')
  })

  it('calls markConsumed after sendPrompt resolves and turn ends', async () => {
    const deps = createDeps()
    const trigger = createJobAnalysisTrigger(deps)

    trigger.onJobDone(makeJob())
    await flushMicrotasks()
    await flushMicrotasks()

    // onTurnEnd should have been called to register a callback
    expect(deps.onTurnEnd).toHaveBeenCalledTimes(1)
    const [owner, callback] = (deps.onTurnEnd as ReturnType<typeof vi.fn>).mock.calls[0] as [
      ComputeSessionOwner,
      () => void
    ]
    expect(owner).toEqual(defaultOwner)

    // Simulate turn completion by invoking the callback
    await callback()

    // Now markConsumed should be called
    expect(deps.markConsumed).toHaveBeenCalledWith(defaultOwner, ['job-1'])
  })

  it('does not call markConsumed when sendPrompt returns undefined (failed)', async () => {
    const deps = createDeps({
      sendPrompt: vi.fn().mockResolvedValue(undefined)
    })
    const trigger = createJobAnalysisTrigger(deps)

    trigger.onJobDone(makeJob())
    await flushMicrotasks()
    await flushMicrotasks()

    expect(deps.markConsumed).not.toHaveBeenCalled()
  })

  it('does not call markConsumed when sendPrompt rejects', async () => {
    const deps = createDeps({
      sendPrompt: vi.fn().mockRejectedValue(new Error('already running'))
    })
    const trigger = createJobAnalysisTrigger(deps)

    trigger.onJobDone(makeJob())
    await flushMicrotasks()
    await flushMicrotasks()

    expect(deps.markConsumed).not.toHaveBeenCalled()
  })
})

describe('createJobAnalysisTrigger — idempotency', () => {
  it('skips jobs where notification_consumed_at is already set', async () => {
    const deps = createDeps()
    const trigger = createJobAnalysisTrigger(deps)

    trigger.onJobDone(makeJob({ notification_consumed_at: 9999 }))
    await flushMicrotasks()

    expect(deps.sendPrompt).not.toHaveBeenCalled()
  })

  it('does not queue the same job_id twice when a turn is already in flight for it', async () => {
    const deps = createDeps()
    const trigger = createJobAnalysisTrigger(deps)

    // First done → immediate send (in flight now)
    trigger.onJobDone(makeJob())
    // Second broadcast for the same job before markConsumed
    trigger.onJobDone(makeJob())
    await flushMicrotasks()
    await flushMicrotasks()

    // sendPrompt called once, markConsumed called once
    expect(deps.sendPrompt).toHaveBeenCalledTimes(1)
  })
})

describe('createJobAnalysisTrigger — batching', () => {
  it('batches multiple done jobs for the same session into one prompt', async () => {
    const deps = createDeps()
    const trigger = createJobAnalysisTrigger(deps)

    // Arrive synchronously (microtask batching window)
    trigger.onJobDone(makeJob({ job_id: 'job-1' }))
    trigger.onJobDone(makeJob({ job_id: 'job-2' }))
    await flushMicrotasks()

    expect(deps.sendPrompt).toHaveBeenCalledTimes(1)
    const [, text] = (deps.sendPrompt as ReturnType<typeof vi.fn>).mock.calls[0] as [
      ComputeSessionOwner,
      string
    ]
    expect(text).toContain('job-1')
    expect(text).toContain('job-2')
  })

  it('sends separate prompts for different sessions', async () => {
    const deps = createDeps()
    const trigger = createJobAnalysisTrigger(deps)

    trigger.onJobDone(makeJob({ job_id: 'job-1', session_id: 'sess-1' }))
    trigger.onJobDone(makeJob({ job_id: 'job-2', session_id: 'sess-2' }))
    await flushMicrotasks()
    await flushMicrotasks()

    expect(deps.sendPrompt).toHaveBeenCalledTimes(2)
    const sessions = (deps.sendPrompt as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => (call as [ComputeSessionOwner, string])[0]
    )
    expect(sessions).toContainEqual({ projectId: 'project-a', sessionId: 'sess-1' })
    expect(sessions).toContainEqual({ projectId: 'project-a', sessionId: 'sess-2' })
  })
})

describe('createJobAnalysisTrigger — queuing', () => {
  it('queues when session is in flight and sends after notifyTurnEnd', async () => {
    let turnEndCallback: (() => void) | undefined
    const deps = createDeps({
      isSessionInFlight: vi.fn().mockReturnValue(true),
      onTurnEnd: vi.fn((_sessionId, cb) => {
        turnEndCallback = cb
      })
    })
    const trigger = createJobAnalysisTrigger(deps)

    trigger.onJobDone(makeJob())
    await flushMicrotasks()

    // Not sent yet — queued
    expect(deps.sendPrompt).not.toHaveBeenCalled()
    expect(deps.onTurnEnd).toHaveBeenCalledWith(defaultOwner, expect.any(Function))

    // Turn ends
    ;(deps.isSessionInFlight as ReturnType<typeof vi.fn>).mockReturnValue(false)
    turnEndCallback?.()
    await flushMicrotasks()

    expect(deps.sendPrompt).toHaveBeenCalledTimes(1)
  })

  it('does not re-queue when a second done broadcast arrives for a queued job', async () => {
    let turnEndCallback: (() => void) | undefined
    const deps = createDeps({
      isSessionInFlight: vi.fn().mockReturnValue(true),
      onTurnEnd: vi.fn((_sessionId, cb) => {
        turnEndCallback = cb
      })
    })
    const trigger = createJobAnalysisTrigger(deps)

    trigger.onJobDone(makeJob())
    trigger.onJobDone(makeJob()) // same job again
    await flushMicrotasks()

    ;(deps.isSessionInFlight as ReturnType<typeof vi.fn>).mockReturnValue(false)
    turnEndCallback?.()
    await flushMicrotasks()

    expect(deps.sendPrompt).toHaveBeenCalledTimes(1)
    expect(deps.onTurnEnd).toHaveBeenCalledTimes(1)
  })

  it('logs queued and in-flight job ids for observability', async () => {
    const deps = createDeps({
      isSessionInFlight: vi.fn().mockReturnValue(true),
      onTurnEnd: vi.fn()
    })
    const trigger = createJobAnalysisTrigger(deps)

    trigger.onJobDone(makeJob())
    await flushMicrotasks()

    expect(deps.log).toHaveBeenCalled()
  })
})

describe('createJobAnalysisTrigger — cross-session isolation', () => {
  it('sends the prompt to the job own session_id, not a different one', async () => {
    const deps = createDeps()
    const trigger = createJobAnalysisTrigger(deps)

    trigger.onJobDone(makeJob({ session_id: 'sess-xyz' }))
    await flushMicrotasks()

    const [owner] = (deps.sendPrompt as ReturnType<typeof vi.fn>).mock.calls[0] as [
      ComputeSessionOwner
    ]
    expect(owner).toEqual({ projectId: 'project-a', sessionId: 'sess-xyz' })
  })
})

describe('createJobAnalysisTrigger compound owner isolation', () => {
  it('keeps identical session ids in different projects in separate batches', async () => {
    const deps = createDeps()
    const trigger = createJobAnalysisTrigger(deps)

    trigger.onJobDone(makeJob({ job_id: 'job-a', project_id: 'project-a', session_id: 'shared' }))
    trigger.onJobDone(makeJob({ job_id: 'job-b', project_id: 'project-b', session_id: 'shared' }))
    await flushMicrotasks()

    const owners = (deps.sendPrompt as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => (call as [ComputeSessionOwner, string])[0]
    )
    expect(owners).toContainEqual({ projectId: 'project-a', sessionId: 'shared' })
    expect(owners).toContainEqual({ projectId: 'project-b', sessionId: 'shared' })
  })

  it('fails closed when the runtime cannot uniquely address the owner', async () => {
    const deps = createDeps({ canAddressOwner: vi.fn().mockReturnValue(false) })
    const trigger = createJobAnalysisTrigger(deps)

    trigger.onJobDone(makeJob())
    await flushMicrotasks()

    expect(deps.sendPrompt).not.toHaveBeenCalled()
    expect(deps.markConsumed).not.toHaveBeenCalled()
    expect(deps.log).toHaveBeenCalledWith('analysis-turn:ambiguous-owner', expect.any(String))
  })
})
