import { expect, it } from 'vitest'
import type { NotebookRunRecord } from '../../shared/notebook'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import { projectNotebookDependencies } from './dependency-projection'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

const run = (script: string, index: number): NotebookRunRecord => ({
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

it('links VCF input, genomic ranges, and variant export across cells', async () => {
  const scripts = [
    'vcf <- VariantAnnotation::readVcf("inputs/cohort.vcf.gz", genome="hg38")',
    'ranges <- VariantAnnotation::rowRanges(vcf)',
    'write.csv(as.data.frame(ranges), "outputs/variants.csv", row.names=FALSE)'
  ]
  const entries = await Promise.all(
    scripts.map(async (script, index) => ({
      run: run(script, index),
      facts: (await analyzeRNotebookSource(script)).facts
    }))
  )
  const projection = projectNotebookDependencies(entries)
  expect(entries[0]?.facts.typeBindings).toEqual(
    expect.arrayContaining([expect.objectContaining({ target: 'vcf', typeName: 'VCF' })])
  )
  expect(entries[1]?.facts.usedNames).toContain('vcf')
  expect(projection.dependenciesByRunId?.['run-1']).toContain('run-0')
  expect(projection.dependenciesByRunId?.['run-2']).toContain('run-1')
  expect(await analyzeNotebookSourceFileAccess('r', scripts[0]!)).toMatchObject({
    reads: ['inputs/cohort.vcf.gz'],
    readState: 'complete'
  })
  expect(await analyzeNotebookSourceFileAccess('r', scripts[2]!)).toMatchObject({
    writes: ['outputs/variants.csv'],
    writeState: 'complete'
  })
})

it('keeps dynamic VCF paths conservative', async () => {
  const script = 'vcf <- VariantAnnotation::readVcf(input_path, genome="hg38")'
  const { facts } = await analyzeRNotebookSource(script)
  expect(facts.typeBindings ?? []).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ target: 'vcf', typeName: 'VCF' })])
  )
  expect(await analyzeNotebookSourceFileAccess('r', script)).toMatchObject({
    readState: 'partial'
  })
})

it('keeps remote VCF inputs as unresolved external evidence', async () => {
  const script =
    'vcf <- VariantAnnotation::readVcf("https://example.test/cohort.vcf.gz", genome="hg38")'
  expect(await analyzeNotebookSourceFileAccess('r', script)).toMatchObject({
    reads: ['https://example.test/cohort.vcf.gz'],
    readState: 'partial'
  })
})
