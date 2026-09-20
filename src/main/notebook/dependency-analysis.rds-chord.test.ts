import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import type { NotebookRunRecord } from '../../shared/notebook'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'
import cells from './reported-mixed-rds-chord.fixture.json'
import { analyzeRNotebookSource } from './dependency-analysis-r'

const resetPlot = cells[4]!.script.replace('circos.par(', 'circos.clear()\ncircos.par(')

it('reconstructs the reported RDS plot when its plotting parameters are reset before drawing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rds-chord-reset-'))
  try {
    const run: NotebookRunRecord = {
      runId: 'plot',
      cellId: 'plot',
      source: 'agent',
      kernelKind: 'r',
      kernelEpochId: 'r',
      script: resetPlot,
      status: 'completed',
      startedAt: 1,
      endedAt: 2,
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      outputs: [],
      workingFiles: []
    }
    const projection = await new NotebookDependencyAnalyzer({
      storageRoot: root,
      repository: { readSessionRuns: async () => [run] }
    }).project({ projectId: 'p', sessionId: 's', completedRun: run })
    expect(projection.stalenessByRunId.plot).toEqual({ state: 'clear' })
    expect(await analyzeNotebookSourceFileAccess('r', resetPlot)).toMatchObject({
      reads: ['chord_matrix.rds'],
      writes: ['chord_diagram.png'],
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete'
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.each([
  'gsub("[^0-9]", "", labels)',
  'base::sub("^S", "", labels)',
  'grep("^S", labels, value=TRUE)',
  'grepl("[0-9]+$", labels)',
  'regmatches(labels, gregexpr("[0-9]+", labels))',
  'regexec("S([0-9]+)", labels)',
  'strsplit(labels, "S", fixed=TRUE)',
  'tolower(trimws(labels))',
  'toupper(substr(labels, 1, 2))',
  'substring(labels, 2)',
  'chartr("S", "G", labels)',
  'startsWith(labels, "S")',
  'endsWith(labels, "1")',
  'nchar(labels)',
  'nzchar(labels)',
  'strrep(labels, 2)',
  'encodeString(labels)'
])('tracks base string transformations inside scientific indexing: %s', async (expression) => {
  const script = `labels <- c("S1", "S10", "S2")\nresult <- ${expression}\nwrite.csv(result, "labels.csv")`
  const { facts } = await analyzeRNotebookSource(script)
  expect(facts.state === 'unknown' ? facts.reasons : []).not.toContain('opaque-call')
  expect(await analyzeNotebookSourceFileAccess('r', script)).toMatchObject({
    reads: [],
    writes: ['labels.csv'],
    readState: 'complete',
    writeState: 'complete'
  })
})

it.each([
  'gsub <- function(...) source("hidden.R"); gsub("x", "y", "x")',
  'gsub("x", "y", readLines("extra.txt"))',
  'other::gsub("x", "y", "x")'
])('does not hide effects behind string transformations: %s', async (script) => {
  const result = await analyzeNotebookSourceFileAccess('r', script)
  if (script.includes('readLines')) expect(result.reads).toEqual(['extra.txt'])
  else expect(result.readState).not.toBe('complete')
})

it('does not mistake resetting after drawing for a self-contained plot', async () => {
  const { facts } = await analyzeRNotebookSource(cells[4]!.script)
  expect(facts).toMatchObject({
    state: 'unknown',
    reasons: expect.arrayContaining(['graphics-state-unavailable'])
  })
  expect(facts.state === 'unknown' ? facts.reasons : []).not.toContain('function-scope')
})

it('captures the reported Excel inspection and RDS plotting workflow', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rds-chord-analysis-'))
  const runs: NotebookRunRecord[] = cells.map((cell, index) => ({
    runId: `run-${index}`,
    cellId: `cell-${index}`,
    source: 'agent',
    kernelKind: cell.language === 'r' ? 'r' : 'python',
    kernelEpochId: cell.language,
    environment: `default-${cell.language}`,
    script: cell.script,
    status: cell.failed ? 'failed' : 'completed',
    kernelDispatched: true,
    startedAt: index,
    endedAt: index + 1,
    text: { stdout: '', stderr: '', traceback: '', plain: [] },
    outputs: [],
    workingFiles: [],
    inputFiles: []
  }))
  try {
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot: root,
      repository: { readSessionRuns: async () => runs }
    })
    const projection = await analyzer.project({
      projectId: 'p',
      sessionId: 's',
      completedRun: runs[4]!
    })
    for (const index of [0, 1, 3, 4]) {
      expect
        .soft(projection.stalenessByRunId[`run-${index}`], `run-${index}`)
        .toEqual(
          index === 4
            ? { state: 'unknown', reasons: ['graphics-state-unavailable'] }
            : { state: 'clear' }
        )
      const files = await analyzeNotebookSourceFileAccess(
        runs[index]!.kernelKind === 'r' ? 'r' : 'python',
        cells[index]!.script
      )
      expect.soft(files, `files-${index}`).toMatchObject({
        readState: 'complete',
        writeState: 'complete',
        externalState: 'complete',
        reads: [index === 4 ? 'chord_matrix.rds' : 'inputs/edge-weights-222222222222.xlsx'],
        writes: index === 3 ? ['chord_matrix.rds'] : index === 4 ? ['chord_diagram.png'] : []
      })
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.each(['completed', 'failed', 'epoch-change', 'opaque', 'guarded-reset', 'wrapper-reset'])(
  'tracks cross-cell circlize configuration: %s',
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'circlize-config-'))
    const scripts = [
      'library(circlize); circos.clear(); circos.par(start.degree=45)',
      mode === 'opaque'
        ? 'unknown_effect()'
        : mode === 'guarded-reset'
          ? 'tryCatch({circlize::circos.clear(); circlize::circos.par(start.degree=90)}, error=function(e) cat("failed"))'
          : mode === 'wrapper-reset'
            ? 'draw <- function() {circlize::circos.clear(); circlize::chordDiagram(matrix(1:4, 2))}; draw()'
            : 'unrelated <- 42',
      'circlize::circos.par(gap.degree=3)',
      'circlize::chordDiagram(matrix(1:4, 2)); circlize::circos.clear()'
    ]
    const runs: NotebookRunRecord[] = scripts.map((script, index) => ({
      runId: `config-${index}`,
      cellId: `config-${index}`,
      script,
      source: 'agent',
      kernelKind: 'r',
      kernelEpochId: mode === 'epoch-change' && index > 0 ? 'new' : 'original',
      status: mode === 'failed' && index === 0 ? 'failed' : 'completed',
      startedAt: index,
      endedAt: index + 1,
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      outputs: [],
      workingFiles: []
    }))
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const analyzer = new NotebookDependencyAnalyzer({
          storageRoot: root,
          repository: { readSessionRuns: async () => runs }
        })
        const result = await analyzer.project({
          projectId: 'p',
          sessionId: 's',
          completedRun: runs[3]!
        })
        if (mode === 'completed') {
          expect(result.stalenessByRunId['config-3']).toEqual({ state: 'clear' })
          expect(result.dependenciesByRunId?.['config-2']).toContain('config-0')
          expect(result.dependenciesByRunId?.['config-3']).toContain('config-2')
          expect(result.dependenciesByRunId?.['config-3']).not.toContain('config-1')
        } else expect(result.stalenessByRunId['config-3']?.state).toBe('unknown')
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)
