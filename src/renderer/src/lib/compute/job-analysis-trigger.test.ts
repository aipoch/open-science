// Tests for the analysis turn trigger: receives done-state job broadcasts and auto-fires a
// sendPrompt per session, batching same-session done jobs, queuing when a turn is in flight,
// and marking notificationConsumedAt only on success. Pure renderer logic per design §11.

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { JobSummary } from '../../../../shared/compute'
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

const createDeps = (overrides: Partial<JobAnalysisTriggerDeps> = {}): JobAnalysisTriggerDeps => ({
  isSessionInFlight: vi.fn().mockReturnValue(false),
  sendPrompt: vi.fn(async (sessionId, _text, messageId) => ({ sessionId, messageId })),
  createMessageId: vi.fn().mockReturnValue('msg-1'),
  transitionAnalysis: vi.fn().mockResolvedValue(undefined),
  getJobsForSession: vi.fn().mockResolvedValue([]),
  getTurnState: vi.fn().mockReturnValue('missing'),
  onTurnEnd: vi.fn(),
  log: vi.fn(),
  ...overrides
})

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
})

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
    const [sessionId, text] = (deps.sendPrompt as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string
    ]
    expect(sessionId).toBe('sess-1')
    expect(text).toContain('job-1')
  })

  it('records success after sendPrompt resolves and turn ends', async () => {
    const deps = createDeps()
    const trigger = createJobAnalysisTrigger(deps)

    trigger.onJobDone(makeJob())
    await flushMicrotasks()
    await flushMicrotasks()

    // onTurnEnd should have been called to register a callback
    expect(deps.onTurnEnd).toHaveBeenCalledTimes(1)
    const [sessionId, callback] = (deps.onTurnEnd as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      (outcome: 'succeeded' | 'failed' | 'cancelled') => void
    ]
    expect(sessionId).toBe('sess-1')

    // Simulate turn completion by invoking the callback
    callback('succeeded')
    await flushMicrotasks()

    expect(deps.transitionAnalysis).toHaveBeenLastCalledWith({
      sessionId: 'sess-1',
      jobIds: ['job-1'],
      messageId: 'msg-1',
      state: 'succeeded'
    })
  })

  it('retries a failed terminal transition with the same Message ID', async () => {
    vi.useFakeTimers()
    let terminalAttempts = 0
    let turnEndCallback: ((outcome: 'succeeded' | 'failed' | 'cancelled') => void) | undefined
    const transitionAnalysis = vi.fn<JobAnalysisTriggerDeps['transitionAnalysis']>((request) => {
      if (request.state === 'succeeded' && terminalAttempts++ === 0) {
        return Promise.reject(new Error('database temporarily unavailable'))
      }
      return Promise.resolve()
    })
    const deps = createDeps({
      transitionAnalysis,
      getJobsForSession: vi
        .fn()
        .mockResolvedValue([
          makeJob({ analysis_state: 'dispatched', analysis_message_id: 'msg-1' })
        ]),
      onTurnEnd: vi.fn((_sessionId, callback) => {
        turnEndCallback = callback
      })
    })
    const trigger = createJobAnalysisTrigger(deps)

    trigger.onJobDone(makeJob())
    await flushMicrotasks()
    turnEndCallback?.('succeeded')
    await flushMicrotasks()

    expect(
      transitionAnalysis.mock.calls.filter(([request]) => request.state === 'succeeded')
    ).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1_000)
    await flushMicrotasks()

    const terminalCalls = transitionAnalysis.mock.calls.filter(
      ([request]) => request.state === 'succeeded'
    )
    expect(terminalCalls).toEqual([
      [
        {
          sessionId: 'sess-1',
          jobIds: ['job-1'],
          messageId: 'msg-1',
          state: 'succeeded'
        }
      ],
      [
        {
          sessionId: 'sess-1',
          jobIds: ['job-1'],
          messageId: 'msg-1',
          state: 'succeeded'
        }
      ]
    ])
  })

  it('stops retrying a failed terminal transition after the job is deleted', async () => {
    vi.useFakeTimers()
    let turnEndCallback: ((outcome: 'succeeded' | 'failed' | 'cancelled') => void) | undefined
    const transitionAnalysis = vi.fn<JobAnalysisTriggerDeps['transitionAnalysis']>((request) =>
      request.state === 'succeeded'
        ? Promise.reject(new Error('analysis transition conflict'))
        : Promise.resolve()
    )
    const deps = createDeps({
      transitionAnalysis,
      getJobsForSession: vi.fn().mockResolvedValue([]),
      onTurnEnd: vi.fn((_sessionId, callback) => {
        turnEndCallback = callback
      })
    })
    const trigger = createJobAnalysisTrigger(deps)

    trigger.onJobDone(makeJob())
    await flushMicrotasks()
    await flushMicrotasks()
    turnEndCallback?.('succeeded')
    await flushMicrotasks()
    await flushMicrotasks()

    expect(deps.getJobsForSession).toHaveBeenCalledWith('sess-1')
    expect(
      transitionAnalysis.mock.calls.filter(([request]) => request.state === 'succeeded')
    ).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(3_000)
    await flushMicrotasks()

    expect(
      transitionAnalysis.mock.calls.filter(([request]) => request.state === 'succeeded')
    ).toHaveLength(1)
  })

  it('records failure when sendPrompt returns undefined', async () => {
    const deps = createDeps({
      sendPrompt: vi.fn().mockResolvedValue(undefined)
    })
    const trigger = createJobAnalysisTrigger(deps)

    trigger.onJobDone(makeJob())
    await flushMicrotasks()
    await flushMicrotasks()

    expect(deps.transitionAnalysis).toHaveBeenLastCalledWith(
      expect.objectContaining({ messageId: 'msg-1', state: 'failed' })
    )
  })

  it('records failure when sendPrompt rejects', async () => {
    const deps = createDeps({
      sendPrompt: vi.fn().mockRejectedValue(new Error('already running'))
    })
    const trigger = createJobAnalysisTrigger(deps)

    trigger.onJobDone(makeJob())
    await flushMicrotasks()
    await flushMicrotasks()

    expect(deps.transitionAnalysis).toHaveBeenLastCalledWith(
      expect.objectContaining({ messageId: 'msg-1', state: 'failed' })
    )
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

    // sendPrompt called once for the durable dispatch.
    expect(deps.sendPrompt).toHaveBeenCalledTimes(1)
  })

  it('retries a failed durable claim with the same Message ID', async () => {
    vi.useFakeTimers()
    const transitionAnalysis = vi
      .fn<JobAnalysisTriggerDeps['transitionAnalysis']>()
      .mockRejectedValueOnce(new Error('database temporarily unavailable'))
      .mockResolvedValue(undefined)
    const deps = createDeps({
      transitionAnalysis,
      getJobsForSession: vi.fn().mockResolvedValue([makeJob()])
    })
    const trigger = createJobAnalysisTrigger(deps)

    trigger.onJobDone(makeJob())
    await flushMicrotasks()

    expect(deps.sendPrompt).not.toHaveBeenCalled()
    expect(transitionAnalysis).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(1_000)
    await flushMicrotasks()

    expect(transitionAnalysis).toHaveBeenNthCalledWith(1, {
      sessionId: 'sess-1',
      jobIds: ['job-1'],
      messageId: 'msg-1',
      state: 'dispatched'
    })
    expect(transitionAnalysis).toHaveBeenNthCalledWith(2, {
      sessionId: 'sess-1',
      jobIds: ['job-1'],
      messageId: 'msg-1',
      state: 'dispatched'
    })
    expect(deps.sendPrompt).toHaveBeenCalledOnce()
  })

  it('stops retrying a failed durable claim after the job is deleted', async () => {
    vi.useFakeTimers()
    const transitionAnalysis = vi
      .fn<JobAnalysisTriggerDeps['transitionAnalysis']>()
      .mockRejectedValue(new Error('analysis transition conflict'))
    const deps = createDeps({
      transitionAnalysis,
      getJobsForSession: vi.fn().mockResolvedValue([])
    })
    const trigger = createJobAnalysisTrigger(deps)

    trigger.onJobDone(makeJob())
    await flushMicrotasks()
    await flushMicrotasks()

    expect(deps.getJobsForSession).toHaveBeenCalledWith('sess-1')
    expect(transitionAnalysis).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(3_000)
    await flushMicrotasks()

    expect(transitionAnalysis).toHaveBeenCalledOnce()
    expect(deps.sendPrompt).not.toHaveBeenCalled()
  })

  it('adopts a competing renderer claim after its broadcast arrives before the local conflict', async () => {
    vi.useFakeTimers()
    let rejectClaim: ((error: Error) => void) | undefined
    const transitionAnalysis = vi.fn<JobAnalysisTriggerDeps['transitionAnalysis']>(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectClaim = reject
        })
    )
    const winner = makeJob({
      analysis_state: 'dispatched',
      analysis_message_id: 'winner-message'
    })
    const deps = createDeps({
      createMessageId: vi.fn().mockReturnValue('loser-message'),
      transitionAnalysis,
      getJobsForSession: vi.fn().mockResolvedValue([winner])
    })
    const trigger = createJobAnalysisTrigger(deps)

    trigger.onJobDone(makeJob())
    await flushMicrotasks()
    expect(transitionAnalysis).toHaveBeenCalledOnce()

    trigger.onJobDone(winner)
    await flushMicrotasks()
    expect(deps.sendPrompt).not.toHaveBeenCalled()

    rejectClaim?.(new Error('analysis transition conflict'))
    await flushMicrotasks()
    await flushMicrotasks()

    expect(deps.getJobsForSession).toHaveBeenCalledWith('sess-1')
    expect(deps.sendPrompt).toHaveBeenCalledWith(
      'sess-1',
      expect.stringContaining('job-1'),
      'winner-message'
    )

    await vi.advanceTimersByTimeAsync(1_000)
    expect(transitionAnalysis).toHaveBeenCalledOnce()
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
    const [, text] = (deps.sendPrompt as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string]
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
      (call) => (call as [string, string])[0]
    )
    expect(sessions).toContain('sess-1')
    expect(sessions).toContain('sess-2')
  })
})

describe('createJobAnalysisTrigger — queuing', () => {
  it('serializes a later batch that reuses the pending key after claim starts', async () => {
    let resolveFirstClaim: (() => void) | undefined
    const turnEndCallbacks: Array<(outcome: 'succeeded' | 'failed' | 'cancelled') => void> = []
    const transitionAnalysis = vi.fn<JobAnalysisTriggerDeps['transitionAnalysis']>((request) => {
      if (request.state === 'dispatched' && request.jobIds.includes('job-1')) {
        return new Promise<void>((resolve) => {
          resolveFirstClaim = resolve
        })
      }
      return Promise.resolve()
    })
    const deps = createDeps({
      createMessageId: vi
        .fn<JobAnalysisTriggerDeps['createMessageId']>()
        .mockReturnValueOnce('msg-1')
        .mockReturnValueOnce('msg-2'),
      transitionAnalysis,
      onTurnEnd: vi.fn((_sessionId, callback) => {
        turnEndCallbacks.push(callback)
      })
    })
    const trigger = createJobAnalysisTrigger(deps)

    trigger.onJobDone(makeJob({ job_id: 'job-1' }))
    await flushMicrotasks()
    expect(transitionAnalysis).toHaveBeenCalledOnce()

    trigger.onJobDone(makeJob({ job_id: 'job-2' }))
    await flushMicrotasks()

    expect(transitionAnalysis).toHaveBeenCalledOnce()
    expect(deps.sendPrompt).not.toHaveBeenCalled()

    resolveFirstClaim?.()
    await flushMicrotasks()
    expect(deps.sendPrompt).toHaveBeenCalledWith(
      'sess-1',
      expect.stringContaining('job-1'),
      'msg-1'
    )

    turnEndCallbacks[0]?.('succeeded')
    await flushMicrotasks()
    await flushMicrotasks()

    expect(deps.sendPrompt).toHaveBeenLastCalledWith(
      'sess-1',
      expect.stringContaining('job-2'),
      'msg-2'
    )
  })

  it('serializes recovered and pending analysis batches for the same session', async () => {
    const turnEndCallbacks: Array<(outcome: 'succeeded' | 'failed' | 'cancelled') => void> = []
    const deps = createDeps({
      onTurnEnd: vi.fn((_sessionId, callback) => {
        turnEndCallbacks.push(callback)
      })
    })
    const trigger = createJobAnalysisTrigger(deps)

    trigger.onJobDone(
      makeJob({
        job_id: 'job-recovered',
        analysis_state: 'dispatched',
        analysis_message_id: 'message-recovered'
      })
    )
    trigger.onJobDone(makeJob({ job_id: 'job-pending' }))
    await flushMicrotasks()

    expect(deps.sendPrompt).toHaveBeenCalledTimes(1)
    expect(deps.sendPrompt).toHaveBeenCalledWith(
      'sess-1',
      expect.stringContaining('job-recovered'),
      'message-recovered'
    )

    turnEndCallbacks[0]?.('succeeded')
    await flushMicrotasks()

    expect(deps.sendPrompt).toHaveBeenCalledTimes(2)
    expect(deps.sendPrompt).toHaveBeenLastCalledWith(
      'sess-1',
      expect.stringContaining('job-pending'),
      'msg-1'
    )
  })

  it('waits when a session starts a turn while a pending batch is being claimed', async () => {
    let sessionInFlight = false
    let resolveClaim: (() => void) | undefined
    let turnEndCallback: ((outcome: 'succeeded' | 'failed' | 'cancelled') => void) | undefined
    const deps = createDeps({
      isSessionInFlight: vi.fn(() => sessionInFlight),
      transitionAnalysis: vi.fn((request) =>
        request.state === 'dispatched'
          ? new Promise<void>((resolve) => {
              resolveClaim = resolve
            })
          : Promise.resolve()
      ),
      onTurnEnd: vi.fn((_sessionId, callback) => {
        turnEndCallback = callback
      })
    })
    const trigger = createJobAnalysisTrigger(deps)

    trigger.onJobDone(makeJob())
    await flushMicrotasks()
    expect(deps.transitionAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'dispatched' })
    )

    sessionInFlight = true
    resolveClaim?.()
    await flushMicrotasks()

    expect(deps.sendPrompt).not.toHaveBeenCalled()
    expect(deps.onTurnEnd).toHaveBeenCalledWith('sess-1', expect.any(Function))

    sessionInFlight = false
    turnEndCallback?.('succeeded')
    await flushMicrotasks()

    expect(deps.sendPrompt).toHaveBeenCalledOnce()
  })

  it('stops after disposal while a durable claim is pending', async () => {
    let resolveClaim: (() => void) | undefined
    const deps = createDeps({
      transitionAnalysis: vi.fn((request) =>
        request.state === 'dispatched'
          ? new Promise<void>((resolve) => {
              resolveClaim = resolve
            })
          : Promise.resolve()
      )
    })
    const trigger = createJobAnalysisTrigger(deps)

    trigger.onJobDone(makeJob())
    await flushMicrotasks()
    expect(deps.transitionAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'dispatched' })
    )

    trigger.dispose()
    resolveClaim?.()
    await flushMicrotasks()

    expect(deps.sendPrompt).not.toHaveBeenCalled()
    expect(deps.onTurnEnd).not.toHaveBeenCalled()
    expect(deps.transitionAnalysis).toHaveBeenCalledOnce()
  })

  it('queues when session is in flight and sends after notifyTurnEnd', async () => {
    let turnEndCallback: ((outcome: 'succeeded' | 'failed' | 'cancelled') => void) | undefined
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
    expect(deps.onTurnEnd).toHaveBeenCalledWith('sess-1', expect.any(Function))

    // Turn ends
    ;(deps.isSessionInFlight as ReturnType<typeof vi.fn>).mockReturnValue(false)
    turnEndCallback?.('succeeded')
    await flushMicrotasks()

    expect(deps.sendPrompt).toHaveBeenCalledTimes(1)
  })

  it('does not re-queue when a second done broadcast arrives for a queued job', async () => {
    let turnEndCallback: ((outcome: 'succeeded' | 'failed' | 'cancelled') => void) | undefined
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
    turnEndCallback?.('succeeded')
    await flushMicrotasks()

    expect(deps.sendPrompt).toHaveBeenCalledTimes(1)
    expect(deps.onTurnEnd).toHaveBeenCalledTimes(2)
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

    const [sessionId] = (deps.sendPrompt as ReturnType<typeof vi.fn>).mock.calls[0] as [string]
    expect(sessionId).toBe('sess-xyz')
  })
})
