import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { analyzeRSources } from './dependency-analysis-r'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'
import { NotebookDependencyAnalyzer, projectNotebookDependencies } from './dependency-analysis'
import type { NotebookDependencyProjection } from './dependency-analysis-types'
import type { NotebookRunRecord } from '../../shared/notebook'

const run = (script: string, index: number): NotebookRunRecord => ({
  runId: `run-${index}`,
  cellId: `cell-${index}`,
  source: 'agent',
  kernelKind: 'r',
  kernelEpochId: 'epoch',
  environment: 'default-r',
  kernelDispatched: true,
  script,
  status: 'completed',
  startedAt: index,
  endedAt: index,
  text: { stdout: '', stderr: '', traceback: '', plain: [] },
  outputs: [],
  workingFiles: []
})
const project = async (scripts: string[]): Promise<NotebookDependencyProjection> => {
  const facts = await analyzeRSources(scripts)
  return projectNotebookDependencies(
    scripts.map((script, index) => ({ run: run(script, index), facts: facts[index] }))
  )
}
const setup = 'library(dplyr)\ndata <- read.csv("inputs/expression.csv")'

// Original expression-table examples based on R4DS row selection and missing-value chapters.
it.each([
  'slice(data, 1:2)',
  'slice_head(data, n=2)',
  'slice_tail(data, prop=0.5)',
  'slice_min(data, order_by=score, n=2, with_ties=FALSE)',
  'slice_max(data, score, n=2, na_rm=TRUE)',
  'relocate(data, gene, .before=score)',
  'data |> slice_min(order_by=score, n=2) |> relocate(gene)',
  'dplyr::slice_head(n=2, .data=data)',
  'mutate(data, score = coalesce(na_if(score, -999), 0))',
  'dplyr::mutate(data, score = dplyr::coalesce(dplyr::na_if(score, -999), 0))'
])('captures tabular selection/cleaning: %s', async (expression) => {
  const script = `${setup}\nresult <- ${expression}\nwrite.csv(result, "selected.csv", row.names=FALSE)`
  expect((await project([script])).stalenessByRunId['run-0']).toEqual({ state: 'clear' })
  expect(await analyzeNotebookSourceFileAccess('r', script)).toMatchObject({
    reads: ['inputs/expression.csv'],
    writes: ['selected.csv'],
    readState: 'complete',
    writeState: 'complete'
  })
})

it('tracks slice limits as environment variables, not data-mask columns', async () => {
  const [facts] = await analyzeRSources([
    'result <- dplyr::slice_min(data, score, n=limit, with_ties=ties)'
  ])
  expect(facts.priorUsedNames).toEqual(expect.arrayContaining(['data', 'limit', 'ties']))
  expect(facts.priorUsedNames).not.toContain('score')
})

it('keeps cleanup fallback dependencies across blocks', async () => {
  const scripts = [
    setup,
    'fallback <- 0',
    'result <- dplyr::mutate(data, score=dplyr::coalesce(dplyr::na_if(score, -999), .env$fallback))',
    'write.csv(result,"clean.csv")'
  ]
  const before = await project(scripts)
  expect(before.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
  expect(before.dependenciesByRunId?.['run-2']).toEqual(['run-0', 'run-1'])
  const after = await project([...scripts, 'fallback <- 5'])
  expect(after.stalenessByRunId['run-2']?.state).toBe('stale')
})

it.each([
  'dplyr::slice_min(data, score, n=limit, by=group, with_ties=ties)',
  'data |> dplyr::slice_min(score, n=limit, by=group, with_ties=ties)'
])('keeps row limits fresh across blocks: %s', async (expression) => {
  const scripts = [
    setup,
    'limit <- 2; ties <- FALSE',
    `result <- ${expression}`,
    'write.csv(result,"top.csv")'
  ]
  const before = await project(scripts)
  expect(before.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
  expect(before.dependenciesByRunId?.['run-2']).toEqual(['run-0', 'run-1'])
  const after = await project([...scripts, 'limit <- 1'])
  expect(after.stalenessByRunId['run-2']?.state).toBe('stale')
  expect(after.stalenessByRunId['run-3']?.state).toBe('stale')
})

it.each([
  'dplyr::slice_head(data, n=length(readLines("inputs/limit.txt")))',
  'data |> dplyr::slice_head(n=length(readLines("inputs/limit.txt")))',
  'dplyr::mutate(data, score=dplyr::coalesce(score, sum(read.csv("inputs/limit.txt"))))'
])('does not hide I/O in selection or cleaning arguments: %s', async (expression) => {
  const access = await analyzeNotebookSourceFileAccess('r', `${setup}\nresult <- ${expression}`)
  expect(access.reads).toEqual(['inputs/expression.csv', 'inputs/limit.txt'])
})

it.each([
  'result <- other::slice_head(data, n=2)',
  'result <- dplyr::slice_sample(data, n=2)',
  'result <- dplyr::slice_head(data, n=custom())',
  'result <- dplyr::mutate(data, score=other::coalesce(score, 0))',
  'result <- dplyr::mutate(data, dplyr::across(score, function(x, coalesce) coalesce(x, 0)))',
  'result <- dplyr::mutate(data, dplyr::across(score, ~ dplyr::coalesce(.x, custom())))',
  'coalesce <- function(...) custom(); result <- dplyr::mutate(data, score=coalesce(score, 0))',
  'slice_head <- function(...) custom(); result <- data |> slice_head(n=2)',
  'slice_head <- function(...) custom(); result <- slice_head(data, n=2)'
])('stays conservative for unknown or shadowed contracts: %s', async (expression) => {
  const script = `${setup}\n${expression}`
  expect((await project([script])).stalenessByRunId['run-0']?.state).toBe('unknown')
  expect((await analyzeNotebookSourceFileAccess('r', script)).readState).toBe('partial')
})

it('keeps explicitly qualified contracts when an unqualified name is shadowed', async () => {
  const scripts = [
    setup,
    'slice_head <- function(...) custom()',
    'result <- dplyr::slice_head(data, n=2)'
  ]
  expect((await project(scripts)).stalenessByRunId['run-2']).toEqual({ state: 'clear' })
})

it.each([
  'dplyr::mutate(data, dplyr::across(score, ~ dplyr::coalesce(dplyr::na_if(.x, -999), 0)))',
  'data |> dplyr::slice_min(score, n=2, by=group) |> dplyr::relocate(dplyr::all_of(columns))'
])('composes with existing callback and column selection contracts: %s', async (expression) => {
  const script = `${setup}\ncolumns <- c("gene", "score")\nresult <- ${expression}`
  expect((await project([script])).stalenessByRunId['run-0']).toEqual({ state: 'clear' })
  expect((await analyzeNotebookSourceFileAccess('r', script)).readState).toBe('complete')
})

it('keeps missing-value vector transformations independent from later source updates', async () => {
  const scripts = [
    'values <- c(1, -999, NA)',
    'cleaned <- dplyr::coalesce(dplyr::na_if(values, -999), 0)',
    'cleaned[1] <- 9'
  ]
  const projection = await project(scripts)
  expect(projection.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  expect((await project([...scripts, 'values[1] <- 3'])).stalenessByRunId['run-1']?.state).toBe(
    'stale'
  )
})

it('preserves row-option dependencies through the persisted analyzer cache', async () => {
  const root = await mkdtemp(join(tmpdir(), 'r-table-analysis-'))
  const runs = [
    setup,
    'limit <- 2',
    'result <- data |> dplyr::slice_head(n=limit)',
    'write.csv(result,"top.csv")'
  ].map(run)
  const analyzer = (): NotebookDependencyAnalyzer =>
    new NotebookDependencyAnalyzer({
      storageRoot: root,
      repository: { readSessionRuns: async () => runs }
    })
  try {
    const request = { projectId: 'project', sessionId: 'session' }
    const initial = await analyzer().project(request)
    expect(initial.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
    expect(await analyzer().project(request)).toEqual(initial)
    runs.push(run('limit <- 1', runs.length))
    const changed = await analyzer().project(request)
    expect(changed.stalenessByRunId['run-2']?.state).toBe('stale')
    expect(changed.stalenessByRunId['run-3']?.state).toBe('stale')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
