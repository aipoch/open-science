import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import type { NotebookDependencyProjection } from './dependency-analysis-types'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'
import { rCallbackPlot } from './reported-r-callback.fixture'
import { R_GGPLOT_GEOMS } from './dependency-analysis-r-evaluation'

const project = async (scripts: string[]): Promise<NotebookDependencyProjection> => {
  const root = await mkdtemp(join(tmpdir(), 'r-callback-analysis-'))
  try {
    const runs: NotebookRunRecord[] = scripts.map((script, index) => ({
      runId: `run-${index}`,
      cellId: `cell-${index}`,
      source: 'agent',
      kernelKind: 'r',
      kernelEpochId: 'epoch',
      environment: 'default-r',
      script,
      status: 'completed',
      startedAt: index,
      endedAt: index,
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      outputs: [],
      artifacts: [],
      workingFiles: [],
      inputFiles: []
    }))
    return await new NotebookDependencyAnalyzer({
      storageRoot: root,
      repository: { readSessionRuns: async () => runs }
    }).project({ projectId: 'project', sessionId: 'session', completedRun: runs.at(-1) })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

it.each([
  rCallbackPlot,
  'factor <- 2\nresult <- lapply(1:3, function(x) round(x * factor))',
  'factor <- 2\nformatter <- function(x) sprintf("%.1f%%", x * factor)\nresult <- lapply(1:3, formatter)',
  'factor <- 2\nresult <- purrr::map_dbl(1:3, ~ round(.x * factor))',
  'factor <- 2\nresult <- vapply(1:3, function(x) { y <- x * factor; round(y) }, numeric(1))',
  'formatter <- function(x, digits=1) round(x, digits)\nresult <- formatter(1.234)',
  'formatter <- function(x) round(x)\nformat_alias <- formatter\nresult <- lapply(1:3, format_alias)',
  'result <- base::lapply(1:3, round)',
  'result <- purrr::map_dbl(1:3, round)',
  'library(ggplot2)\np <- scale_y_continuous(labels=function(x) sprintf("%.1f%%", x))'
])('analyzes R function composition: %s', async (script) => {
  expect((await project([script])).stalenessByRunId['run-0']).toEqual({ state: 'clear' })
  expect(await analyzeNotebookSourceFileAccess('r', script)).toMatchObject({
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete'
  })
})

it.each([
  'lapply(1:3, function(x) round(x * factor))',
  'lapply(1:3, formatter)',
  'formatter(1:3)',
  'purrr::map_dbl(1:3, ~ round(.x * factor))'
])('tracks closure dependencies at invocation: %s', async (call) => {
  const scripts = ['factor <- 2\nformatter <- function(x) round(x * factor)', `result <- ${call}`]
  const before = await project(scripts)
  expect(before.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  expect(before.dependenciesByRunId?.['run-1']).toContain('run-0')
  const after = await project([...scripts, 'factor <- 3'])
  expect(after.stalenessByRunId['run-1']).toMatchObject({ state: 'stale' })
})

it.each([
  'function(x) { total <<- x; x }',
  'function(x) read.csv("hidden.csv")',
  'function(x) assign("total", x, envir=.GlobalEnv)',
  'function(x) eval(parse(text=x))',
  'function(x) { names(x) <- "n"; x }',
  'function(x) custom_transform(x)',
  'function(x, digits=readRDS("hidden.rds")) round(x, digits)',
  'function(x, ...) sum(x, ...)',
  'function(x, sum) sum(x)',
  'function(x) { if (x > 0) y <- x; y }'
])('keeps unresolved function effects conservative: %s', async (fn) => {
  const script = `result <- lapply(1:3, ${fn})`
  expect((await project([script])).stalenessByRunId['run-0']).toMatchObject({ state: 'unknown' })
  expect(await analyzeNotebookSourceFileAccess('r', script)).toMatchObject({ readState: 'partial' })
})

it('does not bind a deferred formatter closure to plot creation time', async () => {
  const projection = await project([
    'library(ggplot2)\nfactor <- 2\np <- ggplot(data.frame(x=1:3,y=1:3),aes(x,y)) + geom_point() + scale_y_continuous(labels=function(x) x * factor)',
    'factor <- 3',
    'ggsave("plot.png", p)'
  ])
  expect(projection.stalenessByRunId['run-0']).toMatchObject({ state: 'unknown' })
})

it('invalidates callable knowledge when a builtin is replaced', async () => {
  const scripts = [
    'formatter <- function(x) round(x)',
    'round <- function(x) readRDS("hidden.rds")',
    'result <- lapply(1:3, formatter)'
  ]
  expect((await project(scripts)).stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
})

it('preserves possible reference sharing through a function return', async () => {
  const projection = await project([
    'env <- new.env()\nenv$value <- 1\nidentity_fn <- function(x) x\nreturned <- identity_fn(env)',
    'print(env$value)',
    'returned$value <- 2'
  ])
  expect(projection.stalenessByRunId['run-1']?.state).not.toBe('clear')
})

it.each([
  'dplyr::mutate(df, dplyr::across(x:y, ~ round(.x * factor)))',
  'df |> dplyr::summarise(dplyr::across(x:y, list(avg = mean, spread = sd)))',
  'df |> dplyr::mutate(dplyr::across(dplyr::where(is.numeric), ~ .x / factor))',
  'df |> dplyr::filter(dplyr::if_any(x:y, ~ .x > factor))',
  'df |> dplyr::filter(dplyr::if_all(x:y, function(x) x > factor))',
  'df |> dplyr::reframe(dplyr::across(dplyr::all_of(columns), formatter))',
  'df |> dplyr::mutate(dplyr::across(x:y))',
  'dplyr::mutate(df, z = lapply(x, function(v) v * factor))',
  'dplyr::mutate(df, z = formatter(x))',
  'dplyr::mutate(df, dplyr::across(x:y, ~ formatter(.x)))',
  'purrr::map_dbl(df$x, ~ formatter(.x))',
  'dplyr::mutate(df, dplyr::across(x:y, base::mean))',
  'dplyr::mutate(df, dplyr::across(base::mean, .cols=x:y))',
  'dplyr::mutate(df, dplyr::across(x:y, .names="copy_{.col}"))',
  'dplyr::rename_with(df, ~ paste0(.x, "_count"), dplyr::all_of(columns))',
  'dplyr::group_map(df, ~ mean(.x$x))',
  'dplyr::group_modify(df, function(.x, .y) data.frame(total=sum(.x$x)))'
])('shares closure analysis with data-mask calls: %s', async (call) => {
  const script = `df <- data.frame(x=1:3, y=4:6); factor <- 2; columns <- c("x", "y"); formatter <- function(x) round(x * factor); result <- ${call}`
  expect((await project([script])).stalenessByRunId['run-0']).toEqual({ state: 'clear' })
  expect(await analyzeNotebookSourceFileAccess('r', script)).toMatchObject({
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete'
  })
})

it('tracks closure and selection values across runs without treating lambda parameters as columns', async () => {
  const scripts = [
    'factor <- 2; columns <- c("x"); formatter <- function(x) x * factor',
    'df <- data.frame(x=1:3); result <- dplyr::mutate(df, dplyr::across(dplyr::all_of(columns), formatter))'
  ]
  const before = await project(scripts)
  expect(before.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  expect(before.dependenciesByRunId?.['run-1']).toContain('run-0')
  for (const change of ['factor <- 3', 'columns <- c("y")']) {
    expect((await project([...scripts, change])).stalenessByRunId['run-1']).toMatchObject({
      state: 'stale'
    })
  }
})

it.each([...R_GGPLOT_GEOMS])('applies the shared layer rule to %s', async (geom) => {
  // Validity of each plot's required aesthetics is ggplot2's responsibility; these tests
  // exercise the shared evaluation contract, including effects hidden in delayed callbacks.
  for (const data of ['', 'data = function(x) x', 'data = ~ .x']) {
    expect(
      await analyzeNotebookSourceFileAccess('r', `p <- ggplot2::${geom}(${data})`)
    ).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete'
    })
  }
  expect(
    await analyzeNotebookSourceFileAccess(
      'r',
      `p <- ggplot2::${geom}(data = function(x) read.csv("hidden.csv"))`
    )
  ).toMatchObject({ readState: 'partial' })
})

it.each([
  'dplyr::mutate(df, dplyr::across(x, function(x) read.csv("hidden.csv")))',
  'dplyr::mutate(df, dplyr::across(x, list(mean, ~ custom(.x))))',
  'dplyr::filter(df, dplyr::if_any(x, ~ { value <<- .x; TRUE }))',
  'dplyr::select(df, dplyr::where(function(x) eval(parse(text=x))))',
  'dplyr::mutate(df, dplyr::across(x, function(x, y = readRDS("hidden.rds")) x + y))',
  'dplyr::mutate(df, custom::across(x, mean))',
  'across <- function(...) readRDS("hidden.rds"); dplyr::mutate(df, across(x, mean))',
  'lapply <- function(...) readRDS("hidden.rds"); lapply(1:3, mean)',
  'p <- ggplot2::geom_point(stat = "custom")',
  'p <- ggplot2::geom_density(position = "custom")',
  'p <- ggplot2::geom_smooth(method = custom_method)',
  'formatter <- function(x) x * factor; p <- ggplot2::geom_point(data = formatter)',
  'p <- extension::geom_point()',
  'p <- geom_custom()',
  'p <- ggplot2::geom_qq(distribution = function(x) read.csv("hidden.csv"))',
  'p <- ggplot2::geom_histogram(binwidth = function(x) readRDS("hidden.rds"))',
  'reader <- function(x) read.csv("hidden.csv"); p <- ggplot2::geom_point(data = reader)',
  'p <- ggplot2::geom_qq(distribution = "custom")',
  'p <- ggplot2::geom_qq(geom = "custom")',
  'formatter <- function(x) round(x); round <- function(x) custom(x); dplyr::mutate(df, dplyr::across(x, ~ formatter(.x)))',
  'p <- ggplot2::ggplot(df, ggplot2::aes(x, y=sapply(x, function(v) v * factor)))',
  'formatter <- function(x) x * factor; p <- ggplot2::ggplot(df, ggplot2::aes(x, y=formatter(x)))'
])('does not certify unresolved shared evaluation effects: %s', async (call) => {
  const script = `df <- data.frame(x=1:3); factor <- 2; ${call}`
  expect(await analyzeNotebookSourceFileAccess('r', script)).toMatchObject({ readState: 'partial' })
})
