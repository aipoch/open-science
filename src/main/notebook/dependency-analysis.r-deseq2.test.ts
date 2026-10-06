import { expect, it } from 'vitest'
import type { NotebookRunRecord } from '../../shared/notebook'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import { projectNotebookDependencies } from './dependency-projection'

const run = (script: string, index: number): NotebookRunRecord => ({
  runId: `run-${index}`,
  cellId: `cell-${index}`,
  source: 'agent',
  kernelKind: 'r',
  kernelEpochId: 'epoch-1',
  environment: 'r',
  script,
  status: 'completed',
  startedAt: index,
  endedAt: index + 1,
  executionCount: index,
  text: { stdout: '', stderr: '', traceback: '', plain: [] },
  outputs: [],
  workingFiles: []
})

it('links a DESeq2 count model through fit, results, and transform cells', async () => {
  const scripts = [
    'counts <- read.csv("inputs/counts.csv")\nmetadata <- read.csv("inputs/metadata.csv")\ndds <- DESeq2::DESeqDataSetFromMatrix(countData = counts, colData = metadata, design = ~ condition)',
    'dds <- DESeq2::DESeq(dds)',
    'res <- DESeq2::results(dds, contrast = c("condition", "treated", "control"))',
    'rld <- DESeq2::rlog(dds, blind = FALSE)'
  ]
  const entries = await Promise.all(
    scripts.map(async (script, index) => ({
      run: run(script, index + 1),
      facts: (await analyzeRNotebookSource(script)).facts
    }))
  )
  const projection = projectNotebookDependencies(entries)

  expect(entries[0]?.facts.typeBindings).toEqual(
    expect.arrayContaining([expect.objectContaining({ target: 'dds', typeName: 'DESeqDataSet' })])
  )
  expect(entries[1]?.facts.safeCallNames).toContain('DESeq2::DESeq')
  expect(entries[2]?.facts.safeCallNames).toContain('DESeq2::results')
  expect(entries[3]?.facts.safeCallNames).toContain('DESeq2::rlog')
  expect(projection.dependenciesByRunId?.['run-2']).toContain('run-1')
  expect(projection.dependenciesByRunId?.['run-3']).toContain('run-2')
  expect(projection.dependenciesByRunId?.['run-4']).toContain('run-2')
})

it('keeps dynamic DESeq2 designs conservative', async () => {
  const { facts } = await analyzeRNotebookSource(
    'dds <- DESeq2::DESeqDataSetFromMatrix(countData = counts, colData = metadata, design = design_formula)'
  )

  expect(facts.typeBindings ?? []).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ target: 'dds', typeName: 'DESeqDataSet' })])
  )
  expect(facts.state).toBe('unknown')
  expect(facts.state === 'unknown' ? facts.reasons : []).toContain('opaque-call')
})

it('rejects effectful calls embedded in DESeq2 formulas', async () => {
  const { facts } = await analyzeRNotebookSource(
    'dds <- DESeq2::DESeqDataSetFromMatrix(countData = counts, colData = metadata, design = ~ condition + system("touch outputs/marker"))'
  )

  expect(facts.typeBindings ?? []).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ target: 'dds', typeName: 'DESeqDataSet' })])
  )
  expect(facts.state).toBe('unknown')
  expect(facts.state === 'unknown' ? facts.reasons : []).toContain('opaque-call')
})

it('does not trust a DESeq2 constructor from another namespace', async () => {
  const { facts } = await analyzeRNotebookSource(
    'dds <- custom::DESeqDataSetFromMatrix(countData = counts, colData = metadata, design = ~ condition)'
  )

  expect(facts.typeBindings ?? []).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ target: 'dds', typeName: 'DESeqDataSet' })])
  )
  expect(facts.state).toBe('unknown')
  expect(facts.state === 'unknown' ? facts.reasons : []).toContain('opaque-call')
})
