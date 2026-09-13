import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'
import historicalCells from './reported-r-welch-volcano.fixture.json'
import correctedCells from './bh-r-welch-volcano.fixture.json'

// Test-only companion to the reported execution: exercise dependency tracking for a
// bounded BH/Welch example without changing the historical fixture or agent instructions.
const replacements: Record<string, string> = { '4': 'compute', '6': 'classify', '7': 'plot' }
const cells = historicalCells.map((cell) => ({
  ...cell,
  script:
    correctedCells.find((replacement) => replacement.runId === replacements[cell.runId])?.script ??
    cell.script
}))

const runsFor = (): NotebookRunRecord[] =>
  cells
    .filter((cell) => cell.status === 'completed')
    .map((cell, index) => ({
      runId: cell.runId,
      cellId: cell.runId,
      script: cell.script,
      kernelKind: 'r',
      kernelEpochId: 'epoch',
      environment: 'r',
      source: 'agent',
      status: 'completed',
      kernelDispatched: true,
      startedAt: index,
      endedAt: index + 1,
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      outputs: [],
      workingFiles: []
    }))
it.each(cells.filter((cell) => replacements[cell.runId]))(
  'captures BH Welch cell $runId with its upstream values',
  async ({ script, runId }) => {
    const root = await mkdtemp(join(tmpdir(), 'welch-cell-'))
    const runs = runsFor()
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot: root,
      repository: { readSessionRuns: async () => runs }
    })
    try {
      const context = await analyzer.sourceFileAccessContext({
        projectId: 'p',
        sessionId: 's',
        currentRunId: runId,
        language: 'r',
        environment: 'r',
        kernelEpochId: 'epoch'
      })
      const { facts } = await analyzeRNotebookSource(script, context)
      expect(
        facts.state === 'unknown' ? facts.reasons.filter((r) => r !== 'external-state') : [],
        JSON.stringify(facts)
      ).toEqual([])
      const access = await analyzeNotebookSourceFileAccess('r', script, context)
      expect(access, JSON.stringify(access)).toMatchObject({
        readState: 'complete',
        writeState: 'complete',
        externalState: 'complete'
      })
      if (runId === '7') {
        expect(access.writes).toEqual(['diagonal_volcano.png', 'diagonal_volcano_diff.csv'])
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

it('reconstructs the corrected BH plot and CSV through their complete producer chain', async () => {
  const root = await mkdtemp(join(tmpdir(), 'welch-volcano-'))
  const runs = runsFor()
  try {
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot: root,
      repository: { readSessionRuns: async () => runs }
    })
    const projection = await analyzer.project({
      projectId: 'p',
      sessionId: 's',
      completedRun: runs.at(-1)!
    })
    expect(projection.stalenessByRunId['7'], JSON.stringify(projection)).toEqual({ state: 'clear' })
    const upstream = new Set<string>()
    const pending = ['7']
    while (pending.length) {
      for (const dependency of projection.dependenciesByRunId?.[pending.pop()!] ?? []) {
        if (upstream.has(dependency)) continue
        upstream.add(dependency)
        pending.push(dependency)
      }
    }
    expect([...upstream].sort()).toEqual(['2', '3', '4', '6'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
