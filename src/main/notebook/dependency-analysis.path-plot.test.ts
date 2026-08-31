import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookDependencyAnalyzer, projectNotebookDependencies } from './dependency-analysis'
import { analyzePythonSources } from './dependency-analysis-python'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'
import { reportedPathInput, reportedPathPlots } from './reported-python-path-plot.fixture'

it.each([
  ['Path construction', 'from pathlib import Path\np = Path("inputs/data.csv")'],
  ['aliased Path', 'from pathlib import Path as FilePath\np = FilePath("inputs/data.csv")'],
  ['qualified Path', 'import pathlib as paths\np = paths.Path("inputs/data.csv")'],
  [
    'pure path composition',
    'from pathlib import PurePath\np = PurePath("inputs").joinpath("data.csv").with_suffix(".tsv")\nprint(p.as_posix())'
  ],
  ['Index conversion', 'import pandas as pd\ns = pd.Series([1, 2])\nlabels = s.index.tolist()'],
  ['values conversion', 'import pandas as pd\ns = pd.Series([1, 2])\nvalues = s.values.tolist()'],
  ['reported input', reportedPathInput],
  ['reported plots', `${reportedPathInput}\n${reportedPathPlots}`]
])('analyzes %s without opaque state', async (_name, script) => {
  const [facts] = await analyzePythonSources([script])
  const run: NotebookRunRecord = {
    runId: 'probe',
    cellId: 'probe',
    source: 'agent',
    kernelKind: 'python',
    kernelEpochId: 'epoch',
    script,
    status: 'completed',
    startedAt: 0,
    endedAt: 0,
    text: { stdout: '', stderr: '', traceback: '', plain: [] },
    outputs: [],
    workingFiles: []
  }
  expect(projectNotebookDependencies([{ run, facts }]).stalenessByRunId.probe).toEqual({
    state: 'clear'
  })
})

it.each([
  'from pathlib import Path\nPath = custom_path\np = Path("data.csv")',
  'from custom_paths import Path\np = Path("data.csv")',
  'import pathlib\npathlib.Path = custom_path\np = pathlib.Path("data.csv")'
])('keeps unknown or replaced path behavior conservative: %s', async (script) => {
  const [facts] = await analyzePythonSources([script])
  const run: NotebookRunRecord = {
    runId: 'probe',
    cellId: 'probe',
    source: 'agent',
    kernelKind: 'python',
    kernelEpochId: 'epoch',
    script,
    status: 'completed',
    startedAt: 0,
    endedAt: 0,
    text: { stdout: '', stderr: '', traceback: '', plain: [] },
    outputs: [],
    workingFiles: []
  }
  expect(projectNotebookDependencies([{ run, facts }]).stalenessByRunId.probe.state).toBe('unknown')
})

it('captures the exact Path input and both reported outputs', async () => {
  expect(
    await analyzeNotebookSourceFileAccess('python', `${reportedPathInput}\n${reportedPathPlots}`)
  ).toMatchObject({
    reads: ['inputs/sample-groups-666666666666.csv'],
    writes: ['synthetic_groups_bar.png', 'synthetic_groups_pie.png'],
    readState: 'complete',
    writeState: 'complete'
  })
})

it.each(['unknown_operation', 'unlink', 'resolve', 'exists'])(
  'does not turn Path.%s filesystem effects into complete file evidence',
  async (method) => {
    expect(
      await analyzeNotebookSourceFileAccess(
        'python',
        `from pathlib import Path\np = Path("data.csv")\np.${method}()`
      )
    ).toMatchObject({
      readState: 'partial'
    })
  }
)

it('links both plots to the prior Path input run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'path-plot-analysis-'))
  const runs: NotebookRunRecord[] = [reportedPathInput, reportedPathPlots].map((script, index) => ({
    runId: `run-${index}`,
    cellId: `cell-${index}`,
    source: 'agent',
    kernelKind: 'python',
    kernelEpochId: 'epoch',
    kernelDispatched: true,
    environment: 'default-python',
    script,
    status: 'completed',
    startedAt: index,
    endedAt: index,
    text: { stdout: '', stderr: '', traceback: '', plain: [] },
    outputs: [],
    artifacts: [],
    inputFiles: [],
    workingFiles: []
  }))
  try {
    const result = await new NotebookDependencyAnalyzer({
      storageRoot: root,
      repository: { readSessionRuns: async () => runs }
    }).project({ projectId: 'project', sessionId: 'session', completedRun: runs[1] })
    expect(result.stalenessByRunId['run-0']).toEqual({ state: 'clear' })
    expect(result.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
    expect(result.dependenciesByRunId?.['run-1']).toEqual(['run-0'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
