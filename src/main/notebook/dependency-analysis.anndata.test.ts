import { expect, it } from 'vitest'
import type { NotebookRunRecord } from '../../shared/notebook'
import { analyzePythonSources } from './dependency-analysis-python'
import { projectNotebookDependencies } from './dependency-projection'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

it.each(['scanpy', 'anndata', 'anndata.io'])(
  'keeps %s file provenance and object mutation knowledge aligned',
  async (module) => {
    for (const reader of ['read_h5ad', 'read_mtx', 'read_loom', 'read_text', 'read_csv']) {
      const scripts = [
        `from ${module} import ${reader} as read_input\nitem = read_input(filename="inputs/cells.dat")`,
        'snapshot = item.n_obs\nprint(snapshot)',
        'item.obs_names_make_unique()'
      ]
      const facts = await analyzePythonSources(scripts)
      const analyzed = scripts.map((script, index) => {
        const run: NotebookRunRecord = {
          runId: `run-${index}`,
          cellId: `cell-${index}`,
          source: 'agent',
          kernelKind: 'python',
          kernelEpochId: 'epoch',
          environment: 'default-python',
          script,
          status: 'completed',
          startedAt: index,
          endedAt: index,
          text: { stdout: '', stderr: '', traceback: '', plain: [] },
          outputs: [],
          artifacts: [],
          workingFiles: [],
          inputFiles: []
        }
        return { run, facts: facts[index]! }
      })
      const projection = projectNotebookDependencies(analyzed)
      expect(projection.stalenessByRunId['run-1']).toMatchObject({ state: 'stale' })
      expect(projection.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
      expect(await analyzeNotebookSourceFileAccess('python', scripts[0]!)).toMatchObject({
        readState: 'complete',
        reads: ['inputs/cells.dat']
      })
    }
  }
)

it('does not confuse a module text reader with a Path method', async () => {
  expect(
    await analyzeNotebookSourceFileAccess(
      'python',
      'import scanpy as sc\nx = sc.read_text("inputs/cells.tsv")'
    )
  ).toMatchObject({ readState: 'complete', reads: ['inputs/cells.tsv'] })
  expect(
    await analyzeNotebookSourceFileAccess(
      'python',
      'from pathlib import Path\nx = Path("inputs/notes.txt").read_text()'
    )
  ).toMatchObject({ readState: 'complete', reads: ['inputs/notes.txt'] })
})

it.each([
  ['write_h5ad', '', 'stale'],
  ['write', '', 'stale'],
  ['write_h5ad', ', convert_strings_to_categoricals=True', 'stale'],
  ['write_h5ad', ', convert_strings_to_categoricals=False', 'clear'],
  ['write_h5ad', ', convert_strings_to_categoricals=flag', 'unknown'],
  ['write_h5ad', ', **options', 'unknown']
])('tracks %s conversion side effects (%s)', async (method, options, expected) => {
  const scripts = [
    'import anndata as ad\nitem = ad.read_h5ad("cells.h5ad")',
    'snapshot = item.obs.copy()',
    `item.${method}("result.h5ad"${options})`
  ]
  const facts = await analyzePythonSources(scripts)
  const projection = projectNotebookDependencies(
    scripts.map((script, index) => {
      const run: NotebookRunRecord = {
        runId: `run-${index}`,
        cellId: `cell-${index}`,
        source: 'agent',
        kernelKind: 'python',
        kernelEpochId: 'epoch',
        environment: 'default-python',
        script,
        status: 'completed',
        startedAt: index,
        endedAt: index,
        text: { stdout: '', stderr: '', traceback: '', plain: [] },
        outputs: [],
        artifacts: [],
        workingFiles: [],
        inputFiles: []
      }
      return { run, facts: facts[index]! }
    })
  )
  expect(projection.stalenessByRunId['run-1']?.state).toBe(expected)
})
