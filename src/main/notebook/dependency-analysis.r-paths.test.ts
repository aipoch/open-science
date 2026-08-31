import { expect, it } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookDependencyAnalyzer, projectNotebookDependencies } from './dependency-analysis'
import { analyzeRSources } from './dependency-analysis-r'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

const cases = [
  ['file.path', 'file.path("inputs", "groups.csv")'],
  ['qualified file.path', 'base::file.path("inputs", "groups.csv")'],
  ['named separator', 'file.path("inputs", "groups.csv", fsep = "/")'],
  ['paste', 'paste("inputs", "groups.csv", sep = "/")'],
  ['paste0', 'paste0("inputs/", "groups.csv")'],
  ['sprintf', 'sprintf("%s/%s", "inputs", "groups.csv")'],
  ['basename', 'file.path("inputs", basename("archive/groups.csv"))'],
  ['dirname', 'file.path(dirname("inputs/old.csv"), "groups.csv")'],
  ['named basename', 'file.path("inputs", base::basename(path="archive/groups.csv"))'],
  ['nested path', 'file.path(base::dirname("inputs/old.csv"), paste0("groups", ".csv"), fsep="/")'],
  ['fs path', 'fs::path("inputs", "groups.csv")']
] as const

it.each([
  ['qualified', 'folder <- "inputs"; name <- "groups"; p <- glue::glue("{folder}/{name}.csv")'],
  [
    'attached',
    'library(glue); folder <- "inputs"; name <- "groups"; p <- glue("{folder}/{name}.csv")'
  ],
  [
    'split template',
    'folder <- "inputs"; name <- "groups"; p <- glue::glue("{folder}", "{name}.csv", .sep="/")'
  ],
  ['whitespace', 'folder <- "inputs"; name <- "groups"; p <- glue::glue("{ folder }/{ name }.csv")']
])('captures %s glue input paths', async (_name, setup) => {
  expect(await analyzeNotebookSourceFileAccess('r', `${setup}\ndf <- read.csv(p)`)).toMatchObject({
    readState: 'complete',
    reads: ['inputs/groups.csv']
  })
})

it.each([
  'library(glue); glue <- function(...) custom_path(); p <- glue("inputs/groups.csv")',
  'glue <- function(...) custom_path(); library(glue); p <- glue("inputs/groups.csv")',
  'if (flag) library(glue); p <- glue("inputs/groups.csv")',
  'library(glue); p <- glue("inputs/{custom_name()}.csv")',
  'library(glue); p <- glue("inputs/{name}.csv", .envir = custom_environment)',
  'library(glue); p <- glue("inputs/{name}.csv", .transformer = custom_transformer)',
  'library(glue); detach("package:glue"); p <- glue("inputs/groups.csv")'
])('does not certify unresolved glue evaluation: %s', async (setup) => {
  expect(await analyzeNotebookSourceFileAccess('r', `${setup}\ndf <- read.csv(p)`)).toMatchObject({
    readState: 'partial'
  })
})

it('captures attached glue vector paths and escaped braces', async () => {
  expect(
    await analyzeNotebookSourceFileAccess(
      'r',
      'library(glue); names <- c("a", "b"); paths <- glue("inputs/{{draft}}-{ names }.csv"); for (path in paths) df <- read.csv(path)'
    )
  ).toMatchObject({
    readState: 'complete',
    reads: ['inputs/{draft}-a.csv', 'inputs/{draft}-b.csv']
  })
})

it('retains attached glue through batch output loops', async () => {
  expect(
    await analyzeNotebookSourceFileAccess(
      'r',
      'library(glue); names <- c("a", "b"); df <- data.frame(x=1); for (name in names) write.csv(df, glue("outputs/{name}.csv")); write.csv(df, glue("outputs/final.csv"))'
    )
  ).toMatchObject({
    readState: 'complete',
    writeState: 'complete',
    writes: ['outputs/a.csv', 'outputs/b.csv', 'outputs/final.csv']
  })
})

it.each(cases)('captures R %s paths without losing dependency evidence', async (_name, path) => {
  const script = `input <- ${path}\ndf <- read.csv(input)\nwrite.csv(df, file.path("outputs", "groups.csv"), row.names=FALSE)`
  const [facts] = await analyzeRSources([script])
  const run: NotebookRunRecord = {
    runId: 'run',
    cellId: 'run',
    source: 'agent',
    kernelKind: 'r',
    kernelEpochId: 'epoch',
    script,
    status: 'completed',
    startedAt: 0,
    endedAt: 1,
    text: { stdout: '', stderr: '', traceback: '', plain: [] },
    outputs: [],
    workingFiles: []
  }
  expect(projectNotebookDependencies([{ run, facts }]).stalenessByRunId.run).toEqual({
    state: 'clear'
  })
  expect(await analyzeNotebookSourceFileAccess('r', script)).toMatchObject({
    readState: 'complete',
    writeState: 'complete',
    reads: ['inputs/groups.csv'],
    writes: ['outputs/groups.csv']
  })
})

it('resolves file.path vector recycling and the named separator consistently', async () => {
  expect(
    await analyzeNotebookSourceFileAccess(
      'r',
      `files <- file.path("inputs", c("a.csv", "b.csv"), fsep="/")
for (path in files) { df <- read.csv(path) }`
    )
  ).toMatchObject({
    readState: 'complete',
    reads: ['inputs/a.csv', 'inputs/b.csv']
  })
})

it.each([
  'files <- file.path("inputs", c("a.csv", "b.csv"), fsep="/")',
  'files <- file.path("inputs", basename(c("archive/a.csv", "archive/b.csv")))'
])('retains character path identity inside batch reads: %s', async (setup) => {
  const [facts] = await analyzeRSources([`${setup}\nfor (path in files) { df <- read.csv(path) }`])
  expect(facts).toMatchObject({ state: 'unknown', reasons: ['external-state'] })
  expect(facts.possiblyMutatedNames).toEqual([])
})

it.each([
  'basename <- function(path) custom_reader(path)\np <- basename("inputs/groups.csv")',
  'p <- otherpkg::basename("inputs/groups.csv")',
  'p <- file.path("inputs", "groups.csv", fsep = custom_separator)',
  'p <- file.path("inputs", "groups.csv", fsep = "/", fsep = ":")',
  'p <- normalizePath("inputs/groups.csv")',
  'p <- file.path("inputs", basename("~/groups.csv"))'
])('keeps unresolved or replaced path operations conservative: %s', async (setup) => {
  expect(await analyzeNotebookSourceFileAccess('r', `${setup}\ndf <- read.csv(p)`)).toMatchObject({
    readState: 'partial'
  })
})

it('does not treat a replaced loop binding as a character path', async () => {
  const [facts] = await analyzeRSources([
    'files <- c("a.csv", "b.csv")\nfor (path in files) { path <- custom_connection(); df <- read.csv(path) }'
  ])
  expect(facts).toMatchObject({
    state: 'unknown',
    reasons: expect.arrayContaining(['opaque-mutation'])
  })
})

const pathRuns = [
  'folder <- "inputs"\ninput <- base::file.path(folder, "groups.csv", fsep="/")',
  'df <- read.csv(input)\noutput <- file.path("outputs", basename(input), fsep="/")\nwrite.csv(df, output, row.names=FALSE)'
]

it.each([
  ['base paths', pathRuns],
  [
    'attached glue',
    [
      'library(glue)\nfolder <- "inputs"\nname <- "groups"',
      'input <- glue("{folder}/{name}.csv")\ndf <- read.csv(input)\nwrite.csv(df, glue("outputs/{name}.csv"), row.names=FALSE)'
    ]
  ]
])('restores %s and dependency edges across R runs', async (_name, scripts) => {
  const root = await mkdtemp(join(tmpdir(), 'r-path-context-'))
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
    expect(result.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
    expect(result.dependenciesByRunId?.['run-1']).toEqual(['run-0'])
    expect(await analyzeNotebookSourceFileAccess('r', scripts[1], context)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      reads: ['inputs/groups.csv'],
      writes: ['outputs/groups.csv']
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.skipIf(!process.env.RUN_KERNEL || !process.env.OPEN_SCIENCE_TEST_R_COMMAND)(
  'matches real R path generation and replays the CSV pipeline in isolated directories',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'r-path-replay-'))
    try {
      for (const directory of ['original', 'replay']) {
        const cwd = join(root, directory)
        await mkdir(join(cwd, 'inputs'), { recursive: true })
        await mkdir(join(cwd, 'outputs'), { recursive: true })
        await writeFile(join(cwd, 'inputs/groups.csv'), 'group\nCtrl\nIRI\n')
        const script = [
          ...pathRuns,
          'library(glue); name <- "groups"; stopifnot(glue("{ folder }", "{ name }.csv", .sep="/") == input)',
          'write.csv(df, glue("outputs/{name}-glue.csv"), row.names=FALSE)',
          ...cases
            .filter(([name]) => name !== 'fs path')
            .map(
              ([, expression]) =>
                `stopifnot(identical(as.character(${expression}), "inputs/groups.csv"))`
            )
        ].join('\n')
        const execution = spawnSync(
          process.env.OPEN_SCIENCE_TEST_R_COMMAND!,
          ['--vanilla', '-e', script],
          { cwd, encoding: 'utf8', timeout: 30000 }
        )
        expect(execution.error).toBeUndefined()
        expect(execution.status, execution.stderr).toBe(0)
      }
      expect(await readFile(join(root, 'original/outputs/groups.csv'))).toEqual(
        await readFile(join(root, 'replay/outputs/groups.csv'))
      )
      expect(await readFile(join(root, 'original/outputs/groups-glue.csv'))).toEqual(
        await readFile(join(root, 'replay/outputs/groups.csv'))
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)
