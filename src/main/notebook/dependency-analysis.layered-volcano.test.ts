import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { expect, it } from 'vitest'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'
import cells from './reported-layered-volcano.fixture.json'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookDependencyAnalyzer } from './dependency-analysis'

it('retains standalone plot paths while keeping unproven column dispatch uncertain', async () => {
  const { facts } = await analyzeRNotebookSource(cells[11].script)
  expect(facts.state === 'unknown' ? facts.reasons : [], JSON.stringify(facts)).toEqual([
    'external-state',
    'opaque-call'
  ])
  expect(await analyzeNotebookSourceFileAccess('r', cells[11].script)).toMatchObject({
    readState: 'partial',
    writeState: 'partial',
    externalState: 'partial',
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
      // Correcting the failed record cannot prove dispatch on the standalone plot's columns.
      expect(p.stalenessByRunId['11'], JSON.stringify(p)).toEqual({
        state: 'unknown',
        reasons: ['external-state', 'opaque-call']
      })
      expect(p.dependenciesByRunId?.['11']).toBeUndefined()
      for (const runId of ['2', '4']) {
        expect(p.stalenessByRunId[runId], JSON.stringify(p)).toEqual(
          corrected ? { state: 'clear' } : { state: 'unknown', reasons: ['parse-error'] }
        )
      }
      expect(runs.find((run) => run.runId === '6')?.status).toBe(corrected ? 'failed' : 'completed')
      if (corrected) expect(p.stalenessByRunId['6']).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

configureTestRuntimeMetadata()
