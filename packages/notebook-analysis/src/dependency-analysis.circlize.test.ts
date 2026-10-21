import { NotebookDependencyAnalyzer } from './analysis-test-support'

import { readFileSync } from 'node:fs'

import { mkdtemp, rm } from 'node:fs/promises'

import { tmpdir } from 'node:os'

import { join } from 'node:path'

import { expect, it } from 'vitest'

import type { NotebookRunRecord } from './analysis-test-support'

import type { NotebookDependencyProjection } from './contracts'

import { analyzeRNotebookSource } from './index'

import { analyzeNotebookSourceFileAccess } from './index'

// Owned keys can still dispatch xtfrm; unproven ordering keeps effects partial.
// Known paths and producer/consumer evidence remain checked independently.

const cells = readFileSync(join(__dirname, 'reported-r-circlize.fixture.R'), 'utf8')
  .trim()
  .split('\n\n# %%\n\n')

const explorationCells = readFileSync(
  join(__dirname, 'reported-r-exploration-chord.fixture.R'),
  'utf8'
)
  .trim()
  .split('\n\n# %%\n\n')

const deviceCopyCells = readFileSync(join(__dirname, 'reported-r-device-copy.fixture.R'), 'utf8')
  .trim()
  .split('\n\n# %%\n\n')

const packageReplayCells = readFileSync(
  join(__dirname, 'reported-r-package-replay.fixture.R'),
  'utf8'
)
  .trim()
  .split('\n\n# %%\n\n')

const project = async (
  scripts: string[],
  failedIndex?: number
): Promise<NotebookDependencyProjection> => {
  const root = await mkdtemp(join(tmpdir(), 'circlize-analysis-'))
  const runs: NotebookRunRecord[] = scripts.map((script, index) => ({
    runId: `run-${index}`,
    cellId: `cell-${index}`,
    source: 'agent',
    kernelKind: 'r',
    kernelEpochId: 'epoch',
    environment: 'default-r',
    script,
    status: index === failedIndex ? 'failed' : 'completed',
    kernelDispatched: true,
    startedAt: index,
    endedAt: index + 1,
    text: { stdout: '', stderr: '', traceback: '', plain: [] },
    outputs: [],
    artifacts: [],
    workingFiles: [],
    inputFiles: []
  }))
  try {
    return await new NotebookDependencyAnalyzer({
      storageRoot: root,
      repository: { readSessionRuns: async () => runs }
    }).project({ projectId: 'p', sessionId: 's', completedRun: runs.at(-1)! })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

it.each([0, 1, 3, 4])('analyzes reported circlize cell %s', async (index) => {
  const script = cells[index]!
  const result = await project([script])
  const files = await analyzeNotebookSourceFileAccess('r', script)
  expect(result.stalenessByRunId['run-0']).toMatchObject({
    state: index >= 1 ? 'unknown' : 'clear'
  })
  expect(files).toMatchObject({
    reads: ['inputs/edge-weights-222222222222.xlsx'],
    readState: index >= 1 ? 'partial' : 'complete',
    writeState: index >= 1 ? 'partial' : 'complete',
    externalState: index >= 1 ? 'partial' : 'complete'
  })
  if (index >= 3)
    expect(files.writes).toEqual(
      index === 4
        ? ['chord_diagram.pdf', 'chord_diagram.png', 'chord_diagram_legend.png']
        : ['chord_diagram.pdf', 'chord_diagram.png']
    )
})

it.each([0, 1, 2, 3, 4, 5, 6, 8, 9])(
  'analyzes reported exploration and top-level chord cell %s',
  async (index) => {
    const scripts =
      index === 0
        ? [explorationCells[0]!]
        : index <= 2
          ? [explorationCells[0]!, explorationCells[index]!]
          : [explorationCells[0]!, explorationCells[2]!, explorationCells[index]!]
    const result = await project(scripts)
    expect(result.stalenessByRunId[`run-${scripts.length - 1}`]).toMatchObject({
      state: index >= 3 ? 'unknown' : 'clear'
    })
    expect(await analyzeNotebookSourceFileAccess('r', scripts.join('\n'))).toMatchObject({
      readState: index >= 3 ? 'partial' : 'complete',
      writeState: index >= 3 ? 'partial' : 'complete',
      externalState: index >= 3 ? 'partial' : 'complete',
      reads: ['inputs/edge-weights-222222222222.xlsx']
    })
  }
)

it.each([0, 3, 4, 7])('captures reported device-copy cell %s', async (index) => {
  const script = deviceCopyCells[index]!
  const result = await project([script])
  const files = await analyzeNotebookSourceFileAccess('r', script)
  expect(result.stalenessByRunId['run-0']).toMatchObject({
    state: index >= 4 ? 'unknown' : 'clear'
  })
  expect(files).toMatchObject({
    reads: ['inputs/edge-weights-222222222222.xlsx'],
    readState: index >= 4 ? 'partial' : 'complete',
    writeState: index >= 4 ? 'partial' : 'complete',
    externalState: index >= 4 ? 'partial' : 'complete'
  })
  if (index >= 4) expect(files.writes).toEqual(['chord_diagram.png'])
})

it.each([
  'dev.copy(png,"copy.png")',
  'plot(1:3); dev.copy(which=2)',
  'plot(1:3); dev.print()',
  'png <- function(...) write.csv(1,"hidden.csv"); plot(1:3); dev.copy(png,"copy.png")',
  'plot(1:3); dev.copy(function(...) write.csv(1,"hidden.csv"),"copy.png")',
  'plot(1:3); dev.off(); dev.copy(png,"copy.png")',
  'dev.copy <- function(...) read.csv("hidden.csv"); plot(1:3); dev.copy(png,"copy.png")'
])('keeps unsupported or prior-device export incomplete: %s', async (script) => {
  const files = await analyzeNotebookSourceFileAccess('r', script)
  expect([files.readState, files.writeState, files.externalState]).toContain('partial')
})

it.each([
  ['plot(1:3); dev.copy(png, "copy.png"); dev.off()', 'copy.png'],
  [
    'plot(1:3); grDevices::dev.copy(device=grDevices::png, filename="copy.png"); dev.off()',
    'copy.png'
  ],
  ['plot(1:3); dev.copy(filename="copy.png", device=png); dev.off()', 'copy.png'],
  ['plot(1:3); dev.print(device=pdf, file="copy.pdf")', 'copy.pdf'],
  [
    'plot(1:3); target <- file.path("plots", "copy.tiff"); dev.copy(tiff,target); dev.off()',
    'plots/copy.tiff'
  ]
])('normalizes an explicit graphics export: %s', async (script, path) => {
  const files = await analyzeNotebookSourceFileAccess('r', script)
  expect(files).toMatchObject({
    reads: [],
    writes: [path],
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete'
  })
})

it('keeps mean-based device export uncertain after older redraws or a failed attempt', async () => {
  const result = await project([deviceCopyCells[4]!, deviceCopyCells[6]!, deviceCopyCells[7]!], 1)
  expect(result.stalenessByRunId['run-2']).toMatchObject({
    state: 'unknown',
    reasons: expect.arrayContaining(['opaque-call'])
  })
  expect(result.dependenciesByRunId?.['run-2']).toBeUndefined()
})

it('keeps a redraw with unproven mean callbacks uncertain after package loading', async () => {
  const result = await project(packageReplayCells)
  expect(result.stalenessByRunId['run-6']).toMatchObject({
    state: 'unknown',
    reasons: expect.arrayContaining(['opaque-call'])
  })
  expect(result.dependenciesByRunId?.['run-6']).toBeUndefined()
})

it.each([0, 2, 4, 6])('analyzes reported package replay cell %s', async (index) => {
  const files = await analyzeNotebookSourceFileAccess('r', packageReplayCells[index]!)
  const result = await project([packageReplayCells[index]!])
  expect(result.stalenessByRunId['run-0']).toMatchObject({
    state: index >= 4 ? 'unknown' : 'clear'
  })
  expect(files.readState).toBe(index >= 4 ? 'partial' : 'complete')
})

it.each([
  ['df <- read_excel("input.xlsx")', true],
  ['df <- readxl::read_excel("input.xlsx")', false],
  ['library(readxl); df <- read_excel("input.xlsx")', false],
  ['df <- read_excel("input.xlsx"); library(readxl)', true]
])('tracks package setup in statement order: %s', async (script, needsEarlierLoad) => {
  const result = await project(['library(readxl)', script])
  expect(result.dependenciesByRunId?.['run-1']?.includes('run-0')).toBe(needsEarlierLoad)
})

it('keeps a failed package loader uncertain until explicitly loaded again', async () => {
  const result = await project(
    [
      'library(readxl); stop("failed")',
      'df <- read_excel("input.xlsx")',
      'library(readxl); df <- read_excel("input.xlsx")'
    ],
    0
  )
  expect(result.stalenessByRunId['run-1']?.state).toBe('unknown')
  expect(result.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
})

it('retains a pipe provider even when its data functions are qualified', async () => {
  const result = await project(['library(dplyr)', 'result <- 1 %>% base::round()'])
  expect(result.dependenciesByRunId?.['run-1']).toContain('run-0')
})

it('does not assume a worksheet loop necessarily initialized its last dataframe', async () => {
  const result = await project([
    'library(readxl); sheets <- excel_sheets("input.xlsx"); for (sh in sheets) { df <- read_excel("input.xlsx", sheet=sh) }; write.csv(df,"result.csv")'
  ])
  expect(result.stalenessByRunId['run-0']?.state).toBe('unknown')
})

it('does not discard writes inside a filesystem diagnostic branch', async () => {
  const files = await analyzeNotebookSourceFileAccess(
    'r',
    'if (!file.exists("input.csv")) write.csv(1,"result.csv")'
  )
  expect(files.writes).toContain('result.csv')
  expect(files.externalState).toBe('partial')
})

it('does not certify mean-based redraw dependencies from previous outputs', async () => {
  const result = await project([cells[3]!, cells[4]!])
  expect(result.stalenessByRunId['run-1']).toMatchObject({
    state: 'unknown',
    reasons: expect.arrayContaining(['opaque-call'])
  })
  expect(result.dependenciesByRunId?.['run-1']).toBeUndefined()
})

it('keeps unproven mean redraw uncertain after a failed mixedsort cell', async () => {
  const result = await project([cells[2]!, cells[4]!], 0)
  expect(result.stalenessByRunId['run-1']).toMatchObject({
    state: 'unknown',
    reasons: expect.arrayContaining(['opaque-call'])
  })
  expect(result.dependenciesByRunId?.['run-1']).toBeUndefined()
})

it('retains drawing wrapper paths without certifying unproven mean effects', async () => {
  const source = cells[3]!
  const split = source.indexOf('draw_chord(out_png,')
  const setup = source.slice(0, split)
  const invocation = source.slice(split)
  const result = await project([setup, invocation])
  expect(result.stalenessByRunId['run-1']).toMatchObject({
    state: 'unknown',
    reasons: expect.arrayContaining(['opaque-call'])
  })
  expect(result.dependenciesByRunId?.['run-1']).toBeUndefined()
  const capture = await analyzeRNotebookSource(setup)
  const files = await analyzeNotebookSourceFileAccess('r', invocation, capture.fileAccess!.context)
  // Path-only extraction retains destinations; the full projection above remains unknown.
  expect(files).toMatchObject({
    writeState: 'complete',
    writes: ['chord_diagram.pdf', 'chord_diagram.png']
  })
  const template = await analyzeNotebookSourceFileAccess(
    'r',
    'draw_chord("page-%03d.png", 800, 600, 100)',
    capture.fileAccess!.context
  )
  expect(template.writeState).toBe('partial')
})

it('supports qualified table inspectors without trusting unknown generic dispatch', async () => {
  const ordinary = await analyzeNotebookSourceFileAccess(
    'r',
    'df <- read.csv("input.csv"); utils::head(df); base::summary(df)'
  )
  expect(ordinary).toMatchObject({ readState: 'complete', reads: ['input.csv'] })
  const unknown = await analyzeNotebookSourceFileAccess(
    'r',
    'object <- readRDS("object.rds"); head(object); summary(object)'
  )
  expect(unknown.readState).toBe('partial')
})

it.each([
  ['missing reset', cells[3]!.replaceAll('circos.clear()', '')],
  ['conditional reset', cells[3]!.replaceAll('circos.clear()', 'if (width > 0) circos.clear()')],
  ['unknown panel effect', cells[3]!.replace('sector.name <-', 'opaque_effect(x)\nsector.name <-')],
  ['shadowed layout call', 'circos.clear <- function() source("custom.R")\n' + cells[3]!],
  ['borrowed argument replacement', 'f <- function(x) { x[1] <- 0; x }; x <- 1:3; y <- f(x)']
])('retains uncertainty for %s', async (_label, script) => {
  const result = await project([script])
  expect(result.stalenessByRunId['run-0']?.state).toBe('unknown')
})

it.each([
  'helper <- function(file) { png(file); plot(1); dev.off() }; draw <- function(file) { helper(file) }; draw("plot.png")',
  'helper <- function(file) { png(file); plot(1); dev.off() }; draw <- function(file) { png(file); plot(1); dev.off(); helper("other.png") }; draw("plot.png")',
  'draw <- function(file) { file <- "other.png"; png(file); plot(1); dev.off() }; draw("plot.png")',
  'draw <- function(file, second) { png(file); plot(1); dev.off(); png(second); plot(2); dev.off() }; draw("one.png", "two.png")',
  'draw <- function(file) { png(file); plot(1); dev.off() }; draw("page-%03d.png")',
  'draw <- function(file) { png(file); plot(1); dev.off() }; draw("|command")'
])('keeps unresolved device destinations partial: %s', async (script) => {
  const result = await analyzeNotebookSourceFileAccess('r', script)
  expect(result.writeState).toBe('partial')
})

it('keeps directory metadata as a dependency when it supplies output data', async () => {
  const result = await analyzeNotebookSourceFileAccess(
    'r',
    'sizes <- file.info(list.files())[, "size"]; write.csv(sizes, "sizes.csv")'
  )
  expect(result.externalState).toBe('partial')
})

it.each([
  'library(circlize); circos.trackPlotRegion(panel.fun=function(x,y) circos.text(x,y,"label"))',
  'library(circlize); circos.clear(); chordDiagram(matrix(1:4,2)); circos.trackPlotRegion(panel.fun=function(x,y) write.csv(x,"hidden.csv"))',
  'colorRampPalette <- function(...) function(n) read.csv("hidden.csv"); cols <- colorRampPalette("red")(6)',
  'factory <- function() function() read.csv("hidden.csv"); x <- factory()()',
  'tryCatch(stop("fail"), error=function(e) write.csv(1,"hidden.csv"))',
  'x <- installed.packages(); write.csv(x,"packages.csv")',
  'x <- readRDS("input.rds"); str(x)'
])('retains uncertainty for unsupported effects: %s', async (script) => {
  const files = await analyzeNotebookSourceFileAccess('r', script)
  expect([files.readState, files.writeState, files.externalState]).toContain('partial')
})

it('retains the preparation chain while leaving mean-based drawing uncertain', async () => {
  const result = await project([
    explorationCells[0]!,
    explorationCells[1]!,
    explorationCells[2]!,
    explorationCells[3]!
  ])
  expect(result.stalenessByRunId['run-3']).toMatchObject({
    state: 'unknown',
    reasons: expect.arrayContaining(['opaque-call'])
  })
  expect(result.dependenciesByRunId?.['run-3']).toBeUndefined()
  const drawFacts = (await analyzeRNotebookSource(explorationCells[3]!)).facts
  expect(drawFacts.state === 'unknown' ? drawFacts.reasons : []).toContain('opaque-call')
  expect(result.dependenciesByRunId?.['run-2']).toContain('run-0')
})

it('keeps mean-based redraw uncertain after a failed palette cell', async () => {
  const result = await project([explorationCells[3]!, explorationCells[8]!], 0)
  expect(result.stalenessByRunId['run-1']).toMatchObject({
    state: 'unknown',
    reasons: expect.arrayContaining(['opaque-call'])
  })
  expect(result.dependenciesByRunId?.['run-1']).toBeUndefined()
})

it('does not invent values from a failed palette cell', async () => {
  const result = await project([explorationCells[3]!, explorationCells[7]!], 0)
  expect(result.stalenessByRunId['run-1']?.state).not.toBe('clear')
})

it('records a literal asterisk path without pretending to expand it', async () => {
  const result = await analyzeNotebookSourceFileAccess(
    'r',
    'library(readxl); read_excel("inputs/*-*-222222222222.xlsx")'
  )
  expect(result.reads).toEqual(['inputs/*-*-222222222222.xlsx'])
})
