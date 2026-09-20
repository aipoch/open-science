import { expect, it } from 'vitest'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'
import cells from './reported-venn-partitions.fixture.json'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookDependencyAnalyzer } from './dependency-analysis'

it.each([0, 1, 2, 3, 5, 6])('captures reported Venn workflow cell %s', async (index) => {
  const { facts } = await analyzeRNotebookSource(cells[index])
  expect(facts.state === 'unknown' ? facts.reasons : [], JSON.stringify(facts)).toEqual([
    'external-state'
  ])
  if (index !== 2)
    expect(
      await analyzeNotebookSourceFileAccess('r', cells[index]),
      JSON.stringify(facts)
    ).toMatchObject({ readState: 'complete', writeState: 'complete', externalState: 'complete' })
})

it('keeps preparation, failed CSV export, and independent replacement outputs separate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'venn-partitions-'))
  const runs: NotebookRunRecord[] = cells.map((script, index) => ({
    runId: String(index),
    cellId: String(index),
    script,
    kernelKind: 'r',
    kernelEpochId: 'epoch',
    environment: 'r',
    source: 'agent',
    status: index === 4 ? 'failed' : 'completed',
    kernelDispatched: true,
    startedAt: index,
    endedAt: index + 1,
    text: { stdout: '', stderr: '', traceback: '', plain: [] },
    outputs: [],
    workingFiles: []
  }))
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const analyzer = new NotebookDependencyAnalyzer({
        storageRoot: root,
        repository: { readSessionRuns: async () => runs }
      })
      const result = await analyzer.project({ projectId: 'p', sessionId: 's', throughRunId: '6' })
      for (const index of [0, 1, 2, 3, 5, 6])
        expect(result.stalenessByRunId[String(index)], JSON.stringify(result)).toEqual({
          state: 'clear'
        })
      for (const index of [3, 5, 6]) expect(result.dependenciesByRunId?.[String(index)]).toEqual([])
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.each([
  'function(x) na.omit(unique(x))',
  'function(x) stats::na.exclude(base::unique(x))',
  'stats::na.omit',
  'function(x) as.character(stats::na.omit(unique(x)))'
])('preserves ordinary mapped values through %s', async (callback) => {
  const { facts } = await analyzeRNotebookSource(
    `data<-list(c('a',NA,'a'),c('b'));result<-lapply(data,${callback})`
  )
  expect(facts.state === 'unknown' ? facts.reasons : []).toEqual([])
  expect(facts.copyOnModifyNames).toContain('result')
})

it.each([
  'x<-readRDS("unknown.rds");lapply(x,function(v) na.omit(v))',
  'x<-list(1:3);other<-readRDS("unknown.rds");lapply(x,function(v,y) na.omit(y),y=other)',
  'x<-list(1:3);na.omit<-custom;lapply(x,function(v) na.omit(v))',
  'x<-list(1:3);lapply(x,function(v) other::na.omit(v))',
  'x<-list(1:3);lapply(x,function(v,na.omit) na.omit(v),na.omit=custom)',
  'x<-list(1:3);lapply(x,function(v) na.omit(custom(v)))',
  'VennDiagram::get.venn.partitions(readRDS("unknown.rds"))',
  'other::get.venn.partitions(list(A=1:3))',
  'get.venn.partitions<-custom;get.venn.partitions(list(A=1:3))',
  'VennDiagram::get.venn.partitions(list(A=1:3),keep.elements=custom())',
  'obj<-data.frame(a=1);if(check()) obj[["a"]]<-NULL'
])('retains unknown dispatch: %s', async (script) => {
  const access = await analyzeNotebookSourceFileAccess('r', script)
  expect([access.readState, access.writeState, access.externalState]).not.toEqual([
    'complete',
    'complete',
    'complete'
  ])
})

it('does not certify conditional replacement on a deserialized unknown object', async () => {
  const { facts } = await analyzeRNotebookSource(
    'obj<-readRDS("object.rds");if("drop" %in% names(obj)) obj[["drop"]]<-NULL'
  )
  expect(facts.state === 'unknown' ? facts.reasons : []).toContain('control-flow')
  expect(facts.copyOnModifyNames).not.toContain('obj')
})

it.each(['sapply(data,class)', 'sapply(data,base::typeof)', 'lapply(data,function(x) class(x))'])(
  'recognizes primitive type inspection %s',
  async (call) => {
    const { facts } = await analyzeRNotebookSource(`data<-list(1:3,'a');result<-${call}`)
    expect(facts.state === 'unknown' ? facts.reasons : []).toEqual([])
  }
)
