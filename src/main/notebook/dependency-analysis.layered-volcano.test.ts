import { expect, it } from 'vitest'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'
import cells from './reported-layered-volcano.fixture.json'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookDependencyAnalyzer } from './dependency-analysis'

it('captures the standalone plot with layer-local data', async () => {
  const { facts } = await analyzeRNotebookSource(cells[11].script)
  expect(facts.state === 'unknown' ? facts.reasons : [], JSON.stringify(facts)).toEqual([
    'external-state'
  ])
  expect(await analyzeNotebookSourceFileAccess('r', cells[11].script)).toMatchObject({
    readState: 'complete',
    writeState: 'complete',
    reads: ['inputs/differential-results-333333333333.xlsx'],
    writes: ['diagonal_volcano.pdf', 'diagonal_volcano.png']
  })
})

it.each([false, true])(
  'handles recorded parse failure status (corrected=%s)',
  async (corrected) => {
    const root = await mkdtemp(join(tmpdir(), 'layered-volcano-'))
    const runs: NotebookRunRecord[] = cells
      .filter((c) => c.language === 'r')
      .map((c) => ({
        runId: String(c.index),
        cellId: String(c.index),
        kernelKind: 'r',
        kernelEpochId: 'epoch',
        environment: 'r',
        source: 'agent',
        status: c.status === 'failed' || (corrected && c.index === 6) ? 'failed' : 'completed',
        kernelDispatched: true,
        startedAt: c.index,
        endedAt: c.index + 1,
        script: c.script,
        text: { stdout: '', stderr: '', traceback: '', plain: [] },
        outputs: [],
        workingFiles: []
      }))
    try {
      const p = await new NotebookDependencyAnalyzer({
        storageRoot: root,
        repository: { readSessionRuns: async () => runs }
      }).project({ projectId: 'p', sessionId: 's', throughRunId: '11' })
      if (corrected) {
        expect(p.stalenessByRunId['11'], JSON.stringify(p)).toEqual({ state: 'clear' })
        expect(p.dependenciesByRunId?.['11']).toEqual([])
      } else {
        // A parser/runtime disagreement in a legacy completed record remains uncertain.
        expect(p.stalenessByRunId['11']).toMatchObject({
          state: 'unknown',
          reasons: ['parse-error']
        })
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)
