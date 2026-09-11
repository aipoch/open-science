import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import { expect, it } from 'vitest'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'
import cells from './reported-rds-envelope-volcano.fixture.json'

it.each([4, 7, 8])('captures RDS envelope cell %s', async (index) => {
  const { facts } = await analyzeRNotebookSource(cells[index].script)
  const access = await analyzeNotebookSourceFileAccess('r', cells[index].script)
  expect(access, JSON.stringify(facts)).toMatchObject({
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete'
  })
})

it('reconstructs the final RDS plot without failed or overwritten plot cells', async () => {
  const runs: NotebookRunRecord[] = cells
    .filter((c) => c.language === 'r')
    .map((c) => ({
      runId: String(c.index),
      cellId: String(c.index),
      script: c.script,
      kernelKind: 'r',
      kernelEpochId: 'epoch',
      environment: 'r',
      source: 'agent',
      status: c.status === 'failed' ? 'failed' : 'completed',
      kernelDispatched: true,
      startedAt: c.index,
      endedAt: c.index + 1,
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      outputs: [],
      workingFiles: []
    }))
  const root = await mkdtemp(join(tmpdir(), 'rds-envelope-'))
  try {
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot: root,
      repository: { readSessionRuns: async () => runs }
    })
    const p = await analyzer.project({ projectId: 'p', sessionId: 's', completedRun: runs.at(-1)! })
    expect(p.stalenessByRunId['8'], JSON.stringify(p)).toEqual({ state: 'clear' })
    expect(p.dependenciesByRunId?.['8']).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.each(['as.numeric', 'base::as.numeric', 'function(x) as.numeric(x)'])(
  'preserves ordinary column ownership through a known lapply converter: %s',
  async (converter) => {
    const { facts } = await analyzeRNotebookSource(
      `d<-read.csv("data.csv"); d[,-1]<-lapply(d[,-1],${converter}); out<-dplyr::inner_join(d,d,by="id")`
    )
    expect(facts.copyOnModifyNames).toContain('d')
    expect(facts.copyOnModifyNames).toContain('out')
  }
)

it.each([
  'd<-readRDS("unknown.rds"); out<-lapply(d,as.numeric)',
  'd<-read.csv("data.csv"); out<-lapply(d,function(x) new.env())',
  'd<-read.csv("data.csv"); lapply<-custom; out<-lapply(d,as.numeric)',
  'd<-read.csv("data.csv"); as.numeric<-custom; out<-lapply(d,as.numeric)'
])('retains uncertain converter ownership: %s', async (script) => {
  const { facts } = await analyzeRNotebookSource(script)
  expect(facts.copyOnModifyNames ?? []).not.toContain('out')
})

it.each([
  'x<-readRDS("unknown.rds"); out<-scales::rescale(x)',
  'x<-structure(1:3,class="custom"); out<-scales::rescale(x)',
  'x<-seq(0,1); rescale<-custom; out<-rescale(x)',
  'x<-seq(0,1); out<-scales::rescale(x,to=custom())'
])('does not hide custom rescale dispatch or argument effects: %s', async (script) => {
  const { facts } = await analyzeRNotebookSource(script)
  expect(facts.state === 'unknown' ? facts.reasons : []).toContain('opaque-call')
})
