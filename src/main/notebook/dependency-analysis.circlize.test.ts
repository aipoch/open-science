import { readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import type { NotebookRunRecord } from '../../shared/notebook'
import type { NotebookDependencyProjection } from './dependency-analysis-types'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import { frameRRequest, parseLoopResponse } from './kernel-protocol'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'
import { startWorkingFileObservation } from './working-file-observer'

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
  expect(result.stalenessByRunId['run-0']).toEqual({ state: 'clear' })
  expect(files).toMatchObject({
    reads: ['inputs/edge-weights-222222222222.xlsx'],
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete'
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
    expect(result.stalenessByRunId[`run-${scripts.length - 1}`]).toEqual({ state: 'clear' })
    expect(await analyzeNotebookSourceFileAccess('r', scripts.join('\n'))).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: ['inputs/edge-weights-222222222222.xlsx']
    })
  }
)

it.each([0, 3, 4, 7])('captures reported device-copy cell %s', async (index) => {
  const script = deviceCopyCells[index]!
  const result = await project([script])
  const files = await analyzeNotebookSourceFileAccess('r', script)
  expect(result.stalenessByRunId['run-0']).toEqual({ state: 'clear' })
  expect(files).toMatchObject({
    reads: ['inputs/edge-weights-222222222222.xlsx'],
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete'
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

it('does not make a self-contained device export depend on older redraws or a failed attempt', async () => {
  const result = await project([deviceCopyCells[4]!, deviceCopyCells[6]!, deviceCopyCells[7]!], 1)
  expect(result.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
  expect(result.dependenciesByRunId?.['run-2']).toEqual([])
})

it('retains the package-loading run for the reported redraw', async () => {
  const result = await project(packageReplayCells)
  expect(result.dependenciesByRunId?.['run-6']).toContain('run-2')
})

it.each([0, 2, 4, 6])('analyzes reported package replay cell %s', async (index) => {
  const files = await analyzeNotebookSourceFileAccess('r', packageReplayCells[index]!)
  const result = await project([packageReplayCells[index]!])
  expect(result.stalenessByRunId['run-0']).toEqual({ state: 'clear' })
  expect(files.readState).toBe('complete')
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

it('does not link a self-contained redraw to the previous outputs or variables', async () => {
  const result = await project([cells[3]!, cells[4]!])
  expect(result.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  expect(result.dependenciesByRunId?.['run-1']).toEqual([])
})

it('keeps the complete redraw independent after the failed mixedsort cell', async () => {
  const result = await project([cells[2]!, cells[4]!], 0)
  expect(result.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  expect(result.dependenciesByRunId?.['run-1']).toEqual([])
})

it('carries a drawing wrapper and its paths across cells', async () => {
  const source = cells[3]!
  const split = source.indexOf('draw_chord(out_png,')
  const setup = source.slice(0, split)
  const invocation = source.slice(split)
  const result = await project([setup, invocation])
  expect(result.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  expect(result.dependenciesByRunId?.['run-1']).toContain('run-0')
  const capture = await analyzeRNotebookSource(setup)
  const files = await analyzeNotebookSourceFileAccess('r', invocation, capture.fileAccess!.context)
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

it('keeps exploration out of the required data-to-plot chain', async () => {
  const result = await project([
    explorationCells[0]!,
    explorationCells[1]!,
    explorationCells[2]!,
    explorationCells[3]!
  ])
  expect(result.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  expect(result.dependenciesByRunId?.['run-3']).toContain('run-2')
  expect(result.dependenciesByRunId?.['run-3']).not.toContain('run-1')
  expect(result.dependenciesByRunId?.['run-2']).toContain('run-0')
})

it('keeps a self-contained redraw independent of a failed palette cell', async () => {
  const result = await project([explorationCells[3]!, explorationCells[8]!], 0)
  expect(result.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  expect(result.dependenciesByRunId?.['run-1']).toEqual([])
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

it
  .skipIf(
    process.env.RUN_KERNEL !== '1' ||
      !process.env.OPEN_SCIENCE_TEST_R_ENV ||
      !process.env.OPEN_SCIENCE_TEST_PYTHON
  )
  .each([
    { name: 'package-replay', script: packageReplayCells[6]!, filenames: ['chord_diagram.png'] },
    ...[3, 4].map((index) => ({
      name: `wrapper-${index}`,
      script: cells[index]!,
      filenames: [
        'chord_diagram.pdf',
        'chord_diagram.png',
        ...(index === 4 ? ['chord_diagram_legend.png'] : [])
      ]
    })),
    ...[4, 7].map((index) => ({
      name: `device-copy-${index}`,
      script: deviceCopyCells[index]!,
      filenames: ['chord_diagram.png']
    })),
    ...[3, 5, 8, 9].map((index) => ({
      name: `exploration-${index}`,
      script: [
        'set.seed(42)',
        explorationCells[0],
        explorationCells[2],
        explorationCells[index]
      ].join('\n'),
      filenames:
        index === 8
          ? ['chord_test.png']
          : index === 9
            ? ['test_a.png', 'test_b.png', 'test_c.png']
            : ['chord_diagram.png']
    }))
  ])(
  'captures and replays reported circlize $name in fresh R processes',
  async ({ script: caseScript, filenames, name: caseName }) => {
    const root = await mkdtemp(join(tmpdir(), 'native-circlize-'))
    const execute = promisify(execFile)
    const snapshots: string[][] = []
    let replayScript = caseScript
    if (caseName === 'package-replay') {
      const projection = await project(packageReplayCells)
      const required = new Set(['run-6'])
      const addDependencies = (runId: string): void => {
        for (const dependency of projection.dependenciesByRunId?.[runId] ?? []) {
          if (required.has(dependency)) continue
          required.add(dependency)
          addDependencies(dependency)
        }
      }
      addDependencies('run-6')
      expect([...required].sort()).toEqual(['run-2', 'run-6'])
      // Fix RNG at each test cell boundary: circlize can choose random colors.
      // Package restoration is the subject here, not implicit RNG-state replay.
      replayScript = packageReplayCells
        .filter((_, index) => required.has(`run-${index}`))
        .map((source) => `set.seed(42)\n${source}`)
        .join('\n')
    }
    try {
      for (const name of ['original', 'replay']) {
        const script =
          caseName === 'package-replay' && name === 'original'
            ? packageReplayCells.map((source) => `set.seed(42)\n${source}`).join('\n')
            : replayScript
        const sessionRoot = join(root, name)
        const dataRoot = join(sessionRoot, 'data')
        await mkdir(join(dataRoot, 'inputs'), { recursive: true })
        await execute(
          process.env.OPEN_SCIENCE_TEST_PYTHON!,
          [
            '-c',
            'import pandas as pd; pd.DataFrame([(f"Gene{i}",f"S{j}",float(i+j)) for i in range(1,7) for j in range(1,11)],columns=["from","to","value"]).to_excel("inputs/edge-weights-222222222222.xlsx",index=False,sheet_name="Sheet 1")'
          ],
          { cwd: dataRoot, timeout: 20000 }
        )
        if (name === 'original') {
          await writeFile(join(dataRoot, 'chord_diagram.png'), 'previous generation')
          await writeFile(join(dataRoot, 'chord_diagram.pdf'), 'previous generation')
        }
        const observation = await startWorkingFileObservation({
          dataRoot,
          notebookSessionRoot: sessionRoot,
          cwd: dataRoot,
          code: script,
          language: 'r',
          runId: name
        })
        const figuresRoot = join(sessionRoot, 'figures')
        await mkdir(figuresRoot, { recursive: true })
        // Use the application's device lifecycle. Bare Rscript may open an
        // implicit Rplots.pdf when circlize restores par() after dev.off().
        const execution = execute(
          join(process.env.OPEN_SCIENCE_TEST_R_ENV!, 'bin/Rscript'),
          ['--vanilla', join(__dirname, '../../../resources/notebook/r_loop.R')],
          {
            cwd: dataRoot,
            timeout: 90000,
            env: { ...process.env, OPEN_SCIENCE_KERNEL_FIGURES_DIR: figuresRoot },
            maxBuffer: 8 * 1024 * 1024
          }
        )
        execution.child.stdin!.end(frameRRequest(name, script))
        const output = await execution
        const response = output.stdout
          .split('\n')
          .map(parseLoopResponse)
          .find((item) => item?.reqId === name)
        expect(response).toMatchObject({ error: null })
        expect(response?.stdout).not.toContain('FAIL test_')
        const evidence = await observation.finish()
        expect(evidence.fileEvidence).toMatchObject({
          state: 'available',
          fileReads: 'complete',
          writerAttribution: 'complete',
          reasonCodes: []
        })
        expect(evidence.confirmedReadPaths).toEqual(['data/inputs/edge-weights-222222222222.xlsx'])
        expect(evidence.workingFiles.map((file) => file.relativePath).sort()).toEqual(
          filenames.map((file) => `data/${file}`).sort()
        )
        const hashes: string[] = []
        for (const filename of filenames) {
          const data = await readFile(join(dataRoot, filename))
          if (filename.endsWith('.png')) {
            expect(data.subarray(1, 4).toString()).toBe('PNG')
            hashes.push(createHash('sha256').update(data).digest('hex'))
          } else expect(data.subarray(0, 4).toString()).toBe('%PDF')
        }
        snapshots.push(hashes)
      }
      expect(snapshots[0]).toEqual(snapshots[1])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  240000
)
