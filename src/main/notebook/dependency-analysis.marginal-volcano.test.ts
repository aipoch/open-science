import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'
import cells from './reported-marginal-volcano.fixture.json'

const runsFor = (): NotebookRunRecord[] =>
  cells
    .filter((cell) => cell.language === 'r' && cell.status === 'completed')
    .map((cell) => ({
      runId: String(cell.index),
      cellId: String(cell.index),
      script: cell.script,
      kernelKind: 'r',
      kernelEpochId: 'epoch',
      environment: 'r',
      source: 'agent',
      status: 'completed',
      kernelDispatched: true,
      startedAt: cell.index,
      endedAt: cell.index + 1,
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      outputs: [],
      workingFiles: []
    }))

it.each(runsFor())('captures marginal volcano cell $runId and its prior values', async (run) => {
  const root = await mkdtemp(join(tmpdir(), 'marginal-analysis-'))
  try {
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot: root,
      repository: { readSessionRuns: async () => runsFor() }
    })
    const context = await analyzer.sourceFileAccessContext({
      projectId: 'p',
      sessionId: 's',
      currentRunId: run.runId,
      language: 'r',
      environment: 'r',
      kernelEpochId: 'epoch'
    })
    const { facts } = await analyzeRNotebookSource(run.script, context)
    const access = await analyzeNotebookSourceFileAccess('r', run.script, context)
    expect(access, JSON.stringify({ facts, context })).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete'
    })
    expect(access.reads).toEqual(
      run.runId === '9'
        ? ['inputs/expression-matrix-444444444444.csv']
        : run.runId === '10'
          ? ['inputs/differential-results-333333333333.xlsx']
          : []
    )
    if (run.runId === '11') expect(access.writes).toEqual(['diagonal_volcano_plot.png'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('reconstructs both input stages for the marginal plot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'marginal-projection-'))
  try {
    const runs = runsFor()
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot: root,
      repository: { readSessionRuns: async () => runs }
    })
    const projection = await analyzer.project({
      projectId: 'p',
      sessionId: 's',
      completedRun: runs.at(-1)!
    })
    expect(projection.stalenessByRunId['11'], JSON.stringify(projection)).toEqual({
      state: 'clear'
    })
    expect(projection.dependenciesByRunId?.['11']).toContain('10')
    expect(projection.dependenciesByRunId?.['10']).toContain('9')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('recovers after the failed header assignment is superseded by successful preparation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'marginal-failure-'))
  const failed: NotebookRunRecord = {
    ...runsFor()[0],
    runId: '8',
    cellId: '8',
    startedAt: 8,
    endedAt: 9,
    status: 'failed',
    script: cells[8].script
  }
  const runs = [failed, ...runsFor()]
  try {
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot: root,
      repository: { readSessionRuns: async () => runs }
    })
    const before = await analyzer.project({
      projectId: 'p',
      sessionId: 's',
      completedRun: runs.at(-1)!
    })
    expect(before.stalenessByRunId['11']).toEqual({ state: 'clear' })
    expect(before.dependenciesByRunId?.['9']).not.toContain('8')
    expect(before.dependenciesByRunId?.['10']).not.toContain('8')
    expect(before.dependenciesByRunId?.['11']).not.toContain('8')
    runs.push(
      ...runsFor().map((run) => ({
        ...run,
        runId: `retry-${run.runId}`,
        cellId: `retry-${run.cellId}`,
        kernelEpochId: 'fresh',
        startedAt: run.startedAt + 20,
        endedAt: run.endedAt! + 20
      }))
    )
    const after = await analyzer.project({
      projectId: 'p',
      sessionId: 's',
      completedRun: runs.at(-1)!
    })
    expect(after.stalenessByRunId['retry-11'], JSON.stringify(after)).toEqual({ state: 'clear' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.each(['theme_set(theme_minimal())', 'ggplot2::theme_set(ggplot2::theme_minimal())'])(
  'retains a separate earlier theme provider: %s',
  async (script) => {
    const root = await mkdtemp(join(tmpdir(), 'theme-provider-'))
    const runs = [
      'library(ggplot2)',
      script,
      'd<-data.frame(x=1:3,y=2:4);p<-ggplot(d,aes(x,y))+geom_point();ggsave("plot.png",p)'
    ].map((script, index) => ({
      ...runsFor()[0],
      script,
      runId: String(index),
      cellId: String(index),
      startedAt: index,
      endedAt: index + 1
    }))
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const analyzer = new NotebookDependencyAnalyzer({
          storageRoot: root,
          repository: { readSessionRuns: async () => runs }
        })
        const result = await analyzer.project({
          projectId: 'p',
          sessionId: 's',
          completedRun: runs[2]
        })
        expect(result.stalenessByRunId['2']).toEqual({ state: 'clear' })
        expect(result.dependenciesByRunId?.['2']).toContain('1')
      }
      runs[1].status = 'failed'
      const analyzer = new NotebookDependencyAnalyzer({
        storageRoot: root,
        repository: { readSessionRuns: async () => runs }
      })
      const result = await analyzer.project({
        projectId: 'p',
        sessionId: 's',
        completedRun: runs[2]
      })
      expect(result.stalenessByRunId['2']?.state).toBe('unknown')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

it.each([
  'd<-readRDS("object.rds");unlist(d)',
  'unlist<-custom;d<-read.csv("data.csv");unlist(d)',
  'd<-read.csv("data.csv");n<-as.character(unlist(d));if(length(n)>2){n<-readRDS("object.rds")};head(n)',
  'theme_set<-custom;theme_set(theme_minimal())',
  'ggplot2::scale_size_continuous(breaks=function(x) readRDS("breaks.rds"))'
])('preserves uncertainty in custom objects and callbacks: %s', async (script) => {
  const access = await analyzeNotebookSourceFileAccess('r', script)
  expect([access.readState, access.writeState, access.externalState]).not.toEqual([
    'complete',
    'complete',
    'complete'
  ])
})
