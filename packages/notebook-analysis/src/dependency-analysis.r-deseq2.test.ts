import { expect, it } from 'vitest'
import type { NotebookRunRecord } from './analysis-test-support'
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

it('resolves only bounded unqualified DESeq2 calls from attested attachment order', async () => {
  const context = {
    staticStrings: [],
    staticCollections: [],
    localFileWrappers: [],
    resolvedKernelNames: ['clean', 'samples', 'dds'],
    rAttachedPackages: ['DESeq2', 'stats', 'base']
  }
  for (const [source, name] of [
    [
      'dds <- DESeqDataSetFromMatrix(countData=clean, colData=samples, design=~condition)',
      'DESeqDataSetFromMatrix'
    ],
    ['dds <- DESeq(dds, fitType="mean", quiet=TRUE)', 'DESeq'],
    ['res <- results(dds, contrast=c("condition","treated","control"))', 'results']
  ]) {
    const { facts } = await analyzeRNotebookSource(source!, context)
    expect(facts.state).toBe('available')
    expect(facts.safeCallNames).toContain(`DESeq2::${name}`)
    expect(facts.priorUsedNames).not.toContain('condition')
  }
})

it('does not infer DESeq2 ownership through a masking attachment or global binding', async () => {
  for (const context of [
    { rAttachedPackages: ['unknownPackage', 'DESeq2'] },
    { rAttachedPackages: ['DESeq2'], resolvedKernelNames: ['DESeq'] }
  ]) {
    const { facts } = await analyzeRNotebookSource('dds <- DESeq(dds)', {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      ...context
    })
    expect(facts.safeCallNames ?? []).not.toContain('DESeq2::DESeq')
    expect(facts.priorUsedNames).toContain('DESeq')
  }
})

it.each([
  'DESeq <- function(x) system("touch marker"); dds <- DESeq(dds)',
  'library(limma); dds <- DESeq(dds)',
  'dds <- DESeqDataSetFromMatrix(clean, samples, design_formula)',
  'dds <- DESeqDataSetFromMatrix(clean, samples, ~condition + get("dynamic"))',
  'res <- results(dds, contrast=get_contrast())',
  'dds <- DESeq(dds, callback=function(x) x)'
])('keeps dynamic or rebound attached DESeq2 calls conservative: %s', async (source) => {
  const { facts } = await analyzeRNotebookSource(source, {
    staticStrings: [],
    staticCollections: [],
    localFileWrappers: [],
    rAttachedPackages: ['DESeq2'],
    resolvedKernelNames: ['clean', 'samples', 'dds']
  })
  expect(facts.state).toBe('unknown')
})
