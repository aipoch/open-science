import { expect, it } from 'vitest'
import type { NotebookRunRecord } from '../../shared/notebook'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import {
  projectNotebookDependencies,
  projectNotebookFileDependencies
} from './dependency-projection'
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

it('captures Arrow Dataset directory roots while keeping coverage partial', async () => {
  const access = await analyzeNotebookSourceFileAccess(
    'r',
    'dataset <- arrow::open_dataset("inputs/events", format = "parquet")'
  )

  expect(access).toMatchObject({
    readState: 'partial',
    writeState: 'complete',
    reads: ['inputs/events'],
    reasonCodes: expect.arrayContaining(['dynamic-path-unresolved'])
  })
})

it('keeps Arrow Dataset directory lineage conservative across cells', async () => {
  const scripts = [
    'dataset <- arrow::open_dataset("inputs/events", format = "parquet")',
    'events <- dplyr::collect(dataset)',
    'arrow::write_parquet(events, "outputs/positive-events.parquet")'
  ]
  const runs = scripts.map((script, index) => completedRun(`run-${index + 1}`, script))
  const facts = await analyzeRNotebookSource(scripts[1]!)
  expect(facts.facts.usedNames ?? []).toContain('dataset')
  expect(facts.facts.safeCallNames ?? []).toContain('dplyr::collect')
  const sameCellFacts = await analyzeRNotebookSource(scripts.slice(0, 2).join('\n'))
  expect(sameCellFacts.facts.typeBindings).toEqual(
    expect.arrayContaining([
      { target: 'dataset', typeName: 'arrow.Dataset', argumentNames: [] },
      { target: 'events', typeName: 'arrow.Table', argumentNames: ['dataset'] }
    ])
  )
  const analyzedRuns = await Promise.all(
    runs.map(async (run) => ({
      run,
      facts: (await analyzeRNotebookSource(run.script)).facts,
      fileAccess: await analyzeNotebookSourceFileAccess('r', run.script)
    }))
  )
  const projection = projectNotebookDependencies(analyzedRuns)
  expect(projection.dependenciesByRunId?.['run-2']).toContain('run-1')
  expect(projection.dependenciesByRunId?.['run-3']).toContain('run-2')
  const fileProjection = projectNotebookFileDependencies(analyzedRuns)
  expect(fileProjection.unresolvedFileReadRunIds).toContain('run-1')
})

it('keeps dynamic Arrow Dataset sources conservative', async () => {
  const access = await analyzeNotebookSourceFileAccess(
    'r',
    'source_root <- choose.files(); dataset <- arrow::open_dataset(source_root)'
  )

  expect(access.readState).toBe('partial')
  expect(access.reasonCodes).toEqual(expect.arrayContaining(['dynamic-path-unresolved']))
})
