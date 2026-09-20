import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'
import cells from './reported-r-finite-volcano.fixture.json'

it.each(cells.filter((c) => c.kernelKind === 'r' && c.status === 'completed'))(
  'captures reported finite volcano cell $runId',
  async ({ script }) => {
    const { facts } = await analyzeRNotebookSource(script)
    expect(
      facts.state === 'unknown' ? facts.reasons.filter((r) => r !== 'external-state') : [],
      JSON.stringify(facts)
    ).toEqual([])
    expect(await analyzeNotebookSourceFileAccess('r', script)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete'
    })
  }
)

it('projects the self-contained plot after pre-dispatch installation rejection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'finite-volcano-'))
  const runs: NotebookRunRecord[] = cells
    .filter((c) => c.kernelKind === 'r')
    .map((cell, index) => ({
      runId: cell.runId,
      cellId: cell.runId,
      script: cell.script,
      status: cell.status === 'failed' ? 'failed' : 'completed',
      kernelKind: 'r',
      kernelEpochId: 'epoch',
      environment: 'r',
      kernelDispatched: cell.status !== 'failed',
      source: 'agent',
      startedAt: index,
      endedAt: index + 1,
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      outputs: [],
      workingFiles: []
    }))
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
    expect(projection.stalenessByRunId['8'], JSON.stringify(projection)).toEqual({ state: 'clear' })
    expect(projection.dependenciesByRunId?.['8'] ?? []).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.each([
  'library(dplyr); d <- read.csv("input.csv") %>% as.data.frame(); print(head(d))',
  'library(dplyr); d <- read.csv("input.csv") %>% as.data.frame(); d$x <- 1; print(head(d))',
  'm <- matrix(1:9,3); for (g in rownames(m)[1:3]) print(mean(m[g,]))',
  'd<-read.csv("input.csv"); d$x<-d$x[is.finite(d$x)]'
])('supports table inspection and metadata slicing: %s', async (script) => {
  const { facts } = await analyzeRNotebookSource(script)
  expect(
    facts.state === 'unknown' ? facts.reasons.filter((r) => r !== 'external-state') : [],
    JSON.stringify(facts)
  ).toEqual([])
})

it('preserves table ownership after a transformed column assignment', async () => {
  const { facts } = await analyzeRNotebookSource(
    'd<-read.csv("input.csv");d$y<--log10(d$x);print(head(d))'
  )
  expect(facts.copyOnModifyNames).toContain('d')
  expect(
    facts.state === 'unknown' ? facts.reasons.filter((r) => r !== 'external-state') : [],
    JSON.stringify(facts)
  ).toEqual([])
})

it.each([
  'log(d$x)',
  'log2(d$x)',
  'log10(d$x)',
  'sqrt(abs(d$x))',
  'round(expm1(d$x))',
  'pmin(d$x, max(d$x, na.rm=TRUE))',
  'pmax(d$x, min(d$x, na.rm=TRUE))',
  'range(d$x)[1]',
  'as.numeric(is.finite(d$x))',
  'as.numeric(is.infinite(d$x))',
  'as.numeric(is.nan(d$x))',
  'base::log10(d$x)',
  'base::max(d$x)',
  'base::is.finite(d$x)',
  'base::is.infinite(d$x)',
  'base::is.nan(d$x)'
])('preserves ordinary column values through %s', async (expression) => {
  const { facts } = await analyzeRNotebookSource(
    `d<-read.csv("input.csv");d$y<-${expression};print(head(d))`
  )
  expect(facts.copyOnModifyNames).toContain('d')
  expect(
    facts.state === 'unknown' ? facts.reasons.filter((r) => r !== 'external-state') : [],
    JSON.stringify(facts)
  ).toEqual([])
})

it.each([
  'd<-read.csv("input.csv");log10<-function(x) get("custom")(x);d$y<-log10(d$x);head(d)',
  'd<-read.csv("input.csv");max<-function(x) get("custom")(x);d$y<-max(d$x);head(d)',
  'd<-read.csv("input.csv");is.finite<-function(x) get("custom")(x);d$y<-is.finite(d$x);head(d)',
  'd<-read.csv("input.csv");d$y<-max(d$x, get("custom")());head(d)',
  'm<-matrix(numeric(),0,0);for(g in rownames(m)) z<-mean(m[g,]);print(z)',
  'm<-get("custom")();for(g in rownames(m))print(m[g,])'
])('retains uncertainty for unsupported state: %s', async (script) => {
  const { facts } = await analyzeRNotebookSource(script)
  expect(
    facts.state === 'unknown' ? facts.reasons.filter((r) => r !== 'external-state') : [],
    JSON.stringify(facts)
  ).not.toEqual([])
})

it.each(['log10', 'is.finite', 'base::is.finite'])(
  'does not certify an arbitrary RDS object through %s',
  async (operation) => {
    const { facts } = await analyzeRNotebookSource(
      `d<-readRDS("input.rds");d$y<-${operation}(d$x);head(d)`
    )
    expect(facts.copyOnModifyNames ?? []).not.toContain('d')
    expect(facts.receiverCalls).toEqual(
      expect.arrayContaining([expect.objectContaining({ receiver: 'd', kind: 'generic' })])
    )
  }
)

it('attributes only the producer workbook and its two output files', async () => {
  const access = await analyzeNotebookSourceFileAccess('r', cells[8]!.script)
  expect(access).toMatchObject({
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete'
  })
  expect(access.reads).toEqual(['inputs/differential-results-333333333333.xlsx'])
  expect([...access.writes].sort()).toEqual(['diagonal_volcano.png', 'volcano_data.csv'])
})
