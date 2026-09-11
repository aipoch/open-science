import { expect, it } from 'vitest'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'
import cells from './reported-r-diagonal-volcano.fixture.json'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import type { NotebookRunRecord } from '../../shared/notebook'
import { projectNotebookFileContext } from './dependency-file-context'
import type { NotebookSourceFileAccessContext } from './dependency-analysis-types'

// Isolate syntax coverage from the transcript's failed attempts. The full-history
// projection below separately verifies recovery after those failures.
async function preparedContext(): Promise<NotebookSourceFileAccessContext | undefined> {
  const { facts, fileAccess } = await analyzeRNotebookSource(cells[16]!.script)
  return projectNotebookFileContext('r', [{ facts, fileContext: fileAccess!.context }])
}

it.each([
  'f <- function(mat) apply(mat, 1, function(row) { writeLines("hidden", "side.txt"); sum(row) }); f(matrix(1:4, 2))',
  'f <- function(x) tryCatch(suppressWarnings(t.test(y ~ group)$p.value), error=function(e) NA_real_); f(1)',
  'f <- function(mat) { t.test <- function(x) source("hidden.R"); apply(mat, 1, function(row) t.test(row)) }; f(matrix(1:4, 2))',
  'f <- function(x, cat) tryCatch(x, error=function(e) cat("failed")); f(1, unknown_callback)',
  'with(data.frame(x=1), { y <- x; y })',
  'with(data.frame(x=1), unknown_effect(x))',
  'f <- function(x) { x[1] <- 0; x }; f(1:3)',
  'f <- function() geom_point(data = unknown_callback); f()',
  'ggplot2::annotate("custom_extension", x=1, y=1)',
  'head(readRDS("unknown-object.rds"))'
])('keeps unsupported callbacks, dispatch and mutations uncertain: %s', async (script) => {
  const files = await analyzeNotebookSourceFileAccess('r', script)
  expect(files.readState).not.toBe('complete')
})

it('tracks nested callback captures without leaking parameters or locals into the kernel dependencies', async () => {
  const script =
    'cutoff <- 0.05; analyze <- function(mat) apply(mat, 1, function(row) { a <- row[1:3]; b <- row[4:6]; tryCatch(suppressWarnings(t.test(a,b)$p.value) < cutoff, error=function(e) FALSE) }); result <- analyze(matrix(1:12,2))'
  const { facts } = await analyzeRNotebookSource(script)
  expect(facts.state).toBe('available')
  const typeName = facts.typeBindings?.find((binding) => binding.target === 'analyze')?.typeName
  const summary = facts.typeSummaries?.find((type) => type.name === typeName)
  expect(summary?.methods[0]?.usedNames).toContain('cutoff')
  for (const local of ['mat', 'row', 'a', 'b', 'e'])
    expect(summary?.methods[0]?.usedNames).not.toContain(local)
  expect(await analyzeNotebookSourceFileAccess('r', script)).toMatchObject({
    readState: 'complete',
    writeState: 'complete',
    reads: [],
    writes: []
  })
})

it('forgets ordinary R value ownership after failure or rebinding to an arbitrary RDS object', async () => {
  const first = await analyzeRNotebookSource('frame <- read.csv("input.csv")')
  const entry = { facts: first.facts, fileContext: first.fileAccess!.context }
  const original = projectNotebookFileContext('r', [entry])
  expect(await analyzeNotebookSourceFileAccess('r', 'head(frame)', original)).toMatchObject({
    readState: 'complete'
  })
  const replacement = await analyzeRNotebookSource('frame <- readRDS("unknown.rds")', original)
  for (const context of [
    projectNotebookFileContext('r', [entry, undefined]),
    projectNotebookFileContext('r', [
      entry,
      { facts: replacement.facts, fileContext: replacement.fileAccess!.context }
    ])
  ])
    expect((await analyzeNotebookSourceFileAccess('r', 'head(frame)', context)).readState).not.toBe(
      'complete'
    )
})

it.each(cells.filter((cell) => cell.language === 'r' && cell.status === 'completed'))(
  'captures completed volcano workflow run $runId',
  async ({ script, runId }) => {
    const context = await preparedContext()
    const { facts } = await analyzeRNotebookSource(script, context)
    expect
      .soft(
        facts.state === 'unknown'
          ? facts.reasons.filter((reason) => reason !== 'external-state')
          : [],
        `variables in run ${runId}`
      )
      .toEqual([])
    const files = await analyzeNotebookSourceFileAccess('r', script, context)
    expect.soft(files, `files in run ${runId}`).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete'
    })
    if (['20', '21', '22', '25'].includes(runId)) {
      expect(files.reads).toEqual(['diff_final.rds'])
      expect(files.writes).toEqual(['diagonal_volcano.png'])
    }
  }
)

it('recovers a self-contained producer after failed attempts in the reported history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'volcano-history-'))
  const runs: NotebookRunRecord[] = cells
    .filter((cell) => cell.language === 'r')
    .map((cell, index) => ({
      runId: cell.runId,
      cellId: cell.runId,
      source: 'agent',
      kernelKind: 'r',
      kernelEpochId: 'r',
      script: cell.script,
      status: cell.status === 'failed' ? 'failed' : 'completed',
      kernelDispatched: true,
      startedAt: index,
      endedAt: index + 1,
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      outputs: [],
      workingFiles: []
    }))
  try {
    const projection = await new NotebookDependencyAnalyzer({
      storageRoot: root,
      repository: { readSessionRuns: async () => runs }
    }).project({ projectId: 'p', sessionId: 's', completedRun: runs.at(-1)! })
    expect(projection.stalenessByRunId['19']).toEqual({ state: 'clear' })
    expect(projection.stalenessByRunId['25']).toEqual({ state: 'clear' })
    for (const priorPlot of ['20', '21', '22'])
      expect(projection.dependenciesByRunId?.['25'] ?? []).not.toContain(priorPlot)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.skipIf(process.env.RUN_KERNEL !== '1' || !process.env.OPEN_SCIENCE_TEST_R_COMMAND)(
  'replays the reported statistics and final plot identically in two fresh R processes',
  async () => {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const root = await mkdtemp(join(tmpdir(), 'native-r-volcano-'))
    try {
      const outputs: Buffer[][] = []
      for (let attempt = 0; attempt < 2; attempt++) {
        const cwd = join(root, String(attempt))
        await mkdir(join(cwd, 'inputs'), { recursive: true })
        const rows = Array.from({ length: 24 }, (_, i) =>
          [
            `Gene${i + 1}`,
            ...Array.from({ length: 12 }, (_, j) =>
              (5 + Math.sin(i + j * 0.7) + (Math.floor(j / 3) % 2) * ((i % 3) - 1)).toFixed(6)
            )
          ].join(',')
        )
        await writeFile(
          join(cwd, 'inputs/expression-matrix-444444444444.csv'),
          [
            '#group',
            'id,' + Array.from({ length: 12 }, (_, i) => `sample${i}`).join(','),
            ...rows
          ].join('\n')
        )
        await writeFile(join(cwd, 'replay.R'), cells[18]!.script + '\n' + cells[24]!.script)
        await promisify(execFile)(
          process.env.OPEN_SCIENCE_TEST_R_COMMAND!,
          ['--vanilla', 'replay.R'],
          { cwd, timeout: 45000 }
        )
        outputs.push(
          await Promise.all(
            ['diff_final.rds', 'diagonal_volcano.png'].map((file) => readFile(join(cwd, file)))
          )
        )
      }
      expect(outputs[0]![0]!.length).toBeGreaterThan(100)
      expect(outputs[0]![1]!.length).toBeGreaterThan(1000)
      expect(outputs[0]).toEqual(outputs[1])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  100000
)
