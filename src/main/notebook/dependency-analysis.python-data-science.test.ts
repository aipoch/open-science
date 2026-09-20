import { expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'
import { analyzePythonSources } from './dependency-analysis-python'
import { NotebookDependencyAnalyzer, projectNotebookDependencies } from './dependency-analysis'
import type { NotebookRunRecord } from '../../shared/notebook'

const run = (script: string, index = 0): NotebookRunRecord => ({
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
  workingFiles: []
})

// Original fixtures informed by Python for Data Analysis and the Python Data Science Handbook.
// https://wesmckinney.com/book/pandas-basics.html#pandas-loc-iloc
// https://wesmckinney.com/book/data-cleaning.html#pandas_missing_filling
const input = 'import pandas as pd\ndf = pd.read_csv("inputs/patients.csv")'

it.each([
  ['column list', 'result = df[["group", "value"]]'],
  ['positional rows and columns', 'result = df.iloc[:3, :2]'],
  ['label rows and columns', 'result = df.loc[:, ["group", "value"]]'],
  ['boolean row filter', 'result = df[df["value"].notna()]'],
  ['membership row filter', 'result = df[df["group"].isin(["Ctrl", "Case"])]'],
  ['grouped column reduction', 'result = df.groupby("group")["value"].mean()'],
  ['forward fill', 'result = df.ffill()'],
  [
    'reshaping',
    'result = df.melt(id_vars="group").pivot_table(index="group", columns="variable", values="value", aggfunc="mean")'
  ]
])('captures Python data science workflow: %s', async (_name, operation) => {
  const script = `${input}\n${operation}\nresult.to_csv("summary.csv", index=False)`
  const [facts] = await analyzePythonSources([script])
  expect(
    projectNotebookDependencies([{ run: run(script), facts }]).stalenessByRunId['run-0']
  ).toEqual({ state: 'clear' })
  expect(await analyzeNotebookSourceFileAccess('python', script)).toMatchObject({
    reads: ['inputs/patients.csv'],
    writes: ['summary.csv'],
    readState: 'complete',
    writeState: 'complete'
  })
})

it.each(['ffill', 'bfill'])(
  'distinguishes %s mutation options from read-only filling',
  async (method) => {
    for (const [option, state] of [
      ['False', 'clear'],
      ['True', 'stale'],
      ['flag', 'unknown']
    ] as const) {
      const scripts = [
        'import pandas as pd\ndata = pd.DataFrame([1, None, 3])\nflag = False',
        'print(data.head())',
        `data.${method}(inplace=${option})`
      ]
      const facts = await analyzePythonSources(scripts)
      const projection = projectNotebookDependencies(
        scripts.map((script, index) => ({ run: run(script, index), facts: facts[index] }))
      )
      expect(projection.stalenessByRunId['run-1']?.state, option).toBe(state)
    }
  }
)

it('does not trust a monkey-patched fill method', async () => {
  const scripts = [
    'import pandas as pd\ndata = pd.DataFrame([1, None, 3])',
    'print(data.head())',
    'data.ffill = custom_fill\ndata.ffill()'
  ]
  const facts = await analyzePythonSources(scripts)
  const projection = projectNotebookDependencies(
    scripts.map((script, index) => ({ run: run(script, index), facts: facts[index] }))
  )
  expect(projection.stalenessByRunId['run-2']?.state).toBe('unknown')
})

it('preserves dependencies from later index axes after the analysis cache reloads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'python-index-cache-'))
  const runs = [
    'import numpy as np\ndata = np.array([[1,2,3], [4,5,6]])',
    'rows = [0,1]',
    'columns = [0,2]',
    'selected = data[rows, columns]',
    'print(selected)'
  ].map(run)
  const request = { projectId: 'project', sessionId: 'session', interpreter: { command: 'unused' } }
  const repository = { readSessionRuns: async () => runs }
  try {
    const initial = await new NotebookDependencyAnalyzer({ storageRoot: root, repository }).project(
      request
    )
    expect(initial.dependenciesByRunId?.['run-3']).toEqual(['run-0', 'run-1', 'run-2'])
    const cache = join(root, 'notebooks/project/session/cache/dependency-analysis.json')
    const sidecar = JSON.parse(await readFile(cache, 'utf8'))
    delete sidecar.projectionSnapshots
    await writeFile(cache, JSON.stringify(sidecar))
    const analyze = vi.fn(async () => {
      throw new Error('valid cached facts must remain reusable')
    })
    const reloaded = await new NotebookDependencyAnalyzer({
      storageRoot: root,
      repository,
      analyze
    }).project(request)
    expect(reloaded).toEqual(initial)
    expect(analyze).not.toHaveBeenCalled()
    runs.push(run('columns.append(1)', runs.length))
    const changed = await new NotebookDependencyAnalyzer({ storageRoot: root, repository }).project(
      request
    )
    expect(changed.stalenessByRunId['run-3']?.state).toBe('stale')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

const python = process.env.OPEN_SCIENCE_TEST_PYTHON
it.skipIf(!process.env.RUN_KERNEL || !python)(
  'agrees with native Python AST about every index dimension',
  async () => {
    const scripts = [
      'selected = data[rows, columns]',
      'selected = data[:, columns]',
      'selected = data[rows:start:step, columns, channels]',
      'data[..., columns] = replacement',
      'del data[rows, columns]',
      'selected = data[(rows, columns)]',
      'selected = data[rows,]',
      'selected = data[:, choose_columns(path)]',
      'selected = data[rows, columns:stop:stride, ...]'
    ]
    const { stdout } = await promisify(execFile)(python!, [
      '-c',
      'import ast, json, sys\nprint(json.dumps([sorted({n.id for n in ast.walk(ast.parse(s)) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load)}) for s in json.loads(sys.argv[1])]))',
      JSON.stringify(scripts)
    ])
    const expected: string[][] = JSON.parse(stdout)
    const facts = await analyzePythonSources(scripts)
    facts.forEach((fact, index) => expect(fact.usedNames, scripts[index]).toEqual(expected[index]))
  }
)

it.skipIf(!process.env.RUN_KERNEL || !python)(
  'runs native NumPy selection and pandas fill with the captured inputs and outputs',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'python-book-native-'))
    const script = `import numpy as np
import pandas as pd
data = np.load("measurements.npy")
selected = data[:, np.load("columns.npy")]
np.save("selected.npy", selected)
frame = pd.read_csv("patients.csv")
filled = frame.ffill(limit=1).bfill(limit=1)
filled.to_csv("filled.csv", index=False)`
    try {
      const { stdout } = await promisify(execFile)(
        python!,
        [
          '-c',
          `import numpy as np\nimport pandas as pd\nimport json
np.save("measurements.npy", np.array([[1,2,3], [4,5,6]]))
np.save("columns.npy", np.array([2,0]))
pd.DataFrame({"value": [None, 1, None, 3]}).to_csv("patients.csv", index=False)
${script}
print(json.dumps({"selected": np.load("selected.npy").tolist(), "filled": pd.read_csv("filled.csv")["value"].tolist(), "original": frame["value"].isna().sum().item()}))`
        ],
        { cwd: root, timeout: 30000 }
      )
      expect(JSON.parse(stdout)).toEqual({
        selected: [
          [3, 1],
          [6, 4]
        ],
        filled: [1, 1, 1, 3],
        original: 2
      })
      expect(await analyzeNotebookSourceFileAccess('python', script)).toMatchObject({
        reads: ['columns.npy', 'measurements.npy', 'patients.csv'],
        writes: ['filled.csv', 'selected.npy'],
        readState: 'complete',
        writeState: 'complete'
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

it.each(['loc', 'iloc'])(
  'retains dependencies in every pandas %s index dimension',
  async (indexer) => {
    const script = `${input}\nresult = df.${indexer}[rows, columns]`
    const [facts] = await analyzePythonSources([script])
    expect(facts.usedNames).toEqual(expect.arrayContaining(['rows', 'columns']))
    expect(facts.priorUsedNames).toEqual(expect.arrayContaining(['rows', 'columns']))
  }
)

it('captures file reads used to compute a later NumPy index dimension', async () => {
  const script =
    'import numpy as np\nvalues = np.load("inputs/measurements.npy")\nselected = values[:, np.load("inputs/columns.npy")]\nnp.save("selected.npy", selected)'
  expect(await analyzeNotebookSourceFileAccess('python', script)).toMatchObject({
    reads: ['inputs/columns.npy', 'inputs/measurements.npy'],
    writes: ['selected.npy'],
    readState: 'complete',
    writeState: 'complete'
  })
})

it('does not drop an unknown call in a later index dimension', async () => {
  const script = `${input}\nselected = df.iloc[:, custom_columns()]`
  const [facts] = await analyzePythonSources([script])
  expect(facts.usedNames).toContain('custom_columns')
  expect((await analyzeNotebookSourceFileAccess('python', script)).readState).toBe('partial')
})

it('tracks reads and mutations in multidimensional assignment', async () => {
  const [facts] = await analyzePythonSources(['matrix[rows, columns] = replacement'])
  expect(facts.usedNames).toEqual(
    expect.arrayContaining(['matrix', 'rows', 'columns', 'replacement'])
  )
  expect(facts.mutatedNames).toContain('matrix')
})

it.each(['0,', '(0,)'])(
  'does not mistake a tuple index for a scalar file-list index: %s',
  async (selector) => {
    expect(
      (
        await analyzeNotebookSourceFileAccess(
          'python',
          `import pandas as pd\npaths = ["patients.csv"]\ndf = pd.read_csv(paths[${selector}])`
        )
      ).readState
    ).toBe('partial')
  }
)

it.each(['DataFrame', 'Series'])(
  'preserves %s fill results across Notebook blocks',
  async (type) => {
    const scripts = [
      `import pandas as pd\ndata = pd.${type}([1, None, 3])`,
      'print(data.head())',
      'filled = data.ffill(limit=1).bfill(limit=1)',
      'filled.to_csv("filled.csv")'
    ]
    const facts = await analyzePythonSources(scripts)
    const projection = projectNotebookDependencies(
      scripts.map((script, index) => ({ run: run(script, index), facts: facts[index] }))
    )
    expect(projection.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
    expect(projection.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
    expect(projection.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
  }
)
