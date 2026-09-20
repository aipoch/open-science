import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import type { NotebookRunRecord } from '../../shared/notebook'
import { analyzePythonNotebookSource } from './dependency-analysis-python'
import { projectNotebookDependencies } from './dependency-projection'

const record = (script: string, index: number): NotebookRunRecord => ({
  runId: String(index),
  cellId: String(index),
  source: 'agent',
  kernelKind: 'python',
  kernelEpochId: 'epoch',
  script,
  status: 'completed',
  startedAt: index,
  endedAt: index + 1,
  text: { stdout: '', stderr: '', traceback: '', plain: [] },
  outputs: [],
  workingFiles: []
})

it.each([
  'random.shuffle(values)',
  'random.shuffle(x=values)',
  'np.random.shuffle(values)',
  'np.random.shuffle(x=values)'
])('retains argument mutation for global RNG operations: %s', async (call) => {
  const runs = [
    'values = [1, 2, 3]',
    'ordered = tuple(values)',
    `import random\nimport numpy as np\n${call}`
  ].map(record)
  const analyzed = await Promise.all(
    runs.map(async (run) => ({ run, facts: (await analyzePythonNotebookSource(run.script)).facts }))
  )
  // Even a legacy run without an RNG snapshot must invalidate consumers of the
  // collection it shuffles, for both positional and keyword arguments.
  expect(projectNotebookDependencies(analyzed).stalenessByRunId['1']?.state).toBe('stale')
  expect(analyzed[2]!.facts.pythonRandomStateReads).toBe(true)
})

it.each([
  'plt.style.use("ggplot")',
  'plt.rcParams["font.size"] = 17',
  'plt.rcParams.update({"axes.grid": True})',
  'import seaborn as sns\nsns.set_theme(style="whitegrid")'
])('includes cross-cell plotting configuration: %s', async (configuration) => {
  const root = await mkdtemp(join(tmpdir(), 'python-state-'))
  const scripts = [
    'import matplotlib.pyplot as plt',
    configuration,
    'unrelated = 1',
    'import matplotlib.pyplot as plt\nfig, ax = plt.subplots()\nax.plot([1,2],[3,4])\nfig.savefig("plot.png")'
  ]
  const runs: NotebookRunRecord[] = scripts.map((script, index) => ({
    runId: String(index),
    cellId: String(index),
    source: 'agent',
    kernelKind: 'python',
    kernelEpochId: 'epoch',
    script,
    status: 'completed',
    startedAt: index,
    endedAt: index + 1,
    text: { stdout: '', stderr: '', traceback: '', plain: [] },
    outputs: [],
    workingFiles: []
  }))
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const projection = await new NotebookDependencyAnalyzer({
        storageRoot: root,
        repository: { readSessionRuns: async () => runs }
      }).project({ projectId: 'p', sessionId: 's', completedRun: runs[3]! })
      expect(projection.stalenessByRunId['3']).toEqual({ state: 'clear' })
      expect(projection.dependenciesByRunId?.['3']).toContain('1')
      expect(projection.dependenciesByRunId?.['3']).not.toContain('2')
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.each([
  'import random\nx = random.gauss(0, 1)',
  'import numpy as np\nx = np.random.normal(size=10)',
  'from numpy.random import normal\nx = normal(size=10)',
  'import numpy as np\nnp.random.seed(42)\nx = np.random.normal(size=10)'
])('requires a captured snapshot for global draws: %s', async (script) => {
  const analyzed = await analyzePythonNotebookSource(script)
  expect(analyzed.facts.pythonRandomStateReads).toBe(true)
  const run = record(script, 0)
  expect(
    projectNotebookDependencies([{ run, facts: analyzed.facts }]).stalenessByRunId['0']
  ).toEqual({ state: 'unknown', reasons: ['random-state-unavailable'] })
  const observation = {
    locale: 'C',
    timezone: 'UTC',
    threadLimits: {},
    randomLibraries: [],
    pythonRandomState: {
      state: 'available' as const,
      standard: { words: [...Array<number>(624).fill(1), 624], gaussian: null },
      numpy: { words: Array<number>(624).fill(1), position: 624, hasGaussian: 0, gaussian: 0 }
    }
  }
  run.environmentManifest = {
    schemaVersion: 1,
    captureKind: 'completed-run',
    capturedAt: '2026-09-09T00:00:00Z',
    installedInventory: {
      capturedAt: '2026-09-09T00:00:00Z',
      source: 'full-scan',
      validation: 'full-scan'
    },
    kernelKind: 'python',
    environmentName: 'python',
    runtimeSource: 'managed',
    inventorySources: ['kernel-native'],
    packages: [],
    complete: true,
    captureStatus: 'complete',
    executionContext: { schemaVersion: 1, before: observation, after: observation }
  }
  expect(
    projectNotebookDependencies([{ run, facts: analyzed.facts }]).stalenessByRunId['0']
  ).toEqual({ state: 'clear' })
})

it.each([
  'import numpy as np\ng = np.random.default_rng()\nx = g.normal()',
  'import random\nrandom.seed()\nx = random.random()',
  'import matplotlib.pyplot as plt\nplt.style.use("https://example.test/style.mplstyle")',
  'import matplotlib.pyplot as plt\nplt.rcParams = {}\nplt.rcParams.update({"font.size": 17})'
])(
  'keeps unsupported entropy, custom styles and module replacement uncertain: %s',
  async (script) => {
    const { facts } = await analyzePythonNotebookSource(script)
    expect(
      projectNotebookDependencies([{ run: record(script, 0), facts }]).stalenessByRunId['0']?.state
    ).toBe('unknown')
  }
)

it.each(['failed', 'epoch'] as const)(
  'does not reuse plotting configuration across an unsafe boundary: %s',
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'python-config-boundary-'))
    const runs = [
      record('import matplotlib.pyplot as plt\nplt.rcParams["font.size"] = 17', 0),
      record(
        'import matplotlib.pyplot as plt\nfig, ax = plt.subplots()\nfig.savefig("plot.png")',
        1
      )
    ]
    if (mode === 'failed') runs[0]!.status = 'failed'
    else runs[1]!.kernelEpochId = 'new-epoch'
    try {
      const result = await new NotebookDependencyAnalyzer({
        storageRoot: root,
        repository: { readSessionRuns: async () => runs }
      }).project({ projectId: 'p', sessionId: 's', completedRun: runs[1]! })
      if (mode === 'failed') expect(result.stalenessByRunId['1']?.state).toBe('unknown')
      else expect(result.dependenciesByRunId?.['1']).not.toContain('0')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)
