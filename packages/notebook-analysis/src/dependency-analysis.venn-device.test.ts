import { NotebookDependencyAnalyzer } from './analysis-test-support'

import { expect, it } from 'vitest'

import { analyzeRNotebookSource } from './index'

import { analyzeNotebookSourceFileAccess } from './index'

import cells from './reported-venn-device.fixture.json'

import { mkdtemp, rm } from 'node:fs/promises'

import { tmpdir } from 'node:os'

import { join } from 'node:path'

import type { NotebookRunRecord } from './analysis-test-support'

it.each([0, 11])('captures self-contained Venn device cell %s', async (index) => {
  expect(await analyzeNotebookSourceFileAccess('r', cells[index])).toMatchObject({
    readState: index === 11 ? 'partial' : 'complete',
    writeState: index === 11 ? 'partial' : 'complete',
    externalState: index === 11 ? 'partial' : 'complete',
    reads: ['inputs/set-membership-111111111111.xlsx'],
    writes: index === 11 ? ['venn_5sets_proportional.png'] : [],
    ...(index === 11
      ? { writeScopes: [{ kind: 'timestamped-log', path: 'venn_5sets_proportional.png' }] }
      : {})
  })
})

it('keeps failed history and unproved new-kernel distinct methods uncertain', async () => {
  const root = await mkdtemp(join(tmpdir(), 'venn-device-projection-'))
  const runs: NotebookRunRecord[] = cells.map((script, index) => ({
    runId: String(index),
    cellId: String(index),
    script,
    kernelKind: 'r',
    kernelEpochId: index === 11 ? 'recovered' : 'r',
    environment: 'r',
    source: 'agent',
    status: [1, 3, 6, 7].includes(index) ? 'failed' : 'completed',
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
      const projection = await analyzer.project({
        projectId: 'p',
        sessionId: 's',
        throughRunId: '11'
      })
      expect(projection.stalenessByRunId['10']?.state).toBe('unknown')
      expect(projection.stalenessByRunId['11']).toMatchObject({
        state: 'unknown',
        reasons: expect.arrayContaining(['opaque-call'])
      })
      expect(projection.dependenciesByRunId?.['11']).toBeUndefined()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.each(['png', 'tiff', 'svg'])('captures %s device output and optional log', async (format) => {
  for (const logging of ['', ',disable.logging=TRUE']) {
    const result = await analyzeNotebookSourceFileAccess(
      'r',
      `VennDiagram::venn.diagram(list(A=1:3,B=2:4), "plot.${format}", imagetype="${format}"${logging})`
    )
    expect(result).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      writes: [`plot.${format}`]
    })
    expect(result.writeScopes ?? []).toEqual(
      logging ? [] : [{ kind: 'timestamped-log', path: `plot.${format}` }]
    )
  }
})

it.each([
  'venn.diagram<-custom;venn.diagram(list(A=1:3),"out.png")',
  'other::venn.diagram(list(A=1:3),"out.png")',
  'VennDiagram::venn.diagram(readRDS("sets.rds"),"out.png")',
  'VennDiagram::venn.diagram(list(A=1:3),filename=NULL)',
  'VennDiagram::venn.diagram(list(A=1:3),filename=unknown)',
  'VennDiagram::venn.diagram(list(A=1:3),"out.png",disable.logging=unknown)',
  'VennDiagram::venn.diagram(list(A=1:3),"out.png",fill=custom())'
])('does not certify unknown Venn effects: %s', async (script) => {
  const access = await analyzeNotebookSourceFileAccess('r', script)
  expect([access.readState, access.writeState, access.externalState]).not.toEqual([
    'complete',
    'complete',
    'complete'
  ])
})

it.each([
  'd<-readRDS("d.rds");for(col in colnames(d)) d[[col]][1]<-"x";VennDiagram::venn.diagram(d,"out.png")',
  'd<-data.frame(A=1:3);for(col in colnames(d)) d[[col]][1]<-custom();VennDiagram::venn.diagram(d,"out.png")',
  'd<-data.frame(A=1:3);for(col in colnames(d)){idx<-which(d[[col]]>1);d[[col]][idx]<-0};print(idx)',
  'which<-custom;d<-data.frame(A=1:3);for(col in colnames(d)){idx<-which(d[[col]]>1);d[[col]][idx]<-0}'
])('retains uncertain loop values or escaping temporaries: %s', async (script) => {
  const { facts } = await analyzeRNotebookSource(script)
  expect(facts.state).toBe('unknown')
})

it.each([
  'for(col in colnames(d)) {na_idx<-which(is.na(d[[col]])|d[[col]]=="");d[[col]][na_idx]<-paste0("__NA_",col,"__",seq_along(na_idx))}',
  'for(col in colnames(d)) d[[col]][is.na(d[[col]])|d[[col]]==""]<-paste0("__NA_",col,"__",seq_along(d[[col]][is.na(d[[col]])|d[[col]]==""]))'
])('tracks nested column replacement: %s', async (body) => {
  const { facts } = await analyzeRNotebookSource(
    `d<-data.frame(A=c('a',NA),B=c('b',''));${body};print(d)`
  )
  expect(facts.state === 'unknown' ? facts.reasons : [], JSON.stringify(facts)).toEqual([])
  expect(facts.copyOnModifyNames).toContain('d')
})
