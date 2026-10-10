import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { describe, expect, it, vi } from 'vitest'
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

describe('nested definition header scope isolation', () => {
  it.each([
    'def inner(scale=[helper for helper in [1, 2]]):\n        return 0',
    'async def inner(*, scale={helper for helper in [1, 2]}):\n        return 0',
    'def inner(scale={helper: 1 for helper in [1, 2]}):\n        return 0',
    'def inner(scale=(helper for helper in [1, 2])):\n        return 0',
    '@decorate([helper for helper in [1, 2]])\n    def inner():\n        return 0'
  ])('preserves enclosing helper captures beside %s', async (declaration) => {
    for (const method of [false, true]) {
      const body = `def callback(${method ? 'self, ' : ''}t, value):\n    ${declaration}\n    return helper(value)`
      const source = method ? 'class Model:\n' + body.replace(/^/gm, '    ') : body
      const [facts] = await analyzePythonSources([source])
      const summary = facts.typeSummaries?.find(
        (item) => item.name === (method ? 'Model' : 'python-function:callback')
      )
      expect(
        summary?.methods.find((item) => item.name === (method ? 'callback' : '__call__'))?.usedNames
      ).toContain('helper')
    }
    const scripts = [
      'from scipy.integrate import solve_ivp\nGLOBAL_CAPTURE = 1',
      `def helper(value):\n    return GLOBAL_CAPTURE * value\ndef callback(t, value):\n    ${declaration}\n    return helper(value)`,
      'result = solve_ivp(callback, (0, 1), [0])',
      'GLOBAL_CAPTURE = 2'
    ]
    const projection = await projectPythonScripts(scripts)
    expect(projection.invalidatedByRunId['run-4']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: 'run-3',
          names: expect.arrayContaining(['GLOBAL_CAPTURE'])
        })
      ])
    )
    expect(projection.stalenessByRunId['run-3'].state).toBe('unknown')
  })
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

it('analyzes a recorded helper module when a later cell invokes it', async () => {
  const helper = `import pandas as pd\ndef read_inputs():\n    return pd.read_csv("inputs/patients.csv")`
  const script = 'frame = read_inputs()\nframe.to_csv("summary.csv", index=False)'
  const [facts] = await analyzePythonSources([`${helper}\n${script}`])
  expect(facts.state).toBe('available')
  expect(facts.definedNames).toEqual(expect.arrayContaining(['read_inputs', 'frame']))
  expect(facts.receiverCalls?.some(({ receiver }) => receiver === 'read_inputs')).toBe(true)
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

// SciPy periodogram returns frequency/power arrays and accepts an arbitrary detrend callback.
// https://docs.scipy.org/doc/scipy/reference/generated/scipy.signal.periodogram.html
const projectPythonScripts = async (
  scripts: string[]
): Promise<Awaited<ReturnType<NotebookDependencyAnalyzer['project']>>> => {
  const runs: NotebookRunRecord[] = []
  const storageRoot = await mkdtemp(join(tmpdir(), 'python-scientific-lineage-'))
  const analyzer = new NotebookDependencyAnalyzer({
    storageRoot,
    repository: { readSessionRuns: async () => runs }
  })
  try {
    let projection: Awaited<ReturnType<NotebookDependencyAnalyzer['project']>> | undefined
    for (const [index, script] of scripts.entries()) {
      const completedRun = {
        runId: `run-${index + 1}`,
        cellId: `cell-${index + 1}`,
        source: 'agent',
        inputKind: 'cell',
        kernelKind: 'python',
        kernelEpochId: 'epoch-1',
        environment: 'default-python',
        script,
        status: 'completed',
        startedAt: index + 1,
        endedAt: index + 1,
        executionCount: index + 1,
        text: { stdout: '', stderr: '', traceback: '', plain: [] },
        outputs: [],
        artifacts: [],
        workingFiles: [],
        inputFiles: []
      } satisfies NotebookRunRecord
      runs.push(completedRun)
      projection = await analyzer.project({
        projectId: 'project',
        sessionId: 'session',
        completedRun,
        interpreter: { command: 'unused-python' }
      })
    }
    if (!projection) throw new Error('Python lineage requires at least one cell')
    return projection
  } finally {
    await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

describe('SciPy periodogram multi-cell lineage', () => {
  it.each(['spectrum', 'frequency, *power', '*frequency, power', '*spectrum,', 'first = second'])(
    'keeps unsupported periodogram output assignment shapes opaque: %s',
    async (target) => {
      const [facts] = await analyzePythonSources([
        `import numpy as np\nfrom scipy.signal import periodogram\ny = np.array([1., 2., 1., 2.])\n${target} = periodogram(y)`
      ])
      expect(facts?.typeBindings?.filter((binding) => binding.target !== 'y')).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ typeName: 'numpy.ndarray' })])
      )
      expect(
        facts?.receiverCalls?.find((call) => call.receiver.includes('periodogram'))?.resultNames
      ).toEqual([])
    }
  )

  it('does not assign the first array type to a tuple consumed in another cell', async () => {
    const projection = await projectPythonScripts([
      'import numpy as np\nfrom scipy import signal\ny = np.array([1., 2., 1., 2.])',
      'spectrum = signal.periodogram(y, detrend="constant")',
      'print(spectrum[1].mean())'
    ])
    expect(projection.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
  })

  it('supports an exact list assignment of both array returns', async () => {
    const [facts] = await analyzePythonSources([
      'import numpy as np\nfrom scipy.signal import periodogram\ny = np.array([1., 2., 1., 2.])\n[frequency, power] = periodogram(y)'
    ])
    expect(facts?.typeBindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: 'frequency', typeName: 'numpy.ndarray' }),
        expect.objectContaining({ target: 'power', typeName: 'numpy.ndarray' })
      ])
    )
  })

  it('does not preserve an input snapshot when a detrend callback can mutate the input', async () => {
    const projection = await projectPythonScripts([
      'import numpy as np\nfrom scipy import signal\ny = np.array([1., 2., 1., 2.])',
      'input_snapshot = y.mean()\nprint(input_snapshot)',
      'def center(segment):\n    segment.fill(0)\n    return segment',
      'frequency, power = signal.periodogram(y, detrend=center)'
    ])
    expect(projection.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
    expect(projection.stalenessByRunId['run-4']).toMatchObject({ state: 'unknown' })
  })

  it.each([
    'y',
    'y, detrend="constant"',
    'y, detrend="linear"',
    'y, detrend=False',
    'y, 1.0, "boxcar", None, "linear"',
    'y, 1.0, "boxcar", None, False'
  ])('certifies only literal built-in detrend options: %s', async (arguments_) => {
    const source = `import numpy as np\nfrom scipy import signal\ny = np.array([1., 2., 1., 2.])\nfrequency, power = signal.periodogram(${arguments_})`
    expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete'
    })
    const projection = await projectPythonScripts([source, 'print(power.max())'])
    expect(projection.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
    expect(projection.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
  })

  it.each([
    'y, detrend=mode',
    'y, detrend="custom"',
    'y, detrend=True',
    'y, 1.0, "boxcar", None, mode',
    'y, **options',
    'y, detrend="constant", **options',
    '*arguments'
  ])(
    'keeps dynamic, unsupported or expanded detrend options conservative: %s',
    async (arguments_) => {
      const source = `import numpy as np\nfrom scipy import signal\ny = np.array([1., 2., 1., 2.])\nmode = "constant"\noptions = {}\narguments = [y]\nfrequency, power = signal.periodogram(${arguments_})`
      expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
      const projection = await projectPythonScripts([source, 'print(power.max())'])
      expect(projection.stalenessByRunId['run-1']).toMatchObject({ state: 'unknown' })
      expect(projection.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
    }
  )

  it.each([
    ['from scipy import signal', 'signal.periodogram'],
    ['import scipy.signal as sig', 'sig.periodogram'],
    ['from scipy.signal import periodogram as spectrum', 'spectrum']
  ])('types both periodogram outputs through %s', async (imports, call) => {
    const [facts] = await analyzePythonSources([
      `import numpy as np\n${imports}\ny = np.array([1., 2., 1., 2.])\nfrequency, power = ${call}(y, fs=1.0, detrend="constant")`
    ])
    expect(facts?.typeBindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: 'frequency', typeName: 'numpy.ndarray' }),
        expect.objectContaining({ target: 'power', typeName: 'numpy.ndarray' })
      ])
    )
  })

  it('links max to the spectrum and limits output mutation to the fresh output', async () => {
    const scripts = [
      'import numpy as np\nfrom scipy import signal\ny = np.array([1., 2., 1., 2.])',
      'input_snapshot = y.mean()\nprint(input_snapshot)',
      'frequency, power = signal.periodogram(y, fs=1.0, detrend="constant")',
      'peak = power.max()\nprint(peak)',
      'power.fill(0)'
    ]
    const beforeMutation = await projectPythonScripts(scripts.slice(0, 4))
    expect(beforeMutation.dependenciesByRunId?.['run-3']).toContain('run-1')
    expect(beforeMutation.dependenciesByRunId?.['run-4']).toContain('run-3')
    const projection = await projectPythonScripts(scripts)
    expect(projection.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
    expect(projection.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
    expect(projection.stalenessByRunId['run-4']).toMatchObject({ state: 'stale' })
    expect(projection.stalenessByRunId['run-5']).toEqual({ state: 'clear' })
  })

  it.each(['y, fs=1.0, detrend=center', 'y, 1.0, "boxcar", None, center'])(
    'retains captures of opaque detrend without certifying it: %s',
    async (arguments_) => {
      const projection = await projectPythonScripts([
        'import numpy as np\nfrom scipy import signal\ny = np.array([1., 2., 1., 2.])\noffset = 3.',
        'def center(segment):\n    return calibrate(segment, offset)',
        `frequency, power = signal.periodogram(${arguments_})`,
        'print(power.max())',
        'offset = 4.'
      ])
      expect(projection.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
      expect(projection.dependenciesByRunId?.['run-3']).toBeUndefined()
      expect(projection.stalenessByRunId['run-4']).toMatchObject({ state: 'unknown' })
      expect(projection.invalidatedByRunId['run-5']).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ runId: 'run-3', state: 'unknown', names: ['offset'] })
        ])
      )
    }
  )

  it.each([
    '    segment.fill(0)\n    return segment + offset',
    '    Path("outputs/callback.txt").write_text(str(offset))\n    return segment',
    '    return external_center(segment, offset)'
  ])('does not certify a typed result from effectful or opaque detrend: %s', async (body) => {
    const scripts = [
      'import numpy as np\nfrom scipy import signal\nfrom pathlib import Path\ny = np.array([1., 2., 1., 2.])\noffset = 3.',
      `def center(segment):\n${body}`,
      'frequency, power = signal.periodogram(y, detrend=center)',
      'print(power.max())'
    ]
    const projection = await projectPythonScripts(scripts)
    expect(projection.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
    expect(projection.stalenessByRunId['run-4']).toMatchObject({ state: 'unknown' })
    expect(projection.dependenciesByRunId?.['run-3']).toBeUndefined()
    const access = await analyzeNotebookSourceFileAccess('python', scripts.join('\n'))
    expect(access).toMatchObject({ readState: 'partial', writeState: 'partial' })
  })

  it('does not reuse periodogram semantics after replacing the imported callable', async () => {
    const [facts] = await analyzePythonSources([
      'from scipy.signal import periodogram\nperiodogram = replacement\nfrequency, power = periodogram(y)'
    ])
    expect(facts?.typeBindings ?? []).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: 'power', typeName: 'numpy.ndarray' })
      ])
    )
  })

  it('does not certify a replaced periodogram module member', async () => {
    const projection = await projectPythonScripts([
      'import numpy as np\nfrom scipy import signal\ny = np.array([1., 2., 1., 2.])',
      'signal.periodogram = replacement',
      'frequency, power = signal.periodogram(y, detrend="constant")',
      'print(power.max())'
    ])
    expect(projection.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
    expect(projection.stalenessByRunId['run-4']).toMatchObject({ state: 'unknown' })
    expect(projection.dependenciesByRunId?.['run-3']).toBeUndefined()
  })
})

// Reduced from a real multi-cell mercury vapor-pressure fit: both callbacks
// capture ordinary globals, and the Jacobian reads a scale file and appends a trace.
// https://docs.scipy.org/doc/scipy/reference/generated/scipy.optimize.curve_fit.html
describe('SciPy curve_fit callback lineage', () => {
  const setup = [
    'import numpy as np',
    'from scipy.optimize import curve_fit',
    'kelvin_offset = 273.15',
    'ref_temperature = 298.15',
    'temperatures = np.array([0.0, 20.0, 40.0])',
    'log_observed = np.array([-8.5, -6.7, -5.1])',
    'baseline_a = -6.0',
    'baseline_b = -7000.0'
  ].join('\n')
  const callbacks = [
    'def model_fn(temp_c, a, b):',
    '    return a + b * (1.0 / (temp_c + kelvin_offset) - 1.0 / ref_temperature)',
    'def jac_fn(temp_c, a, b):',
    '    with open("outputs/jacobian-scale.txt", "r") as fh:',
    '        scale = float(fh.read().strip())',
    '    n = len(temp_c)',
    '    dinv = 1.0 / (temp_c + kelvin_offset) - 1.0 / ref_temperature',
    '    with open("outputs/jacobian-calls.txt", "a") as fo:',
    '        fo.write("jac_fn called n=%d\\n" % n)',
    '    return np.column_stack([np.ones(n), dinv]) * scale'
  ].join('\n')
  const calls = [
    'popt, pcov = curve_fit(model_fn, temperatures, log_observed, p0=[-6.0, -7000.0], jac=jac_fn, method="lm", absolute_sigma=False)',
    'popt, pcov = curve_fit(model_fn, temperatures, log_observed, [baseline_a, baseline_b], None, False, None, (-np.inf, np.inf), "lm", jac_fn)'
  ]

  it.each(
    calls.flatMap((call) => ['ref_temperature', 'kelvin_offset'].map((name) => [name, call]))
  )('retains captured %s when a later cell changes it after %s', async (name, call) => {
    const projection = await projectPythonScripts([
      setup,
      callbacks,
      call,
      `${name} = ${name === 'ref_temperature' ? '318.15' : '274.15'}`
    ])
    expect(projection.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
    expect(projection.dependenciesByRunId?.['run-3']).toBeUndefined()
    expect(projection.invalidatedByRunId['run-4']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runId: 'run-3', state: 'unknown', names: [name] })
      ])
    )
    const facts = await analyzePythonSources([setup, callbacks, call])
    expect(facts[2]?.typeBindings ?? []).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: expect.stringMatching(/^(popt|pcov)$/) })
      ])
    )
  })

  // Isolate each callback so one cannot mask missing metadata for the other.
  it.each([
    ['model', 'popt, pcov = curve_fit(model_fn, temperatures, log_observed)'],
    [
      'Jacobian',
      'popt, pcov = curve_fit(lambda temp_c, a, b: a + b * temp_c, temperatures, log_observed, jac=jac_fn)'
    ]
  ])('retains both global captures from the %s callback alone', async (_callback, call) => {
    const projection = await projectPythonScripts([
      setup,
      callbacks,
      call,
      'ref_temperature = 318.15\nkelvin_offset = 274.15'
    ])
    expect(projection.invalidatedByRunId['run-4']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: 'run-3',
          state: 'unknown',
          names: expect.arrayContaining(['ref_temperature', 'kelvin_offset'])
        })
      ])
    )
  })
})

// Reduced from a real solar-spectrum workflow with a calibrated detrend callback.
// https://docs.scipy.org/doc/scipy/reference/generated/scipy.signal.welch.html
describe('SciPy Welch callback lineage', () => {
  const setup = [
    'import numpy as np',
    'from scipy.signal import welch',
    'x = np.array([1.0, 2.0, 1.0, 2.0])',
    'spectral_gain = 1.0',
    'calls_log_path = "outputs/detrend-calls.txt"'
  ].join('\n')
  const callback = [
    'def detrend_calibrated(segment):',
    '    s = np.asarray(segment, dtype=np.float64)',
    '    with open("outputs/detrend-scale.txt", "r") as fh:',
    '        scale = float(fh.read().strip())',
    '    g = spectral_gain',
    '    with open(calls_log_path, "a") as log_fh:',
    '        log_fh.write("gain={:.17g} shape={}\\n".format(g, s.shape))',
    '    return (s - np.mean(s, axis=-1, keepdims=True)) * g * scale'
  ].join('\n')

  it.each([
    'freq, psd = welch(x, fs=12, window="boxcar", nperseg=256, noverlap=128, nfft=256, detrend=detrend_calibrated)',
    'freq, psd = welch(x, 12, "boxcar", 256, 128, 256, detrend_calibrated)'
  ])('retains callback captures across cells without typing outputs: %s', async (call) => {
    const projection = await projectPythonScripts([
      setup,
      callback,
      call,
      'spectral_gain = 2.0\ncalls_log_path = "outputs/another-trace.txt"'
    ])
    expect(projection.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
    expect(projection.dependenciesByRunId?.['run-3']).toBeUndefined()
    expect(projection.invalidatedByRunId['run-4']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: 'run-3',
          state: 'unknown',
          names: expect.arrayContaining(['spectral_gain', 'calls_log_path'])
        })
      ])
    )
    const facts = await analyzePythonSources([setup, callback, call])
    expect(facts[2]?.typeBindings ?? []).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: expect.stringMatching(/^(freq|psd)$/) })
      ])
    )
  })

  it('keeps expanded Welch callback options and result ownership opaque', async () => {
    const scripts = [
      setup,
      callback,
      'options = {"detrend": detrend_calibrated}\nfreq, psd = welch(x, **options)'
    ]
    expect(await analyzeNotebookSourceFileAccess('python', scripts.join('\n'))).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    const projection = await projectPythonScripts(scripts)
    expect(projection.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
    const facts = await analyzePythonSources(scripts)
    expect(facts[2]?.typeBindings ?? []).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: expect.stringMatching(/^(freq|psd)$/) })
      ])
    )
  })

  it('does not certify arrays or ownership after replacing the Welch module member', async () => {
    const scripts = [
      'import numpy as np\nfrom scipy import signal\nx = np.array([1.0, 2.0, 1.0, 2.0])',
      'signal.welch = lambda segment: (segment, segment)',
      'freq, psd = signal.welch(x)'
    ]
    const projection = await projectPythonScripts(scripts)
    expect(projection.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
    expect(projection.dependenciesByRunId?.['run-3']).toBeUndefined()
    const facts = await analyzePythonSources(scripts)
    expect(facts[2]?.typeBindings ?? []).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: expect.stringMatching(/^(freq|psd)$/) })
      ])
    )
  })
})

describe('SciPy named callback container candidates', () => {
  // Reduced from the executed LakeHuron callback list; no scientific execution.
  const setup = [
    'from scipy.integrate import solve_ivp',
    'THRESHOLD_PATH = "inputs/threshold-low.txt"',
    'def rhs(t, y):',
    '    return [1.0]',
    'def threshold():',
    '    with open(THRESHOLD_PATH) as handle:',
    '        return float(handle.read())',
    'def terminal_event(t, y):',
    '    class EventMetadata:',
    '        def threshold(self, dummy):',
    '            return dummy',
    '    _ = EventMetadata',
    '    return y[0] - threshold()',
    'terminal_event.terminal = True',
    'terminal_event.direction = 1'
  ].join('\n')
  const solve = 'solution = solve_ivp(rhs, (0, 97), [0.0], events=event_callbacks)'
  const rebindPath = 'THRESHOLD_PATH = "inputs/threshold-high.txt"'
  const capturesPath = (
    projection: Awaited<ReturnType<typeof projectPythonScripts>>,
    solverRunId: string,
    lastRunId: string
  ): boolean =>
    (projection.invalidatedByRunId[lastRunId] ?? []).some(
      (item) => item.runId === solverRunId && item.names.includes('THRESHOLD_PATH')
    )

  it.each(['[terminal_event]', '(terminal_event,)'])(
    'retains nested helper captures from a named literal %s without certification',
    async (members) => {
      const binding = 'event_callbacks = ' + members
      const projection = await projectPythonScripts([setup, binding, solve, rebindPath])
      expect(capturesPath(projection, 'run-3', 'run-4')).toBe(true)
      expect(projection.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
      const combined = [setup, binding, solve].join('\n')
      const [facts] = await analyzePythonSources([combined])
      expect(facts.typeBindings ?? []).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ target: 'solution' })])
      )
      expect(await analyzeNotebookSourceFileAccess('python', combined)).toMatchObject({
        readState: 'partial',
        writeState: 'partial',
        externalState: 'partial'
      })
    }
  )

  it('supports a fresh function and container in one source', async () => {
    const projection = await projectPythonScripts([
      setup + '\nevent_callbacks = [terminal_event]',
      solve,
      rebindPath
    ])
    expect(capturesPath(projection, 'run-2', 'run-3')).toBe(true)
  })

  it.each(['terminal_event.terminal = False', 'terminal_event.direction = -1'])(
    'preserves function captures through metadata write %s',
    async (metadata) => {
      const projection = await projectPythonScripts([
        setup,
        'event_callbacks = [terminal_event]',
        metadata,
        solve,
        rebindPath
      ])
      expect(capturesPath(projection, 'run-4', 'run-5')).toBe(true)
      expect(projection.stalenessByRunId['run-4']).toMatchObject({ state: 'unknown' })
    }
  )

  it.each([
    'event_callbacks.append(rhs)',
    'alias = event_callbacks\nalias.append(rhs)',
    'event_callbacks = other_events',
    'terminal_event = rhs',
    'alias = terminal_event',
    'terminal_event.__code__ = rhs.__code__',
    'terminal_event.__defaults__ = (0,)',
    'unknown_mutator(event_callbacks)',
    'unknown_mutator(terminal_event)',
    'exec(source)',
    'if flag:\n    event_callbacks = [rhs]'
  ])('discards untrustworthy candidate history after %s', async (operation) => {
    const projection = await projectPythonScripts([
      setup,
      'event_callbacks = [terminal_event]',
      operation,
      solve,
      rebindPath
    ])
    expect(capturesPath(projection, 'run-4', 'run-5')).toBe(false)
    expect(projection.stalenessByRunId['run-4']).toMatchObject({ state: 'unknown' })
  })

  it.each([
    ['list opaque call', '[terminal_event]', '', 'unknown_mutator(event_callbacks)'],
    ['tuple opaque call', '(terminal_event,)', '', 'unknown_mutator(event_callbacks)'],
    [
      'list mutating helper',
      '[terminal_event]',
      '\ndef replace_event(events):\n    events[0] = rhs',
      'replace_event(event_callbacks)'
    ],
    [
      'list zero-argument mutating helper',
      '[terminal_event]',
      '\ndef replace_event():\n    event_callbacks[0] = rhs',
      'replace_event()'
    ]
  ])(
    'discards a named candidate after same-cell exposure: %s',
    async (_description, members, helper, operation) => {
      const projection = await projectPythonScripts([
        setup + helper,
        'event_callbacks = ' + members,
        operation + '\n' + solve,
        rebindPath
      ])
      expect(capturesPath(projection, 'run-3', 'run-4')).toBe(false)
      expect(projection.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
    }
  )

  it.each(['same', 'prior'])(
    'discards a candidate after a %s-cell dynamic namespace helper',
    async (boundary) => {
      const scripts = [
        setup + '\nSOURCE = "event_callbacks.clear()"\ndef replace_event():\n    exec(SOURCE)',
        'event_callbacks = [terminal_event]',
        ...(boundary === 'same' ? ['replace_event()\n' + solve] : ['replace_event()', solve]),
        rebindPath
      ]
      const projection = await projectPythonScripts(scripts)
      expect(capturesPath(projection, 'run-' + (scripts.length - 1), 'run-' + scripts.length)).toBe(
        false
      )
      expect(projection.stalenessByRunId['run-' + (scripts.length - 1)]).toMatchObject({
        state: 'unknown'
      })
    }
  )

  it('discards a candidate when a nested solver argument helper mutates its global list', async () => {
    const projection = await projectPythonScripts([
      setup + '\ndef replace_event():\n    event_callbacks[0] = rhs\n    return [0.0]',
      'event_callbacks = [terminal_event]',
      solve.replace('[0.0]', 'replace_event()'),
      rebindPath
    ])
    expect(capturesPath(projection, 'run-3', 'run-4')).toBe(false)
    expect(projection.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
  })

  it('discards a candidate when a nested solver argument helper changes its namespace', async () => {
    const projection = await projectPythonScripts([
      setup +
        '\nSOURCE = "event_callbacks.clear()"\ndef replace_event():\n    exec(SOURCE)\n    return [0.0]',
      'event_callbacks = [terminal_event]',
      solve.replace('[0.0]', 'replace_event()'),
      rebindPath
    ])
    expect(capturesPath(projection, 'run-3', 'run-4')).toBe(false)
    expect(projection.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
  })

  it.each([
    'event_callbacks = [terminal_event]\nterminal_event = rhs',
    'if flag:\n    event_callbacks = [terminal_event]',
    'event_callbacks = [entry for entry in (terminal_event,)]',
    'event_callbacks = {"event": terminal_event}'
  ])('does not invent a captured identity for %s', async (binding) => {
    const projection = await projectPythonScripts([setup, binding, solve, rebindPath])
    expect(capturesPath(projection, 'run-3', 'run-4')).toBe(false)
  })

  it.each([
    'event_callbacks = [terminal_event]',
    'def late_event(t, y):\n    return y[0] - threshold()\nevent_callbacks = [late_event]'
  ])('does not use a later container assignment for an earlier solver call: %s', async (later) => {
    for (const earlier of [
      solve,
      'def preview(dummy=solve_ivp(rhs, (0, 97), [0.0], events=event_callbacks)):\n    pass',
      'if flag:\n    ' + solve
    ]) {
      const projection = await projectPythonScripts([
        setup,
        'event_callbacks = [rhs]',
        earlier + '\n' + later,
        rebindPath
      ])
      expect(capturesPath(projection, 'run-3', 'run-4')).toBe(false)
    }
    const firstSource = await projectPythonScripts([
      setup + '\n' + solve + '\n' + later,
      rebindPath
    ])
    expect(capturesPath(firstSource, 'run-1', 'run-2')).toBe(false)
  })

  it('expands only a bare named container, preserving direct inline callback handling', async () => {
    for (const argument of ['event_callbacks.pop', '[event_callbacks]']) {
      const projection = await projectPythonScripts([
        setup,
        'event_callbacks = [terminal_event]',
        solve.replace('events=event_callbacks', 'events=' + argument),
        rebindPath
      ])
      expect(capturesPath(projection, 'run-3', 'run-4')).toBe(false)
    }
    const inline = await projectPythonScripts([
      setup,
      solve.replace('events=event_callbacks', 'events=[terminal_event]'),
      rebindPath
    ])
    expect(capturesPath(inline, 'run-2', 'run-3')).toBe(true)
  })

  it.each(['failed', 'epoch', 'environment'] as const)(
    'does not carry a candidate across an %s boundary',
    async (boundary) => {
      const scripts = [setup, 'event_callbacks = [terminal_event]', solve, rebindPath]
      const facts = await analyzePythonSources(scripts)
      const runs = scripts.map((script, index) => ({
        run: {
          ...run(script, index + 1),
          ...(boundary === 'failed' && index === 1 ? { status: 'failed' as const } : {}),
          ...(boundary === 'epoch' && index >= 2 ? { kernelEpochId: 'other-epoch' } : {}),
          ...(boundary === 'environment' && index >= 2 ? { environment: 'other-python' } : {})
        },
        facts: facts[index]
      }))
      const projection = projectNotebookDependencies(runs)
      expect(capturesPath(projection, 'run-3', 'run-4')).toBe(false)
    }
  )
})

// Reduced from an executed six-subject Indometh elimination workflow.
// Original source SHA256: 3b8c16ad5e1374f28b3af10b7c98bd8664960f297599f8cbb491448900fe8e56.
// https://docs.scipy.org/doc/scipy/reference/generated/scipy.integrate.solve_ivp.html
describe('SciPy solve_ivp callback lineage', () => {
  const setup = [
    'import os',
    'import numpy as np',
    'from scipy.integrate import solve_ivp',
    'rate_factor = 1.0',
    'rates = np.array([0.2, 0.25, 0.3, 0.35, 0.4, 0.45])',
    'initials = np.array([1.0, 2.0, 3.0, 4.0, 5.0, 6.0])',
    'half_initial_first = float(initials[0])',
    'half_initial_last = float(initials[5])',
    'rhs_log_path = os.path.join("outputs", "rhs-calls.txt")',
    'jac_log_path = os.path.join("outputs", "jac-calls.txt")',
    'event_log_path = os.path.join("outputs", "event-calls.txt")'
  ].join('\n')
  // Function bodies retain the actual provider-generated file accesses and captures.
  const callbacks = String.raw`
def rhs(t, y):
    with open(os.path.join('outputs', 'rate-scale.txt'), 'r') as fh:
        scale = float(fh.read().strip())
    with open(rhs_log_path, 'a') as fh:
        fh.write('1\n')
    return -rate_factor * scale * rates * y
def jac(t, y):
    with open(os.path.join('outputs', 'rate-scale.txt'), 'r') as fh:
        scale = float(fh.read().strip())
    with open(jac_log_path, 'a') as fh:
        fh.write('1\n')
    return np.diag(-rate_factor * scale * rates)
def half_first(t, y):
    with open(os.path.join('outputs', 'event-fraction.txt'), 'r') as fh:
        fraction = float(fh.read().strip())
    with open(event_log_path, 'a') as fh:
        fh.write('half_first\n')
    return y[0] - half_initial_first * fraction
def half_last(t, y):
    with open(os.path.join('outputs', 'event-fraction.txt'), 'r') as fh:
        fraction = float(fh.read().strip())
    with open(event_log_path, 'a') as fh:
        fh.write('half_last\n')
    return y[5] - half_initial_last * fraction
half_first.direction = -1
half_first.terminal = False
half_last.direction = -1
half_last.terminal = False
`
  const calls = [
    'solution = solve_ivp(fun=rhs, t_span=(0.0, 8.0), y0=initials.copy(), method="Radau", jac=jac, events=[half_first, half_last])',
    'solution = solve_ivp(rhs, (0.0, 8.0), initials.copy(), "Radau", None, False, [half_first, half_last], jac=jac)'
  ]
  const assertNoSolutionType = async (scripts: string[]): Promise<void> => {
    const [facts] = await analyzePythonSources([scripts.join('\n')])
    expect(facts?.typeBindings ?? []).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ target: 'solution' })])
    )
  }

  it.each(calls)('keeps every opaque callback capture across later cells: %s', async (call) => {
    const projection = await projectPythonScripts([
      setup,
      callbacks,
      call,
      'rate_factor = 2.0\nhalf_initial_first = 1.5\nhalf_initial_last = 6.5\nrhs_log_path = os.path.join("outputs", "rhs-alternative.txt")\njac_log_path = os.path.join("outputs", "jac-alternative.txt")\nevent_log_path = os.path.join("outputs", "event-alternative.txt")'
    ])
    expect(projection.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
    expect(projection.dependenciesByRunId?.['run-3']).toBeUndefined()
    expect(projection.invalidatedByRunId['run-4']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: 'run-3',
          state: 'unknown',
          names: expect.arrayContaining([
            'rate_factor',
            'half_initial_first',
            'half_initial_last',
            'rhs_log_path',
            'jac_log_path',
            'event_log_path'
          ])
        })
      ])
    )
    await assertNoSolutionType([setup, callbacks, call])
  })

  it.each(['(half_first, half_last)', 'half_first'])(
    'retains event captures for tuple and single-callable forms: %s',
    async (events) => {
      const projection = await projectPythonScripts([
        setup,
        callbacks,
        `solution = solve_ivp(rhs, (0.0, 8.0), initials.copy(), events=${events}, jac=jac)`,
        'half_initial_first = 1.5\nhalf_initial_last = 6.5'
      ])
      expect(projection.invalidatedByRunId['run-4']).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            runId: 'run-3',
            state: 'unknown',
            names: expect.arrayContaining(
              events === 'half_first'
                ? ['half_initial_first']
                : ['half_initial_first', 'half_initial_last']
            )
          })
        ])
      )
    }
  )

  it.each([
    'options = {"events": [half_first, half_last], "jac": jac}\nsolution = solve_ivp(rhs, (0.0, 8.0), initials.copy(), **options)',
    'arguments = [rhs, (0.0, 8.0), initials.copy()]\nsolution = solve_ivp(*arguments, events=[half_first, half_last], jac=jac)'
  ])('keeps expanded solver arguments conservative: %s', async (call) => {
    const scripts = [setup, callbacks, call]
    expect(await analyzeNotebookSourceFileAccess('python', scripts.join('\n'))).toMatchObject({
      readState: 'partial',
      writeState: 'partial',
      externalState: 'partial'
    })
    const projection = await projectPythonScripts(scripts)
    expect(projection.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
    await assertNoSolutionType(scripts)
  })

  it('does not certify fresh solution arrays or their consumers', async () => {
    const scripts = [setup, callbacks, calls[0], 'solution.y.fill(0)']
    const projection = await projectPythonScripts(scripts)
    expect(projection.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
    expect(projection.stalenessByRunId['run-4']).toMatchObject({ state: 'unknown' })
    await assertNoSolutionType(scripts.slice(0, 3))
  })

  it('does not reuse solver certification after replacing the imported module member', async () => {
    const scripts = [
      'import scipy.integrate as integrate\ny0 = [1.0]',
      'integrate.solve_ivp = lambda *args, **kwargs: args[2]',
      'solution = integrate.solve_ivp(rhs, (0.0, 8.0), y0)'
    ]
    const projection = await projectPythonScripts(scripts)
    expect(projection.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
    expect(projection.dependenciesByRunId?.['run-3']).toBeUndefined()
    await assertNoSolutionType(scripts)
  })
})

// Reduced from an executed multi-cell lynx filtering workflow. The callback reads
// calibration on every invocation and appends a trace while writing a strided view.
// https://docs.scipy.org/doc/scipy/reference/generated/scipy.ndimage.generic_filter.html
describe('SciPy generic_filter callback lineage', () => {
  const setup = [
    'import numpy as np',
    'from scipy.ndimage import generic_filter',
    'filter_gain = 1.0',
    'SCALE_PATH = "outputs/filter-scale.txt"',
    'TRACE_PATH = "outputs/filter-calls.txt"',
    'values = np.array([1., 2., 3.])',
    'parent = np.full((3, 2), -999.)',
    'filter_buffer = parent[:, 0]',
    'output_alias = filter_buffer'
  ].join('\n')
  const callback = String.raw`def neighborhood_response(values):
    with open(SCALE_PATH, "r") as f:
        scale = float(f.read().strip())
    with open(TRACE_PATH, "a") as f:
        f.write("call\n")
    return float(np.median(values) * filter_gain * scale)`
  const calls = [
    'ret = generic_filter(values, neighborhood_response, size=5, output=filter_buffer)',
    'ret = generic_filter(values, function=neighborhood_response, size=5, output=filter_buffer)',
    'ret = generic_filter(values, neighborhood_response, 5, None, filter_buffer)'
  ]

  it.each(calls)('retains named captures without certifying the filter: %s', async (call) => {
    const projection = await projectPythonScripts([
      setup,
      callback,
      call,
      'filter_gain = 2.0\nSCALE_PATH = "outputs/other-scale.txt"\nTRACE_PATH = "outputs/other-trace.txt"'
    ])
    expect(projection.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
    expect(projection.dependenciesByRunId?.['run-3']).toBeUndefined()
    expect(projection.invalidatedByRunId['run-4']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: 'run-3',
          state: 'unknown',
          names: expect.arrayContaining(['filter_gain', 'SCALE_PATH', 'TRACE_PATH'])
        })
      ])
    )
  })

  it.each([calls[0], calls[2]])(
    'preserves possible mutation through the strided output alias: %s',
    async (call) => {
      const projection = await projectPythonScripts([
        setup,
        `${callback}\nprint(output_alias)`,
        call
      ])
      expect(projection.invalidatedByRunId['run-3']).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            runId: 'run-2',
            state: 'unknown',
            names: expect.arrayContaining(['output_alias'])
          })
        ])
      )
    }
  )

  it('does not certify return ownership for array, dtype or absent output', async () => {
    for (const call of [
      calls[0],
      calls[2],
      'ret = generic_filter(values, neighborhood_response, size=5, output=np.float64)',
      'ret = generic_filter(values, neighborhood_response, size=5)'
    ]) {
      const [facts] = await analyzePythonSources([[setup, callback, call].join('\n')])
      expect(facts?.typeBindings ?? []).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ target: 'ret', typeName: 'numpy.ndarray' })
        ])
      )
      expect(facts?.aliases ?? []).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ target: 'ret', source: 'filter_buffer', kind: 'reference' })
        ])
      )
      const projection = await projectPythonScripts([setup, callback, call])
      expect(projection.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
    }
  })

  it('does not inherit the library callback contract after a pure local replacement', async () => {
    const source = [
      setup,
      callback,
      'generic_filter = lambda *args, **kwargs: values',
      calls[0]
    ].join('\n')
    const projection = await projectPythonScripts([source, 'filter_gain = 2.0'])
    expect(projection.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
    expect(projection.invalidatedByRunId['run-2'] ?? []).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runId: 'run-1', names: expect.arrayContaining(['filter_gain']) })
      ])
    )
  })

  it('keeps an opaque replacement or module monkeypatch uncertain', async () => {
    for (const scripts of [
      [setup, callback, 'generic_filter = replacement', calls[0]],
      [
        `${setup}\nimport scipy.ndimage as ndi`,
        callback,
        'ndi.generic_filter = replacement',
        'ret = ndi.generic_filter(values, neighborhood_response, size=5, output=filter_buffer)'
      ]
    ]) {
      const projection = await projectPythonScripts(scripts)
      expect(projection.stalenessByRunId['run-4']).toMatchObject({ state: 'unknown' })
    }
  })

  it('keeps expanded callbacks unknown without inventing captures', async () => {
    const projection = await projectPythonScripts([
      setup,
      callback,
      'options = {"output": filter_buffer, "function": neighborhood_response}\nret = generic_filter(values, size=5, **options)',
      'filter_gain = 2.0'
    ])
    expect(projection.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
    expect(projection.invalidatedByRunId['run-4'] ?? []).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runId: 'run-3', names: expect.arrayContaining(['filter_gain']) })
      ])
    )
  })
})

// Reduced from the executed Morley bootstrap and Nottem Welch notebooks. The
// helpers read a late-bound path through a saved function alias on each callback.
describe('opaque Python callback helper lineage', () => {
  const setup = [
    'import math',
    'import numpy as np',
    'from scipy.stats import bootstrap',
    'from scipy.signal import welch',
    'from scipy.ndimage import generic_filter',
    'SCALE_PATH = "outputs/scale.txt"',
    'CENTER_FRACTION_PATH = "outputs/fraction.txt"',
    'NEW_FRACTION_PATH = "outputs/other-fraction.txt"',
    'TRACE_PATH = "outputs/bootstrap-trace.txt"',
    'trace_path = "outputs/detrend-trace.txt"',
    'statistic_gain = 1.0',
    'NEW_GAIN = 2.0',
    'choice = True',
    'member = "__code__"',
    'speed = np.array([1., 2., 3.])',
    'row_id = np.array([1, 2, 3])',
    'values = np.array([1., 2., 3.])',
    '_callback_log = []'
  ].join('\n')
  const scaleReader = String.raw`def _read_scale():
    with open(SCALE_PATH, "r") as f:
        text = f.read().strip()
    if "\n" in text or "\r" in text:
        raise ValueError("scale file must contain a single line")
    try:
        v = float(text)
    except Exception:
        raise ValueError("scale file must contain a numeric value")
    if not np.isfinite(v):
        raise ValueError("scale value must be finite")
    return v
read_scale_alias = _read_scale`
  const statistic = String.raw`def statistic_cb(sample_speed, sample_id):
    scale = read_scale_alias()
    with open(TRACE_PATH, "a") as f:
        f.write("call\n")
    ss = np.asarray(sample_speed, dtype=np.float64)
    return float(np.mean(ss)) * statistic_gain * scale`
  const fractionReader = String.raw`def _read_fraction() -> float:
    with open(CENTER_FRACTION_PATH, "r") as fh:
        s = fh.read().strip()
    v = float(s)
    if not math.isfinite(v):
        raise ValueError(f"non-finite centering fraction parsed: {s!r}")
    return v
fraction_reader = _read_fraction`
  const detrend = String.raw`def detrend_callback(values: np.ndarray) -> np.ndarray:
    arr = np.asarray(values, dtype=np.float64)
    f = fraction_reader()
    row_mean = arr.mean(axis=-1, keepdims=True)
    out = arr - f * row_mean
    _callback_log.append({"shape": arr.shape, "fraction": f})
    with open(trace_path, "a") as handle:
        handle.write("call\n")
    return out`
  const newReader = 'def replacement_reader():\n    return float(NEW_FRACTION_PATH)'
  const direct = 'def callback(window, offset=0.0):\n    return statistic_gain + offset'
  const filterCall = 'result = generic_filter(values, function=callback, size=3)'
  const welchCall = 'frequency, power = welch(values, detrend=detrend_callback)'
  const bootstrapCalls = [
    'result = bootstrap((speed, row_id), statistic=statistic_cb, paired=True, vectorized=False)',
    'result = bootstrap((speed, row_id), statistic_cb, paired=True, vectorized=False)'
  ]

  const assertCaptures = async (
    scripts: string[],
    expected: string[],
    absent: string[] = []
  ): Promise<Awaited<ReturnType<typeof projectPythonScripts>>> => {
    const callRunId = `run-${scripts.length - 1}`
    const projection = await projectPythonScripts(scripts)
    expect(projection.stalenessByRunId[callRunId]).toMatchObject({ state: 'unknown' })
    expect(projection.dependenciesByRunId?.[callRunId]).toBeUndefined()
    const capturedNames = (projection.invalidatedByRunId[`run-${scripts.length}`] ?? [])
      .filter((item) => item.runId === callRunId)
      .flatMap((item) => item.names)
    expect(capturedNames).toEqual(expect.arrayContaining(expected))
    for (const name of absent) expect(capturedNames).not.toContain(name)
    const facts = await analyzePythonSources(scripts)
    // The call cell must acquire these names from callback summaries, not from
    // an unrelated top-level load of the same global in the fixture.
    for (const name of [...expected, ...absent])
      expect(facts[scripts.length - 2]?.priorUsedNames ?? []).not.toContain(name)
    return projection
  }

  it('retains nested alias captures for bootstrap keyword and positional callbacks', async () => {
    for (const call of bootstrapCalls) {
      await assertCaptures(
        [
          setup,
          `${scaleReader}\n${statistic}`,
          call,
          'SCALE_PATH = "outputs/new-scale.txt"\nTRACE_PATH = "outputs/new-trace.txt"\nstatistic_gain = 2.0'
        ],
        ['SCALE_PATH', 'TRACE_PATH', 'statistic_gain']
      )
    }
  })

  it('retains nested input paths for Welch keyword and position-six callbacks', async () => {
    for (const call of [
      welchCall,
      'frequency, power = welch(values, 1.0, "hann", 3, 0, 3, detrend_callback)'
    ]) {
      await assertCaptures(
        [
          setup,
          `${fractionReader}\n${detrend}`,
          call,
          'CENTER_FRACTION_PATH = "outputs/new-fraction.txt"'
        ],
        ['CENTER_FRACTION_PATH']
      )
    }
  })

  it('uses the helper currently bound to a callback global after replacement', async () => {
    await assertCaptures(
      [
        setup,
        `${fractionReader}\n${detrend}\n${newReader}`,
        'fraction_reader = replacement_reader',
        welchCall,
        'CENTER_FRACTION_PATH = "outputs/old.txt"\nNEW_FRACTION_PATH = "outputs/new.txt"'
      ],
      ['NEW_FRACTION_PATH'],
      ['CENTER_FRACTION_PATH']
    )
  })

  it('stops at conditional and unresolved helper bindings', async () => {
    for (const replacement of [
      'if choice:\n    fraction_reader = replacement_reader',
      'fraction_reader = make_reader()'
    ]) {
      await assertCaptures(
        [
          setup,
          `${fractionReader}\n${detrend}\n${newReader}`,
          replacement,
          welchCall,
          'CENTER_FRACTION_PATH = "outputs/old.txt"\nNEW_FRACTION_PATH = "outputs/new.txt"'
        ],
        [],
        ['CENTER_FRACTION_PATH', 'NEW_FRACTION_PATH']
      )
    }
  })

  it('does not revive a direct callback body after opaque or decorated replacement', async () => {
    for (const replacement of [
      'callback = make_callback()',
      '@decorate\ndef callback(window):\n    return float(window[0])'
    ]) {
      await assertCaptures(
        [setup, direct, `${replacement}\n${filterCall}`, 'statistic_gain = 2.0'],
        [],
        ['statistic_gain']
      )
    }
  })

  it('blocks function behavior-slot and unknown-member pollution through aliases', async () => {
    for (const pollution of [
      'saved_callback.__code__ = replacement.__code__',
      'saved_callback.__defaults__ = (2.0,)',
      'setattr(saved_callback, member, replacement.__code__)'
    ]) {
      await assertCaptures(
        [
          setup,
          `${direct}\ndef replacement(window):\n    return NEW_GAIN`,
          'saved_callback = callback',
          pollution,
          filterCall,
          'statistic_gain = 2.0'
        ],
        [],
        ['statistic_gain']
      )
    }
  })

  it('retains captures after ordinary function metadata writes', async () => {
    await assertCaptures(
      [
        setup,
        `${fractionReader}\n${detrend}`,
        'saved_reader = fraction_reader\nsaved_reader.business_label = "reader"',
        `detrend_callback.business_label = "detrend"\n${welchCall}`,
        'CENTER_FRACTION_PATH = "outputs/new-fraction.txt"'
      ],
      ['CENTER_FRACTION_PATH']
    )
  })

  it('distinguishes a fresh function definition from aliases to an old polluted object', async () => {
    for (const [binding, expected] of [
      ['def fraction_reader():\n    return float(NEW_FRACTION_PATH)', ['NEW_FRACTION_PATH']],
      ['fraction_reader = old_reader', []],
      ['new_alias = old_reader\nfraction_reader = new_alias', []]
    ] as const) {
      await assertCaptures(
        [
          setup,
          `${fractionReader}\n${detrend}\n${newReader}`,
          'old_reader = fraction_reader\nold_reader.__code__ = replacement_reader.__code__',
          `${binding}\n${welchCall}`,
          'CENTER_FRACTION_PATH = "outputs/old.txt"\nNEW_FRACTION_PATH = "outputs/new.txt"'
        ],
        [...expected],
        expected.length ? ['CENTER_FRACTION_PATH'] : ['CENTER_FRACTION_PATH', 'NEW_FRACTION_PATH']
      )
    }
    await assertCaptures(
      [
        setup,
        `${direct}\ndef replacement(window):\n    return NEW_GAIN`,
        'callback.__code__ = replacement.__code__',
        `def callback(window):\n    return NEW_GAIN\n${filterCall}`,
        'statistic_gain = 3.0\nNEW_GAIN = 4.0'
      ],
      ['NEW_GAIN'],
      ['statistic_gain']
    )
  })

  it('preserves an existing saved callback object after its name is rebound', async () => {
    await assertCaptures(
      [
        setup,
        direct,
        'saved_callback = callback',
        'callback = lambda window: float(window[0])',
        filterCall.replace('function=callback', 'function=saved_callback'),
        'statistic_gain = 2.0'
      ],
      ['statistic_gain']
    )
  })

  it('keeps same-cell alias versions opaque when persisted facts cannot distinguish them', async () => {
    const original = [
      'import numpy as np',
      'from scipy.ndimage import generic_filter',
      'GAIN = 1.0\nNEW_GAIN = 2.0\nOTHER_GAIN = 3.0',
      'values = np.array([1., 2., 3.])',
      'def callback(window):\n    return float(np.mean(window)) * GAIN',
      'print(callback)'
    ].join('\n')
    const intermediate = 'def callback(window):\n    return NEW_GAIN'
    const final = 'def callback(window):\n    return OTHER_GAIN'
    const save = 'saved_callback = callback'
    const call = filterCall.replace('function=callback', 'function=saved_callback')
    const programs = [
      [original, save, intermediate, final, call].join('\n'),
      [original, intermediate, save, final, call].join('\n')
    ]
    const facts = await analyzePythonSources(programs)
    expect(facts[0]).toEqual(facts[1])
    expect(facts[0]?.aliases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: 'saved_callback',
          source: 'callback',
          kind: 'possible-reference'
        })
      ])
    )
    for (const program of programs) {
      await assertCaptures(
        [program, 'GAIN = 4.0\nNEW_GAIN = 5.0\nOTHER_GAIN = 6.0'],
        [],
        ['GAIN', 'NEW_GAIN', 'OTHER_GAIN']
      )
    }
  })

  it('terminates helper cycles while retaining potential captures', async () => {
    const callbacks = [
      'def first(window):\n    if len(window) > 10:\n        return second(window)\n    return SCALE_PATH',
      'def second(window):\n    return first(window) + CENTER_FRACTION_PATH',
      'def callback(window):\n    return float(first(window))'
    ].join('\n')
    await assertCaptures(
      [
        setup,
        callbacks,
        filterCall,
        'SCALE_PATH = "other-scale"\nCENTER_FRACTION_PATH = "other-fraction"'
      ],
      ['SCALE_PATH', 'CENTER_FRACTION_PATH']
    )
  })

  it('keeps earlier array-alias consumers unknown around opaque callbacks', async () => {
    for (const [callbacks, aliases, call] of [
      [
        `${scaleReader}\n${statistic}`,
        'speed_alias = speed\nrow_id_alias = row_id\nprint(speed_alias, row_id_alias)',
        bootstrapCalls[0]
      ],
      [`${fractionReader}\n${detrend}`, 'values_alias = values\nprint(values_alias)', welchCall]
    ]) {
      const scripts = [setup, callbacks, aliases]
      const before = await projectPythonScripts(scripts)
      expect(before.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
      const after = await projectPythonScripts([...scripts, call])
      expect(after.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
      expect(after.stalenessByRunId['run-4']).toMatchObject({ state: 'unknown' })
      expect(after.dependenciesByRunId?.['run-4']).toBeUndefined()
    }
  })
})

configureTestRuntimeMetadata()

describe('lambda creation default captures', () => {
  const callback = (header: string): string =>
    [
      'def callback(window):',
      '    normalizer = ' + header,
      '    return normalizer(window[0])'
    ].join('\n')

  it.each([
    ['positional', 'lambda value, scale=calibrate(): value * scale + DEFERRED_BODY'],
    ['keyword-only', 'lambda value, *, scale=calibrate(): value * scale + DEFERRED_BODY']
  ])(
    'retains %s defaults without traversing deferred parameters or body',
    async (_name, header) => {
      const [facts] = await analyzePythonSources([callback(header)])
      const method = facts.typeSummaries?.find((item) => item.name === 'python-function:callback')
        ?.methods[0]
      expect(method?.effect).toBe('unknown')
      expect(method?.usedNames).toEqual(['calibrate'])
    }
  )

  it('retains the enclosing load when a lambda parameter has the same name', async () => {
    const [facts] = await analyzePythonSources([callback('lambda GAIN=GAIN: GAIN + DEFERRED_BODY')])
    const method = facts.typeSummaries?.find((item) => item.name === 'python-function:callback')
      ?.methods[0]
    expect(method?.effect).toBe('unknown')
    expect(method?.usedNames).toEqual(['GAIN'])
  })

  it('keeps lambda-local normalization separate from the unrelated global decoy', async () => {
    const [facts] = await analyzePythonSources([
      [
        'def normalize(value):',
        '    return DECOY_FILE',
        'def callback(window):',
        '    normalize = lambda value, scale=calibrate(): value * scale',
        '    return normalize(window[0])'
      ].join('\n')
    ])
    const method = facts.typeSummaries?.find((item) => item.name === 'python-function:callback')
      ?.methods[0]
    expect(method?.effect).toBe('unknown')
    expect(method?.usedNames).toEqual(['calibrate'])
  })

  it.each([
    [
      'parameter',
      'def callback(calibrate, window):\n    normalizer = lambda value, scale=calibrate(): value * scale\n    return normalizer(window[0])'
    ],
    [
      'local helper',
      'def callback(window):\n    def calibrate():\n        return DEFERRED_HELPER_BODY\n    normalizer = lambda value, scale=calibrate(): value * scale\n    return normalizer(window[0])'
    ]
  ])('respects an enclosing %s that shadows a global helper', async (_name, source) => {
    const [facts] = await analyzePythonSources([source])
    const method = facts.typeSummaries?.find((item) => item.name === 'python-function:callback')
      ?.methods[0]
    expect(method?.effect).toBe('unknown')
    expect(method?.usedNames).toEqual([])
  })

  it('does not certify a shadowed builtin invoked by a lambda default', async () => {
    const [facts] = await analyzePythonSources([
      [
        'def callback(window):',
        '    float = replacement',
        '    normalizer = lambda value, scale=float(GAIN): value * scale',
        '    return normalizer(window[0])'
      ].join('\n')
    ])
    const method = facts.typeSummaries?.find((item) => item.name === 'python-function:callback')
      ?.methods[0]
    expect(method?.effect).toBe('unknown')
    expect(method?.usedNames).toEqual(['GAIN', 'replacement'])
    expect(method?.safeCallNames).not.toContain('float')
  })

  it('retains default captures in a class method without its receiver or deferred lambda body', async () => {
    const [facts] = await analyzePythonSources([
      'class Sensor:\n    def apply(self, window):\n        normalizer = lambda value, scale=calibrate(): value * scale + DEFERRED_BODY\n        return normalizer(window[0])'
    ])
    const method = facts.typeSummaries
      ?.find((item) => item.name === 'Sensor')
      ?.methods.find((item) => item.name === 'apply')
    expect(method?.effect).toBe('unknown')
    expect(method?.usedNames).toEqual(['calibrate'])
  })

  it('keeps a lambda body deferred when no default executes it', async () => {
    const [facts] = await analyzePythonSources([
      'def callback(window):\n    deferred = lambda value: HIDDEN_BODY + value\n    return OUTER_CAPTURE'
    ])
    const method = facts.typeSummaries?.find((item) => item.name === 'python-function:callback')
      ?.methods[0]
    expect(method?.effect).toBe('unknown')
    expect(method?.usedNames).toEqual(['OUTER_CAPTURE'])
  })

  it.each([
    ['list', '[DEFERRED_READER() for calibrate in values]'],
    ['set', '{DEFERRED_READER() for calibrate in values}'],
    ['dict', '{calibrate: DEFERRED_READER() for calibrate in values}'],
    ['generator', '(DEFERRED_READER() for calibrate in values)'],
    ['nested', 'tuple([DEFERRED_READER() for calibrate in values])']
  ])('leaves a %s default unmodeled without erasing other captures', async (_name, value) => {
    const [facts] = await analyzePythonSources([
      [
        'def callback(window):',
        '    scale = calibrate()',
        '    normalizer = lambda value=' + value + ', gain=GAIN: value',
        '    return scale * window[0]'
      ].join('\n')
    ])
    const method = facts.typeSummaries?.find((item) => item.name === 'python-function:callback')
      ?.methods[0]
    expect(method?.effect).toBe('unknown')
    expect(method?.usedNames).toEqual(['GAIN', 'calibrate'])
  })

  // The unchanged callback excerpt from the real four-cell map workflow.
  it('retains the calibration helper in the observed map callback', async () => {
    const [facts] = await analyzePythonSources([
      [
        'def relief_callback(window):',
        '    call_counts["relief"] += 1',
        '    normalize = lambda value, scale=calibrate(): value * scale',
        '    return normalize(GAIN * np.mean(np.abs(window - np.mean(window))))'
      ].join('\n')
    ])
    const method = facts.typeSummaries?.find(
      (item) => item.name === 'python-function:relief_callback'
    )?.methods[0]
    expect(method?.effect).toBe('unknown')
    expect(method?.usedNames).toEqual(['GAIN', 'calibrate', 'call_counts', 'np'])
  })
})

// Reduced from an executed four-cell R/Python quakes notebook. These histories
// test static capture semantics, not native callback counts or per-open lineage.
// https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.binned_statistic.html
describe('SciPy binned_statistic callback lineage', () => {
  const setup = [
    'import numpy as np',
    'from scipy.stats import binned_statistic',
    'CALIBRATION_PATH = "inputs/offset-low.txt"',
    'DECOY_PATH = "inputs/unrelated.txt"',
    'depth_arr = np.array([40., 100., 680.])',
    'mag_arr = np.array([4., 5., 6.])',
    'edges = np.array([0., 40., 100., 680.])'
  ].join('\n')
  const helpers = String.raw`def calibrate():
    with open(CALIBRATION_PATH, "r") as handle:
        return float(handle.read().strip())
def bin_reducer(values):
    return float(np.median(values) + calibrate())
def unused_reader():
    with open(DECOY_PATH, "r") as handle:
        return handle.read()`
  const calls = [
    'result = binned_statistic(depth_arr, mag_arr, statistic=bin_reducer, bins=edges)',
    'result = binned_statistic(depth_arr, mag_arr, bin_reducer, edges)'
  ]
  const rebind = 'CALIBRATION_PATH = "inputs/offset-high.txt"\nDECOY_PATH = "inputs/other.txt"'
  const capturedNames = (
    projection: Awaited<ReturnType<typeof projectPythonScripts>>,
    callId: string,
    rebindId: string
  ): string[] =>
    (projection.invalidatedByRunId[rebindId] ?? [])
      .filter((item) => item.runId === callId)
      .flatMap((item) => item.names)

  it.each(calls)(
    'retains the late-bound helper input without certifying the call: %s',
    async (call) => {
      const scripts = [setup, helpers, call, rebind]
      const projection = await projectPythonScripts(scripts)
      expect(projection.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
      expect(projection.dependenciesByRunId?.['run-3']).toBeUndefined()
      expect(capturedNames(projection, 'run-3', 'run-4')).toContain('CALIBRATION_PATH')
      expect(capturedNames(projection, 'run-3', 'run-4')).not.toContain('DECOY_PATH')
      const facts = await analyzePythonSources(scripts)
      expect(facts[2]?.priorUsedNames ?? []).not.toContain('CALIBRATION_PATH')
    }
  )

  it('retains possible input mutation without claiming result type or a definite alias', async () => {
    const projection = await projectPythonScripts([setup, helpers + '\nprint(mag_arr)', calls[0]])
    expect(projection.invalidatedByRunId['run-3']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: 'run-2',
          state: 'unknown',
          names: expect.arrayContaining(['mag_arr'])
        })
      ])
    )
    const [facts] = await analyzePythonSources([[setup, helpers, calls[0]].join('\n')])
    expect(facts?.typeBindings ?? []).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ target: 'result' })])
    )
    expect(facts?.aliases ?? []).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ target: 'result', kind: 'reference' })])
    )
  })

  it('rebuilds the same opaque captures from cached facts after projection snapshots are removed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'binned-statistic-cache-'))
    const runs = [setup, helpers, calls[1], rebind].map(run)
    const repository = { readSessionRuns: async () => runs }
    const request = {
      projectId: 'project',
      sessionId: 'session',
      interpreter: { command: 'unused' }
    }
    try {
      const initial = await new NotebookDependencyAnalyzer({
        storageRoot: root,
        repository
      }).project(request)
      expect(initial.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
      expect(capturedNames(initial, 'run-2', 'run-3')).toContain('CALIBRATION_PATH')
      expect(capturedNames(initial, 'run-2', 'run-3')).not.toContain('DECOY_PATH')
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
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not reinterpret position one as the statistic callback', async () => {
    const projection = await projectPythonScripts([
      setup,
      helpers,
      'result = binned_statistic(depth_arr, bin_reducer, statistic="mean", bins=edges)',
      rebind
    ])
    expect(projection.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
    expect(capturedNames(projection, 'run-3', 'run-4')).not.toContain('CALIBRATION_PATH')
  })

  it('does not inherit callback effects after a pure local replacement', async () => {
    const source = [
      setup,
      helpers,
      'binned_statistic = lambda *args, **kwargs: mag_arr',
      calls[0]
    ].join('\n')
    const projection = await projectPythonScripts([source, rebind])
    expect(projection.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
    expect(capturedNames(projection, 'run-1', 'run-2')).not.toContain('CALIBRATION_PATH')
  })

  it.each([
    ['opaque replacement', 'binned_statistic = replacement', calls[0]],
    [
      'module monkeypatch',
      'import scipy.stats as stats\nstats.binned_statistic = replacement',
      'result = stats.binned_statistic(depth_arr, mag_arr, statistic=bin_reducer, bins=edges)'
    ]
  ])('does not recover callback captures from an uncertain %s', async (_name, shadow, call) => {
    const projection = await projectPythonScripts([setup, helpers, shadow + '\n' + call, rebind])
    expect(projection.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
    expect(capturedNames(projection, 'run-3', 'run-4')).not.toContain('CALIBRATION_PATH')
  })
})

// Reduced from an executed Indometh R/Python notebook: the same integrand calls
// calibrate() again after its global input path changes in the warm Python kernel.
// https://docs.scipy.org/doc/scipy/reference/generated/scipy.integrate.quad.html
describe('SciPy quad callback lineage', () => {
  const setup = [
    'import numpy as np',
    'from scipy.integrate import quad',
    'CALIBRATION_PATH = "inputs/offset-low.txt"',
    'DECOY_PATH = "inputs/unrelated.txt"',
    'times = np.array([0., 1., 2.])',
    'concentrations = np.array([3., 2., 1.])',
    'subject_data = {"subject": (times, concentrations)}',
    'active_subject = "subject"',
    'callback_entries = 0',
    'calibration_entries = 0',
    'a = 0.0',
    'b = 2.0',
    'points = [1.0]'
  ].join('\n')
  const helpers = String.raw`def calibrate():
    global calibration_entries
    calibration_entries += 1
    with open(CALIBRATION_PATH, "r", encoding="utf-8") as f:
        return float(f.read().strip())
def integrand(t):
    global callback_entries
    callback_entries += 1
    ts, cs = subject_data[active_subject]
    return float(np.interp(t, ts, cs)) + calibrate()
def unused_reader():
    with open(DECOY_PATH, "r") as f:
        return f.read()`
  const calls = [
    'result = quad(integrand, a, b, points=points)',
    'result = quad(func=integrand, a=a, b=b, points=points)',
    'import scipy.integrate as integrate\nresult = integrate.quad(integrand, a, b, points=points)'
  ]
  const rebind = 'CALIBRATION_PATH = "inputs/offset-high.txt"\nDECOY_PATH = "inputs/other.txt"'
  const capturedNames = (
    projection: Awaited<ReturnType<typeof projectPythonScripts>>,
    callId: string,
    rebindId: string
  ): string[] =>
    (projection.invalidatedByRunId[rebindId] ?? [])
      .filter((item) => item.runId === callId)
      .flatMap((item) => item.names)

  it.each(calls)(
    'retains the late-bound helper input without certifying quad: %s',
    async (call) => {
      const scripts = [setup, helpers, call, rebind]
      const projection = await projectPythonScripts(scripts)
      expect(projection.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
      expect(projection.dependenciesByRunId?.['run-3']).toBeUndefined()
      expect(capturedNames(projection, 'run-3', 'run-4')).toContain('CALIBRATION_PATH')
      expect(capturedNames(projection, 'run-3', 'run-4')).not.toContain('DECOY_PATH')
      const facts = await analyzePythonSources(scripts)
      expect(facts[2]?.priorUsedNames ?? []).not.toContain('CALIBRATION_PATH')
    }
  )

  it('retains possible argument mutation without claiming a quad result type or definite alias', async () => {
    const projection = await projectPythonScripts([setup, helpers + '\nprint(points)', calls[0]])
    expect(projection.invalidatedByRunId['run-3']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: 'run-2',
          state: 'unknown',
          names: expect.arrayContaining(['points'])
        })
      ])
    )
    const [facts] = await analyzePythonSources([[setup, helpers, calls[0]].join('\n')])
    expect(facts?.typeBindings ?? []).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ target: 'result' })])
    )
    expect(facts?.aliases ?? []).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ target: 'result', kind: 'reference' })])
    )
  })

  it('rebuilds quad helper captures from cached facts without projection snapshots or reparsing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'quad-callback-cache-'))
    const runs = [setup, helpers, calls[1], rebind].map(run)
    const repository = { readSessionRuns: async () => runs }
    const request = {
      projectId: 'project',
      sessionId: 'session',
      interpreter: { command: 'unused' }
    }
    try {
      const initial = await new NotebookDependencyAnalyzer({
        storageRoot: root,
        repository
      }).project(request)
      expect(initial.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
      expect(capturedNames(initial, 'run-2', 'run-3')).toContain('CALIBRATION_PATH')
      expect(capturedNames(initial, 'run-2', 'run-3')).not.toContain('DECOY_PATH')
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
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    'result = quad(lambda t: t, integrand, b)',
    'result = quad(lambda t: t, a, integrand)',
    'result = quad(lambda t: t, a, b, fun=integrand)'
  ])('does not reinterpret a wrong quad callback position or keyword: %s', async (call) => {
    const projection = await projectPythonScripts([setup, helpers, call, rebind])
    expect(projection.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
    expect(capturedNames(projection, 'run-3', 'run-4')).not.toContain('CALIBRATION_PATH')
  })

  it('does not inherit quad callback effects after a pure local replacement', async () => {
    const source = [setup, helpers, 'quad = lambda *args, **kwargs: a', calls[0]].join('\n')
    const projection = await projectPythonScripts([source, rebind])
    expect(projection.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
    expect(capturedNames(projection, 'run-1', 'run-2')).not.toContain('CALIBRATION_PATH')
  })

  it.each([
    ['opaque replacement', 'quad = replacement', calls[0]],
    [
      'module monkeypatch',
      'import scipy.integrate as integrate\nintegrate.quad = replacement',
      'result = integrate.quad(integrand, a, b, points=points)'
    ]
  ])('does not recover quad helper captures from an uncertain %s', async (_name, shadow, call) => {
    const projection = await projectPythonScripts([setup, helpers, shadow + '\n' + call, rebind])
    expect(projection.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
    expect(capturedNames(projection, 'run-3', 'run-4')).not.toContain('CALIBRATION_PATH')
  })

  // Replaying a call cell restores its own literal path before invoking quad.
  // That binding must not become a dependency on a later cell's replacement.
  it.each([
    ['prior-cell calibration path', false],
    ['call-cell literal calibration path', true]
  ] as const)('distinguishes quad callbacks with a %s', async (_description, ownsPath) => {
    const call = ownsPath ? 'CALIBRATION_PATH = "inputs/offset-low.txt"\n' + calls[0] : calls[0]
    const scripts = [setup, helpers, call, rebind]
    const projection = await projectPythonScripts(scripts)
    expect(projection.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
    const names = capturedNames(projection, 'run-3', 'run-4')
    expect(names.includes('CALIBRATION_PATH')).toBe(!ownsPath)
    expect(names).not.toContain('DECOY_PATH')
    const facts = await analyzePythonSources(scripts)
    expect(facts[2]?.priorUsedNames ?? []).not.toContain('CALIBRATION_PATH')
    expect((facts[2]?.definedNames ?? []).includes('CALIBRATION_PATH')).toBe(ownsPath)
  })
})

// Reduced from an executed pressure R/Python notebook. The original objective
// reads its current calibration path through a helper during every solver call.
// https://docs.scipy.org/doc/scipy/reference/generated/scipy.optimize.root_scalar.html
describe('SciPy root_scalar callback lineage', () => {
  const setup = [
    'import numpy as np',
    'from scipy.optimize import root_scalar',
    'OFFSET_PATH = "inputs/offset-low.txt"',
    'DECOY_PATH = "inputs/unrelated.txt"',
    'temperatures = np.array([0., 180., 360.])',
    'pressures = np.array([0.0002, 10., 806.])',
    'args = (50.0,)',
    'bracket = [0.0, 360.0]'
  ].join('\n')
  const helpers = String.raw`def calibrated_pressure(t):
    with open(OFFSET_PATH, "r") as f:
        offset = float(f.read().strip())
    return float(np.interp(t, temperatures, pressures)) + offset

def objective(t, target):
    return calibrated_pressure(t) - target

def unused_reader():
    with open(DECOY_PATH, "r") as f:
        return f.read()`
  const calls = [
    'result = root_scalar(objective, args=args, bracket=bracket, method="brentq")',
    'result = root_scalar(f=objective, args=args, bracket=bracket, method="brentq")',
    'from scipy import optimize\nresult = optimize.root_scalar(objective, args=args, bracket=bracket, method="brentq")'
  ]
  const rebind = 'OFFSET_PATH = "inputs/offset-high.txt"\nDECOY_PATH = "inputs/other.txt"'
  const capturedNames = (
    projection: Awaited<ReturnType<typeof projectPythonScripts>>,
    callId: string,
    rebindId: string
  ): string[] =>
    (projection.invalidatedByRunId[rebindId] ?? [])
      .filter((item) => item.runId === callId)
      .flatMap((item) => item.names)

  it.each(calls)(
    'retains root_scalar helper captures without certifying the call: %s',
    async (call) => {
      const scripts = [setup, helpers, call, rebind]
      const projection = await projectPythonScripts(scripts)
      expect(capturedNames(projection, 'run-3', 'run-4')).toContain('OFFSET_PATH')
      expect(capturedNames(projection, 'run-3', 'run-4')).not.toContain('DECOY_PATH')
      expect(projection.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
      expect(projection.dependenciesByRunId?.['run-3']).toBeUndefined()
      const facts = await analyzePythonSources(scripts)
      expect(facts[2]?.priorUsedNames ?? []).not.toContain('OFFSET_PATH')
    }
  )

  it('does not make a root_scalar call-owned literal path depend on a later replacement', async () => {
    const scripts = [setup, helpers, 'OFFSET_PATH = "inputs/offset-low.txt"\n' + calls[0], rebind]
    const projection = await projectPythonScripts(scripts)
    expect(projection.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
    expect(capturedNames(projection, 'run-3', 'run-4')).not.toContain('OFFSET_PATH')
    expect(capturedNames(projection, 'run-3', 'run-4')).not.toContain('DECOY_PATH')
  })

  it('keeps root_scalar argument mutation possible without assigning result types or aliases', async () => {
    const projection = await projectPythonScripts([
      setup,
      helpers + '\nprint(args, bracket)',
      calls[0]
    ])
    expect(projection.invalidatedByRunId['run-3']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: 'run-2',
          state: 'unknown',
          names: expect.arrayContaining(['args', 'bracket'])
        })
      ])
    )
    const [facts] = await analyzePythonSources([[setup, helpers, calls[0]].join('\n')])
    expect(facts?.typeBindings ?? []).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ target: 'result' })])
    )
    expect(facts?.aliases ?? []).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ target: 'result', kind: 'reference' })])
    )
  })

  it('rebuilds root_scalar helper captures from cached facts without snapshots or reparsing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'root-scalar-callback-cache-'))
    const runs = [setup, helpers, calls[1], rebind].map(run)
    const repository = { readSessionRuns: async () => runs }
    const request = {
      projectId: 'project',
      sessionId: 'session',
      interpreter: { command: 'unused' }
    }
    try {
      const initial = await new NotebookDependencyAnalyzer({
        storageRoot: root,
        repository
      }).project(request)
      expect(capturedNames(initial, 'run-2', 'run-3')).toContain('OFFSET_PATH')
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
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    'result = root_scalar(lambda t: t, objective, bracket=bracket)',
    'result = root_scalar(lambda t: t, args=args, bracket=bracket, fun=objective)'
  ])('does not reinterpret a wrong root_scalar callback slot: %s', async (call) => {
    const projection = await projectPythonScripts([setup, helpers, call, rebind])
    expect(projection.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
    expect(capturedNames(projection, 'run-3', 'run-4')).not.toContain('OFFSET_PATH')
  })

  it('does not inherit root_scalar callback effects after a pure local replacement', async () => {
    const source = [setup, helpers, 'root_scalar = lambda *args, **kwargs: 0.0', calls[0]].join(
      '\n'
    )
    const projection = await projectPythonScripts([source, rebind])
    expect(projection.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
    expect(capturedNames(projection, 'run-1', 'run-2')).not.toContain('OFFSET_PATH')
  })

  it.each([
    ['opaque replacement', 'root_scalar = replacement', calls[0]],
    [
      'module monkeypatch',
      'from scipy import optimize\noptimize.root_scalar = replacement',
      'result = optimize.root_scalar(objective, args=args, bracket=bracket, method="brentq")'
    ]
  ])(
    'does not recover root_scalar helper captures from an uncertain %s',
    async (_name, shadow, call) => {
      const projection = await projectPythonScripts([setup, helpers, shadow + '\n' + call, rebind])
      expect(projection.stalenessByRunId['run-3']).toMatchObject({ state: 'unknown' })
      expect(capturedNames(projection, 'run-3', 'run-4')).not.toContain('OFFSET_PATH')
    }
  )
})
