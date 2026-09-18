import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'
import cells from './reported-contrasts-volcano.fixture.json'

it.each(cells)('analyzes contrast cell $index with its preparation', async (cell) => {
  const script =
    cell.index >= 4
      ? cells
          .slice(3, cell.index + 1)
          .map((c) => c.script)
          .join('\n')
      : cell.script
  const { facts } = await analyzeRNotebookSource(script)
  expect(facts.state === 'unknown' ? facts.reasons : [], JSON.stringify(facts)).toEqual([
    'external-state'
  ])
})

it('connects the final plot to all required contrast preparation cells', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contrasts-volcano-'))
  const runs: NotebookRunRecord[] = cells.map((c) => ({
    runId: String(c.index),
    cellId: String(c.index),
    kernelKind: 'r',
    kernelEpochId: 'epoch',
    environment: 'r',
    source: 'agent',
    status: 'completed',
    kernelDispatched: true,
    startedAt: c.index,
    endedAt: c.index + 1,
    script: c.script,
    text: { stdout: '', stderr: '', traceback: '', plain: [] },
    outputs: [],
    workingFiles: []
  }))
  try {
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot: root,
      repository: { readSessionRuns: async () => runs }
    })
    const projection = await analyzer.project({ projectId: 'p', sessionId: 's', throughRunId: '6' })
    for (const index of [3, 4, 5, 6]) {
      expect(projection.stalenessByRunId[String(index)], JSON.stringify(projection)).toEqual({
        state: 'clear'
      })
      const context = await analyzer.sourceFileAccessContext({
        projectId: 'p',
        sessionId: 's',
        currentRunId: String(index),
        language: 'r',
        environment: 'r',
        kernelEpochId: 'epoch'
      })
      expect(
        await analyzeNotebookSourceFileAccess('r', cells[index].script, context)
      ).toMatchObject({
        readState: 'complete',
        writeState: 'complete',
        externalState: 'complete',
        reads: index === 3 ? ['inputs/expression-matrix-444444444444.csv'] : [],
        writes: index === 6 ? ['diagonal_volcano.pdf', 'diagonal_volcano.png'] : []
      })
    }
    expect(projection.dependenciesByRunId?.['3']).toEqual([])
    expect(projection.dependenciesByRunId?.['4']).toContain('3')
    expect(projection.dependenciesByRunId?.['5']).toContain('4')
    expect(projection.dependenciesByRunId?.['6']).toContain('5')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.each(['t(x)', 'base::t(x)', 't(x=x)'])('handles ordinary transpose %s', async (call) => {
  const { facts } = await analyzeRNotebookSource(`x <- matrix(1:6, nrow=2); y <- ${call}`)
  expect(facts.state).toBe('available')
  expect(facts.copyOnModifyNames).toContain('y')
})

it.each([
  'x <- readRDS("input.rds"); y <- t(x)',
  'x <- matrix(1:6,nrow=2); t <- custom; y <- t(x)'
])('keeps transpose dispatch uncertain: %s', async (script) => {
  const { facts } = await analyzeRNotebookSource(script)
  expect(facts.state).toBe('unknown')
})

it('does not execute opaque function bodies or default promises at definition', async () => {
  const { facts } = await analyzeRNotebookSource(
    'unused <- function(x=custom()) { eval(x) }; value <- 1'
  )
  expect(facts.state).toBe('available')
  expect(facts.usedNames).not.toContain('custom')
})

it.each(['unused(1)', 'lapply(1:3, unused)', 'wrapper <- function(x) unused(x); wrapper(1)'])(
  'retains opaque function barriers across cells: %s',
  async (invocation) => {
    const root = await mkdtemp(join(tmpdir(), 'opaque-r-function-'))
    const scripts = ['unused <- function(x) eval(x)', 'value <- 1', invocation]
    const runs: NotebookRunRecord[] = scripts.map((script, index) => ({
      runId: String(index),
      cellId: String(index),
      kernelKind: 'r',
      kernelEpochId: 'epoch',
      environment: 'r',
      source: 'agent',
      status: 'completed',
      kernelDispatched: true,
      startedAt: index,
      endedAt: index + 1,
      script,
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      outputs: [],
      workingFiles: []
    }))
    try {
      const analyzer = new NotebookDependencyAnalyzer({
        storageRoot: root,
        repository: { readSessionRuns: async () => runs }
      })
      const before = await analyzer.project({ projectId: 'p', sessionId: 's', throughRunId: '1' })
      expect(before.stalenessByRunId['1']).toEqual({ state: 'clear' })
      const after = await analyzer.project({ projectId: 'p', sessionId: 's', throughRunId: '2' })
      expect(after.stalenessByRunId['2'].state).toBe('unknown')
      const context = await analyzer.sourceFileAccessContext({
        projectId: 'p',
        sessionId: 's',
        currentRunId: '2',
        language: 'r',
        environment: 'r',
        kernelEpochId: 'epoch'
      })
      expect((await analyzeNotebookSourceFileAccess('r', invocation, context)).externalState).toBe(
        'partial'
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

it.each([
  'unused(1)',
  'wrapper <- function(x) unused(x); wrapper(1)',
  'alias <- unused; alias(1)',
  'lapply(1:3, unused)'
])('keeps opaque function invocation uncertain: %s', async (call) => {
  const { facts } = await analyzeRNotebookSource(`unused <- function(x) eval(x); ${call}`)
  expect(facts.state === 'unknown' ? facts.reasons : []).toContain('opaque-call')
})

it('retains ordinary data after immediate logical masks', async () => {
  const { facts } = await analyzeRNotebookSource(
    'd <- data.frame(x=1:3); cutoff <- 2; d$keep <- with(d, x >= cutoff & !is.na(x)); d <- d[d$keep,,drop=FALSE]'
  )
  expect(facts.state).toBe('available')
  expect(facts.copyOnModifyNames).toContain('d')
  expect(facts.possiblyUsedNames).not.toContain('cutoff')
})

it.each([
  'd <- readRDS("input.rds"); d$keep <- with(d, x > 2)',
  'd <- data.frame(x=1:3); d$keep <- with(d, custom(x))'
])('does not infer arbitrary data-mask result ownership: %s', async (script) => {
  const { facts } = await analyzeRNotebookSource(script)
  expect(facts.copyOnModifyNames).not.toContain('d')
})

it('retains deferred mask dependencies and earlier environment lookups', async () => {
  const { facts } = await analyzeRNotebookSource(
    'library(ggplot2); cutoff <- 2; mapping <- aes(y=x+cutoff); d <- data.frame(x=1:3); keep <- with(d, x > earlier_cutoff)'
  )
  expect(facts.possiblyUsedNames).toEqual(expect.arrayContaining(['cutoff', 'earlier_cutoff']))
})
