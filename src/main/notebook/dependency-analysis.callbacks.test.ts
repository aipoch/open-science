import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import type { NotebookDependencyProjection } from './dependency-analysis-types'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'
import {
  reportedPythonCallbackPlot,
  reportedPythonCallbackPrelude
} from './reported-python-callback.fixture'

const project = async (scripts: string[]): Promise<NotebookDependencyProjection> => {
  const root = await mkdtemp(join(tmpdir(), 'callback-analysis-'))
  try {
    const runs: NotebookRunRecord[] = scripts.map((script, index) => ({
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
    }))
    return await new NotebookDependencyAnalyzer({
      storageRoot: root,
      repository: { readSessionRuns: async () => runs }
    }).project({ projectId: 'project', sessionId: 'session', completedRun: runs.at(-1) })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

it('captures the reported pie callback without treating its comment as a file read', async () => {
  expect((await project([reportedPythonCallbackPlot])).stalenessByRunId['run-0']).toEqual({
    state: 'clear'
  })
  expect(await analyzeNotebookSourceFileAccess('python', reportedPythonCallbackPlot)).toMatchObject(
    {
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: [],
      writes: ['group_pie_r.png']
    }
  )
})

it('keeps the reported sine and callback pie independent', async () => {
  const projection = await project([reportedPythonCallbackPrelude, reportedPythonCallbackPlot])
  expect(projection.stalenessByRunId).toEqual({
    'run-0': { state: 'clear' },
    'run-1': { state: 'clear' }
  })
  expect(projection.dependenciesByRunId).toEqual({ 'run-0': [], 'run-1': [] })
})

it.each(['lambda p: p * 100', 'lambda p: round(p)', 'lambda p: p * sum(sizes)'])(
  'analyzes callback expressions: %s',
  async (callback) => {
    const script = `import matplotlib.pyplot as plt\nsizes = [33, 33]\nfig, ax = plt.subplots()\nax.pie(sizes, autopct=${callback})\nfig.savefig("plot.png")`
    expect((await project([script])).stalenessByRunId['run-0']).toEqual({ state: 'clear' })
  }
)

it.each([
  'result = sorted(sizes, key=lambda p: round(p * factor))',
  'result = min(sizes, key=lambda p: abs(p - factor))',
  'series = pd.Series(sizes)\nresult = series.map(lambda p: round(p * factor))',
  'frame = pd.DataFrame({"n": sizes})\nresult = frame.assign(scaled=lambda row: row["n"] * factor)',
  'fig, ax = plt.subplots()\nbars = ax.bar(["A", "B"], sizes)\nax.bar_label(bars, fmt=lambda p: f"{round(p * factor)}")'
])('reuses callback analysis across consumers: %s', async (body) => {
  const script = `import pandas as pd\nimport matplotlib.pyplot as plt\nsizes = [33, 33]\nfactor = 2\n${body}`
  expect((await project([script])).stalenessByRunId['run-0']).toEqual({ state: 'clear' })
  expect(await analyzeNotebookSourceFileAccess('python', script)).toMatchObject({
    readState: 'complete'
  })
})

it.each(['lambda p: p * factor', 'formatter'])(
  'tracks closure reads at invocation time: %s',
  async (callback) => {
    const scripts = [
      'factor = 2\nformatter = lambda p: p * factor',
      `import matplotlib.pyplot as plt\nfig, ax = plt.subplots()\nax.pie([1, 2], autopct=${callback})`
    ]
    expect((await project(scripts)).dependenciesByRunId?.['run-1']).toContain('run-0')
    expect((await project([...scripts, 'factor = 3'])).stalenessByRunId['run-1']).toMatchObject({
      state: 'stale'
    })
  }
)

it.each([
  'lambda p: open("secret.csv").read()',
  'lambda p: sizes.append(p)',
  'lambda p: custom(p)',
  'lambda p: (factor := p)',
  'lambda p, round: round(p)',
  'lambda p: p.attribute'
])('keeps side effects and unresolved dispatch conservative: %s', async (callback) => {
  const script = `import matplotlib.pyplot as plt\nsizes = [33, 33]\nfig, ax = plt.subplots()\nax.pie(sizes, autopct=${callback})`
  expect((await project([script])).stalenessByRunId['run-0']).toMatchObject({ state: 'unknown' })
  expect(await analyzeNotebookSourceFileAccess('python', script)).toMatchObject({
    readState: 'partial'
  })
})

it('does not treat a shadowed builtin in a callback as safe', async () => {
  const projection = await project([
    'round = custom_round',
    'import matplotlib.pyplot as plt\nfig, ax = plt.subplots()\nax.pie([1, 2], autopct=lambda p: round(p))'
  ])
  expect(projection.stalenessByRunId['run-1']).toMatchObject({ state: 'unknown' })
})

it('does not attribute a lazy iterator closure to its creation run', async () => {
  expect(
    (await project(['factor = 2\nresult = map(lambda p: p * factor, [1, 2])'])).stalenessByRunId[
      'run-0'
    ]
  ).toMatchObject({ state: 'unknown' })
})

it('uses the same closure summary for a named formatter function', async () => {
  const scripts = [
    'factor = 2\ndef formatter(p):\n    return f"{int(round(p * factor))}%"',
    'import matplotlib.pyplot as plt\nfig, ax = plt.subplots()\nax.pie([1, 2], autopct=formatter)\nfig.savefig("plot.png")'
  ]
  expect((await project(scripts)).stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  expect((await project([...scripts, 'factor = 3'])).stalenessByRunId['run-1']).toMatchObject({
    state: 'stale'
  })
})
