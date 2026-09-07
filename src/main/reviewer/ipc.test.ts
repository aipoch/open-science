import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ReviewRunRequest, ReviewRunResult } from '../../shared/reviewer'
import { REVIEWER_IPC } from '../../shared/reviewer'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type { AcpRuntime } from '../acp/runtime'
import { ReviewerProjectRuntimeOwner } from './project-runtime-owner'

// Distinct roots so a config-vs-data mix-up is unambiguous: artifacts must read from the data root.
const CONFIG_ROOT = join(tmpdir(), 'open-science-config-root')
const DATA_ROOT = join(tmpdir(), 'open-science-data-root')
const INJECTED_CONFIG_ROOT = join(tmpdir(), 'injected-config')
const INJECTED_DATA_ROOT = join(tmpdir(), 'injected-data')

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
  resolveConfigRoot: () => CONFIG_ROOT,
  resolveDataRoot: () => DATA_ROOT
}))

const runReview = vi.fn().mockResolvedValue(undefined)
vi.mock('./orchestrator', () => ({
  runReview: (options: unknown) => runReview(options)
}))

// Controllable review lookup so a test can make main's auto-idempotency check find an existing review.
// The thunk passed to ReviewRepository (`() => getProjectDbClient(storageRoot)`) closes over the
// resolved storageRoot. Capturing the thunk in the constructor lets the injected-config-root test
// invoke it directly and observe which storageRoot the thunk was constructed against.
const reviewRepositoryThunks: Array<() => unknown> = []
const getReviewsForSession = vi.fn().mockResolvedValue([])
const recoverInterruptedReviews = vi.fn().mockResolvedValue(0)
vi.mock('./repository', () => ({
  ReviewRepository: class {
    constructor(thunk: () => unknown) {
      reviewRepositoryThunks.push(thunk)
    }
    getReviewsForSession = getReviewsForSession
    recoverInterruptedReviews = recoverInterruptedReviews
    getReviewsForProjectSession = getReviewsForSession
  }
}))

// Spies on getProjectDbClient so the injected-config-root test can assert that
// registerReviewerIpcHandlers really passes options.storageRoot into the prisma-client getter that
// the ReviewRepository's lazy thunk captures. A regression that bypasses resolveConfigRoot()
// here would otherwise slip past unnoticed.
const getProjectDbClient = vi.fn()
vi.mock('../projects/prisma-client', () => ({
  getProjectDbClient: (...args: unknown[]) =>
    (getProjectDbClient as unknown as (...a: unknown[]) => unknown)(...args)
}))

// Shared, controllable session loader so a test can make the pre-runReview session load fail.
// Same capture pattern as ReviewRepository above.
const sessionRepositoryRoots: string[] = []
const sessionLoadAll = vi.fn().mockResolvedValue({ sessions: [] })
const sessionLoadOne = vi.fn().mockResolvedValue({ id: 'session-1' })
vi.mock('../session-persistence/repository', () => ({
  SessionRepository: class {
    constructor(root: string) {
      sessionRepositoryRoots.push(root)
    }
    loadAll = sessionLoadAll
    loadSession = sessionLoadOne
  },
  // storage-root imports these names from the same module in production; keep them defined.
  DEV_SESSION_DIR_NAME: 'dev',
  PROD_SESSION_DIR_NAME: 'prod',
  getSessionPersistenceDir: () => CONFIG_ROOT
}))

// Capture broadcasts so a test can assert the start-failure error review reaches the renderer.
const broadcastToRenderers = vi.fn()
vi.mock('../renderer-broadcast', () => ({ broadcastToRenderers }))

// Treat stale-review detection as a no-op identity function so GET_FOR_SESSION tests stay focused
// on the IPC wiring (no scope resolution / file IO). Tests that exercise staleness use a real
// repository-driven setup, not this stubbed path. The mock forwards ALL args so the spy records the
// full call (reviews, session, dataRoot) the way the production function receives it.
const flagStaleReviews = vi.fn(async (reviews: unknown) => reviews)
vi.mock('./stale-reviews', () => ({
  flagStaleReviews: (...args: unknown[]) =>
    (flagStaleReviews as unknown as (...a: unknown[]) => unknown)(...args)
}))

const { createReviewerCommandOwner, registerReviewerIpcHandlers } = await import('./ipc')
const { beginMigration, clearMigrationPending } = await import('../storage/migration-state')

const acpRuntime = {} as AcpRuntime
const managedFileVersions = { openVersion: vi.fn() }

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
  flagStaleReviews.mockReset()
  flagStaleReviews.mockImplementation(async (reviews: unknown) => reviews)
  sessionLoadAll.mockReset()
  sessionLoadAll.mockResolvedValue({ sessions: [{ id: 'session-1' }] })
  sessionLoadOne.mockReset()
  // Default: the requested session exists, so triggerReview proceeds to runReview.
  sessionLoadOne.mockResolvedValue({ id: 'session-1' })
  getReviewsForSession.mockReset()
  recoverInterruptedReviews.mockReset()
  recoverInterruptedReviews.mockResolvedValue(0)
  // Default: no prior review for the turn, so the auto-idempotency check lets the run proceed.
  getReviewsForSession.mockResolvedValue([])
})

afterEach(() => clearMigrationPending())

describe('reviewer IPC handlers', () => {
  it('waits for startup recovery before exposing persisted reviews', async () => {
    let finishRecovery!: (count: number) => void
    recoverInterruptedReviews.mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          finishRecovery = resolve
        })
    )
    const owner = createReviewerCommandOwner({ acpRuntime })
    const pendingRead = owner.getForSession({ projectId: 'project-1', appSessionId: 'session-1' })

    await Promise.resolve()
    expect(getReviewsForSession).not.toHaveBeenCalled()
    finishRecovery(1)
    await expect(pendingRead).resolves.toEqual([])
    expect(recoverInterruptedReviews).toHaveBeenCalledTimes(1)
  })

  it('retries startup recovery after a failed attempt', async () => {
    recoverInterruptedReviews
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce(0)
    const owner = createReviewerCommandOwner({ acpRuntime })

    await expect(
      owner.getForSession({ projectId: 'project-1', appSessionId: 'session-1' })
    ).rejects.toThrow('database unavailable')
    expect(getReviewsForSession).not.toHaveBeenCalled()
    await expect(
      owner.getForSession({ projectId: 'project-1', appSessionId: 'session-1' })
    ).resolves.toEqual([])

    expect(recoverInterruptedReviews).toHaveBeenCalledTimes(2)
  })

  it('shares the in-flight start outcome between direct and IPC commands', async () => {
    let finishRun: (() => void) | undefined
    let backgroundRun: Promise<void> | undefined
    runReview.mockImplementation((options?: { onStarted?: () => void }) => {
      backgroundRun = new Promise<void>((resolve) => {
        options?.onStarted?.()
        finishRun = resolve
      })
      return backgroundRun
    })
    const options = { acpRuntime }
    const owner = createReviewerCommandOwner(options)
    registerReviewerIpcHandlers(options, owner)

    await expect(owner.run(createRequest())).resolves.toEqual({ started: true })
    await expect(handlers.get(REVIEWER_IPC.RUN)?.({}, createRequest())).resolves.toEqual({
      started: true
    })
    expect(runReview).toHaveBeenCalledTimes(1)

    finishRun?.()
    await backgroundRun
  })

  it('fences new Project reviews and drains an admitted background run during deletion', async () => {
    let finishRun!: () => void
    let reviewSignal: AbortSignal | undefined
    runReview.mockImplementation(
      (options?: { onStarted?: () => void; fixLoopAbortSignal?: AbortSignal }) => {
        reviewSignal = options?.fixLoopAbortSignal
        options?.onStarted?.()
        return new Promise<void>((resolve) => {
          finishRun = resolve
        })
      }
    )
    const projectRuntime = new ReviewerProjectRuntimeOwner()
    const owner = createReviewerCommandOwner({ acpRuntime, projectRuntime })

    await expect(owner.run(createRequest())).resolves.toEqual({ started: true })

    let quiesced = false
    const quiescing = projectRuntime.quiesceProject('project-1').then(() => {
      quiesced = true
    })
    await vi.waitFor(() => expect(reviewSignal?.aborted).toBe(true))

    expect(quiesced).toBe(false)
    await expect(
      owner.run({ ...createRequest(), turnMessageId: 'message-after-fence' })
    ).rejects.toThrow('Project is being deleted.')
    expect(runReview).toHaveBeenCalledOnce()

    finishRun()
    await quiescing
    expect(quiesced).toBe(true)
  })

  it('checks Project archive availability before admitting a Review', async () => {
    const projectRuntime = new ReviewerProjectRuntimeOwner()
    const admit = vi.spyOn(projectRuntime, 'admit')
    const withProjectAvailable = vi.fn(async () => {
      throw new Error('Restore this archived Project before continuing.')
    })
    const options = { acpRuntime, projectRuntime, withProjectAvailable }
    const owner = createReviewerCommandOwner(options)

    await expect(owner.run(createRequest())).rejects.toThrow('archived Project')

    expect(withProjectAvailable).toHaveBeenCalledWith('project-1', expect.any(Function))
    expect(admit).not.toHaveBeenCalled()
    expect(runReview).not.toHaveBeenCalled()
  })

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

  it('uses the Main-process Reviewer model admission instead of the renderer model label', async () => {
    const fixedReviewerRuntime = {} as AcpRuntime
    const release = vi.fn(async () => undefined)
    const modelRuntime = {
      admit: vi.fn(async () => ({
        model: 'reviewer-model',
        reviewerAcpRuntime: fixedReviewerRuntime,
        release
      }))
    }
    const owner = createReviewerCommandOwner({ acpRuntime, modelRuntime })

    await expect(owner.run({ ...createRequest(), model: 'renderer-model' })).resolves.toEqual({
      started: true
    })
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce())

    const passed = runReview.mock.calls[0][0] as {
      acpRuntime: AcpRuntime
      reviewerAcpRuntime?: AcpRuntime
      model: string
    }
    expect(passed.acpRuntime).toBe(acpRuntime)
    expect(passed.reviewerAcpRuntime).toBe(fixedReviewerRuntime)
    expect(passed.model).toBe('reviewer-model')
  })

  it('resolves and forwards the persisted Session target to background reviews', async () => {
    const agentConfiguration = {
      providerId: 'provider-1',
      model: 'model-1',
      reasoningEffort: 'high' as const
    }
    const agentTarget = { frameworkId: 'opencode' as const, ...agentConfiguration }
    const resolveSessionAgentTarget = vi.fn(async () => agentTarget)
    const persistedSession = { id: 'session-1', agentConfiguration }
    sessionLoadOne.mockResolvedValue(persistedSession)
    const owner = createReviewerCommandOwner({
      acpRuntime,
      resolveSessionAgentTarget
    })

    await expect(owner.run(createRequest())).resolves.toEqual({ started: true })
    await vi.waitFor(() => expect(runReview).toHaveBeenCalledOnce())

    expect(resolveSessionAgentTarget).toHaveBeenCalledWith(persistedSession)
    expect(runReview.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        agentTarget
      })
    )
  })

  it('materializes and persists legacy Session identity before background reviews', async () => {
    const legacySession: PersistedChatSession = {
      id: 'session-1',
      projectId: 'project-1',
      title: 'Legacy review',
      cwd: '/workspace/review',
      status: 'idle',
      agentFrameworkId: 'opencode',
      agentBackendId: 'opencode:provider-legacy',
      agentModel: 'model-legacy',
      messages: [],
      createdAt: 1,
      updatedAt: 1
    }
    const agentConfiguration = {
      providerId: 'provider-legacy',
      model: 'model-legacy',
      reasoningEffort: 'high' as const
    }
    const agentTarget = { frameworkId: 'opencode' as const, ...agentConfiguration }
    const resolveSessionAgentTarget = vi.fn(async () => agentTarget)
    const saveSessionAgentConfiguration = vi.fn(async () => ({
      ...legacySession,
      agentConfiguration
    }))
    sessionLoadOne.mockResolvedValue(legacySession)
    const owner = createReviewerCommandOwner({
      acpRuntime,
      resolveSessionAgentTarget,
      saveSessionAgentConfiguration
    })

    await expect(owner.run(createRequest())).resolves.toEqual({ started: true })
    await vi.waitFor(() => expect(runReview).toHaveBeenCalledOnce())

    expect(resolveSessionAgentTarget).toHaveBeenCalledWith(legacySession)
    expect(saveSessionAgentConfiguration).toHaveBeenCalledWith(legacySession, agentConfiguration)
    expect(runReview.mock.calls[0][0]).toEqual(expect.objectContaining({ agentTarget }))
  })

  it('lets injected options override the config/data split independently', async () => {
    runReview.mockClear()
    // Reset the captured-roots recorders so this test only observes its own wiring.
    reviewRepositoryThunks.length = 0
    sessionRepositoryRoots.length = 0
    getProjectDbClient.mockReset()
    registerReviewerIpcHandlers({
      acpRuntime,
      storageRoot: INJECTED_CONFIG_ROOT,
      dataRoot: INJECTED_DATA_ROOT
    })

    const runHandler = handlers.get(REVIEWER_IPC.RUN)
    runHandler?.({}, createRequest())

    await vi.waitFor(() => expect(runReview).toHaveBeenCalledTimes(1))

    const passed = runReview.mock.calls[0][0] as { artifactStorageRoot: string }
    expect(passed.artifactStorageRoot).toBe(INJECTED_DATA_ROOT)
    // ReviewRepository is constructed against the injected config root, not the resolveConfigRoot()
    // default. The repository captures a thunk `() => getProjectDbClient(storageRoot)`; invoke it
    // and assert the captured storageRoot surfaces through the getProjectDbClient spy.
    expect(reviewRepositoryThunks).toHaveLength(1)
    reviewRepositoryThunks[0]?.()
    expect(getProjectDbClient).toHaveBeenCalledWith(INJECTED_CONFIG_ROOT)
    expect(getProjectDbClient).not.toHaveBeenCalledWith(CONFIG_ROOT)
    // SessionRepository takes a plain root string, captured by the mock constructor.
    expect(sessionRepositoryRoots).toEqual([INJECTED_CONFIG_ROOT])
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

  it('passes a live session loader to the orchestrator instead of a review-start snapshot', async () => {
    sessionLoadOne
      .mockResolvedValueOnce({ id: 'session-1', messages: [{ id: 'original-turn' }] })
      .mockResolvedValueOnce({ id: 'session-1', messages: [{ id: 'correction-turn' }] })
    registerReviewerIpcHandlers({ acpRuntime })

    const runHandler = handlers.get(REVIEWER_IPC.RUN)
    await runHandler?.({}, createRequest())
    await vi.waitFor(() => expect(runReview).toHaveBeenCalledTimes(1))

    const passed = runReview.mock.calls[0][0] as {
      getSession: () => Promise<{ messages: Array<{ id: string }> } | undefined>
    }
    const refreshed = await passed.getSession()

    expect(refreshed?.messages[0]?.id).toBe('correction-turn')
    expect(sessionLoadOne).toHaveBeenCalledTimes(2)
    expect(sessionLoadOne).toHaveBeenNthCalledWith(1, 'project-1', 'session-1')
    expect(sessionLoadOne).toHaveBeenNthCalledWith(2, 'project-1', 'session-1')
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
    const first = runHandler?.({}, createRequest()) as unknown as Promise<ReviewRunResult>
    let duplicateSettled = false
    const duplicate = (
      runHandler?.({}, createRequest()) as unknown as Promise<ReviewRunResult>
    ).then((result) => {
      duplicateSettled = true
      return result
    })

    // The duplicate joins the authoritative start verdict instead of releasing its renderer gate
    // before a running Review row exists (or before the original start attempt fails).
    await Promise.resolve()
    expect(duplicateSettled).toBe(false)

    await vi.waitFor(() => expect(runReview).toHaveBeenCalledTimes(1))
    resolveRun?.()
    await expect(first).resolves.toEqual({ started: false, reason: 'run-failed' })
    await expect(duplicate).resolves.toEqual({ started: false, reason: 'run-failed' })
    expect(runReview).toHaveBeenCalledTimes(1)
  })

  it('returns started:false without a review row or broadcast when the session load fails', async () => {
    // The pre-runReview session load throws (e.g. DB/FS unavailable).
    sessionLoadOne.mockRejectedValueOnce(new Error('session store unavailable'))
    registerReviewerIpcHandlers({ acpRuntime })

    const runHandler = handlers.get(REVIEWER_IPC.RUN)
    const result = await runHandler?.({}, { ...createRequest(), turnMessageId: 'message-1' })

    // No fabricated error review, no broadcast — started:false with a retryable reason.
    expect(result).toEqual({ started: false, reason: 'load-failed' })
    expect(runReview).not.toHaveBeenCalled()
    expect(broadcastToRenderers).not.toHaveBeenCalled()
  })

  it('returns started:false without calling runReview when the session id is gone', async () => {
    // The direct session load succeeds but the session was deleted between card render and click. Falling
    // through to runReview would create a non-retriable error card that replaces the stale card the
    // user was re-running; instead we bail with started:false so the existing card + Re-run survive.
    sessionLoadOne.mockResolvedValueOnce(undefined)
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
    sessionLoadOne.mockReset()
    sessionLoadOne.mockResolvedValueOnce(undefined).mockResolvedValue({ id: 'session-1' })
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

  it('does not start a Review sidecar writer while data-root migration is pending', async () => {
    registerReviewerIpcHandlers({ acpRuntime })
    beginMigration()

    const result = await handlers.get(REVIEWER_IPC.RUN)?.({}, createRequest())

    expect(result).toEqual({ started: false, reason: 'run-failed' })
    expect(runReview).not.toHaveBeenCalled()
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

  it('publishes the running and completed lifecycle for a manual re-review', async () => {
    const runningReview = {
      id: 'manual-review',
      turnMessageId: 'message-1',
      lifecycle: 'running'
    }
    const completedReview = {
      ...runningReview,
      lifecycle: 'complete',
      outcome: 'pass'
    }
    runReview.mockImplementationOnce(
      (opts?: { onStarted?: () => void; onReviewUpdate?: (review: unknown) => void }) => {
        opts?.onStarted?.()
        opts?.onReviewUpdate?.(runningReview)
        opts?.onReviewUpdate?.(completedReview)
        return Promise.resolve(completedReview)
      }
    )
    getReviewsForSession.mockResolvedValue([{ turnMessageId: 'message-1' }])
    registerReviewerIpcHandlers({ acpRuntime })

    const runHandler = handlers.get(REVIEWER_IPC.RUN)
    const result = await runHandler?.({}, { ...createRequest(), origin: 'manual' })

    expect(result).toEqual({ started: true })
    expect(getReviewsForSession).not.toHaveBeenCalled()
    expect(broadcastToRenderers.mock.calls).toEqual(
      expect.arrayContaining([
        [REVIEWER_IPC.UPDATED, { review: runningReview }],
        [REVIEWER_IPC.UPDATED, { review: completedReview }]
      ])
    )
  })

  describe('reviewer:get-for-session handler', () => {
    it('loads persisted reviews and runs them through the stale-review detector', async () => {
      const reviews = [
        { id: 'review-1', turnMessageId: 'message-1' },
        { id: 'review-2', turnMessageId: 'message-1' }
      ]
      const flagged = [
        { ...reviews[0], stale: false },
        { ...reviews[1], stale: true }
      ]
      getReviewsForSession.mockResolvedValue(reviews)
      // The default sessionLoadAll mock returns [{ id: 'session-1' }], which matches the request.
      flagStaleReviews.mockResolvedValue(flagged as never)
      registerReviewerIpcHandlers({ acpRuntime, managedFileVersions })

      const getHandler = handlers.get(REVIEWER_IPC.GET_FOR_SESSION)
      expect(getHandler).toBeDefined()

      const result = await getHandler?.(
        {},
        {
          projectId: 'project-1',
          appSessionId: 'session-1'
        }
      )

      expect(getReviewsForSession).toHaveBeenCalledWith('project-1', 'session-1')
      expect(flagStaleReviews).toHaveBeenCalledWith(
        reviews,
        expect.objectContaining({ id: 'session-1' }),
        DATA_ROOT,
        expect.any(Function)
      )
      expect(result).toEqual(flagged)
    })

    it('returns unflagged reviews when the session is not in the loaded list', async () => {
      const reviews = [{ id: 'review-1', turnMessageId: 'message-1' }]
      getReviewsForSession.mockResolvedValue(reviews)
      // sessionLoadAll returns [{ id: 'session-1' }] by default; look up a different session id.
      registerReviewerIpcHandlers({ acpRuntime, managedFileVersions })

      const getHandler = handlers.get(REVIEWER_IPC.GET_FOR_SESSION)
      sessionLoadOne.mockResolvedValueOnce(undefined)
      const result = await getHandler?.(
        {},
        {
          projectId: 'project-1',
          appSessionId: 'missing-session'
        }
      )

      expect(sessionLoadOne).toHaveBeenCalledWith('project-1', 'missing-session')
      // flagStaleReviews is fail-open: a missing session means staleness was not computed, so the
      // reviews pass through without modification.
      expect(flagStaleReviews).toHaveBeenCalledWith(
        reviews,
        undefined,
        DATA_ROOT,
        expect.any(Function)
      )
      expect(result).toBe(reviews)
    })

    it('returns reviews unflagged when the session load throws', async () => {
      const reviews = [{ id: 'review-1', turnMessageId: 'message-1' }]
      getReviewsForSession.mockResolvedValue(reviews)
      sessionLoadOne.mockRejectedValueOnce(new Error('session store unavailable'))
      registerReviewerIpcHandlers({ acpRuntime })

      const getHandler = handlers.get(REVIEWER_IPC.GET_FOR_SESSION)
      const result = await getHandler?.(
        {},
        {
          projectId: 'project-1',
          appSessionId: 'session-1'
        }
      )

      expect(result).toBe(reviews)
      // Fail-open: a load failure must not hide stale findings by leaving the detector un-runnable.
      expect(flagStaleReviews).not.toHaveBeenCalled()
    })
  })

  describe('reviewer:abort-fix-loop handler', () => {
    it('is registered and a no-op (with a warn log) when no fix loop is active for the session', () => {
      registerReviewerIpcHandlers({ acpRuntime })

      const abortHandler = handlers.get(REVIEWER_IPC.ABORT_FIX_LOOP)
      expect(abortHandler).toBeDefined()

      // No throw + no return value — the renderer awaits only to confirm Electron processed it.
      expect(
        abortHandler?.({}, { projectId: 'project-1', appSessionId: 'session-without-loop' })
      ).toBeUndefined()
    })

    it('aborts the active fix loop controller when one is registered by the orchestrator', async () => {
      // Capture the runReview options so we can drive the orchestrator callbacks ourselves.
      let captured: {
        onStarted?: () => void
        onFixLoopStart?: () => void
        onFixLoopEnd?: () => void
        fixLoopAbortSignal?: AbortSignal
      } = {}
      runReview.mockReset()
      runReview.mockImplementation((opts?: typeof captured) => {
        captured = opts ?? {}
        opts?.onStarted?.()
        return Promise.resolve(undefined)
      })

      registerReviewerIpcHandlers({ acpRuntime })

      // Trigger a review so the orchestrator options are captured.
      const runHandler = handlers.get(REVIEWER_IPC.RUN)
      const promise = runHandler?.({}, createRequest())
      await vi.waitFor(() => expect(runReview).toHaveBeenCalledTimes(1))

      // The orchestrator would call onFixLoopStart when the loop actually starts; we simulate it.
      captured.onFixLoopStart?.()
      expect(captured.fixLoopAbortSignal).toBeDefined()
      // The signal is the one the IPC layer handed to runReview — the handler's abort call must
      // reach it through fixLoopAbortControllers look-up keyed by effectiveMainSessionId.
      const abortEvent = vi.fn()
      captured.fixLoopAbortSignal?.addEventListener('abort', abortEvent)

      const abortHandler = handlers.get(REVIEWER_IPC.ABORT_FIX_LOOP)
      const abortRequest = { projectId: 'project-1', appSessionId: 'session-1' }
      expect(abortHandler?.({}, abortRequest)).toBeUndefined()
      expect(abortEvent).toHaveBeenCalledTimes(1)

      // The fix-loop-end callback deregisters the controller so a second abort is a no-op
      // (matches the warn-log path above).
      captured.onFixLoopEnd?.()
      const second = abortHandler?.({}, abortRequest)
      expect(abortEvent).toHaveBeenCalledTimes(1)
      expect(second).toBeUndefined()

      // Settle the original review promise so the mock's pending state is released.
      await expect(promise).resolves.toEqual({ started: true })
    })

    it('serializes fix loops that target the same Main session', async () => {
      type CapturedRun = {
        onStarted?: () => void
        onFixLoopStart?: () => void | Promise<void>
        onFixLoopEnd?: () => void
        fixLoopAbortSignal?: AbortSignal
      }
      const captured: CapturedRun[] = []
      const finishRuns: Array<() => void> = []
      runReview.mockImplementation((options?: CapturedRun) => {
        if (options) captured.push(options)
        options?.onStarted?.()
        return new Promise<void>((resolve) => finishRuns.push(resolve))
      })
      const owner = createReviewerCommandOwner({ acpRuntime })

      await owner.run({
        ...createRequest(),
        sessionId: 'reviewer-a',
        turnMessageId: 'turn-a',
        mainSessionId: 'main-session'
      })
      await owner.run({
        ...createRequest(),
        sessionId: 'reviewer-b',
        turnMessageId: 'turn-b',
        mainSessionId: 'main-session'
      })
      expect(captured).toHaveLength(2)

      await captured[0].onFixLoopStart?.()
      const secondStart = Promise.resolve(captured[1].onFixLoopStart?.())
      await Promise.resolve()
      expect(
        broadcastToRenderers.mock.calls.filter(
          ([channel]) => channel === REVIEWER_IPC.FIX_LOOP_START
        )
      ).toHaveLength(1)

      captured[0].onFixLoopEnd?.()
      await secondStart
      expect(
        broadcastToRenderers.mock.calls.filter(
          ([channel]) => channel === REVIEWER_IPC.FIX_LOOP_START
        )
      ).toHaveLength(2)

      owner.abortFixLoop({ projectId: 'project-1', appSessionId: 'main-session' })
      expect(captured[1].fixLoopAbortSignal?.aborted).toBe(true)
      captured[1].onFixLoopEnd?.()
      for (const finish of finishRuns) finish()
    })

    it('aborts queued fix loops before they can start after the active loop ends', async () => {
      type CapturedRun = {
        onStarted?: () => void
        onFixLoopStart?: () => void | Promise<void>
        onFixLoopEnd?: () => void
        fixLoopAbortSignal?: AbortSignal
      }
      const captured: CapturedRun[] = []
      const finishRuns: Array<() => void> = []
      runReview.mockImplementation((options?: CapturedRun) => {
        if (options) captured.push(options)
        options?.onStarted?.()
        return new Promise<void>((resolve) => finishRuns.push(resolve))
      })
      const owner = createReviewerCommandOwner({ acpRuntime })

      await owner.run({
        ...createRequest(),
        sessionId: 'reviewer-a',
        turnMessageId: 'turn-a',
        mainSessionId: 'main-session'
      })
      await owner.run({
        ...createRequest(),
        sessionId: 'reviewer-b',
        turnMessageId: 'turn-b',
        mainSessionId: 'main-session'
      })
      await captured[0].onFixLoopStart?.()
      const secondStart = Promise.resolve(captured[1].onFixLoopStart?.())
      await Promise.resolve()

      owner.abortFixLoop({ projectId: 'project-1', appSessionId: 'main-session' })
      expect(captured[0].fixLoopAbortSignal?.aborted).toBe(true)
      expect(captured[1].fixLoopAbortSignal?.aborted).toBe(true)

      captured[0].onFixLoopEnd?.()
      await secondStart
      captured[1].onFixLoopEnd?.()
      expect(
        broadcastToRenderers.mock.calls.filter(
          ([channel]) => channel === REVIEWER_IPC.FIX_LOOP_START
        )
      ).toHaveLength(1)
      expect(
        broadcastToRenderers.mock.calls.filter(([channel]) => channel === REVIEWER_IPC.FIX_LOOP_END)
      ).toHaveLength(1)

      for (const finish of finishRuns) finish()
    })
  })

  describe('Task review-chain cancellation', () => {
    it('aborts an active initial review without exposing a new Electron handler', async () => {
      let finishRun: (() => void) | undefined
      let reviewSignal: AbortSignal | undefined
      runReview.mockImplementation(
        (options?: { onStarted?: () => void; fixLoopAbortSignal?: AbortSignal }) => {
          reviewSignal = options?.fixLoopAbortSignal
          options?.onStarted?.()
          return new Promise<void>((resolve) => {
            finishRun = resolve
          })
        }
      )
      const owner = createReviewerCommandOwner({ acpRuntime })

      await expect(owner.run(createRequest())).resolves.toEqual({ started: true })
      expect(reviewSignal?.aborted).toBe(false)

      owner.abort({ projectId: 'project-1', appSessionId: 'session-1' })
      expect(reviewSignal?.aborted).toBe(true)
      expect(handlers.has('reviewer:abort')).toBe(false)

      finishRun?.()
      await vi.waitFor(() => expect(runReview).toHaveBeenCalledOnce())
    })
  })

  describe('orchestrator callback wiring', () => {
    type OrchestratorCallbacks = {
      onStarted?: () => void
      onReviewUpdate?: (review: unknown) => void
      onCorrectionPrompt?: () => void
      onCorrectionFailed?: () => void
      onFixLoopStart?: () => void
      onFixLoopEnd?: () => void
    }

    const captureCallbacks = (): { captured: OrchestratorCallbacks; promise: Promise<unknown> } => {
      const captured: OrchestratorCallbacks = {}
      runReview.mockReset()
      runReview.mockImplementation((opts?: OrchestratorCallbacks) => {
        Object.assign(captured, opts)
        opts?.onStarted?.()
        return Promise.resolve(undefined)
      })
      registerReviewerIpcHandlers({ acpRuntime })
      const runHandler = handlers.get(REVIEWER_IPC.RUN)
      // Fire-and-forget the triggerReview call so vi.waitFor can flush the microtask queue. The
      // synchronous call path resolves either with started:true (no in-flight lock) or one of the
      // started:false reasons; we cast the handler's `unknown` return into a typed Promise so the
      // test sites can await it cleanly.
      const promise = runHandler?.({}, createRequest()) as unknown as Promise<unknown>
      return { captured, promise }
    }

    it('broadcasts REVIEWER_IPC.UPDATED when the orchestrator reports a review update', async () => {
      const { captured, promise } = captureCallbacks()

      await vi.waitFor(() => expect(runReview).toHaveBeenCalledTimes(1))

      const review = { id: 'review-1', turnMessageId: 'message-1' }
      captured.onReviewUpdate?.(review)

      expect(broadcastToRenderers).toHaveBeenCalledWith(REVIEWER_IPC.UPDATED, { review })
      await expect(promise).resolves.toEqual({ started: true })
    })

    it('broadcasts SUPPRESS_NEXT_AUTO_REVIEW for the main session when the correction prompt fires', async () => {
      const { captured, promise } = captureCallbacks()

      // The orchestrator only carries mainSessionId when the renderer supplied one; this is the
      // real path used by the auto-review follow-up after a flagged review.
      const runHandler = handlers.get(REVIEWER_IPC.RUN)
      const second = runHandler?.(
        {},
        {
          sessionId: 'reviewer-session-1',
          turnMessageId: 'message-1',
          projectId: 'project-1',
          mainSessionId: 'main-session-1'
        }
      )
      await vi.waitFor(() => expect(runReview).toHaveBeenCalledTimes(2))

      // The second invocation's callbacks are the ones the triggerReview returned; invoke them.
      // (triggerReview is fire-and-forget; we read off the most recent runReview call's options.)
      const latest = runReview.mock.calls[1]?.[0] as OrchestratorCallbacks
      latest.onCorrectionPrompt?.()

      expect(broadcastToRenderers).toHaveBeenCalledWith(REVIEWER_IPC.SUPPRESS_NEXT_AUTO_REVIEW, {
        projectId: 'project-1',
        appSessionId: 'main-session-1',
        clear: false
      })
      expect(captured.onCorrectionPrompt).toBeDefined() // run-1 captured too, but unused here
      await expect(second).resolves.toEqual({ started: true })
      await expect(promise).resolves.toEqual({ started: true })
    })

    it('clears the auto-review suppression (clear:true) when the correction turn fails to send', async () => {
      const { promise } = captureCallbacks()

      const runHandler = handlers.get(REVIEWER_IPC.RUN)
      await runHandler?.(
        {},
        {
          sessionId: 'reviewer-session-1',
          turnMessageId: 'message-1',
          projectId: 'project-1',
          mainSessionId: 'main-session-1'
        }
      )
      await vi.waitFor(() => expect(runReview).toHaveBeenCalledTimes(2))

      const latest = runReview.mock.calls[1]?.[0] as OrchestratorCallbacks
      latest.onCorrectionFailed?.()

      expect(broadcastToRenderers).toHaveBeenCalledWith(REVIEWER_IPC.SUPPRESS_NEXT_AUTO_REVIEW, {
        projectId: 'project-1',
        appSessionId: 'main-session-1',
        clear: true
      })
      await expect(promise).resolves.toEqual({ started: true })
    })

    it('falls back to the reviewer sessionId for fix-loop broadcasts when no mainSessionId is provided', async () => {
      // Triggers line 225: `const effectiveMainSessionId = mainSessionId ?? sessionId`. No mainSessionId
      // means the fix-loop start/end broadcasts (and the abort lookup) must use sessionId directly.
      const { captured, promise } = captureCallbacks()

      await vi.waitFor(() => expect(runReview).toHaveBeenCalledTimes(1))

      captured.onFixLoopStart?.()
      expect(broadcastToRenderers).toHaveBeenCalledWith(REVIEWER_IPC.FIX_LOOP_START, {
        projectId: 'project-1',
        appSessionId: 'session-1'
      })

      captured.onFixLoopEnd?.()
      expect(broadcastToRenderers).toHaveBeenCalledWith(REVIEWER_IPC.FIX_LOOP_END, {
        projectId: 'project-1',
        appSessionId: 'session-1'
      })

      await expect(promise).resolves.toEqual({ started: true })
    })

    it('broadcasts FIX_LOOP_START/END keyed by mainSessionId when one is supplied', async () => {
      // Same as above but with mainSessionId, confirming the wiring picks the supplied value over the
      // reviewer sessionId when deciding where the renderer should lock the composer send button.
      const { promise } = captureCallbacks()
      const runHandler = handlers.get(REVIEWER_IPC.RUN)
      await runHandler?.(
        {},
        {
          sessionId: 'reviewer-session-1',
          turnMessageId: 'message-1',
          projectId: 'project-1',
          mainSessionId: 'main-session-9'
        }
      )
      await vi.waitFor(() => expect(runReview).toHaveBeenCalledTimes(2))

      const latest = runReview.mock.calls[1]?.[0] as OrchestratorCallbacks
      latest.onFixLoopStart?.()
      latest.onFixLoopEnd?.()

      expect(broadcastToRenderers).toHaveBeenCalledWith(REVIEWER_IPC.FIX_LOOP_START, {
        projectId: 'project-1',
        appSessionId: 'main-session-9'
      })
      expect(broadcastToRenderers).toHaveBeenCalledWith(REVIEWER_IPC.FIX_LOOP_END, {
        projectId: 'project-1',
        appSessionId: 'main-session-9'
      })
      await expect(promise).resolves.toEqual({ started: true })
    })

    it('skips correction broadcasts when no mainSessionId is supplied', () => {
      // The IPC layer only suppresses the next auto-review for the MAIN session; a reviewer that
      // was spawned without a mainSessionId (e.g. an ad-hoc CLI) has no parent to suppress for.
      const { captured } = captureCallbacks()

      // captureCallbacks already kicked off a run; wait a microtask for runReview to be invoked.
      // (vi.advanceTimersByTime is not used here — we wait the actual microtask flush.)
      return Promise.resolve().then(() => {
        captured.onCorrectionPrompt?.()
        captured.onCorrectionFailed?.()

        const suppressCalls = broadcastToRenderers.mock.calls.filter(
          ([channel]) => channel === REVIEWER_IPC.SUPPRESS_NEXT_AUTO_REVIEW
        )
        expect(suppressCalls).toEqual([])
      })
    })
  })

  describe('triggerReview session loading', () => {
    it('falls back to loadAll when the request omits projectId', async () => {
      // Lines 174-176: no projectId means the per-project loadSession path is unavailable, so the
      // loader scans every session file. Make sure that branch is exercised and the right loader wins.
      const loadAllSpy = vi.fn().mockResolvedValue({ sessions: [{ id: 'session-1' }] })
      sessionLoadAll.mockImplementation(loadAllSpy)
      sessionLoadOne.mockClear()

      runReview.mockClear()
      registerReviewerIpcHandlers({ acpRuntime })

      const runHandler = handlers.get(REVIEWER_IPC.RUN)
      const result = await runHandler?.({}, { sessionId: 'session-1', turnMessageId: 'message-1' })

      expect(result).toEqual({ started: true })
      // No projectId → the per-project loadSession path must NOT be called.
      expect(sessionLoadOne).not.toHaveBeenCalled()
      expect(loadAllSpy).toHaveBeenCalled()
      await vi.waitFor(() => expect(runReview).toHaveBeenCalledTimes(1))
    })
  })
})
