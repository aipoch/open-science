import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { startWorkingFileObservation } from './working-file-observer'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { NotebookDependencyAnalyzer, projectNotebookDependencies } from './dependency-analysis'
import type { NotebookRunRecord } from '../../shared/notebook'
import type { NotebookDependencyProjection } from './dependency-analysis-types'
import { analyzePythonSources } from './dependency-analysis-python'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

const cells = readFileSync(join(__dirname, 'reported-python-chord.fixture.py'), 'utf8').split(
  '\n\n# %%\n\n'
)
const recordCells = readFileSync(
  join(__dirname, 'reported-python-chord-records.fixture.py'),
  'utf8'
).split('\n\n# %%\n\n')
const polarChord = readFileSync(join(__dirname, 'reported-python-polar-chord.fixture.py'), 'utf8')

const arcRibbon = readFileSync(join(__dirname, 'reported-python-arc-ribbon.fixture.py'), 'utf8')

const exploration = readFileSync(
  join(__dirname, 'reported-python-exploration.fixture.py'),
  'utf8'
).split('\n\n# %%\n\n')
const cartesianChord = readFileSync(
  join(__dirname, 'reported-python-cartesian-chord.fixture.py'),
  'utf8'
)

const workbookCells = readFileSync(
  join(__dirname, 'reported-python-workbook-chord.fixture.py'),
  'utf8'
).split('\n\n# %%\n\n')

const coloredChordCells = readFileSync(
  join(__dirname, 'reported-python-colored-chord.fixture.py'),
  'utf8'
).split('\n\n# %%\n\n')

const redrawCells = readFileSync(
  join(__dirname, 'reported-python-chord-redraw.fixture.py'),
  'utf8'
).split('\n\n# %%\n\n')

const matrixChord = readFileSync(join(__dirname, 'reported-python-matrix-chord.fixture.py'), 'utf8')
const matrixInput = "import pandas as pd\ndf = pd.read_excel('inputs/edge-weights-222222222222.xlsx')"
const neighborChords = [0, 1].map((variant) =>
  readFileSync(join(__dirname, `reported-python-neighbor-chord-${variant}.fixture.py`), 'utf8')
)
it('reconstructs a numerical helper returning appended coordinate pairs', async () => {
  const script = `import numpy as np
def curve(p0, p1, origin=(0, 0)):
    points = []
    for t in np.linspace(0, 1, 40):
        x = (1-t)*p0[0] + t*p1[0] + origin[0]
        y = (1-t)*p0[1] + t*p1[1] + origin[1]
        points.append((x, y))
    return points
points = curve((1., 2.), (3., 4.))
print(points)`
  expect((await project([script])).stalenessByRunId['run-0']).toEqual({ state: 'clear' })
})

it('separates nested function locals from an eager sort callback in the enclosing loop', async () => {
  const script = `import numpy as np
values = np.array([1., 2.])
result = []
for i in range(len(values)):
    neighbors = sorted([j for j in range(len(values))], key=lambda x: x)
    def build(value):
        x = value + 1
        points = []
        points.append(x)
        return points
    result.append(build(i))
print(result)`
  expect((await project([script])).stalenessByRunId['run-0']).toEqual({ state: 'clear' })
})

it.each([
  'def build(values=[]):\n    values.append(1)\n    return values\nresult = build()',
  'def build(values=([],)):\n    values[0].append(1)\n    return values\nresult = build()',
  'def build():\n    points = []\n    unknown(points)\n    return points\nresult = build()',
  'def build():\n    points = []\n    alias = points\n    alias.append(external)\n    return points\nresult = build()',
  'for i in range(2):\n    def build():\n        x = 1\n        return x\n    print(x)'
])('keeps unverified builder state conservative: %s', async (script) => {
  expect((await project([script])).stalenessByRunId['run-0']?.state).not.toBe('clear')
})

it('keeps caller-owned entries aliased through a returned list builder', async () => {
  const scripts = [
    'source = [1.]\ndef build(value):\n    points = []\n    points.append(value)\n    return points\nresult = build(source)',
    'print(result)',
    'source.append(2.)'
  ]
  const projection = await project(scripts)
  expect(projection.stalenessByRunId['run-1']?.state).not.toBe('clear')
})

it.each(neighborChords)('reconstructs the reported neighbor chord variant %#', async (script) => {
  expect((await project([script])).stalenessByRunId['run-0']).toEqual({ state: 'clear' })
  expect(await analyzeNotebookSourceFileAccess('python', script)).toMatchObject({
    reads: ['inputs/edge-weights-222222222222.xlsx'],
    writes: ['chord_diagram.png'],
    readState: 'complete',
    writeState: 'complete'
  })
})

it('does not invent a dependency on the preceding chord redraw', async () => {
  const result = await project(neighborChords)
  expect(result.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  expect(result.dependenciesByRunId?.['run-1'] ?? []).not.toContain('run-0')
})

it('reconstructs the matrix chord across its captured DataFrame producer', async () => {
  const result = await project([matrixInput, matrixChord])
  expect(result.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  expect(result.dependenciesByRunId?.['run-1']).toContain('run-0')
})

it.each([
  "import pandas as pd\ndf = pd.read_excel('inputs/book.xlsx')\ndef s_key(s): return int(s.replace('S',''))\nsamples = sorted(df['to'].unique(), key=s_key)",
  'import numpy as np\nrot = np.degrees(1.0)\nif rot > 90: rot -= 180\nif rot < -90: rot += 180'
])('analyzes matrix chord building block: %s', async (script) => {
  expect((await project([script])).stalenessByRunId['run-0']).toEqual({ state: 'clear' })
})

it.each(['degrees', 'radians', 'rad2deg', 'deg2rad', 'floor', 'ceil', 'log10'])(
  'tracks fresh scalar and array results of numpy.%s without hiding output buffers',
  async (method) => {
    for (const input of ['1.0', 'np.array([1.0])']) {
      const result = await project([
        `import numpy as np
source = ${input}
result = np.${method}(source)
if result > 90: result -= 180
if result < -90: result += 180`
      ])
      expect(result.stalenessByRunId['run-0']).toEqual({ state: 'clear' })
    }
    for (const output of ['out=buffer', 'buffer', '**options']) {
      const result = await project([
        'import numpy as np\nsource = np.array([1.0])\nbuffer = np.zeros(1)\noptions = {"out": buffer}',
        'print(buffer)',
        `result = np.${method}(source, ${output})\nif result[0] > 90: result -= 180`
      ])
      expect(
        result.stalenessByRunId[output === '**options' ? 'run-2' : 'run-1']?.state,
        output
      ).not.toBe('clear')
    }
  }
)

it('retains the matrix chord dependency when its source DataFrame changes', async () => {
  const result = await project([
    matrixInput,
    matrixChord,
    "df = pd.DataFrame({'from': [], 'to': [], 'value': []})"
  ])
  expect(result.stalenessByRunId['run-1']?.state).toBe('stale')
})

it.each(['np.degrees = custom', 'np = custom'])(
  'does not trust rebound numerical calls: %s',
  async (mutation) => {
    const result = await project([
      `import numpy as np\n${mutation}\nrot = np.degrees(1.0)\nif rot > 90: rot -= 180`
    ])
    expect(result.stalenessByRunId['run-0']?.state).not.toBe('clear')
  }
)

const subarcCells = readFileSync(
  join(__dirname, 'reported-python-chord-subarcs.fixture.py'),
  'utf8'
).split('\n\n# %%\n\n')

it.each([
  'items = [[2], [1]]\nitems.sort(key=lambda x: x[0])',
  'def key(value):\n    return 1\nitems = [[2], [1]]\nitems.sort(key=key)',
  "import pandas as pd\ndf = pd.read_excel('inputs/book.xlsx')\nfor e in ['Gene1']:\n    if e.startswith('Gene'):\n        conns = df[['to', 'value']].values.tolist()\n    else:\n        conns = df[['from', 'value']].values.tolist()\n    conns.sort(key=lambda x: x[0])",
  "import pandas as pd\ndf = pd.read_excel('inputs/book.xlsx')\nfor e in ['Gene1']:\n    conns = df[['to', 'value']].values.tolist()\n    conns.sort(key=lambda x: x[0])",
  "for pkg in ['matplotlib', 'bokeh']:\n    try:\n        __import__(pkg)\n        print(pkg)\n    except ImportError:\n        print(pkg)"
])('analyzes eager sort callbacks and bounded import probes: %s', async (script) => {
  expect((await project([script])).stalenessByRunId['run-0']).toEqual({ state: 'clear' })
})

it.each([0, 1, 2, 3, 4, 5])('analyzes reported subarc notebook cell %i', async (index) => {
  const script = subarcCells[index]!
  const result = await project([script])
  const files = await analyzeNotebookSourceFileAccess('python', script)
  expect({ state: result.stalenessByRunId['run-0'], files }).toMatchObject({
    state: { state: 'clear' },
    files: { readState: 'complete', writeState: 'complete', externalState: 'complete' }
  })
  expect(files.reads).toEqual(index === 2 ? [] : ['inputs/edge-weights-222222222222.xlsx'])
  expect(files.writes).toEqual(
    index === 4 ? ['config.json', 'sub_arcs.npy'] : index === 5 ? ['chord_diagram.png'] : []
  )
})

it('keeps the independent subarc chart clear after the reported exploration history', async () => {
  const result = await project(subarcCells)
  expect(result.stalenessByRunId['run-5']).toEqual({ state: 'clear' })
  expect(result.dependenciesByRunId?.['run-5']).not.toContain('run-2')
})

it.each([
  'items = [1, 2]\nitems.sort(key=lambda x: custom(x))',
  'items = [1, 2]\nitems.sort(key=custom)',
  'import numpy as np\nsource = np.array([1, 2])\nif flag:\n    values = np.sum(source, out=previous)\nelse:\n    values = np.sum(source, out=previous)\nprint(values)',
  "import pandas as pd\ndf = pd.read_excel('inputs/book.xlsx')\nif custom():\n    values = df['value'].values.tolist()\nelse:\n    values = df['other'].values.tolist()\nprint(values)",
  "__import__ = custom\nfor pkg in ['matplotlib']:\n    try:\n        __import__(pkg)\n        print(pkg)\n    except ImportError:\n        print(pkg)",
  'for pkg in packages:\n    try:\n        __import__(pkg)\n        print(pkg)\n    except ImportError:\n        print(pkg)',
  "for pkg in ['matplotlib']:\n    try:\n        __import__(pkg)\n        custom()\n    except ImportError:\n        print(pkg)",
  'import numpy as np\nif flag:\n    values = np.array([1,2]).tolist()\nvalues.sort(key=lambda x:x)',
  'items = [1, 2]\nfor item in items:\n    angle = previous\n    if item > 1:\n        angle += 180'
])('preserves unknown effects and previous bindings in subarc variants: %s', async (script) => {
  expect((await project([script])).stalenessByRunId['run-0']?.state).not.toBe('clear')
})

it('tracks a shadowed dtype binding and object elements shared by tolist', async () => {
  const result = await project([
    'object = custom_type',
    'import numpy as np\nvalues = np.array([1], dtype=object)',
    'object = other_type'
  ])
  expect(result.stalenessByRunId['run-1']?.state).not.toBe('clear')
  const aliased = await project([
    'import numpy as np\nsource = np.zeros(1, dtype=object)\nsource[0] = []\nitems = source.tolist()',
    'print(source)',
    'items[0].append(1)'
  ])
  expect(aliased.stalenessByRunId['run-1']?.state).not.toBe('clear')
})

it.each([
  `import pandas as pd\nframe = pd.read_excel('inputs/book.xlsx')\nlabels = sorted(frame.index.tolist(), key=lambda value: int(value.replace('Gene', '')))`,
  `import matplotlib.pyplot as plt\nfrom matplotlib.patches import Wedge\nR = 1.0\ndef draw(ax, radius=R):\n    wedge = Wedge((0,0), radius, 0, 90)\n    ax.add_patch(wedge)\nfig, ax = plt.subplots()\ndraw(ax)`,
  `import numpy as np\ndef ticks(total, count=4):\n    power = 10 ** np.floor(np.log10(total / count))\n    for candidate in [1,2,2.5,5,10]:\n        step = candidate * power\n        if total / step <= count + 1:\n            return step\n    return step\nresult = ticks(100)`,
  `from matplotlib.colors import to_rgba, to_hex\nimport colorsys\ndef lighten(color):\n    r,g,b,a = to_rgba(color)\n    h,l,s = colorsys.rgb_to_hls(r,g,b)\n    return to_hex(colorsys.hls_to_rgb(h,l,s))\nvalue = lighten('#123456')`
])('analyzes redraw building block: %s', async (source) => {
  expect((await project([source])).stalenessByRunId['run-0']).toEqual({ state: 'clear' })
})

it.each([0, 1, 2])('analyzes independent reported chord redraw %i', async (index) => {
  expect((await project([redrawCells[index]!])).stalenessByRunId['run-0']).toEqual({
    state: 'clear'
  })
  expect(await analyzeNotebookSourceFileAccess('python', redrawCells[index]!)).toMatchObject({
    readState: 'complete',
    writeState: 'complete',
    reads: ['inputs/edge-weights-222222222222.xlsx'],
    writes: ['chord_diagram.png']
  })
})

// The unused dictionary reads a loop variable after a potentially empty loop.
const independentPolarChord = polarChord.replace(/^gene_unit_rad = .*\n/m, '')

it('keeps the escaped loop-variable warning in the original polar notebook', async () => {
  expect((await project([polarChord])).stalenessByRunId['run-0']).toEqual({
    state: 'unknown',
    reasons: ['control-flow']
  })
})
it('analyzes the full polar notebook after removing its unused escaping read', async () => {
  expect((await project([independentPolarChord])).stalenessByRunId['run-0']).toEqual({
    state: 'clear'
  })
  expect(await analyzeNotebookSourceFileAccess('python', independentPolarChord)).toMatchObject({
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete',
    reads: ['inputs/edge-weights-222222222222.xlsx'],
    writes: ['chord_diagram.png']
  })
})
const run = (script: string, index: number): NotebookRunRecord => ({
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
const project = async (scripts: string[]): Promise<NotebookDependencyProjection> => {
  const root = await mkdtemp(join(tmpdir(), 'chord-analysis-'))
  const runs = scripts.map(run)
  try {
    return await new NotebookDependencyAnalyzer({
      storageRoot: root,
      repository: { readSessionRuns: async () => runs }
    }).project({
      projectId: 'project',
      sessionId: 'session',
      completedRun: runs.at(-1),
      interpreter: { command: 'unused' }
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

it('analyzes grouped Excel totals with an unused optional plotting import', async () => {
  const script = `import pandas as pd
import numpy as np
from pycirclize import Circos
import matplotlib.pyplot as plt
df = pd.read_excel('inputs/edge-weights-222222222222.xlsx')
print(df.head())
print(df.shape)
gene_totals = df.groupby('from')['value'].sum().reindex(['Gene1', 'Gene2', 'Gene3', 'Gene4', 'Gene5', 'Gene6'])
sample_totals = df.groupby('to')['value'].sum().reindex(['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10'])
print(gene_totals.to_dict(), sample_totals.to_dict(), df['value'].sum())`
  const result = await project([script])
  expect(result.stalenessByRunId['run-0']).toEqual({ state: 'clear' })
  expect(await analyzeNotebookSourceFileAccess('python', script)).toMatchObject({
    readState: 'complete',
    reads: ['inputs/edge-weights-222222222222.xlsx']
  })
})

it('analyzes reported record preparation and nested chord helpers', async () => {
  const result = await project(recordCells)
  expect(result.stalenessByRunId['run-0']).toEqual({ state: 'clear' })
  expect(result.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  expect(result.dependenciesByRunId?.['run-1']).toContain('run-0')
  expect(await analyzeNotebookSourceFileAccess('python', recordCells.join('\n'))).toMatchObject({
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete',
    reads: ['inputs/edge-weights-222222222222.xlsx'],
    writes: ['chord_diagram.png']
  })
})

it('follows the selected literal conditional input through cumulative angle preparation', async () => {
  const script =
    recordCells[0]
      .slice(0, recordCells[0].indexOf('# Compute ribbon'))
      .replace(
        "pd.read_excel('inputs/edge-weights-222222222222.xlsx')",
        "pd.read_excel('inputs/missing.xlsx') if False else pd.read_excel('inputs/edge-weights-222222222222.xlsx')"
      ) + '\nfor n in all_names:\n    print(n, angles[n], sizes[n])'
  expect((await project([script])).stalenessByRunId['run-0']).toEqual({ state: 'clear' })
  expect(await analyzeNotebookSourceFileAccess('python', script)).toMatchObject({
    readState: 'complete',
    reads: ['inputs/edge-weights-222222222222.xlsx']
  })
})

it.each([
  'result = df.to_dict(into=custom_mapping)',
  "result = df.to_dict('records', custom_mapping)",
  'result = df["value"].to_dict(into=custom_mapping)'
])('retains unknown user callbacks: %s', async (expression) => {
  const result = await project([
    `import pandas as pd\ndf = pd.DataFrame({'value': [1]})\n${expression}`
  ])
  expect(result.stalenessByRunId['run-0']?.state).toBe('unknown')
})

it.each([
  'def build(value):\n    return (value,)\nresult = build(shared)',
  'def build(value):\n    points = [1, 2]\n    alias = points\n    alias.append(value)\n    return points\nresult = build(shared)',
  'def build(value):\n    return [item for item in value]\nresult = build(shared)',
  'import numpy as np\ndef build(value):\n    return (value * np.ones(2),)\nresult = build(shared)'
])('keeps potentially borrowed helper return values conservative: %s', async (script) => {
  expect((await project(['shared = []', script])).stalenessByRunId['run-1']?.state).toBe('unknown')
})

it('does not let a comprehension initialize an outer variable', async () => {
  const script = 'items = [1, 2]\nfor item in items:\n    values = [v for v in items]\n    print(v)'
  expect((await project([script])).stalenessByRunId['run-0']?.state).toBe('unknown')
})

it('tracks mutations in the selected else expression', async () => {
  const result = await project([
    'shared = []',
    'print(shared)',
    'result = 0 if False else shared.append(1)'
  ])
  expect(result.stalenessByRunId['run-1']?.state).toBe('stale')
})

it('retains conditional aliases to external objects inside an isolated loop', async () => {
  const result = await project([
    'shared = []',
    'print(shared)',
    'for value in values:\n    chosen = shared if value else []\n    chosen.append(1)'
  ])
  expect(result.stalenessByRunId['run-2']?.state).toBe('unknown')
  expect(result.stalenessByRunId['run-1']?.state).not.toBe('clear')
})

it.each([1, 3, 4, 5, 6])('analyzes reported chord notebook block %i', async (index) => {
  const script = `${cells[0]}\n${cells[index]}`
  const [facts] = await analyzePythonSources([script])
  expect(
    projectNotebookDependencies([{ run: run(script, 0), facts }]).stalenessByRunId['run-0']
  ).toEqual({ state: 'clear' })
  expect(await analyzeNotebookSourceFileAccess('python', script)).toMatchObject({
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete',
    reads: ['inputs/edge-weights-222222222222.xlsx'],
    ...(index === 6 ? { writes: ['chord_diagram.png'] } : {})
  })
})

it('keeps the final chart linked to its Excel cell across all reported attempts', async () => {
  const result = await project(cells)
  expect(result.stalenessByRunId['run-6']).toEqual({ state: 'clear' })
  const ancestors = new Set<string>()
  const collect = (id: string): void => {
    for (const dependency of result.dependenciesByRunId?.[id] ?? []) {
      if (ancestors.has(dependency)) continue
      ancestors.add(dependency)
      collect(dependency)
    }
  }
  collect('run-6')
  expect(ancestors).toContain('run-0')
  expect(ancestors).not.toContain('run-2')
  expect(result.dependenciesByRunId?.['run-6']).not.toContain('run-2')
})

it('keeps a value used after an empty loop uncertain', async () => {
  const result = await project(['for item in []:\n    value = item', 'print(value)'])
  expect(result.stalenessByRunId['run-1']?.state).toBe('unknown')
})

it('retains conditional writes through an external alias', async () => {
  const result = await project([
    'shared = {}',
    'snapshot = dict(shared)',
    'counts = shared\nfor row in source:\n    if row in counts:\n        counts[row] += 1'
  ])
  expect(result.stalenessByRunId['run-2']?.state).toBe('unknown')
  expect(result.stalenessByRunId['run-1']?.state).not.toBe('clear')
})

const setup =
  'import numpy as np\nimport matplotlib.pyplot as plt\nfig, ax = plt.subplots()\nscale = 2'

const helper =
  'def decorate(target, value):\n    angle = np.deg2rad(value * scale)\n    target.text(angle, 1, "label")\ndecorate(ax, 30)'
it('tracks helper mutations and captured values without leaking its local names', async () => {
  const result = await project([setup, 'print(ax)', helper])
  expect(result.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
  expect(result.stalenessByRunId['run-1']?.state).toBe('stale')
  expect(result.dependenciesByRunId?.['run-2']).toContain('run-0')
  const changed = await project([setup, helper, 'scale = 3'])
  expect(changed.stalenessByRunId['run-1']?.state).toBe('stale')
})

it.each([
  'def decorate(target):\n    custom_operation(target)\ndecorate(ax)',
  'def decorate(target):\n    import custom_plugin\ndecorate(ax)',
  'def decorate(target):\n    for item in unknown_iterator:\n        target.text(0, 0, item)\ndecorate(ax)',
  'def decorate(target, print):\n    print(target)\ndecorate(ax, custom_operation)',
  'def decorate(target):\n    alias = target\n    alias.clear()\ndecorate(ax)',
  'def decorate(target):\n    return target\nother = decorate(ax)'
])('keeps unsupported helper behavior conservative: %s', async (script) => {
  const result = await project([setup, script])
  expect(result.stalenessByRunId['run-1']?.state).toBe('unknown')
})

it('does not trust a previously monkey-patched helper dependency', async () => {
  const result = await project([setup, 'np.deg2rad = custom_operation', helper])
  expect(result.stalenessByRunId['run-2']?.state).toBe('unknown')
})

it('tracks the output-buffer form of angle conversion', async () => {
  const result = await project([
    'import numpy as np\na = np.array([30, 60])\nb = np.zeros(2)',
    'print(b)',
    'np.deg2rad(a, out=b)'
  ])
  expect(result.stalenessByRunId['run-1']?.state).toBe('stale')
})

it
  .skipIf(process.env.RUN_KERNEL !== '1' || !process.env.OPEN_SCIENCE_TEST_PYTHON)
  .each([
    `${cells[0]}\n${cells[6]}`,
    recordCells.join('\n'),
    independentPolarChord,
    arcRibbon,
    cartesianChord,
    [workbookCells[5], workbookCells[6]].join('\n'),
    [coloredChordCells[2], coloredChordCells[3]].join('\n'),
    ...redrawCells,
    subarcCells[5]!,
    `${matrixInput}\n${matrixChord}`,
    ...neighborChords
  ])(
  'captures Excel input and reproduces chord workflow %# in fresh Python processes',
  async (script) => {
    const root = await mkdtemp(join(tmpdir(), 'native-chord-'))
    const python = process.env.OPEN_SCIENCE_TEST_PYTHON!
    const hashes: string[] = []
    try {
      await mkdir(join(root, 'cache'), { recursive: true })
      for (const name of ['original', 'replay']) {
        const sessionRoot = join(root, name)
        const dataRoot = join(sessionRoot, 'data')
        await mkdir(join(dataRoot, 'inputs'), { recursive: true })
        // Small synthetic fixture with the same schema: no user spreadsheet is loaded by the test runner.
        await promisify(execFile)(
          python,
          [
            '-c',
            'import pandas as pd\npd.DataFrame([(f"Gene{i}",f"S{j}",float(i+j)) for i in range(1,7) for j in range(1,11)], columns=["from","to","value"]).to_excel("inputs/edge-weights-222222222222.xlsx",index=False,sheet_name="Sheet 1")'
          ],
          { cwd: dataRoot, timeout: 20000 }
        )
        if (name === 'original' && redrawCells.includes(script)) {
          await writeFile(join(dataRoot, 'chord_diagram.png'), 'older published generation')
        }
        const observation = await startWorkingFileObservation({
          dataRoot,
          notebookSessionRoot: sessionRoot,
          cwd: dataRoot,
          code: script,
          language: 'python',
          runId: name
        })
        await promisify(execFile)(python, ['-c', script], {
          cwd: dataRoot,
          timeout: 30000,
          env: {
            ...process.env,
            MPLBACKEND: 'Agg',
            MPLCONFIGDIR: join(root, 'matplotlib'),
            XDG_CACHE_HOME: join(root, 'cache')
          }
        })
        const evidence = await observation.finish()
        expect(evidence.fileEvidence).toMatchObject({
          state: 'available',
          fileReads: 'complete',
          writerAttribution: 'complete',
          reasonCodes: []
        })
        expect(evidence.confirmedReadPaths).toContain('data/inputs/edge-weights-222222222222.xlsx')
        if (redrawCells.includes(script))
          expect(evidence.confirmedReadPaths).not.toContain('data/chord_diagram.png')
        expect(evidence.workingFiles.map((file) => file.relativePath)).toContain(
          'data/chord_diagram.png'
        )
        const png = await readFile(join(dataRoot, 'chord_diagram.png'))
        expect(png.subarray(1, 4).toString()).toBe('PNG')
        hashes.push(createHash('sha256').update(png).digest('hex'))
      }
      expect(hashes[0]).toBe(hashes[1])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  90000
)

it('keeps loop temporaries that may read old kernel state uncertain', async () => {
  const result = await project([
    'unrelated = 1',
    'for value in values:\n    if value > 0:\n        label = str(value)\n    print(label)'
  ])
  expect(result.stalenessByRunId['run-1']?.state).toBe('unknown')
})

it('captures a DataFrame text export without treating inspection as a file write', async () => {
  for (const [argument, writes] of [
    ['', []],
    ['buf="summary.txt"', ['summary.txt']]
  ] as const) {
    expect(
      await analyzeNotebookSourceFileAccess('python', `${cells[0]}\ndf.to_string(${argument})`)
    ).toMatchObject({ writes, writeState: 'complete' })
  }
})

it.each([
  'def draw(target, values):\n    result = sorted(values, key=custom_key)\n    target.text(0, 0, str(result))\ndraw(ax, [1, 2])',
  'from matplotlib.path import Path\ndef wrap(vertices):\n    return Path(vertices)\nvertices = np.zeros((3,2))\nresult = wrap(vertices)',
  'def transform(values, output):\n    return np.deg2rad(values, out=output)\na = np.ones(2)\nb = np.zeros(2)\nc = transform(a,b)'
])('retains callback and returned-identity uncertainty: %s', async (script) => {
  const result = await project([setup, script])
  expect(result.stalenessByRunId['run-1']?.state).toBe('unknown')
})

it('ignores comments between call arguments and collection elements', async () => {
  const source =
    'import numpy as np\na = np.zeros(2)\nb = np.zeros(2)\nnp.deg2rad(\n a, # input\n out=b # output\n)\nlabels = [\n "x", # first\n "y" # second\n]\n'
  const uncommented = source.replace(/#[^\n]*/g, '')
  expect(await analyzePythonSources([source])).toEqual(await analyzePythonSources([uncommented]))
})

it.each([
  'mpl.colors = custom',
  'mpl.colors.to_rgb = custom',
  'fig.patch = custom',
  'fig.patch.set_facecolor = custom'
])('does not trust a replaced plotting property: %s', async (change) => {
  const result = await project([
    `import matplotlib as mpl
import matplotlib.pyplot as plt
fig, ax = plt.subplots()
${change}
fig.patch.set_facecolor('white')
print(mpl.colors.to_rgb('red'))`
  ])
  expect(result.stalenessByRunId['run-0']?.state).not.toBe('clear')
})

it('tracks both collections when mutating entries of a concatenated list', async () => {
  const result = await project([
    'left = [{"value": 1}]\nright = [{"value": 2}]',
    'print(left, right)',
    'for record in left + right:\n    record["value"] = 3'
  ])
  expect(result.stalenessByRunId['run-1']?.state).not.toBe('clear')
  const [facts] = await analyzePythonSources([
    'left = [{"value": 1}]\nright = [{"value": 2}]\nfor record in left + right:\n    record["value"] = 3'
  ])
  expect([...(facts.mutatedNames ?? []), ...(facts.possiblyMutatedNames ?? [])]).toEqual(
    expect.arrayContaining(['left', 'right'])
  )
})

it('keeps references stored in a returned builder list connected to caller objects', async () => {
  const result = await project([
    `import numpy as np
source = np.array([1., 2.])
def build(value):
    result = []
    result.append(value)
    return result, 0
items, count = build(source)`,
    'print(items)',
    'source[0] = 9'
  ])
  expect(result.stalenessByRunId['run-1']?.state).not.toBe('clear')
})

it.each([
  '__import__ = custom\nprint(__import__("os").path.getsize("figure.png"))',
  'print(__import__(module_name).path.getsize("figure.png"))',
  'size = __import__("os").path.getsize("figure.png")\nvalues = [size]',
  'import os\nos.path.getsize = custom\nprint(__import__("os").path.getsize("figure.png"))',
  'sorted = custom\nitems = sorted([1, 2])\nfor item in items:\n    print(item)'
])('preserves uncertainty for dynamic or rebound observations: %s', async (script) => {
  expect((await project([script])).stalenessByRunId['run-0']?.state).not.toBe('clear')
})

it('tracks rebinding the diagnostic importer in an earlier cell', async () => {
  const result = await project([
    '__import__ = custom',
    'print(__import__("os").path.getsize("figure.png"))'
  ])
  expect(result.stalenessByRunId['run-1']?.state).not.toBe('clear')
})

it('tracks effects in loops whose target is unused, without assuming the target exists afterwards', async () => {
  const result = await project(['items = []\nfor item in items:\n    pass'])
  expect(result.stalenessByRunId['run-0']).toEqual({ state: 'clear' })
  const escaped = await project(['items = []\nfor item in items:\n    pass\nprint(item)'])
  expect(escaped.stalenessByRunId['run-0']?.state).not.toBe('clear')
})

it('preserves captured references returned inside a new builder list', async () => {
  const result = await project([
    `import numpy as np
source = np.array([1., 2.])
def build():
    result = []
    result.append(source)
    return result, 0
items, count = build()`,
    'print(items)',
    'source[0] = 9'
  ])
  expect(result.stalenessByRunId['run-1']?.state).not.toBe('clear')
})

it('retains later uncertainty for an unused loop binding and its possible input alias', async () => {
  const result = await project(['a = []', 'for b in [a]:\n    pass', 'print(a)', 'b.append(1)'])
  expect(result.stalenessByRunId['run-2']?.state).not.toBe('clear')
})

it('analyzes the reported arc ribbon workflow without losing file evidence', async () => {
  expect((await project([arcRibbon])).stalenessByRunId['run-0']).toEqual({ state: 'clear' })
})
it('captures the reported arc ribbon Excel input and PNG output', async () => {
  expect(await analyzeNotebookSourceFileAccess('python', arcRibbon)).toMatchObject({
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete',
    reads: ['inputs/edge-weights-222222222222.xlsx'],
    writes: ['chord_diagram.png']
  })
})

it.each([
  'lambda x: [order.append(v) for v in x]',
  'lambda x: [order.index(v) for order in x for v in order]',
  'lambda x: [order.index(v) async for v in x]',
  'lambda x: [unknown(v) for v in x]',
  'lambda x: (order.index(v) for v in x)',
  'lambda x: [order.index(v) for v in external_iterator()]'
])('keeps unknown or deferred sorting callbacks conservative: %s', async (callback) => {
  const script = `import pandas as pd
order = ['S1', 'S2']
df = pd.DataFrame({'group':['S1', 'S2']})
result = df.sort_values('group', key=${callback})`
  expect((await project([script])).stalenessByRunId['run-0']?.state).not.toBe('clear')
})

it('tracks the captured ordering when a pure sorting callback runs', async () => {
  const result = await project([
    "import pandas as pd\norder = ['S1', 'S2']\ndf = pd.DataFrame({'group':['S1','S2']})",
    "result = df.sort_values('group', key=lambda x: [order.index(v) for v in x])",
    'order.reverse()'
  ])
  expect(result.stalenessByRunId['run-1']).toMatchObject({
    state: 'stale',
    causedByRunId: 'run-2',
    names: ['order'],
    path: ['run-0', 'run-1']
  })
})

it.each(['    if flag:\n        pos = 0', '    pos = 0\n    del pos'])(
  'does not invent a definite nested-loop accumulator: %s',
  async (setup) => {
    const script = `groups = [1, 2]
for group in groups:
${setup}
    for item in [1, 2]:
        print(pos)
        pos += item`
    expect((await project([script])).stalenessByRunId['run-0']?.state).not.toBe('clear')
  }
)

it('retains mutation through the values property of a DataFrame', async () => {
  const result = await project([
    'import pandas as pd\ndf = pd.DataFrame({"value":[1.,2.]})\na = df.values',
    'print(df)',
    'a[0, 0] = 9'
  ])
  expect(result.stalenessByRunId['run-1']?.state).not.toBe('clear')
})

it.each(exploration.map((script, index) => ({ script, index })))(
  'analyzes reported exploration cell $index',
  async ({ script }) => {
    expect((await project([script])).stalenessByRunId['run-0']).toEqual({ state: 'clear' })
    expect(await analyzeNotebookSourceFileAccess('python', script)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete'
    })
  }
)
it('analyzes reported cartesian chord', async () => {
  expect((await project([cartesianChord])).stalenessByRunId['run-0']).toEqual({ state: 'clear' })
  expect(await analyzeNotebookSourceFileAccess('python', cartesianChord)).toMatchObject({
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete',
    reads: ['inputs/edge-weights-222222222222.xlsx'],
    writes: ['chord_diagram.png']
  })
})

it('keeps exploration cells from contaminating a self-contained drawing', async () => {
  const result = await project([...exploration, cartesianChord])
  expect(result.stalenessByRunId['run-6']).toEqual({ state: 'clear' })
})

it.each([
  'import os\nfor f in os.listdir("."):\n    print(f)\nprint(f)',
  'import os\nfor root, dirs, files in os.walk("."):\n    dirs.clear()\n    print(files)',
  'import os\nfor root, dirs, files in os.walk(".", onerror=custom):\n    print(files)',
  exploration[3] + '\nprint(m.__version__)',
  exploration[3]!.replace('print(f"{pkg}: NOT INSTALLED")', 'change_state()'),
  exploration[3]!.replace(
    "['pycircos', 'plotly', 'matplotlib', 'bokeh', 'holoviews', 'chord']",
    'package_names'
  )
])(
  'retains uncertainty when a diagnostic value escapes or runs unknown code: %s',
  async (script) => {
    expect((await project([script])).stalenessByRunId['run-0']?.state).not.toBe('clear')
  }
)

it('does not discard file reads inside a directory loop', async () => {
  const result = await analyzeNotebookSourceFileAccess(
    'python',
    'import os\nfor f in os.listdir("inputs"):\n    print(open(os.path.join("inputs", f)).read())'
  )
  expect(result.readState).not.toBe('complete')
})

it('tracks nested helper captures across later changes', async () => {
  const result = await project([
    'offset = 2',
    'def convert(x):\n    def adjust(y):\n        return y + offset\n    return adjust(x)\nvalue = convert(3)',
    'offset = 9'
  ])
  expect(result.stalenessByRunId['run-1']?.state).not.toBe('clear')
})

it.each([
  'def helper():\n    def change():\n        external()\n    change()\nhelper()',
  'import pandas as pd\ndf = pd.DataFrame({"g":[1],"n":[2]})\ndf.groupby("g").agg(custom)',
  'sum = custom\nfor g in groups:\n    total = sum(v for v in values)\n    print(total)'
])('retains unknown callback and nested-helper effects: %s', async (script) => {
  expect((await project([script])).stalenessByRunId['run-0']?.state).not.toBe('clear')
})

it('preserves references stored in a freshly unpacked container', async () => {
  const result = await project([
    'shared = []\nitems, offset = [shared], 0',
    'print(shared)',
    'items[0].append(1)'
  ])
  expect(result.stalenessByRunId['run-1']?.state).not.toBe('clear')
})

it('retains directory state used by a nested plotting helper', async () => {
  const result = await project([
    `import os
import matplotlib.pyplot as plt
fig, ax = plt.subplots()
def label(target):
    for filename in os.listdir('.'):
        print(filename)
    target.set_title(filename)
label(ax)`
  ])
  expect(result.stalenessByRunId['run-0']?.state).not.toBe('clear')
})

it('captures diagnostic text redirected to a file', async () => {
  expect(
    await analyzeNotebookSourceFileAccess(
      'python',
      `import os
with open('listing.txt', 'w') as output:
    for f in os.listdir('.'):
        print(f, file=output)`
    )
  ).toMatchObject({ writes: ['listing.txt'] })
})

it.each([0, 1, 2, 3, 5])('analyzes reported workbook cell %i', async (index) => {
  expect((await project([workbookCells[index]!])).stalenessByRunId['run-0']).toEqual({
    state: 'clear'
  })
  expect(await analyzeNotebookSourceFileAccess('python', workbookCells[index]!)).toMatchObject({
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete',
    reads: ['inputs/edge-weights-222222222222.xlsx']
  })
})
it('analyzes reported workbook drawing after its successful matrix setup', async () => {
  const result = await project([workbookCells[5]!, workbookCells[6]!])
  expect(result.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
})

it.each(['sheet_name=None', 'sheet_name=[0, 1]', 'None', '[0, 1]'])(
  'tracks multi-sheet selection %s and its table values',
  async (selector) => {
    for (const loop of [
      'for name, table in sheets.items():\n    print(table.head(), table.columns.tolist())',
      'for table in sheets.values():\n    print(table.sum().to_list())'
    ]) {
      const script = `from pandas import read_excel
sheets = read_excel('inputs/book.xlsx', ${selector})
${loop}`
      expect((await project([script])).stalenessByRunId['run-0']).toEqual({ state: 'clear' })
      expect(await analyzeNotebookSourceFileAccess('python', script)).toMatchObject({
        readState: 'complete',
        reads: ['inputs/book.xlsx']
      })
    }
  }
)

it('preserves workbook table types across cells', async () => {
  const result = await project([
    "import pandas as pd\nsheets = pd.read_excel('inputs/book.xlsx', sheet_name=None)",
    'for key, table in sheets.items():\n    print(table.head())'
  ])
  expect(result.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
})

it.each(['sheet_name=selector', '**options'])(
  'does not guess the workbook result type for %s',
  async (selector) => {
    const result = await project([
      `import pandas as pd
sheets = pd.read_excel('inputs/book.xlsx', ${selector})
for key, table in sheets.items():
    print(table.head())`
    ])
    expect(result.stalenessByRunId['run-0']?.state).not.toBe('clear')
  }
)

it('retains unknown methods and table mutations during workbook iteration', async () => {
  const setup = "import pandas as pd\nsheets = pd.read_excel('inputs/book.xlsx', sheet_name=None)"
  expect(
    (await project([`${setup}\nfor key, table in sheets.items():\n    table.custom_transform()`]))
      .stalenessByRunId['run-0']?.state
  ).not.toBe('clear')
  const result = await project([
    setup,
    'print(sheets)',
    'for table in sheets.values():\n    table.dropna(inplace=True)'
  ])
  expect(result.stalenessByRunId['run-1']?.state).not.toBe('clear')
})

it.each([
  'for x in values:\n    if x > 0:\n        label = str(x)\n        break\nprint(label)',
  'for x in values:\n    if x > 0:\n        break\nelse:\n    label = "empty"\nprint(label)',
  'for x in values:\n    if x > 0:\n        label = str(x)\n    print(label)',
  'for x in values:\n    custom_transform(x)\n    break'
])('retains uncertainty for unsafe early-exit scopes: %s', async (source) => {
  expect((await project([`values = [1, 2]\n${source}`])).stalenessByRunId['run-0']?.state).not.toBe(
    'clear'
  )
})

it('isolates temporary rebindings inside later branches', async () => {
  const source = `values = list(range(3))
for item in values:
    rotation = 90
    print(rotation)
for item in values:
    if item > 0:
        rotation = item + 180
        print(rotation)`
  expect((await project([source])).stalenessByRunId['run-0']).toEqual({ state: 'clear' })
})

it.each(['None', 'sheet_name=None'])(
  'preserves selection shape through a chained workbook call: %s',
  async (selector) => {
    const source = `import pandas as pd
print(pd.read_excel('inputs/book.xlsx', ${selector}).keys())
for table in pd.read_excel('inputs/book.xlsx', ${selector}).values():
    print(table.head())`
    expect((await project([source.split('\nfor table')[0]!])).stalenessByRunId['run-0']).toEqual({
      state: 'clear'
    })
    expect((await project([source])).stalenessByRunId['run-0']).toEqual({ state: 'clear' })
  }
)

it('restores workbook call shapes from the analysis cache', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workbook-analysis-cache-'))
  const runs = [
    run("import pandas as pd\nprint(pd.read_excel('inputs/book.xlsx', None).keys())", 0)
  ]
  const repository = { readSessionRuns: async () => runs }
  const request = {
    projectId: 'project',
    sessionId: 'session',
    completedRun: runs[0],
    interpreter: { command: 'unused' }
  }
  try {
    const initial = await new NotebookDependencyAnalyzer({ storageRoot: root, repository }).project(
      request
    )
    const path = join(root, 'notebooks', 'project', 'session', 'cache', 'dependency-analysis.json')
    const sidecar = JSON.parse(await readFile(path, 'utf8'))
    sidecar.projectionSnapshots = {}
    await writeFile(path, JSON.stringify(sidecar))
    let reanalyses = 0
    const restored = await new NotebookDependencyAnalyzer({
      storageRoot: root,
      repository,
      analyze: async () => {
        reanalyses++
        return []
      }
    }).project(request)
    expect(reanalyses).toBe(0)
    expect(restored.stalenessByRunId).toEqual(initial.stalenessByRunId)
    expect(restored.stalenessByRunId['run-0']).toEqual({ state: 'clear' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.each([0, 1, 2])('analyzes reported colored chord preparation cell %i', async (index) => {
  expect((await project([coloredChordCells[index]!])).stalenessByRunId['run-0']).toEqual({
    state: 'clear'
  })
  expect(await analyzeNotebookSourceFileAccess('python', coloredChordCells[index]!)).toMatchObject({
    readState: 'complete',
    reads: ['inputs/edge-weights-222222222222.xlsx']
  })
})
it('analyzes the reported colored chord function and its workbook dependency', async () => {
  const result = await project([coloredChordCells[2]!, coloredChordCells[3]!])
  expect(result.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  expect(result.dependenciesByRunId?.['run-1']).toContain('run-0')
  expect(
    await analyzeNotebookSourceFileAccess(
      'python',
      [coloredChordCells[2], coloredChordCells[3]].join('\n')
    )
  ).toMatchObject({
    readState: 'complete',
    writeState: 'complete',
    writes: ['chord_diagram.png']
  })
})

it.each([
  `values = ['Gene2', 'Gene1']\nresult = sorted(values, key=lambda x: int(x.replace('Gene', '')))`,
  `def convert(color):\n    color = color.lstrip('#')\n    return tuple(int(color[i:i+2],16) for i in (0,2,4))\nresult = convert('#ABCDEF')`,
  `import numpy as np\ndef select(matrix):\n    return float(matrix.iloc[0,0] if hasattr(matrix, 'iloc') else matrix[0,0])\nresult = select(np.zeros((2,2)))`,
  `import numpy as np\ndef build(data):\n    values = []\n    for x in data:\n        values.append((v := float(x)))\n    return values, len(values)\nresult = build(np.array([1,2]))`
])('analyzes colored chord scalar helper: %s', async (source) => {
  expect((await project([source])).stalenessByRunId['run-0']).toEqual({ state: 'clear' })
})

it.each([
  `result = sorted(objects, key=lambda value: int(value.replace('Gene', '')))`,
  `items = [(last := item) for item in []]\nprint(last)`,
  `import numpy as np\nfrom custom import hasattr\ndef select(matrix):\n    return float(matrix.iloc[0,0] if hasattr(matrix, 'iloc') else matrix[0,0])\nresult = select(np.zeros((2,2)))`,
  `import matplotlib.pyplot as plt\ndef build(axis):\n    fig, ax = plt.subplots()\n    ax = axis\n    return fig, ax\nfig, axis = plt.subplots()\nresult = build(axis)`,
  `import numpy as np\ndef compute(out):\n    local = np.ones(2)\n    local.sum(None, None, out)\n    return 1\nbuffer = np.zeros(1)\nresult = compute(buffer)`,
  `import matplotlib.pyplot as plt\nfrom matplotlib.patches import Rectangle\ndef build(patch):\n    fig, ax = plt.subplots()\n    ax.add_patch(patch)\n    return fig, ax\npatch = Rectangle((0,0),1,1)\nresult = build(patch)`
])('retains uncertainty at an unproven helper boundary: %s', async (source) => {
  expect((await project([source])).stalenessByRunId['run-0']?.state).not.toBe('clear')
})

it('invalidates the chart after its input matrix changes', async () => {
  const result = await project([
    coloredChordCells[2]!,
    coloredChordCells[3]!,
    'matrix.iloc[0, 0] = 100'
  ])
  expect(result.stalenessByRunId['run-1']?.state).toBe('stale')
})

it.each(['np.cumsum(source, out=buffer)', 'np.cumsum(source, None, None, buffer)'])(
  'tracks cumulative-sum output buffers: %s',
  async (operation) => {
    const result = await project([
      'import numpy as np\nsource = np.array([1,2])\nbuffer = np.zeros(2)',
      'snapshot = buffer.copy()',
      operation
    ])
    expect(result.stalenessByRunId['run-1']?.state).toBe('stale')
  }
)

it('ignores an overwritten loop temporary from a previous run', async () => {
  const result = await project([
    'pct=99',
    'from collections import Counter\ncounts=Counter()\nfor label, count in counts.items():\n    pct=count*100\n    print(label,pct)\nresult="ready"'
  ])
  expect(result.dependenciesByRunId?.['run-1']).toEqual([])
})

it.each([
  'def choose(x, values=[]):\n    values.append(x)\n    return values\nresult = choose(1)',
  'def choose(x):\n    for candidate in []:\n        step = candidate*x\n        if step>1:\n            return step\n    return step\nresult=choose(10)',
  'def choose(x):\n    values=[1,2]\n    alias=values\n    alias.clear()\n    for candidate in values:\n        step=candidate*x\n        if step>1:\n            return step\n    return step\nresult=choose(10)',
  'def choose(x):\n    if x>0:\n        return step\n    step=x*2\n    return step\nresult=choose(1)'
])('retains uncertainty for unsafe helper defaults or early returns: %s', async (source) => {
  expect((await project([source])).stalenessByRunId['run-0']?.state).toBe('unknown')
})

it('retains dependencies through a numeric-list alias', async () => {
  const result = await project(['values=[1,2]\nalias=values', 'print(values)', 'alias.append(3)'])
  expect(result.stalenessByRunId['run-1']?.state).toBe('stale')
})

it('keeps list operations on converted pandas indexes available', async () => {
  const result = await project([
    'import pandas as pd\nframe = pd.read_excel("inputs/book.xlsx")\nlabels = frame.index.tolist()\nposition = labels.index("Gene1")\nlabels.append("Gene2")'
  ])
  expect(result.stalenessByRunId['run-0']).toEqual({ state: 'clear' })
})

it('tracks output buffers of scalar-aware numpy functions', async () => {
  const result = await project([
    'import numpy as np\nvalues=np.array([1.5])\nout=np.zeros(1)',
    'print(out)',
    'np.floor(values,out=out)'
  ])
  expect(result.stalenessByRunId['run-1']?.state).toBe('stale')
})

it('keeps a conditional helper mutation attached to its caller', async () => {
  const result = await project([
    'import matplotlib.pyplot as plt\nfig,ax=plt.subplots()',
    'print(ax)',
    'def label(ax, flag):\n    if flag:\n        ax.set_title("updated")\nlabel(ax, True)'
  ])
  expect(result.stalenessByRunId['run-1']?.state).toBe('stale')
})

it('captures scalar defaults before a later rebinding', async () => {
  const result = await project([
    'radius=1.0\ndef square(value=radius):\n    return value*value\nradius=[]\nresult=square()'
  ])
  expect(result.stalenessByRunId['run-0']).toEqual({ state: 'clear' })
})
