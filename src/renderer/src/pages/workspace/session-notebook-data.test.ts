import { describe, expect, it, vi } from 'vitest'

import {
  invalidateSessionNotebookCache,
  loadSessionNotebookData,
  loadSessionNotebookRuns
} from './session-notebook-data'
import type { NotebookRunRecord } from '../../../../shared/notebook'

const request = { sessionId: 's1', projectId: 'default', workspaceCwd: '/w' }

const makeRun = (overrides: Partial<NotebookRunRecord> = {}): NotebookRunRecord => ({
  runId: 'r1',
  cellId: 'c1',
  source: 'agent',
  kernelKind: 'python',
  script: 'print(1)',
  status: 'completed',
  startedAt: 0,
  text: { stdout: '', stderr: '', traceback: '', plain: [] },
  outputs: [],
  artifacts: [],
  workingFiles: [],
  ...overrides
})

describe('loadSessionNotebookRuns', () => {
  it('returns [] and never reads state when no reference exists', async () => {
    const state = vi.fn()
    const runs = await loadSessionNotebookRuns(
      { getReference: vi.fn().mockResolvedValue(null), state },
      request
    )

    expect(runs).toEqual([])
    expect(state).not.toHaveBeenCalled()
  })

  it('returns persisted runs when a reference exists', async () => {
    const run = makeRun()
    const runs = await loadSessionNotebookRuns(
      {
        getReference: vi.fn().mockResolvedValue({ sessionId: 's1' }),
        state: vi.fn().mockResolvedValue({ runs: [run] })
      },
      request
    )

    expect(runs).toEqual([run])
  })

  it('returns the durable run total alongside the bounded renderer window', async () => {
    const run = makeRun()
    const state = vi.fn().mockResolvedValue({ runs: [run], runCount: 125 })

    await expect(
      loadSessionNotebookData(
        {
          getReference: vi.fn().mockResolvedValue({ sessionId: 's1' }),
          state
        },
        request
      )
    ).resolves.toEqual({ runs: [run], runCount: 125 })
    expect(state).toHaveBeenCalledWith(request)
  })

  it('deduplicates and caches the same cursor page until the Session is invalidated', async () => {
    const pagedRequest = { ...request, sessionId: 's-cache' }
    const cursor = { startedAt: 20, runId: 'r20' }
    const state = vi.fn().mockResolvedValue({
      runs: [makeRun({ runId: 'r19', startedAt: 19 })],
      runCount: 40,
      historyPage: {
        hasEarlierRuns: true,
        oldestCursor: { startedAt: 19, runId: 'r19' }
      }
    })
    const api = { getReference: vi.fn().mockResolvedValue({ sessionId: 's-cache' }), state }

    const [first, second] = await Promise.all([
      loadSessionNotebookData(api, pagedRequest, cursor),
      loadSessionNotebookData(api, pagedRequest, cursor)
    ])
    expect(first).toEqual(second)
    expect(state).toHaveBeenCalledTimes(1)
    expect(state).toHaveBeenCalledWith({ ...pagedRequest, historyBefore: cursor })

    await loadSessionNotebookData(api, pagedRequest, cursor)
    expect(state).toHaveBeenCalledTimes(1)

    invalidateSessionNotebookCache(pagedRequest)
    await loadSessionNotebookData(api, pagedRequest, cursor)
    expect(state).toHaveBeenCalledTimes(2)
  })

  it('invalidates by stable Session identity when the change event has a different path', async () => {
    const pagedRequest = { ...request, sessionId: 's-event' }
    const state = vi.fn().mockResolvedValue({ runs: [], runCount: 0 })
    const api = { getReference: vi.fn().mockResolvedValue({ sessionId: 's-event' }), state }

    await loadSessionNotebookData(api, pagedRequest)
    invalidateSessionNotebookCache({ ...pagedRequest, workspaceCwd: '/runtime/data-root' })
    await loadSessionNotebookData(api, pagedRequest)

    expect(state).toHaveBeenCalledTimes(2)
  })

  it('does not retain a response invalidated while its request is in flight', async () => {
    const pagedRequest = { ...request, sessionId: 's-race' }
    let resolveFirst!: (value: { runs: NotebookRunRecord[]; runCount: number }) => void
    const firstState = new Promise<{ runs: NotebookRunRecord[]; runCount: number }>((resolve) => {
      resolveFirst = resolve
    })
    const state = vi
      .fn()
      .mockReturnValueOnce(firstState)
      .mockResolvedValue({ runs: [makeRun({ runId: 'fresh' })], runCount: 1 })
    const api = { getReference: vi.fn().mockResolvedValue({ sessionId: 's-race' }), state }

    const staleLoad = loadSessionNotebookData(api, pagedRequest)
    await vi.waitFor(() => expect(state).toHaveBeenCalledTimes(1))
    invalidateSessionNotebookCache(pagedRequest)
    const freshLoad = loadSessionNotebookData(api, pagedRequest)
    resolveFirst({ runs: [], runCount: 0 })
    await Promise.all([staleLoad, freshLoad])
    await loadSessionNotebookData(api, pagedRequest)

    expect(state).toHaveBeenCalledTimes(2)
  })
})
