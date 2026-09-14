import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

it.each([
  'targets::tar_target(result, saveRDS(cohort, "results/model.rds"))',
  'targets::tar_target(command = saveRDS(cohort, "results/model.rds"), result)',
  'targets::tar_target(result, { path <- "wrong.csv"; saveRDS(cohort, "results/model.rds") })'
])('does not promote a deferred write into produced-file evidence: %s', async (definition) => {
  const source = `path <- "inputs/cohort.csv"
${definition}
cohort <- read.csv(path)
previous <- readRDS("results/model.rds")`
  const access = await analyzeNotebookSourceFileAccess('r', source)
  expect(access).toMatchObject({
    reads: ['inputs/cohort.csv', 'results/model.rds'],
    writes: [],
    externalState: 'partial'
  })
  const { facts } = await analyzeRNotebookSource(source)
  expect(facts.priorUsedNames).not.toContain('cohort')
})

it('retains eager options while ignoring the deferred command and branch pattern', async () => {
  const access = await analyzeNotebookSourceFileAccess(
    'r',
    `targets::tar_target(
  name = stage,
  command = readRDS("inputs/deferred.rds"),
  pattern = map(readRDS("inputs/deferred-pattern.rds")),
  resources = readRDS("inputs/resources.rds"),
  description = { writeLines("prepared", "results/setup.txt"); "stage" }
)`
  )
  expect(access.reads).toEqual(['inputs/resources.rds'])
  expect(access.writes).toEqual(['results/setup.txt'])
})

it('does not apply task quotation semantics to a different namespace', async () => {
  const access = await analyzeNotebookSourceFileAccess(
    'r',
    'other::tar_target(stage, readRDS("inputs/eager.rds"))'
  )
  expect(access.reads).toContain('inputs/eager.rds')
  expect(access.externalState).toBe('partial')
})

it('keeps scheduler execution uncertain after creating a task definition', async () => {
  const access = await analyzeNotebookSourceFileAccess(
    'r',
    `targets::tar_target(stage, saveRDS(cohort, "results/model.rds"))
targets::tar_make()`
  )
  expect(access).toMatchObject({ writes: [], writeState: 'partial', externalState: 'partial' })
})

it('preserves uncertainty for tidy injection within a deferred command', async () => {
  const access = await analyzeNotebookSourceFileAccess(
    'r',
    'targets::tar_target(stage, !!readRDS("inputs/injected.rds"))'
  )
  expect(access.readState).toBe('partial')
  expect(access.externalState).toBe('partial')
})

it('does not report a deferred output through an attached task constructor', async () => {
  const access = await analyzeNotebookSourceFileAccess(
    'r',
    `library(targets)
tar_target(stage, saveRDS(cohort, "results/deferred.rds"))`
  )
  expect(access.writes).toEqual([])
})

it('retains quotation through a constructor alias', async () => {
  const access = await analyzeNotebookSourceFileAccess(
    'r',
    `library(targets)
define_stage <- tar_target
define_stage(stage, saveRDS(cohort, "results/deferred.rds"))`
  )
  expect(access.writes).toEqual([])
  expect(access.writeState).toBe('partial')
})

it('retains eager cohort reporting around a deferred multi-stage omics model', async () => {
  const source = `library(jsonlite)
library(targets)
cfg <- jsonlite::fromJSON("inputs/config.json")
samples <- read.csv("inputs/sample-sheet.csv", stringsAsFactors = FALSE)
for (sample in samples$id) {
  raw <- read.csv(file.path("inputs", "omics", sample, "counts.csv"))
  qc <- transform(raw,
    pass = signal > cfg$threshold,
    normalized = signal / median(signal, na.rm = TRUE))
  dir.create("work", showWarnings = FALSE, recursive = TRUE)
  write.csv(qc, file.path("work", paste0(sample, "-qc.csv")), row.names = FALSE)
}
fit <- lm(outcome ~ batch + treatment, data = samples)
model_metrics <- as.data.frame(coef(summary(fit)))
write.csv(model_metrics, "outputs/final-coefficients.csv")
define_stage <- tar_target
model_path <- "outputs/model.rds"
list(
  define_stage(counts, readRDS("work/merged-counts.rds")),
  define_stage(features, {
    system2("feature-tool", c("--input", "work/merged-counts.rds", "--output", "work/features.csv"))
    read.csv("work/features.csv")
  }),
  define_stage(folds, split(samples, samples$fold)),
  define_stage(models, lapply(folds, function(training) {
    lm(outcome ~ batch + treatment, data = training)
  })),
  define_stage(model_artifact, {
    model_path <- "outputs/replaced-model.rds"
    saveRDS(models, "outputs/model.rds")
  })
)
previous_model <- readRDS(model_path)
comparison <- data.frame(previous = length(previous_model), current = length(coef(fit)))
write.csv(comparison, "outputs/model-comparison.csv", row.names = FALSE)`
  expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
    reads: ['inputs/config.json', 'inputs/sample-sheet.csv', 'outputs/model.rds'],
    writes: ['outputs/final-coefficients.csv', 'outputs/model-comparison.csv'],
    readState: 'partial',
    writeState: 'partial',
    externalState: 'partial'
  })
})

it.each([
  'library(targets); tar_target <- function(name, command) command; tar_target(stage, readRDS("inputs/eager.rds"))',
  'library(targets); source("helpers.R"); tar_target(stage, readRDS("inputs/eager.rds"))',
  'targets::tar_target_raw("stage", readRDS("inputs/eager.rds"))'
])('does not hide evaluated arguments behind unproven quotation: %s', async (source) => {
  const access = await analyzeNotebookSourceFileAccess('r', source)
  expect(access.reads).toContain('inputs/eager.rds')
})

it('restores the constructor binding and its dependency across cells', async () => {
  const scripts = ['library(targets)', 'tar_target(stage, saveRDS(cohort, "results/deferred.rds"))']
  const runs: NotebookRunRecord[] = scripts.map((script, index) => ({
    runId: `run-${index}`,
    cellId: `run-${index}`,
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
    workingFiles: []
  }))
  const root = await mkdtemp(join(tmpdir(), 'r-task-context-'))
  try {
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot: root,
      repository: { readSessionRuns: async () => runs }
    })
    const result = await analyzer.project({
      projectId: 'project',
      sessionId: 'session',
      completedRun: runs[1]
    })
    const context = await analyzer.sourceFileAccessContext({
      projectId: 'project',
      sessionId: 'session',
      currentRunId: 'run-1',
      language: 'r',
      environment: 'default-r',
      kernelEpochId: 'epoch'
    })
    expect(result.stalenessByRunId['run-1']).toMatchObject({ state: 'unknown' })
    const { facts } = await analyzeRNotebookSource(scripts[1], context)
    expect(facts.priorUsedNames).toContain('tar_target')
    expect(facts.priorUsedNames).not.toContain('cohort')
    expect(await analyzeNotebookSourceFileAccess('r', scripts[1], context)).toMatchObject({
      writes: [],
      writeState: 'partial'
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
