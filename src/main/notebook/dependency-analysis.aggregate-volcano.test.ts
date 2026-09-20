import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'
import cells from './reported-r-aggregate-volcano.fixture.json'

it.each(cells)('captures aggregate volcano cell $runId', async ({ script, runId }) => {
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
  if (runId === '3')
    expect(await analyzeNotebookSourceFileAccess('r', script)).toMatchObject({
      reads: ['inputs/expression-matrix-444444444444.csv'],
      writes: ['diagonal_volcano.pdf', 'diagonal_volcano.png', 'diagonal_volcano_stats.csv']
    })
})

it('retains captured matrix and index dependencies through nested error-handling callbacks', async () => {
  const { facts } = await analyzeRNotebookSource(cells[3]!.script)
  const type = facts.typeBindings?.find((binding) => binding.target === 'tt')?.typeName
  const summary = facts.typeSummaries?.find((summary) => summary.name === type)?.methods[0]
  expect(summary).toMatchObject({ effect: 'read', returnType: 'r-value' })
  expect(summary?.usedNames).toEqual(
    expect.arrayContaining(['M', 'apply', 't.test', 'try', 'inherits'])
  )
  for (const local of ['a', 'b', 'v', 'o']) expect(summary?.usedNames).not.toContain(local)
})

it.each([
  'aggregate <- custom; aggregate(frame,by=list(g=1:2),FUN=mean)',
  'mean <- custom; aggregate(frame,by=list(g=1:2),FUN=mean)',
  'aggregate(frame,by=list(g=1:2),FUN=function(v) {writeLines("hidden","hidden.txt");mean(v)})',
  'aggregate(readRDS("unknown.rds"), by=list(g=1), FUN=mean)',
  'aggregate(custom(value) ~ g, data=frame, FUN=mean)',
  'subset(readRDS("unknown.rds"), value>0)',
  'subset <- custom; subset(frame,value>0)',
  'subset(frame, {value <<- 1; TRUE})',
  'f<-function(a) try(source("hidden.R"),silent=TRUE); f(1)',
  'f<-function(a) {try<-custom;try(t.test(a),silent=TRUE)};f(1)',
  'f<-function(a) {t.test<-custom;try(t.test(a),silent=TRUE)};f(1)',
  'f<-function(a) try(a, FALSE, "error.txt");f(1)',
  'f<-function(a) try(a, outFile="error.txt");f(1)',
  'p.adjust<-custom;p.adjust(frame$value)'
])(
  'keeps unresolved dispatch, redirected errors and callback side effects uncertain: %s',
  async (source) => {
    const script = `frame<-data.frame(value=1:2)\n${source}`
    const files = await analyzeNotebookSourceFileAccess('r', script)
    expect(files.readState).not.toBe('complete')
  }
)

it.each([
  'function(x) x',
  'function(x) {if(x) return(x);1}',
  'function(x) apply(x,1,function(v) v)',
  'function(x) {o<-try(x,silent=TRUE);o}'
])('does not infer ordinary ownership from arbitrary callback returns: %s', async (fn) => {
  const { facts } = await analyzeRNotebookSource(`f <- ${fn}`)
  expect(
    facts.typeSummaries?.flatMap((t) => t.methods).every((m) => m.returnType !== 'r-value')
  ).not.toBe(false)
})

it('preserves the formula interface when aggregating ordinary data', async () => {
  const script =
    'frame<-data.frame(value=1:4,g=c(1,1,2,2));clean<-na.omit(frame);result<-stats::aggregate(value ~ g,data=clean,FUN=mean);print(head(result));write.csv(result,"summary.csv")'
  expect(await analyzeNotebookSourceFileAccess('r', script)).toMatchObject({
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete',
    writes: ['summary.csv']
  })
})

it('keeps the independent producer separate from exploratory and overwritten outputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aggregate-volcano-'))
  const runs: NotebookRunRecord[] = cells.map((cell, index) => ({
    runId: cell.runId,
    cellId: cell.runId,
    script: cell.script,
    kernelKind: 'r',
    kernelEpochId: 'epoch',
    environment: 'r',
    source: 'agent',
    status: 'completed',
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
    const p = await analyzer.project({ projectId: 'p', sessionId: 's', completedRun: runs.at(-1)! })
    expect(p.stalenessByRunId['3'], JSON.stringify(p)).toEqual({ state: 'clear' })
    expect(p.dependenciesByRunId?.['3'] ?? []).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
