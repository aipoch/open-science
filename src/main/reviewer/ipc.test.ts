import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ReviewRunRequest } from '../../shared/reviewer'
import { REVIEWER_IPC } from '../../shared/reviewer'
import type { AcpRuntime } from '../acp/runtime'

// Distinct roots so a config-vs-data mix-up is unambiguous: artifacts must read from the data root.
const CONFIG_ROOT = '/tmp/open-science-config-root'
const DATA_ROOT = '/tmp/open-science-data-root'

// Capture every ipcMain.handle registration so handlers can be invoked directly in the test.
const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, payload: unknown) => unknown) => {
      handlers.set(channel, handler)
    }
  },
  BrowserWindow: { getAllWindows: () => [] }
}))

vi.mock('../storage-root', () => ({
  resolveStorageRoot: () => CONFIG_ROOT,
  resolveDataRoot: () => DATA_ROOT
}))

const runReview = vi.fn().mockResolvedValue(undefined)
vi.mock('./orchestrator', () => ({
  runReview: (options: unknown) => runReview(options)
}))

// Controllable review lookup so a test can make main's auto-idempotency check find an existing review.
const getReviewsForSession = vi.fn().mockResolvedValue([])
vi.mock('./repository', () => ({
  ReviewRepository: class {
    getReviewsForSession = getReviewsForSession
  }
}))

vi.mock('../projects/prisma-client', () => ({
  getProjectDbClient: vi.fn()
}))

// Shared, controllable session loader so a test can make the pre-runReview session load fail.
const sessionLoadAll = vi.fn().mockResolvedValue({ sessions: [] })
vi.mock('../session-persistence/repository', () => ({
  SessionRepository: class {
    loadAll = sessionLoadAll
  },
  // storage-root imports these names from the same module in production; keep them defined.
  DEV_SESSION_DIR_NAME: 'dev',
  PROD_SESSION_DIR_NAME: 'prod',
  getSessionPersistenceDir: () => CONFIG_ROOT
}))

// Capture broadcasts so a test can assert the start-failure error review reaches the renderer.
const broadcastToRenderers = vi.fn()
vi.mock('../renderer-broadcast', () => ({ broadcastToRenderers }))

const { registerReviewerIpcHandlers } = await import('./ipc')

const acpRuntime = {} as AcpRuntime

const createRequest = (): ReviewRunRequest => ({
  sessionId: 'session-1',
  turnMessageId: 'message-1',
  projectId: 'project-1'
})

// Default: a review that "starts" (signals onStarted so triggerReview resolves started:true) and
// completes immediately. Individual tests override runReview for held/failed runs.
beforeEach(() => {
  runReview.mockReset()
  runReview.mockImplementation((opts?: { onStarted?: () => void }) => {
    opts?.onStarted?.()
    return Promise.resolve(undefined)
  })
  broadcastToRenderers.mockClear()
  sessionLoadAll.mockReset()
  // Default: the requested session exists, so triggerReview proceeds to runReview.
  sessionLoadAll.mockResolvedValue({ sessions: [{ id: 'session-1' }] })
  getReviewsForSession.mockReset()
  // Default: no prior review for the turn, so the auto-idempotency check lets the run proceed.
  getReviewsForSession.mockResolvedValue([])
})

describe('reviewer IPC handlers', () => {
  it('runs reviews with artifacts rooted at the data root, not the config root', async () => {
    registerReviewerIpcHandlers({ acpRuntime })

    const runHandler = handlers.get(REVIEWER_IPC.RUN)
    expect(runHandler).toBeDefined()

    runHandler?.({}, createRequest())

    // triggerReview is fire-and-forget; wait for the background session load + runReview call.
    await vi.waitFor(() => expect(runReview).toHaveBeenCalledTimes(1))

    const passed = runReview.mock.calls[0][0] as { artifactStorageRoot: string }
    expect(passed.artifactStorageRoot).toBe(DATA_ROOT)
    expect(passed.artifactStorageRoot).not.toBe(CONFIG_ROOT)
  })

  it('lets injected options override the config/data split independently', async () => {
    runReview.mockClear()
    registerReviewerIpcHandlers({
      acpRuntime,
      storageRoot: '/tmp/injected-config',
      dataRoot: '/tmp/injected-data'
    })

    const runHandler = handlers.get(REVIEWER_IPC.RUN)
    runHandler?.({}, createRequest())

    await vi.waitFor(() => expect(runReview).toHaveBeenCalledTimes(1))

    const passed = runReview.mock.calls[0][0] as { artifactStorageRoot: string }
    expect(passed.artifactStorageRoot).toBe('/tmp/injected-data')
  })

  it('forwards scopeTurnMessageId so a re-run audits the scope turn, grouped under turnMessageId', async () => {
    runReview.mockClear()
    registerReviewerIpcHandlers({ acpRuntime })

    const runHandler = handlers.get(REVIEWER_IPC.RUN)
    // Re-running a fix-loop review: grouped under the original turn, but audit the correction turn.
    runHandler?.(
      {},
      { ...createRequest(), turnMessageId: 'original', scopeTurnMessageId: 'correction' }
    )

    await vi.waitFor(() => expect(runReview).toHaveBeenCalledTimes(1))

    const passed = runReview.mock.calls[0][0] as {
      turnMessageId: string
      scopeTurnMessageId?: string
    }
    expect(passed.turnMessageId).toBe('original')
    expect(passed.scopeTurnMessageId).toBe('correction')
  })

  it('dedupes concurrent reviews of the same turn (double-click / multiple stale cards)', async () => {
    runReview.mockClear()
    // Hold runReview open so both synchronous triggers overlap in flight.
    let resolveRun: (() => void) | undefined
    runReview.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveRun = () => resolve()
        })
    )
    registerReviewerIpcHandlers({ acpRuntime })

    const runHandler = handlers.get(REVIEWER_IPC.RUN)
    runHandler?.({}, createRequest())
    // Same turn, still in flight → dropped with the non-retryable already-in-flight reason so the
    // auto path does NOT retry it into a duplicate review.
    const dropped = await runHandler?.({}, createRequest())
    expect(dropped).toEqual({ started: false, reason: 'already-in-flight' })

    await vi.waitFor(() => expect(runReview).toHaveBeenCalledTimes(1))
    resolveRun?.()
    await Promise.resolve()
    expect(runReview).toHaveBeenCalledTimes(1)
  })

  it('returns started:false without a review row or broadcast when the session load fails', async () => {
    // The pre-runReview session load throws (e.g. DB/FS unavailable).
    sessionLoadAll.mockRejectedValueOnce(new Error('session store unavailable'))
    registerReviewerIpcHandlers({ acpRuntime })

    const runHandler = handlers.get(REVIEWER_IPC.RUN)
    const result = await runHandler?.({}, { ...createRequest(), turnMessageId: 'message-1' })

    // No fabricated error review, no broadcast — started:false with a retryable reason.
    expect(result).toEqual({ started: false, reason: 'load-failed' })
    expect(runReview).not.toHaveBeenCalled()
    expect(broadcastToRenderers).not.toHaveBeenCalled()
  })

  it('returns started:false without calling runReview when the session id is gone', async () => {
    // loadAll succeeds but the session was deleted between the card render and the click. Falling
    // through to runReview would create a non-retriable error card that replaces the stale card the
    // user was re-running; instead we bail with started:false so the existing card + Re-run survive.
    sessionLoadAll.mockReset()
    sessionLoadAll.mockResolvedValue({ sessions: [{ id: 'a-different-session' }] })
    registerReviewerIpcHandlers({ acpRuntime })

    const runHandler = handlers.get(REVIEWER_IPC.RUN)
    const result = await runHandler?.({}, createRequest())

    expect(result).toEqual({ started: false, reason: 'not-found' })
    expect(runReview).not.toHaveBeenCalled()
    expect(broadcastToRenderers).not.toHaveBeenCalled()
  })

  it('releases the in-flight lock on a not-found start so a retry after the session appears starts', async () => {
    // Models the persistence race: the first load misses the not-yet-flushed session (started:false),
    // the retry sees it. The retry starting proves the not-found bail released the dedup lock (a stuck
    // lock would drop the retry as "already in flight").
    sessionLoadAll.mockReset()
    sessionLoadAll
      .mockResolvedValueOnce({ sessions: [] })
      .mockResolvedValue({ sessions: [{ id: 'session-1' }] })
    registerReviewerIpcHandlers({ acpRuntime })

    const runHandler = handlers.get(REVIEWER_IPC.RUN)

    const first = await runHandler?.({}, createRequest())
    expect(first).toEqual({ started: false, reason: 'not-found' })
    expect(runReview).not.toHaveBeenCalled()

    const second = await runHandler?.({}, createRequest())
    expect(second).toEqual({ started: true })
    expect(runReview).toHaveBeenCalledTimes(1)
  })

  it('returns started:false when runReview fails before signalling onStarted', async () => {
    // e.g. scope resolution or the createReview insert throws before the running row is pushed.
    runReview.mockReset()
    runReview.mockRejectedValueOnce(new Error('createReview failed'))
    registerReviewerIpcHandlers({ acpRuntime })

    const runHandler = handlers.get(REVIEWER_IPC.RUN)
    const result = await runHandler?.({}, createRequest())

    // A genuine pre-push failure — not a persistence race, so not auto-retried.
    expect(result).toEqual({ started: false, reason: 'run-failed' })
  })

  it('returns started:true when a review begins', async () => {
    runReview.mockClear()
    registerReviewerIpcHandlers({ acpRuntime })

    const runHandler = handlers.get(REVIEWER_IPC.RUN)
    const result = await runHandler?.({}, createRequest())

    expect(result).toEqual({ started: true })
    await vi.waitFor(() => expect(runReview).toHaveBeenCalledTimes(1))
  })

  it('refuses an auto review for a turn that already has a review (atomic idempotency)', async () => {
    // The cross-renderer TOCTOU: even if the caller's local store looked empty, main is the single
    // serialization point — a review already exists for this turn, so an auto request is a duplicate.
    getReviewsForSession.mockResolvedValue([{ turnMessageId: 'message-1' }])
    registerReviewerIpcHandlers({ acpRuntime })

    const runHandler = handlers.get(REVIEWER_IPC.RUN)
    const result = await runHandler?.({}, { ...createRequest(), origin: 'auto' })

    expect(result).toEqual({ started: false, reason: 'already-reviewed' })
    expect(runReview).not.toHaveBeenCalled()
  })

  it('runs an auto review when no review exists yet for the turn', async () => {
    getReviewsForSession.mockResolvedValue([{ turnMessageId: 'a-different-turn' }])
    registerReviewerIpcHandlers({ acpRuntime })

    const runHandler = handlers.get(REVIEWER_IPC.RUN)
    const result = await runHandler?.({}, { ...createRequest(), origin: 'auto' })

    expect(result).toEqual({ started: true })
    await vi.waitFor(() => expect(runReview).toHaveBeenCalledTimes(1))
  })

  it('fails closed when the idempotency lookup throws: no run, lock released, retryable', async () => {
    // The lookup can't confirm the turn is un-reviewed — proceeding risks a duplicate, so refuse.
    getReviewsForSession.mockRejectedValueOnce(new Error('db read failed'))
    registerReviewerIpcHandlers({ acpRuntime })

    const runHandler = handlers.get(REVIEWER_IPC.RUN)
    const result = await runHandler?.({}, { ...createRequest(), origin: 'auto' })

    expect(result).toEqual({ started: false, reason: 'idempotency-check-failed' })
    expect(runReview).not.toHaveBeenCalled()

    // The lock must have been released: a follow-up auto request (lookup now recovered, no prior
    // review) is not dropped as already-in-flight — it proceeds and starts.
    const retry = await runHandler?.({}, { ...createRequest(), origin: 'auto' })
    expect(retry).toEqual({ started: true })
    await vi.waitFor(() => expect(runReview).toHaveBeenCalledTimes(1))
  })

  it('lets a manual re-run bypass idempotency even when the turn already has a review', async () => {
    // Manual stale/error Re-run must force a fresh review — it never consults the auto-idempotency check.
    getReviewsForSession.mockResolvedValue([{ turnMessageId: 'message-1' }])
    registerReviewerIpcHandlers({ acpRuntime })

    const runHandler = handlers.get(REVIEWER_IPC.RUN)
    const result = await runHandler?.({}, { ...createRequest(), origin: 'manual' })

    expect(result).toEqual({ started: true })
    expect(getReviewsForSession).not.toHaveBeenCalled()
    expect(runReview).toHaveBeenCalledTimes(1)
  })
})
