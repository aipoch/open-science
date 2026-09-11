import { expect, it } from 'vitest'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'
import cells from './reported-r-repel-volcano.fixture.json'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookDependencyAnalyzer } from './dependency-analysis'

it.each([
  'library(dplyr); x <- 1; rule <- x > 0 ~ "yes"; case_when(rule)',
  'library(dplyr); case_when <- custom; case_when(TRUE ~ "yes")',
  'other::case_when(TRUE ~ "yes")',
  'library(dplyr); case_when(TRUE ~ unknown_effect())',
  'ggplot2::geom_text_repel(aes(label=name))',
  'other::geom_text_repel(aes(label=name))',
  'library(ggrepel); geom_unregistered_extension()',
  'library(ggrepel); geom_text_repel(data=function(x) read.csv("extra.csv"))',
  'library(ggrepel); geom_label_repel(stat="custom_stat")',
  'library(ggrepel); geom_text_repel <- custom; geom_text_repel()'
])('retains uncertainty for stored formulas or unverified layer behavior: %s', async (script) => {
  expect((await analyzeNotebookSourceFileAccess('r', script)).readState).not.toBe('complete')
})

it('visits both case_when branches and detects their actual file effects', async () => {
  const files = await analyzeNotebookSourceFileAccess(
    'r',
    'library(dplyr); result <- case_when(TRUE ~ readLines("yes.txt"), FALSE ~ readLines("no.txt")); writeLines(result, "selected.txt")'
  )
  expect(files.reads).toEqual(['no.txt', 'yes.txt'])
  expect(files.writes).toEqual(['selected.txt'])
})

it('keeps external thresholds as dependencies while treating data-mask columns as columns', async () => {
  const { facts } = await analyzeRNotebookSource(
    'library(dplyr); data <- data.frame(pvalue=0.1); result <- mutate(data, label=case_when(pvalue < cutoff ~ "significant", TRUE ~ "other"))'
  )
  expect(facts.possiblyUsedNames).toEqual(expect.arrayContaining(['pvalue', 'cutoff']))
  expect(facts.priorUsedNames).not.toContain('pvalue')
  const direct = await analyzeRNotebookSource(
    'result <- dplyr::case_when(x < cutoff ~ "yes", TRUE ~ "no")'
  )
  expect(direct.facts.priorUsedNames).toEqual(expect.arrayContaining(['x', 'cutoff']))
})

it('recovers the self-contained plot after the blocked installation attempt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'repel-volcano-history-'))
  const runs: NotebookRunRecord[] = cells.map((cell, index) => ({
    runId: cell.runId,
    cellId: cell.runId,
    script: cell.script,
    kernelKind: 'r',
    kernelEpochId: 'r',
    source: 'agent',
    status: cell.status === 'failed' ? 'failed' : 'completed',
    kernelDispatched: cell.status !== 'failed',
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
    expect(projection.stalenessByRunId['5']).toEqual({ state: 'clear' })
    expect(projection.dependenciesByRunId?.['5'] ?? []).not.toContain('4')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.each(cells.filter((cell) => cell.status === 'completed'))(
  'captures the reported labelled volcano run $runId',
  async ({ script, runId }) => {
    const { facts } = await analyzeRNotebookSource(script)
    expect
      .soft(
        facts.state === 'unknown'
          ? facts.reasons.filter((reason) => !['external-state', 'control-flow'].includes(reason))
          : []
      )
      .toEqual([])
    expect.soft(await analyzeNotebookSourceFileAccess('r', script)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: ['inputs/differential-results-333333333333.xlsx'],
      writes: runId === '5' ? ['volcano_plot.pdf', 'volcano_plot.png'] : []
    })
  }
)
