import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import { analyzePythonNotebookSource } from './dependency-analysis-python'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'
import cells from './reported-with-volcano.fixture.json'

it.each([3, 4, 5, 6, 8])('captures reported cell %s', async (index) => {
  const cell = cells[index]
  const { facts } = await (cell.language === 'r'
    ? analyzeRNotebookSource(cell.script)
    : analyzePythonNotebookSource(cell.script))
  for (const reason of ['opaque-call', 'opaque-mutation'])
    expect(facts.state === 'unknown' ? facts.reasons : []).not.toContain(reason)
  const access = await analyzeNotebookSourceFileAccess(cell.language as 'r' | 'python', cell.script)
  expect(access, JSON.stringify(facts)).toMatchObject({
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete'
  })
})

it('replays the self-contained final cell without earlier failed plotting', async () => {
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
  const root = await mkdtemp(join(tmpdir(), 'with-volcano-'))
  try {
    const p = await new NotebookDependencyAnalyzer({
      storageRoot: root,
      repository: { readSessionRuns: async () => runs }
    }).project({ projectId: 'p', sessionId: 's', completedRun: runs.at(-1)! })
    expect(p.stalenessByRunId['8'], JSON.stringify(p)).toEqual({ state: 'clear' })
    expect(p.dependenciesByRunId?.['8']).toEqual([])
    expect(await analyzeNotebookSourceFileAccess('r', cells[8].script)).toMatchObject({
      reads: ['inputs/differential-results-333333333333.xlsx'],
      writes: ['diagonal_volcano.png']
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.each([
  '(df["value"] == 0).sum()',
  '(df["value"] != 0).sum()',
  '((df["value"] > 0) & (df["value"] < 2)).sum()',
  '(~(df["value"] > 0)).sum()',
  '(df["name"] == "Gene1").sum()',
  '(df > 0).sum().sum()',
  'mask = df["value"] > 0\nprint(mask.sum())',
  'import numpy as np\na=np.array([0,1,2]); print((a >= 1).sum())'
])('preserves vector mask types and source reads: %s', async (expression) => {
  const script = `import pandas as pd\ndf=pd.read_csv("values.csv")\n${expression}`
  const { facts } = await analyzePythonNotebookSource(script)
  expect(facts.state === 'unknown' ? facts.reasons : []).not.toContain('opaque-call')
  expect(await analyzeNotebookSourceFileAccess('python', script)).toMatchObject({
    readState: 'complete',
    writeState: 'complete',
    reads: ['values.csv']
  })
})

it.each([
  'import pandas as pd\ndf=pd.read_csv("values.csv"); (df["value"] == custom).sum()',
  'import pandas as pd\ndf=pd.read_csv("values.csv"); (0 < df["value"] < 2).sum()',
  'import pandas as pd\ndf=pd.read_csv("values.csv"); (df["value"] > 0).drop(index=0,inplace=True)',
  'x=custom(); (x > 0).sum()'
])('does not certify unresolved comparison dispatch or mutation: %s', async (script) => {
  const { facts } = await analyzePythonNotebookSource(script)
  expect(facts.state).toBe('unknown')
  expect(facts.state === 'unknown' ? facts.reasons : []).toContain('opaque-call')
})

it.each([
  'ifelse(d$x>0, d$x, 0)',
  'base::ifelse(no=0, yes=d$x, test=d$x>0)',
  'with(d,ifelse(x>0,"Up",ifelse(x<0,"Down","NS")))',
  'base::with(expr=ifelse(x>0,"Up","Down"),data=d)'
])('keeps conditional columns as ordinary values: %s', async (value) => {
  const { facts } = await analyzeRNotebookSource(
    `d<-read.csv("data.csv"); d$label<-${value}; subset(d,!is.na(label))`
  )
  expect(facts.copyOnModifyNames).toContain('d')
  expect(facts.state === 'unknown' ? facts.reasons : []).not.toContain('opaque-call')
})

it.each([
  'd<-readRDS("unknown.rds"); out<-with(d,ifelse(x>0,"Up","Down"))',
  'd<-read.csv("data.csv"); out<-with(d,ifelse(x>0,external_ref,"Down"))',
  'd<-read.csv("data.csv"); out<-with(d,{y<-x; y})',
  'd<-read.csv("data.csv"); ifelse<-custom; out<-ifelse(d$x>0,1,0)'
])('retains uncertain conditional references: %s', async (script) => {
  const { facts } = await analyzeRNotebookSource(script)
  expect(facts.copyOnModifyNames ?? []).not.toContain('out')
})
