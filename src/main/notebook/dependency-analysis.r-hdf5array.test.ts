import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { expect, it } from 'vitest'
import type { NotebookRunRecord } from '../../shared/notebook'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import { projectNotebookDependencies } from './dependency-projection'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

const completedRun = (runId: string, script: string): NotebookRunRecord => ({
  runId,
  cellId: runId,
  source: 'agent',
  inputKind: 'cell',
  kernelKind: 'r',
  kernelEpochId: 'epoch-1',
  environment: 'r',
  script,
  status: 'completed',
  startedAt: Number(runId.slice(-1)),
  endedAt: Number(runId.slice(-1)),
  executionCount: Number(runId.slice(-1)),
  text: { stdout: '', stderr: '', traceback: '', plain: [] },
  outputs: [],
  artifacts: [],
  workingFiles: [],
  inputFiles: []
})

// HDF5Array::HDF5Array creates a delayed, file-backed array; writeHDF5Array
// realizes it into a dataset in a new or existing HDF5 file.
// https://bioconductor.org/packages/release/bioc/manuals/HDF5Array/man/HDF5Array.pdf
it('preserves the source and updated output of a delayed HDF5 workflow', async () => {
  const cells = [
    'counts <- HDF5Array::HDF5Array("inputs/counts.h5", "counts")',
    'normalized <- DelayedArray::log1p(counts)',
    'HDF5Array::writeHDF5Array(normalized, filepath="outputs/normalized.h5", name="logcounts")'
  ]
  const input = await analyzeNotebookSourceFileAccess('r', cells[0]!)
  const output = await analyzeNotebookSourceFileAccess('r', cells[2]!)
  expect(input).toMatchObject({ reads: ['inputs/counts.h5'], readState: 'partial' })
  expect(input.externalState).toBe('partial')
  expect(output).toMatchObject({
    reads: ['outputs/normalized.h5'],
    writes: ['outputs/normalized.h5'],
    readState: 'partial',
    writeState: 'complete',
    externalState: 'partial'
  })
  const consumer = (await analyzeRNotebookSource(cells[2]!)).facts
  expect(consumer.usedNames).toContain('normalized')
  expect(consumer.safeCallNames).toContain('HDF5Array::writeHDF5Array')
})

it('matches the HDF5 path after exact named argument matching', async () => {
  expect(
    await analyzeNotebookSourceFileAccess(
      'r',
      'x <- HDF5Array::HDF5Array(name="counts", filepath="inputs/counts.h5")'
    )
  ).toMatchObject({ reads: ['inputs/counts.h5'], readState: 'partial' })
})

it('preserves unqualified HDF5Array effects when the binding is not shadowed', async () => {
  expect(
    await analyzeNotebookSourceFileAccess(
      'r',
      'library(HDF5Array)\ncounts <- HDF5Array("inputs/counts.h5", "counts")\nwriteHDF5Array(counts, filepath="outputs/counts.h5", name="counts")'
    )
  ).toMatchObject({
    reads: ['inputs/counts.h5', 'outputs/counts.h5'],
    writes: ['outputs/counts.h5'],
    readState: 'partial',
    writeState: 'complete',
    externalState: 'partial'
  })
})

it('links delayed HDF5 values across generated notebook cells', async () => {
  const scripts = [
    'counts <- HDF5Array::HDF5Array("inputs/counts.h5", "counts")',
    'normalized <- DelayedArray::log1p(counts)',
    'HDF5Array::writeHDF5Array(normalized, filepath="outputs/normalized.h5", name="logcounts")'
  ]
  const entries = await Promise.all(
    scripts.map(async (script, index) => ({
      run: completedRun(`run-${index + 1}`, script),
      facts: (await analyzeRNotebookSource(script)).facts,
      fileAccess: await analyzeNotebookSourceFileAccess('r', script)
    }))
  )
  const projection = projectNotebookDependencies(entries)
  expect(entries[1]?.facts.usedNames).toContain('counts')
  expect(entries[1]?.facts.safeCallNames).toContain('DelayedArray::log1p')
  expect(projection.dependenciesByRunId?.['run-2']).toContain('run-1')
  expect(projection.dependenciesByRunId?.['run-3']).toContain('run-2')
})

it('keeps implicit HDF5 dump destinations unresolved', async () => {
  const access = await analyzeNotebookSourceFileAccess(
    'r',
    'HDF5Array::writeHDF5Array(normalized, name="counts")'
  )
  expect(access.writes).toEqual([])
  expect(access.writeState).toBe('partial')
})

it('does not apply the HDF5Array contract to another namespace', async () => {
  const access = await analyzeNotebookSourceFileAccess(
    'r',
    'x <- custom::HDF5Array("secret.h5", "counts"); custom::writeHDF5Array(x, "other.h5")'
  )
  expect(access.reads).toEqual([])
  expect(access.writes).toEqual([])
  expect(
    (await analyzeRNotebookSource('x <- custom::HDF5Array("secret.h5", "counts")')).facts.state
  ).toBe('unknown')
})

configureTestRuntimeMetadata()
