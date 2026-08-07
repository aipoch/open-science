// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  NotebookChangedEvent,
  NotebookRunRecord,
  NotebookSessionReference,
  NotebookSessionState
} from '../../../../shared/notebook'
import { useNotebookRunsById } from './use-notebook-runs-by-id'

const reference: NotebookSessionReference = {
  sessionId: 'session-1',
  projectName: 'project-1',
  workspaceCwd: '/workspace',
  notebookSessionRoot: '/workspace/.notebook',
  dataRoot: '/workspace/data',
  runtimeRoot: '/workspace/runtime',
  runJsonPath: '/workspace/run.json'
}

const makeRun = (runId: string, payload: string): NotebookRunRecord => ({
  runId,
  cellId: `cell-${runId}`,
  source: 'agent',
  kernelKind: 'r',
  script: 'plot(1:3)',
  status: 'completed',
  startedAt: 1,
  text: { stdout: '', stderr: '', traceback: '', plain: [] },
  outputs: [{ type: 'display', data: { 'image/png': payload } }],
  artifacts: [],
  workingFiles: []
})

const makeState = (runs: NotebookRunRecord[]): NotebookSessionState => ({
  id: 'notebook-1',
  sessionId: reference.sessionId,
  cwd: reference.workspaceCwd,
  notebookSessionRoot: reference.notebookSessionRoot,
  dataRoot: reference.dataRoot,
  runtimeRoot: reference.runtimeRoot,
  kernelStatus: 'idle',
  runJsonPath: reference.runJsonPath,
  cells: [],
  runs,
  recentRuns: runs,
  environments: []
})

describe('useNotebookRunsById', () => {
  let changedListener: ((event: NotebookChangedEvent) => void) | undefined
  let stopChanged: ReturnType<typeof vi.fn>

  beforeEach(() => {
    stopChanged = vi.fn()
    changedListener = undefined
    window.api = {
      notebook: {
        state: vi.fn().mockResolvedValue(makeState([makeRun('run-1', 'RklSU1Q=')])),
        onChanged: vi.fn((listener) => {
          changedListener = listener
          return stopChanged
        })
      }
    } as unknown as Window['api']
  })

  it('keeps full run data in local renderer state and refreshes only for the same notebook', async () => {
    const { result, unmount } = renderHook(() => useNotebookRunsById(reference))

    await waitFor(() => expect(result.current.get('run-1')).toBeDefined())
    expect(window.api.notebook.state).toHaveBeenCalledWith({
      sessionId: 'session-1',
      projectName: 'project-1',
      workspaceCwd: '/workspace'
    })
    expect(result.current.get('run-1')?.outputs).toEqual([
      { type: 'display', data: { 'image/png': 'RklSU1Q=' } }
    ])

    await act(async () => {
      changedListener?.({ ...reference, sessionId: 'another-session' })
      await Promise.resolve()
    })
    expect(window.api.notebook.state).toHaveBeenCalledTimes(1)

    vi.mocked(window.api.notebook.state).mockResolvedValue(
      makeState([makeRun('run-2', 'U0VDT05E')])
    )
    await act(async () => {
      changedListener?.(reference)
    })
    await waitFor(() => expect(result.current.get('run-2')).toBeDefined())
    expect(result.current.has('run-1')).toBe(false)

    unmount()
    expect(stopChanged).toHaveBeenCalledOnce()
  })

  it('ignores an older state request that resolves after a newer notebook change', async () => {
    let resolveInitial: ((state: NotebookSessionState) => void) | undefined
    let resolveChanged: ((state: NotebookSessionState) => void) | undefined
    vi.mocked(window.api.notebook.state)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveInitial = resolve
        })
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveChanged = resolve
        })
      )
    const { result } = renderHook(() => useNotebookRunsById(reference))

    await waitFor(() => expect(window.api.notebook.state).toHaveBeenCalledOnce())
    act(() => changedListener?.(reference))
    await waitFor(() => expect(window.api.notebook.state).toHaveBeenCalledTimes(2))

    await act(async () => resolveChanged?.(makeState([makeRun('new-run', 'TkVX')])))
    await waitFor(() => expect(result.current.has('new-run')).toBe(true))

    await act(async () => resolveInitial?.(makeState([makeRun('stale-run', 'T0xE')])))
    expect(result.current.has('new-run')).toBe(true)
    expect(result.current.has('stale-run')).toBe(false)
  })
})
