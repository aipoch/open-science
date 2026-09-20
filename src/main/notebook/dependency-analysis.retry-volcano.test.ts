import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'
import cells from './reported-r-retry-volcano.fixture.json'

it('analyzes the self-contained retry independently', async () => {
  const script = cells[8]!.script
  const result = await analyzeRNotebookSource(script)
  expect(
    result.facts.state === 'unknown'
      ? result.facts.reasons.filter((r) => r !== 'external-state')
      : [],
    JSON.stringify(result.facts)
  ).toEqual([])
  expect(await analyzeNotebookSourceFileAccess('r', script)).toMatchObject({
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete',
    reads: ['inputs/differential-results-333333333333.xlsx'],
    writes: ['Synthetic volcano plot.png']
  })
})

it.each([false, true])(
  'scopes exploration effects while preserving genuine namespace uncertainty (dynamic source: %s)',
  async (dynamicSource) => {
    const root = await mkdtemp(join(tmpdir(), 'retry-volcano-'))
    const runs: NotebookRunRecord[] = cells.map((cell, index) => ({
      runId: cell.runId,
      cellId: cell.runId,
      script: cell.script,
      status: cell.status === 'failed' ? 'failed' : 'completed',
      kernelKind: 'r',
      kernelEpochId: 'epoch',
      environment: 'r',
      kernelDispatched: true,
      source: 'agent',
      startedAt: index,
      endedAt: index + 1,
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      outputs: [],
      workingFiles: []
    }))
    if (dynamicSource) runs[2] = { ...runs[2]!, script: 'source("custom.R")' }
    try {
      const analyzer = new NotebookDependencyAnalyzer({
        storageRoot: root,
        repository: { readSessionRuns: async () => runs }
      })
      for (const run of dynamicSource ? [] : runs) {
        const c = await analyzer.sourceFileAccessContext({
          projectId: 'p',
          sessionId: 's',
          currentRunId: run.runId,
          language: 'r',
          kernelEpochId: 'epoch',
          environment: 'r'
        })
        const { facts } = await analyzeRNotebookSource(run.script, c)
        if (run.status === 'completed')
          expect(
            facts.state === 'unknown'
              ? facts.reasons.filter((r) =>
                  ['dynamic-namespace', 'dynamic-assignment', 'opaque-call'].includes(r)
                )
              : [],
            run.runId
          ).toEqual([])
      }
      const projection = await analyzer.project({
        projectId: 'p',
        sessionId: 's',
        completedRun: runs.at(-1)!
      })
      if (dynamicSource)
        expect(projection.stalenessByRunId['8']).toMatchObject({
          state: 'unknown',
          reasons: expect.arrayContaining(['dynamic-namespace'])
        })
      else {
        expect(projection.stalenessByRunId['8'], JSON.stringify(projection)).toEqual({
          state: 'clear'
        })
        expect(projection.dependenciesByRunId?.['8'] ?? []).toEqual([])
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

it.each([
  'colnames(frame)[1] <- "id"',
  'names(frame)[c(1,2)] <- c("id", "value")',
  'dimnames(frame)[[2]][1] <- "id"',
  'base::colnames(frame)[1] <- "id"'
])('scopes nested metadata replacement to its data object: %s', async (replacement) => {
  const { facts } = await analyzeRNotebookSource(
    `frame <- data.frame(a=1,b=2)\nalias <- frame\n${replacement}`
  )
  expect(facts.state, JSON.stringify(facts)).toBe('available')
  expect(facts.mutatedNames).toEqual(['frame'])
  expect(facts.safeCallNames).toEqual(
    expect.arrayContaining([
      replacement.includes('dimnames')
        ? 'dimnames<-'
        : replacement.startsWith('names')
          ? 'names<-'
          : replacement.startsWith('base::')
            ? 'base::colnames<-'
            : 'colnames<-'
    ])
  )
})

it.each([
  'for (pkg in c("readxl", "openxlsx", "xlsx", "XLConnect")) cat(pkg, requireNamespace(pkg, quietly=TRUE))',
  'pkgs <- c("ggplot2", "ggrepel", "ggpubr", "ggthemes", "scales", "cowplot"); for(pkg in pkgs) print(requireNamespace(pkg,quietly=TRUE))',
  'pkg <- "ggplot2"; print(requireNamespace(pkg, quietly=TRUE))'
])('resolves finite package probes without attaching exports: %s', async (script) => {
  const { facts } = await analyzeRNotebookSource(script)
  expect(facts.state, JSON.stringify(facts)).toBe('available')
  expect(facts.rPackageLoads ?? []).toEqual([])
})

it.each([
  'colnames <- custom; colnames(frame)[1] <- "id"',
  '`colnames<-` <- custom; colnames(frame)[1] <- "id"',
  '`[<-` <- custom; colnames(frame)[1] <- "id"',
  'unknown_accessor(frame)[1] <- "id"',
  'for(pkg in unknown_packages) requireNamespace(pkg,quietly=TRUE)',
  'for(pkg in c("readxl","unknownPackage")) requireNamespace(pkg,quietly=TRUE)',
  'for(pkg in c("readxl","ggplot2")) { pkg <- unknown_package; requireNamespace(pkg,quietly=TRUE) }',
  'for(pkg in c("readxl")) { pkg[1] <- "unknownPackage"; requireNamespace(pkg,quietly=TRUE) }',
  'requireNamespace <- custom; for(pkg in c("readxl")) requireNamespace(pkg)',
  'for(pkg in c("readxl")) requireNamespace(pkg, lib.loc="custom-library")',
  'for(pkg in c("readxl")) requireNamespace(pkg, versionCheck=custom_check)',
  'for(pkg in c("readxl")) requireNamespace(pkg); pkg <- other; requireNamespace(pkg)'
])('keeps dynamic or shadowed operations uncertain: %s', async (script) => {
  const { facts } = await analyzeRNotebookSource(`frame <- data.frame(a=1,b=2)\n${script}`)
  expect(facts.state, JSON.stringify(facts)).toBe('unknown')
})

it('captures workbook sheet discovery as an input read', async () => {
  expect(
    await analyzeNotebookSourceFileAccess(
      'r',
      'sheets <- openxlsx::getSheetNames(file="input.xlsx"); print(sheets)'
    )
  ).toMatchObject({
    readState: 'complete',
    writeState: 'complete',
    reads: ['input.xlsx'],
    writes: []
  })
})
