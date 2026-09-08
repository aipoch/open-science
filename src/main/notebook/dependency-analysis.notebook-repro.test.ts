import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import type { NotebookDependencyProjection } from './dependency-analysis-types'
import { reportedPythonPlots } from './reported-python-plots.fixture'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'
import {
  reportedCountsSource,
  reportedPlotSetup,
  reportedBarRetry,
  reportedFailedPlot
} from './reported-python-failed-plot.fixture'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true })))
})

const run = (index: number, script: string): NotebookRunRecord => ({
  runId: `run-${index}`,
  cellId: `cell-${index}`,
  source: 'agent',
  inputKind: 'cell',
  kernelKind: 'python',
  kernelEpochId: 'epoch-1',
  environment: 'default-python',
  script,
  status: 'completed',
  startedAt: index,
  endedAt: index,
  executionCount: index,
  text: { stdout: '', stderr: '', traceback: '', plain: [] },
  outputs: [],
  artifacts: [],
  workingFiles: [],
  inputFiles: []
})

const project = async (
  scripts: string[],
  failedIndex?: number
): Promise<NotebookDependencyProjection> => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-python-call-repro-'))
  temporaryRoots.push(storageRoot)
  const runs = scripts.map((script, index) => run(index + 1, script))
  if (failedIndex !== undefined) runs[failedIndex].status = 'failed'
  return new NotebookDependencyAnalyzer({
    storageRoot,
    repository: { readSessionRuns: async () => runs }
  }).project({
    projectId: 'default-project',
    sessionId: 'session-1',
    completedRun: runs.at(-1),
    interpreter: { command: 'unused-python' }
  })
}

describe('reported Python call tracking regressions', () => {
  it.each([
    ['annotated temporary', 'pct: float = n / total * 100'],
    ['unpacked temporaries', 'pct, label = n / total * 100, str(n)'],
    ['chained temporaries', 'pct = percent = n / total * 100']
  ])('captures plotting loops with %s', async (_name, assignment) => {
    const result = await project([
      reportedCountsSource,
      reportedPlotSetup,
      reportedBarRetry.replace('pct = n / total * 100', assignment)
    ])
    expect(result.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
    expect(result.dependenciesByRunId?.['run-3']).toContain('run-2')
  })

  it('tracks Matplotlib spine styling without losing its Axes owner', async () => {
    const result = await project([
      'import matplotlib.pyplot as plt\nfig, ax = plt.subplots()\nfor spine in ("top", "right"):\n    ax.spines[spine].set_visible(False)'
    ])
    expect(result.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it('captures a successful multi-cell counts and bar pipeline', async () => {
    const result = await project([reportedCountsSource, reportedPlotSetup, reportedBarRetry])
    expect(result.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
    expect(result.dependenciesByRunId?.['run-3']).toContain('run-2')
  })

  it('does not certify variables inherited from the reported failed cell', async () => {
    const result = await project([reportedCountsSource, reportedFailedPlot, reportedBarRetry], 1)
    expect(result.stalenessByRunId['run-3']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['incomplete-run'])
    })
  })

  it('recovers after rerunning the inputs and setup successfully', async () => {
    const result = await project(
      [
        reportedCountsSource,
        reportedFailedPlot,
        [reportedCountsSource, reportedPlotSetup, reportedBarRetry].join('\n')
      ],
      1
    )
    expect(result.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
    expect(result.dependenciesByRunId?.['run-3']).toEqual([])
  })

  it('captures both outputs after rerunning the inputs and corrected plotting cell', async () => {
    const corrected = [
      reportedCountsSource,
      reportedFailedPlot.replace('ax.suptitle(', 'fig.suptitle(')
    ].join('\n')
    const result = await project([reportedCountsSource, reportedFailedPlot, corrected], 1)
    expect(result.stalenessByRunId['run-3']).toEqual({ state: 'clear' })
    expect(result.dependenciesByRunId?.['run-3']).toEqual([])
    expect(await analyzeNotebookSourceFileAccess('python', corrected)).toMatchObject({
      writeState: 'complete',
      writes: ['synthetic_groups_bar.png', 'synthetic_groups_pie.png']
    })
  })

  it('keeps a loop temporary uncertain when a later cell reads it', async () => {
    const result = await project([
      'values = []\nfor value in values:\n    pct = value * 100\n    print(pct)',
      'print(pct)'
    ])
    expect(result.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
    expect(result.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
  })

  it('keeps a loop temporary uncertain when it escapes in the same cell', async () => {
    const result = await project([
      'values = []\nfor value in values:\n    pct = value * 100\n    print(pct)\nprint(pct)'
    ])
    expect(result.stalenessByRunId['run-1']).toMatchObject({ state: 'unknown' })
  })

  it('retains prior-state dependencies when a loop temporary reads its earlier value', async () => {
    const result = await project([
      'pct = 1\nvalues = []',
      'for value in values:\n    pct = pct + value\n    print(pct)'
    ])
    expect(result.dependenciesByRunId?.['run-2']).toContain('run-1')
  })

  it('does not hide unknown calls inside a temporary-value loop', async () => {
    const result = await project([
      'from custom import write\nvalues = []\nfor value in values:\n    pct = value * 100\n    write(pct)'
    ])
    expect(result.stalenessByRunId['run-1']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['opaque-call'])
    })
  })
  it.each(['pd.Series([1.25, 2.75])', 'pd.DataFrame({"n": [1.25, 2.75]})'])(
    'keeps rounding and deduplication separate from the source: %s',
    async (constructor) => {
      const initial = `import pandas as pd\nvalues = ${constructor}`
      const projection = await project([
        initial,
        'print(values)',
        'rounded = values.round(1)\nrounded.drop_duplicates(inplace=True)'
      ])
      expect(projection.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
      const mutated = await project([
        initial,
        'print(values)',
        'values.drop_duplicates(inplace=True)'
      ])
      expect(mutated.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
    }
  )
  it('preserves possible shared data after Series.to_frame', async () => {
    const projection = await project([
      'import pandas as pd\nvalues = pd.Series([1, 2])\nframe = values.to_frame()',
      'print(values)',
      'frame.drop_duplicates(inplace=True)'
    ])
    expect(projection.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
  })
  it('retains consumers of the calculated percentage result', async () => {
    const projection = await project([
      'import pandas as pd\ncounts = pd.Series([1, 2])\npercent = (counts / counts.sum() * 100).round(1)',
      'print(percent.to_dict())',
      'percent = pd.Series([4, 1])'
    ])
    expect(projection.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
  })
  it('retains a proven arithmetic operand type from an earlier run', async () => {
    const projection = await project([
      'import pandas as pd\ncounts = pd.Series([1, 2])',
      'percent = (counts / counts.sum() * 100).round(1)'
    ])
    expect(projection.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
    expect(projection.dependenciesByRunId?.['run-2']).toContain('run-1')
  })
  it.each([
    'percent = (counts + unknown).round(1)',
    'percent = (counts / custom_total()).round(1)',
    'counts = custom_counts\npercent = (counts * 100).round(1)',
    'percent = (counts * 100).custom_method()'
  ])('does not guess overloaded arithmetic or methods: %s', async (script) => {
    const projection = await project([`import pandas as pd\ncounts = pd.Series([1, 2])\n${script}`])
    expect(projection.stalenessByRunId['run-1']).toMatchObject({ state: 'unknown' })
  })
  it('keeps bar label callbacks conservative', async () => {
    const projection = await project([
      'import matplotlib.pyplot as plt\nfig, ax = plt.subplots()\nbars = ax.barh(["A"], [1])\nax.bar_label(bars, fmt=custom_formatter)'
    ])
    expect(projection.stalenessByRunId['run-1']).toMatchObject({ state: 'unknown' })
  })
  it.each([
    [
      'sort index chain',
      'import pandas as pd\ncounts = pd.Series([1, 2]).value_counts().sort_index()\nresult = counts.to_dict()'
    ],
    [
      'pie label loops',
      'import matplotlib.pyplot as plt\nfig, ax = plt.subplots()\nwedges, texts, autotexts = ax.pie([1, 2], autopct="%1.1f%%")\nfor t in texts:\n    t.set_fontsize(12)\nfor t in autotexts:\n    t.set_fontweight("bold")'
    ],
    ['axes aspect', 'import matplotlib.pyplot as plt\nfig, ax = plt.subplots()\nax.axis("equal")'],
    [
      'bar label zip',
      'import pandas as pd\nimport matplotlib.pyplot as plt\ncounts = pd.Series([1, 2]).value_counts()\nfig, ax = plt.subplots()\nbars = ax.bar(counts.index, counts.values)\nfor b, v in zip(bars, counts.values):\n    ax.text(b.get_x() + b.get_width() / 2, v + 0.5, str(v))'
    ]
  ])('isolates %s', async (_name, script) => {
    expect((await project([script])).stalenessByRunId).toEqual({ 'run-1': { state: 'clear' } })
  })

  it.each(
    reportedPythonPlots('inputs/groups.csv').map((script, index) => [index, script] as const)
  )('captures reported plot %s', async (index, script) => {
    expect((await project([script])).stalenessByRunId).toEqual({ 'run-1': { state: 'clear' } })
    expect(await analyzeNotebookSourceFileAccess('python', script)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: index === 0 ? [] : ['inputs/groups.csv'],
      writes: [['sine_plot.png'], ['group_pie.png'], ['group_bar.png']][index]
    })
  })

  it('reconstructs the reported sine, styled pie and annotated bar runs without unknown state', async () => {
    const projection = await project(reportedPythonPlots('inputs/groups.csv'))
    expect(projection.stalenessByRunId).toEqual({
      'run-1': { state: 'clear' },
      'run-2': { state: 'clear' },
      'run-3': { state: 'clear' }
    })
    expect(projection.dependenciesByRunId).toEqual({ 'run-1': [], 'run-2': [], 'run-3': [] })
  })

  it.each(['pd.Series([2, 1])', 'pd.DataFrame({"group": [2, 1]})'])(
    'preserves sort_index effects on %s',
    async (constructor) => {
      const initial = `import pandas as pd\nframe = ${constructor}`
      const normal = await project([
        initial,
        'ordered = frame.sort_index()\nresult = ordered.head()',
        'frame.sort_index()'
      ])
      expect(normal.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
      const mutated = await project([
        initial,
        'result = frame.head()',
        'frame.sort_index(inplace=True)'
      ])
      expect(mutated.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
      const uncertain = await project([
        initial,
        'result = frame.head()',
        'frame.sort_index(inplace=flag)'
      ])
      expect(uncertain.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
      const callback = await project([initial, 'ordered = frame.sort_index(key=custom_key)'])
      expect(callback.stalenessByRunId['run-2']).toMatchObject({ state: 'unknown' })
    }
  )

  it('tracks aspect changes as mutations of the known Axes', async () => {
    const projection = await project([
      'import matplotlib.pyplot as plt\nfig, ax = plt.subplots()',
      'print(ax)',
      'ax.axis("equal")'
    ])
    expect(projection.stalenessByRunId['run-2']).toMatchObject({ state: 'stale' })
  })

  it('does not poison an unrelated later run after scoped control flow', async () => {
    const projection = await project(['for item in []:\n    value = item', 'unrelated = 1'])

    expect(projection.stalenessByRunId).toEqual({
      'run-1': { state: 'clear' },
      'run-2': { state: 'clear' }
    })
  })

  it('keeps dynamic module imports opaque without poisoning unrelated bindings', async () => {
    const projection = await project([
      'import importlib\nmodule = importlib.import_module("custom_plugin")',
      'unrelated = 1'
    ])

    expect(projection.stalenessByRunId['run-1']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['scoped-opaque-call'])
    })
    expect(projection.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
  })

  it('keeps reflection hooks conservative', async () => {
    const projection = await project([
      'items = []',
      'snapshot = len(items)',
      'value = getattr(items, "custom", None)'
    ])

    expect(projection.stalenessByRunId['run-2']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['opaque-mutation'])
    })
  })

  it('classifies JSON decoding as read-only', async () => {
    const projection = await project(['import json\npayload = json.loads("{}")'])

    expect(projection.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  })

  it('preserves modeled effects for aliases assigned from module members', async () => {
    const projection = await project([
      'import numpy as np\nsine = np.sin\nvalues = [0.0]\nresult = sine(values)',
      'unrelated = 1'
    ])

    expect(projection.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
    expect(projection.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
  })

  it('keeps dependencies on conditionally assigned names unknown', async () => {
    const projection = await project([
      'source = []\nvalue = 1',
      'snapshot = value',
      'for item in source:\n    value = item'
    ])

    expect(projection.stalenessByRunId['run-2']).toEqual({
      state: 'unknown',
      reasons: ['control-flow']
    })
  })

  it('restores a definite binding after unconditional reassignment', async () => {
    const projection = await project([
      'source = []\nenabled = True\nif enabled:\n    value = source\nvalue = 2',
      'snapshot = value',
      'source.append(1)'
    ])

    expect(projection.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
  })

  it('does not retain summaries for conditionally defined classes', async () => {
    const projection = await project([
      'enabled = True\nif enabled:\n    class Conditional:\n        pass',
      'instance = Conditional()'
    ])

    expect(projection.stalenessByRunId['run-2']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['opaque-call'])
    })
  })

  it.each([
    ['method call', 'if enabled:\n    items.append(1)'],
    ['augmented assignment', 'if enabled:\n    items += [1]'],
    ['member write', 'if enabled:\n    items.value = 1']
  ])('keeps conditional %s mutations possible rather than definite', async (_, mutation) => {
    const projection = await project([
      'items = []\nenabled = True',
      'snapshot = len(items)',
      mutation
    ])

    expect(projection.stalenessByRunId['run-2']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['control-flow'])
    })
  })

  it('keeps unknown imported call effects namespace-scoped', async () => {
    const projection = await project([
      'from custom import transform\nsource = []\nresult = transform(source)',
      'unrelated = 1'
    ])

    expect(projection.stalenessByRunId['run-1']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['dynamic-namespace'])
    })
    expect(projection.stalenessByRunId['run-2']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['dynamic-namespace'])
    })
  })

  it('tracks captured names mutated by a local function', async () => {
    const projection = await project([
      'items = []',
      'snapshot = len(items)',
      'def update():\n    items.append(1)\nupdate()'
    ])

    expect(projection.stalenessByRunId['run-2']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['opaque-mutation'])
    })
  })

  it('keeps mutable return aliases from local functions conservative', async () => {
    const projection = await project([
      'items = []\ndef expose():\n    return items\nout = expose()',
      'snapshot = len(items)',
      'out.append(1)'
    ])

    expect(projection.stalenessByRunId['run-2']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['dynamic-namespace'])
    })
  })

  it('keeps implicit iteration effects in local functions conservative', async () => {
    const projection = await project([
      'items = []',
      'snapshot = len(items)',
      'def consume():\n    for item in items:\n        pass\nconsume()'
    ])

    expect(projection.stalenessByRunId['run-2']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['opaque-mutation'])
    })
  })

  it('keeps imports inside local functions namespace-scoped', async () => {
    const projection = await project([
      'def load():\n    import custom_plugin\nload()',
      'unrelated = 1'
    ])

    expect(projection.stalenessByRunId['run-2']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['dynamic-namespace'])
    })
  })

  it('keeps explicit global writes namespace-scoped', async () => {
    const projection = await project([
      'value = 1\ndef replace():\n    global value\n    value = 2\nreplace()',
      'unrelated = 1'
    ])

    expect(projection.stalenessByRunId['run-2']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['dynamic-namespace'])
    })
  })

  it('keeps nested helper effects namespace-scoped', async () => {
    const projection = await project([
      [
        'items = []',
        'def outer():',
        '    def nested():',
        '        items.append(1)',
        '    nested()',
        'outer()'
      ].join('\n'),
      'unrelated = 1'
    ])

    expect(projection.stalenessByRunId['run-2']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['dynamic-namespace'])
    })
  })

  it('keeps unmodeled callables assigned from module attributes conservative', async () => {
    const projection = await project([
      'import matplotlib.pyplot as plt\ncmap = plt.cm.Set2\ncolor = cmap(0)',
      'unrelated = 1'
    ])

    expect(projection.stalenessByRunId['run-1']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['scoped-opaque-call'])
    })
    expect(projection.stalenessByRunId['run-2']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['dynamic-namespace'])
    })
  })

  it('keeps unknown members of from-import bindings scoped', async () => {
    const projection = await project([
      'from custom import namespace\nresult = namespace.build()',
      'unrelated = 1'
    ])

    expect(projection.stalenessByRunId['run-1']).toMatchObject({
      state: 'unknown',
      reasons: expect.arrayContaining(['scoped-opaque-call'])
    })
    expect(projection.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
  })
})
