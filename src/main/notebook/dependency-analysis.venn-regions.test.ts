import { expect, it } from 'vitest'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import cells from './reported-venn-regions.fixture.json'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

it.each([0, 1, 2, 3, 4, 5, 6])('analyzes reported region cell %s', async (index) => {
  const { facts } = await analyzeRNotebookSource(cells[index])
  expect(facts.state === 'unknown' ? facts.reasons : [], JSON.stringify(facts)).toEqual(
    index === 2 ? [] : ['external-state']
  )
  expect(
    await analyzeNotebookSourceFileAccess('r', cells[index]),
    JSON.stringify(facts)
  ).toMatchObject({
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete',
    reads: index === 2 ? [] : ['inputs/set-membership-111111111111.xlsx'],
    writes:
      index === 3
        ? ['venn_5set.png']
        : [4, 5].includes(index)
          ? ['venn_intersections.csv']
          : index === 6
            ? ['proportional_venn_diagram.png']
            : []
  })
})

it.each([
  'requireNamespace("eulerr",quietly=TRUE)',
  'pkg<-"eulerr";base::requireNamespace(quietly=TRUE,package=pkg)',
  'for(pkg in c("ggVennDiagram","eulerr","ggplot2")) cat(pkg,requireNamespace(pkg,quietly=TRUE))'
])('recognizes namespace availability probes: %s', async (script) => {
  const { facts } = await analyzeRNotebookSource(script)
  expect(facts.state === 'unknown' ? facts.reasons : []).toEqual([])
  expect(facts.rPackageLoads ?? []).toEqual([])
})

it.each([
  'requireNamespace("eulerr",lib.loc="custom")',
  'requireNamespace("eulerr",versionCheck=check)',
  'requireNamespace(pkg,quietly=TRUE)',
  'requireNamespace("unknownExtension",quietly=TRUE)',
  'requireNamespace<-custom;requireNamespace("eulerr")',
  'other::requireNamespace("eulerr")',
  'requireNamespace("eulerr");eulerr::euler(list(A=1:3,B=2:4))',
  'requireNamespace("eulerr");eulerr::eulerr_options(fills="red")'
])('does not certify custom loading or unaudited package calls: %s', async (script) => {
  const access = await analyzeNotebookSourceFileAccess('r', script)
  expect([access.readState, access.writeState, access.externalState]).not.toEqual([
    'complete',
    'complete',
    'complete'
  ])
})

it.each([
  'v<-ggVennDiagram::Venn(list(A=1:3,B=2:4));out<-ggVennDiagram::process_region_data(v)',
  'library(ggVennDiagram);v<-Venn(sets=list(A=1:3,B=2:4),names=c("a","b"));out<-process_region_data(specific=FALSE,venn=v,sep=";")',
  'library(ggVennDiagram);v<-list(A=1:3,B=2:4);regions<-function() process_region_data(Venn(list(A=1:3,B=2:4)));out<-regions()',
  'library(ggVennDiagram);v<-list(A=1:3,B=2:4);out<-lapply(list(v,v),function(sets) process_region_data(Venn(sets)))'
])('preserves region table and list-column ownership: %s', async (script) => {
  const { facts } = await analyzeRNotebookSource(script)
  expect(facts.state === 'unknown' ? facts.reasons : []).toEqual([])
  expect(facts.copyOnModifyNames).toEqual(expect.arrayContaining(['v', 'out']))
})

it.each([
  'ggVennDiagram::Venn(readRDS("unknown.rds"))',
  'ggVennDiagram::process_region_data(readRDS("unknown.rds"))',
  'Venn<-custom;Venn(list(A=1:3,B=2:4))',
  'other::Venn(list(A=1:3,B=2:4))',
  'v<-ggVennDiagram::Venn(list(A=1:3,B=2:4));v@sets<-custom();ggVennDiagram::process_region_data(v)',
  'v<-ggVennDiagram::Venn(list(A=1:3,B=2:4));process_region_data<-custom;process_region_data(v)',
  'v<-ggVennDiagram::Venn(list(A=1:3,B=2:4));ggVennDiagram::process_region_data(v,sep=custom())',
  'ggVennDiagram::Venn(list(A=1:3,B=2:4),names=custom())',
  'library(ggVennDiagram);regions<-function(sets) process_region_data(Venn(sets));out<-regions(readRDS("unknown.rds"))',
  'library(ggVennDiagram);out<-lapply(readRDS("unknown.rds"),function(sets) process_region_data(Venn(sets)))',
  'library(ggVennDiagram);out<-lapply(list(list(A=1:3,B=2:4)),function(sets,Venn) process_region_data(Venn(sets)),Venn=custom)',
  'library(ggVennDiagram);out<-lapply(list(list(A=1:3,B=2:4)),function(sets) process_region_data(Venn(sets),sep=custom()))'
])('keeps unverified Venn objects and dispatch blocked: %s', async (script) => {
  const access = await analyzeNotebookSourceFileAccess('r', script)
  expect([access.readState, access.writeState, access.externalState]).not.toEqual([
    'complete',
    'complete',
    'complete'
  ])
})

it('recovers independent outputs after a failed list-column CSV export', async () => {
  const root = await mkdtemp(join(tmpdir(), 'venn-regions-'))
  const runs: NotebookRunRecord[] = cells.map((script, index) => ({
    runId: String(index),
    cellId: String(index),
    script,
    kernelKind: 'r',
    kernelEpochId: 'r',
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
      for (const index of [3, 5, 6]) {
        expect(result.stalenessByRunId[String(index)], JSON.stringify(result)).toEqual({
          state: 'clear'
        })
        expect(result.dependenciesByRunId?.[String(index)]).toEqual([])
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.each([
  { label: 'same-epoch value', middle: '', clear: true },
  { label: 'ordinary slot update', middle: 'v@sets<-list(A=1:4,B=2:5)', clear: true },
  { label: 'unknown slot update', middle: 'v@sets<-readRDS("unknown.rds")', clear: false },
  {
    label: 'shadowed extractor',
    middle: 'process_region_data<-function(x) read.csv("hidden.csv")',
    clear: false
  },
  { label: 'failed producer', middle: '', clear: false, failed: true },
  { label: 'different kernel', middle: '', clear: false, newEpoch: true }
])('tracks cross-cell Venn boundaries: $label', async (scenario) => {
  const root = await mkdtemp(join(tmpdir(), 'venn-cross-cell-'))
  const scripts = [
    'library(ggVennDiagram);v<-Venn(list(A=1:3,B=2:4))',
    scenario.middle || 'unrelated<-42',
    'tbl<-process_region_data(v);write.csv(tbl[c("id","name","count")],"regions.csv",row.names=FALSE)'
  ]
  const runs: NotebookRunRecord[] = scripts.map((script, index) => ({
    runId: String(index),
    cellId: String(index),
    script,
    kernelKind: 'r',
    kernelEpochId: index === 2 && scenario.newEpoch ? 'new' : 'epoch',
    environment: 'r',
    source: 'agent',
    status: index === 0 && scenario.failed ? 'failed' : 'completed',
    kernelDispatched: true,
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
    const result = await analyzer.project({ projectId: 'p', sessionId: 's', throughRunId: '2' })
    expect(result.stalenessByRunId['2']?.state, JSON.stringify(result)).toBe(
      scenario.clear ? 'clear' : 'unknown'
    )
    if (scenario.clear) {
      expect(result.dependenciesByRunId?.['2']).toEqual(scenario.middle ? ['0', '1'] : ['0'])
      const context = await analyzer.sourceFileAccessContext({
        projectId: 'p',
        sessionId: 's',
        currentRunId: '2',
        language: 'r',
        environment: 'r',
        kernelEpochId: 'epoch'
      })
      expect(await analyzeNotebookSourceFileAccess('r', scripts[2], context)).toMatchObject({
        readState: 'complete',
        writeState: 'complete',
        externalState: 'complete',
        writes: ['regions.csv']
      })
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
