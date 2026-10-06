import { expect, it } from 'vitest'
import type { NotebookRunRecord } from '../../shared/notebook'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import { projectNotebookDependencies } from './dependency-projection'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

const completedRun = (script: string, index: number): NotebookRunRecord => ({
  runId: `run-${index}`,
  cellId: `cell-${index}`,
  source: 'agent',
  kernelKind: 'r',
  kernelEpochId: 'epoch',
  environment: 'r',
  kernelDispatched: true,
  script,
  status: 'completed',
  startedAt: index,
  endedAt: index + 1,
  text: { stdout: '', stderr: '', traceback: '', plain: [] },
  outputs: [],
  workingFiles: []
})

it('links phyloseq construction and static taxonomic transforms across cells', async () => {
  const scripts = [
    'counts <- matrix(c(1, 2, 3, 4), nrow=2)\nps <- phyloseq::phyloseq(phyloseq::otu_table(counts, taxa_are_rows=TRUE))',
    'collapsed <- phyloseq::tax_glom(ps, taxrank="Phylum")',
    'totals <- phyloseq::sample_sums(collapsed)'
  ]
  const entries = await Promise.all(
    scripts.map(async (script, index) => ({
      run: completedRun(script, index),
      facts: (await analyzeRNotebookSource(script)).facts
    }))
  )
  const projection = projectNotebookDependencies(entries)
  expect(entries[0]?.facts.typeBindings).toEqual(
    expect.arrayContaining([expect.objectContaining({ target: 'ps', typeName: 'phyloseq' })])
  )
  expect(entries[1]?.facts.usedNames).toContain('ps')
  expect(projection.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
  expect(projection.dependenciesByRunId?.['run-2']).toEqual(expect.arrayContaining(['run-1']))
})

it('keeps callback-driven phyloseq transforms conservative', async () => {
  const { facts } = await analyzeRNotebookSource(
    'ps <- phyloseq::phyloseq(phyloseq::otu_table(matrix(1:4, nrow=2), taxa_are_rows=TRUE))\nnormalized <- phyloseq::transform_sample_counts(ps, function(x) x / sum(x))'
  )
  expect(facts.state).toBe('unknown')
  if (facts.state === 'unknown') expect(facts.reasons).toContain('opaque-call')
})

it('captures BIOM input lineage for a phyloseq import', async () => {
  const script = 'ps <- phyloseq::import_biom("inputs/community.biom")'
  const { facts } = await analyzeRNotebookSource(script)
  expect(facts.typeBindings).toEqual(
    expect.arrayContaining([expect.objectContaining({ target: 'ps', typeName: 'phyloseq' })])
  )
  expect(await analyzeNotebookSourceFileAccess('r', script)).toMatchObject({
    reads: ['inputs/community.biom'],
    readState: 'complete'
  })
})

it('does not trust an unqualified phyloseq constructor after local shadowing', async () => {
  const { facts } = await analyzeRNotebookSource(
    "phyloseq <- function(...) read.csv('inputs/hidden.csv')\nps <- phyloseq(matrix(1:4, nrow=2))"
  )
  expect(facts.state).toBe('unknown')
  if (facts.state === 'unknown') expect(facts.reasons).toContain('opaque-call')
  await expect(
    analyzeNotebookSourceFileAccess(
      'r',
      "phyloseq <- function(...) read.csv('inputs/hidden.csv')\nps <- phyloseq(matrix(1:4, nrow=2))"
    )
  ).resolves.toMatchObject({ readState: 'partial' })
})
