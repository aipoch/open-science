import { describe, expect, it, vi } from 'vitest'

import { loadSessionNotebookRuns } from './session-notebook-data'
import type { NotebookRunRecord } from '../../../../shared/notebook'

const request = { sessionId: 's1', projectName: 'default', workspaceCwd: '/w' }

const makeRun = (overrides: Partial<NotebookRunRecord> = {}): NotebookRunRecord => ({
  runId: 'r1',
  cellId: 'c1',
  source: 'agent',
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
})
