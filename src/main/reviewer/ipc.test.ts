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

vi.mock('../session-persistence/repository', () => ({
  SessionRepository: class {
    loadAll = vi.fn().mockResolvedValue({ sessions: [] })
  },
  // storage-root imports these names from the same module in production; keep them defined.
  DEV_SESSION_DIR_NAME: 'dev',
  PROD_SESSION_DIR_NAME: 'prod',
  getSessionPersistenceDir: () => CONFIG_ROOT
}))

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
})
