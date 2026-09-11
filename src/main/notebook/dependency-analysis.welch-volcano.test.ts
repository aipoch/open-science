import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'
import cells from './reported-r-welch-volcano.fixture.json'

const runsFor = (includeFailed = false): NotebookRunRecord[] =>
  cells
    .filter((cell) => includeFailed || cell.status === 'completed')
    .map((cell, index) => ({
      runId: cell.runId,
      cellId: cell.runId,
      script: cell.script,
      kernelKind: 'r',
      kernelEpochId: 'epoch',
      environment: 'r',
      source: 'agent',
      status: cell.status === 'failed' ? 'failed' : 'completed',
      kernelDispatched: true,
      startedAt: index,
      endedAt: index + 1,
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      outputs: [],
      workingFiles: []
    }))
it.each(cells.filter((c) => c.status === 'completed'))(
  'captures Welch volcano cell $runId with its upstream values',
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
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

it('reconstructs the producer through CSV preparation and Welch test cells', async () => {
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

it('keeps failed state uncertain and supports rebuilding in a fresh kernel', async () => {
  const root = await mkdtemp(join(tmpdir(), 'welch-recovery-'))
  const runs = runsFor(true)
  const analyzer = new NotebookDependencyAnalyzer({
    storageRoot: root,
    repository: { readSessionRuns: async () => runs }
  })
  try {
    const before = await analyzer.project({
      projectId: 'p',
      sessionId: 's',
      completedRun: runs.at(-1)!
    })
    expect(before.stalenessByRunId['6']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['incomplete-run'])
    })
    for (const index of [2, 3, 4, 6, 7])
      runs.push({
        ...runs.find((run) => run.runId === String(index))!,
        runId: `retry-${index}`,
        cellId: `retry-${index}`,
        kernelEpochId: 'restarted-epoch',
        startedAt: 100 + index,
        endedAt: 101 + index
      })
    const after = await analyzer.project({
      projectId: 'p',
      sessionId: 's',
      completedRun: runs.at(-1)!
    })
    expect(after.stalenessByRunId['retry-7'], JSON.stringify(after)).toEqual({ state: 'clear' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.each([
  'con<-file("input.csv","r");total<-0;while(length(readLines(con,n=10))>0)total<-total+10;close(con)',
  'con<-file("input.csv","r");total<-0;while(length(base::readLines(con,n=10))!=0){total<-total+10};close(con)'
])('tracks initialized counters over a bounded local file reader: %s', async (script) => {
  const { facts } = await analyzeRNotebookSource(script)
  expect(
    facts.state === 'unknown' ? facts.reasons.filter((r) => r !== 'external-state') : []
  ).toEqual([])
  expect(facts.conditionallyDefinedNames ?? []).not.toContain('total')
  expect(await analyzeNotebookSourceFileAccess('r', script)).toMatchObject({
    readState: 'complete',
    reads: ['input.csv']
  })
})

it.each([
  'con<-file("input.csv","r");while(length(readLines(con,n=10))>0)total<-10',
  'con<-file("input.csv","r");total<-0;while(length(readLines(con,n=0))>0)total<-total+10',
  'con<-file("input.csv","r");total<-0;while(length(readLines(con,n=10))>0)total<-custom(total)',
  'f<-function(x)tryCatch({result<<-sum(x);result},error=function(e)0);f(1:3)',
  'f<-function(x){y<-0;tryCatch({y<-x},error=function(e)NULL);y};f(1:3)',
  'f<-function(x)tryCatch({t<-t.test(x);t$p.value},error=function(e)source("hidden.R"));f(1:3)',
  'head<-custom;f<-function(x)head(x);f(1:3)'
])('does not suppress uncertain iteration or callback effects: %s', async (script) => {
  const { facts } = await analyzeRNotebookSource(script)
  expect(
    facts.state === 'unknown' ? facts.reasons.filter((r) => r !== 'external-state') : [],
    JSON.stringify(facts)
  ).not.toEqual([])
})

it('preserves parameter-dependent return ownership through cached helpers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'welch-return-'))
  const runs: NotebookRunRecord[] = [
    'pick<-function(x,k=2){if(nrow(x)==0)return(x[0,]);head(x,k)}',
    'd<-read.csv("input.csv");picked<-pick(k=1,x=d);picked$label<-"ok";head(picked)'
  ].map((script, index) => ({
    ...runsFor()[0],
    runId: String(index),
    cellId: String(index),
    script,
    startedAt: index,
    endedAt: index + 1
  }))
  try {
    const create = (): NotebookDependencyAnalyzer =>
      new NotebookDependencyAnalyzer({
        storageRoot: root,
        repository: { readSessionRuns: async () => runs }
      })
    await create().project({ projectId: 'p', sessionId: 's', completedRun: runs[1] })
    const context = await create().sourceFileAccessContext({
      projectId: 'p',
      sessionId: 's',
      currentRunId: 'next',
      language: 'r',
      environment: 'r',
      kernelEpochId: 'epoch'
    })
    expect(context?.rCopyOnModifyNames).toContain('picked')
    expect(
      context?.rFunctions?.find((f) => f.name === 'pick')?.summary.methods[0].returnCopyArguments
    ).toBe(true)
    const { facts } = await analyzeRNotebookSource(
      'u<-readRDS("unknown.rds");picked<-pick(u)',
      context
    )
    expect(facts.copyOnModifyNames ?? []).not.toContain('picked')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.each([
  'function(x){x<-external;x}',
  'function(x){tryCatch({v<-t.test(x)},error=function(e)NULL);v}',
  'function(x){tryCatch({v<-t.test(x)},error=function(e)external)}'
])('does not certify unproven callback result ownership: %s', async (fn) => {
  const { facts } = await analyzeRNotebookSource(`f<-${fn}`)
  const method = facts.typeSummaries?.find((summary) => summary.kind === 'r-function')?.methods[0]
  expect(method?.returnCopyArguments).not.toBe(true)
  expect(method?.returnType).not.toBe('r-value')
})
