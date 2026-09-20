import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'
import cells from './dev-web-reproducibility.fixture.json'

// Exact scripts from three model-driven dev:web scenarios; no machine IDs or environment data.
const makeRuns = (): (NotebookRunRecord & { kernelEpochId: string })[] =>
  cells.map((cell, index) => ({
    runId: cell.name,
    cellId: cell.name,
    script: cell.script,
    kernelKind: cell.language === 'r' ? 'r' : 'python',
    kernelEpochId: cell.epoch,
    environment: cell.language,
    source: 'agent',
    status: cell.status === 'failed' ? 'failed' : 'completed',
    kernelDispatched: true,
    startedAt: index,
    endedAt: index + 1,
    text: { stdout: '', stderr: '', traceback: '', plain: [] },
    outputs: [],
    workingFiles: []
  }))

it('preserves live cross-cell inputs and clears self-contained recovery on cold and cached analysis', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dev-web-analysis-'))
  const runs = makeRuns()
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const analyzer = new NotebookDependencyAnalyzer({
        storageRoot: root,
        repository: { readSessionRuns: async () => runs }
      })
      const result = await analyzer.project({
        projectId: 'project',
        sessionId: 'session',
        throughRunId: 'python-recovery'
      })
      expect(result.dependenciesByRunId?.['python-plot']).toEqual(['python-setup'])
      expect(result.dependenciesByRunId?.['python-recovery']).toEqual([])
      for (const run of runs.filter((run) => run.status === 'completed')) {
        expect(result.stalenessByRunId[run.runId], run.runId).toEqual({ state: 'clear' })
      }
      const expectations = [
        { name: 'python-setup', reads: [], writes: ['qa_intermediate.csv'] },
        { name: 'python-plot', reads: [], writes: ['qa_counts.csv', 'qa_python.png'] },
        { name: 'r-setup', reads: [], writes: ['qa_small.rds'] },
        { name: 'r-plot', reads: ['qa_small.rds'], writes: ['qa_r.csv', 'qa_r.png'] },
        { name: 'python-recovery', reads: [], writes: ['qa_recovered.csv', 'qa_recovered.png'] }
      ]
      for (const expected of expectations) {
        const run = runs.find((run) => run.runId === expected.name)!
        const language = run.kernelKind === 'r' ? 'r' : 'python'
        const context = await analyzer.sourceFileAccessContext({
          projectId: 'project',
          sessionId: 'session',
          currentRunId: run.runId,
          language,
          environment: run.environment,
          kernelEpochId: run.kernelEpochId
        })
        const access = await analyzeNotebookSourceFileAccess(language, run.script, context)
        expect(access, run.runId).toMatchObject({
          readState: 'complete',
          writeState: 'complete',
          externalState: 'complete',
          reasonCodes: []
        })
        expect(access.reads.toSorted(), run.runId).toEqual(expected.reads)
        expect(access.writes.toSorted(), run.runId).toEqual(expected.writes)
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('does not carry the live Python counts across a kernel restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dev-web-epoch-'))
  const runs = makeRuns().slice(0, 2)
  runs[1]!.kernelEpochId = 'restarted'
  try {
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot: root,
      repository: { readSessionRuns: async () => runs }
    })
    const result = await analyzer.project({
      projectId: 'project',
      sessionId: 'session',
      throughRunId: 'python-plot'
    })
    expect(result.stalenessByRunId['python-plot']?.state).toBe('unknown')
    expect(result.dependenciesByRunId?.['python-plot']).toBeUndefined()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
