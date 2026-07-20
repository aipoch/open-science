import { describe, expect, it, vi } from 'vitest'

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

// The repository/DB/session collaborators are irrelevant to the root split; stub them out.
vi.mock('./repository', () => ({
  ReviewRepository: class {
    getReviewsForSession = vi.fn().mockResolvedValue([])
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

describe('reviewer IPC handlers', () => {
  it('runs reviews with artifacts rooted at the data root, not the config root', async () => {
    runReview.mockClear()
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
    runHandler?.({}, createRequest()) // same turn, still in flight → dropped

    await vi.waitFor(() => expect(runReview).toHaveBeenCalledTimes(1))
    resolveRun?.()
    await Promise.resolve()
    expect(runReview).toHaveBeenCalledTimes(1)

    runReview.mockReset()
    runReview.mockResolvedValue(undefined)
  })

  it('broadcasts an error review when the session load fails before runReview starts', async () => {
    runReview.mockClear()
    broadcastToRenderers.mockClear()
    // The pre-runReview session load throws (e.g. DB/FS unavailable) — no Review row is ever created.
    sessionLoadAll.mockRejectedValueOnce(new Error('session store unavailable'))
    registerReviewerIpcHandlers({ acpRuntime })

    const runHandler = handlers.get(REVIEWER_IPC.RUN)
    runHandler?.({}, { ...createRequest(), turnMessageId: 'message-1' })

    // An error review-update is broadcast so the renderer can unlatch (Re-run) and show the failure.
    await vi.waitFor(() => expect(broadcastToRenderers).toHaveBeenCalledTimes(1))
    const [channel, payload] = broadcastToRenderers.mock.calls[0] as [
      string,
      { review: { lifecycle: string; turnMessageId: string } }
    ]
    expect(channel).toBe(REVIEWER_IPC.UPDATED)
    expect(payload.review.lifecycle).toBe('error')
    expect(payload.review.turnMessageId).toBe('message-1')
    expect(runReview).not.toHaveBeenCalled()

    sessionLoadAll.mockResolvedValue({ sessions: [] })
  })
})
