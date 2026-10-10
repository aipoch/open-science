import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
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

it('links MultiAssayExperiment assay selection across multi-omics cells', async () => {
  const scripts = [
    'mae <- MultiAssayExperiment::MultiAssayExperiment(experiments=list(rna=matrix(1:4, nrow=2), protein=matrix(5:8, nrow=2)))',
    'rna <- MultiAssayExperiment::assay(mae, "rna")',
    'write.csv(rna, "outputs/rna-assay.csv", row.names=FALSE)'
  ]
  const entries = await Promise.all(
    scripts.map(async (script, index) => ({
      run: run(script, index),
      facts: (await analyzeRNotebookSource(script)).facts
    }))
  )
  const projection = projectNotebookDependencies(entries)
  expect(entries[0]?.facts.typeBindings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ target: 'mae', typeName: 'MultiAssayExperiment' })
    ])
  )
  expect(entries[1]?.facts.usedNames).toContain('mae')
  expect(projection.dependenciesByRunId?.['run-1']).toContain('run-0')
  expect(projection.dependenciesByRunId?.['run-2']).toContain('run-1')
  expect(await analyzeNotebookSourceFileAccess('r', scripts[2]!)).toMatchObject({
    writes: ['outputs/rna-assay.csv'],
    writeState: 'complete'
  })
})

configureTestRuntimeMetadata()
