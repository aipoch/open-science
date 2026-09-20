import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import cells from './reported-r-piped-volcano.fixture.json'

it('captures the reported connection, piped summaries and cross-cell labelled plot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'piped-volcano-'))
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
    for (const run of runs) {
      const context = await analyzer.sourceFileAccessContext({
        projectId: 'p',
        sessionId: 's',
        currentRunId: run.runId,
        language: 'r',
        kernelEpochId: 'epoch',
        environment: 'r'
      })
      const files = await analyzeNotebookSourceFileAccess('r', run.script, context)
      expect
        .soft(files, run.runId)
        .toMatchObject({ readState: 'complete', writeState: 'complete', externalState: 'complete' })
      if (run.runId === '4')
        expect(files).toMatchObject({ reads: [], writes: ['diagonal_volcano_plot.png'] })
    }
    const projection = await analyzer.project({
      projectId: 'p',
      sessionId: 's',
      completedRun: runs.at(-1)!
    })
    expect.soft(projection.stalenessByRunId['4']).toEqual({ state: 'clear' })
    expect(projection.dependenciesByRunId?.['4']).toContain('3')
    expect(projection.dependenciesByRunId?.['3']).toContain('2')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.each([
  'dplyr::bind_rows(head(frame, 2), tail(frame, 2))',
  'dplyr::bind_cols(head(frame, 2), tail(frame, 2))',
  'frame %>% head(2)',
  'frame %>% tail(n = 2)',
  'frame %>% utils::head(2)',
  'frame %>% head(., 2)',
  'frame %>% head(n = 2, x = .)',
  'frame |> utils::head(2)',
  'frame |> tail(n = 2, x = _)'
])('preserves the data receiver through ordinary value transforms: %s', async (expression) => {
  const script = `library(dplyr)\nframe <- read.csv("input.csv")\nselected <- ${expression}\nprint(head(selected))\nwrite.csv(selected, "output.csv")`
  const { facts } = await analyzeRNotebookSource(script)
  expect(
    facts.state === 'unknown' ? facts.reasons.filter((reason) => reason !== 'external-state') : []
  ).toEqual([])
  expect(await analyzeNotebookSourceFileAccess('r', script)).toMatchObject({
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete',
    reads: ['input.csv'],
    writes: ['output.csv']
  })
})

it.each([
  'readRDS("unknown.rds") %>% head(2)',
  'readRDS("unknown.rds") |> tail(2)',
  'readRDS("unknown.rds") |> tail(n = 2, x = _)',
  'readRDS("unknown.rds") %>% head(n = 2, x = .)',
  'head(n = 2, x = readRDS("unknown.rds"))',
  '`%>%` <- custom; frame %>% head(2)',
  'frame %>% head(n = .)',
  'frame %>% head(x = ., n = .)',
  'frame %>% head(n = length(.))',
  'frame %>% head(x = other)',
  'head <- custom; frame %>% head(2)',
  'bind_rows <- custom; bind_rows(frame, frame)',
  'foreign::bind_rows(frame, frame)',
  'dplyr::bind_rows(frame, custom())'
])('keeps unknown dispatch and unsupported pipe arguments uncertain: %s', async (expression) => {
  const script = `library(dplyr)\nframe <- read.csv("input.csv")\n${expression}`
  expect((await analyzeNotebookSourceFileAccess('r', script)).readState).not.toBe('complete')
})

it.each([
  'cat("File size:", round(file.info("plot.png")$size / 1024, 1), "KB\\n")',
  'print((file.info("plot.png")$size + 1) * 2 / 1024^2)',
  'message(-file.info("plot.png")$size - 1)'
])('ignores console-only arithmetic on file metadata: %s', async (script) => {
  expect(await analyzeNotebookSourceFileAccess('r', script)).toMatchObject({
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete',
    reads: []
  })
})

it.each([
  'size <- file.info("plot.png")$size / 1024; writeLines(as.character(size), "size.txt")',
  'cat(file.info("plot.png")$size / 1024, file = "size.txt")',
  'cat(file.info("plot.png")$size / unknown_divisor)',
  'round <- custom; cat(round(file.info("plot.png")$size / 1024))',
  '`/` <- custom; cat(file.info("plot.png")$size / 1024)'
])('retains metadata dependencies consumed by output or unknown code: %s', async (script) => {
  expect((await analyzeNotebookSourceFileAccess('r', script)).externalState).toBe('partial')
})
