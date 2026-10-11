import { NotebookDependencyAnalyzer } from './analysis-test-support'

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'

import { tmpdir } from 'node:os'

import { join } from 'node:path'

import { expect, it, vi } from 'vitest'

import type { NotebookRunRecord } from './analysis-test-support'

import { projectNotebookDependencies } from './index'

import { analyzePythonSources } from './index'

import { analyzeRSources } from './index'

import { analyzeNotebookSourceFileAccess } from './index'

const run = (script: string, kernelKind: 'python' | 'r', index: number): NotebookRunRecord => ({
  runId: `run-${index}`,
  cellId: `cell-${index}`,
  source: 'agent',
  kernelKind,
  kernelEpochId: 'epoch',
  kernelDispatched: true,
  environment: `default-${kernelKind}`,
  script,
  status: 'completed',
  startedAt: index,
  endedAt: index,
  text: { stdout: '', stderr: '', traceback: '', plain: [] },
  outputs: [],
  workingFiles: []
})

it('tracks R plot objects selected from a named result list', async () => {
  const script = `library(ggplot2)
df <- read.csv("inputs/groups.csv")
counts <- as.data.frame(table(df$group))
plots <- list(bar = ggplot(counts, aes(x=Var1, y=Freq)) + geom_col(),
              pie = ggplot(counts, aes(x="", y=Freq, fill=Var1)) + geom_col() + coord_polar(theta="y"))
ggsave("bar.png", plots[["bar"]])
ggsave("pie.png", plots$pie)`
  const [facts] = await analyzeRSources([script])
  expect(
    projectNotebookDependencies([{ run: run(script, 'r', 0), facts }]).stalenessByRunId['run-0']
  ).toEqual({ state: 'clear' })
  expect(await analyzeNotebookSourceFileAccess('r', script)).toMatchObject({
    reads: ['inputs/groups.csv'],
    writes: ['bar.png', 'pie.png'],
    readState: 'complete',
    writeState: 'complete'
  })
})

it.each([
  [
    'imported factory',
    'from matplotlib.pyplot import subplots\nfig, (left, right) = subplots(1, 2)'
  ],
  [
    'unpacked array',
    'import matplotlib.pyplot as plt\nfig, axes = plt.subplots(2, 2)\n(a, b), (left, right) = axes'
  ]
])('tracks a Python %s through downstream plotting', async (_label, setup) => {
  const script = `${setup}\nbars = right.bar([1], [2])\nfor bar in bars:\n    left.text(0, bar.get_height(), "count")\nfig.savefig("panels.png")`
  const [facts] = await analyzePythonSources([script])
  expect(
    projectNotebookDependencies([{ run: run(script, 'python', 0), facts }]).stalenessByRunId[
      'run-0'
    ]
  ).toEqual({ state: 'clear' })
  expect(await analyzeNotebookSourceFileAccess('python', script)).toMatchObject({
    writes: ['panels.png'],
    readState: 'complete',
    writeState: 'complete'
  })
})

it.each([
  ['repeated chain', 'result = frame.copy().dropna().copy().head()'],
  ['ordered chain', 'result = frame.sort_values("x").head().copy()']
])('retains a Python %s through cache reload', async (_label, expression) => {
  const root = await mkdtemp(join(tmpdir(), 'ordered-chain-'))
  const runs = [
    run('import pandas as pd\nframe = pd.DataFrame({"x": [1, 2]})', 'python', 0),
    run(expression, 'python', 1)
  ]
  const repository = { readSessionRuns: async () => runs }
  const request = { projectId: 'project', sessionId: 'session', interpreter: { command: 'unused' } }
  try {
    const first = await new NotebookDependencyAnalyzer({ storageRoot: root, repository }).project({
      ...request,
      completedRun: runs[1]
    })
    expect(first.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
    const path = join(root, 'notebooks/project/session/cache/dependency-analysis.json')
    const sidecar = JSON.parse(await readFile(path, 'utf8'))
    delete sidecar.projectionSnapshots
    await writeFile(path, JSON.stringify(sidecar))
    const analyze = vi.fn(async () => {
      throw new Error('valid ordered facts must be reusable')
    })
    const reloaded = new NotebookDependencyAnalyzer({ storageRoot: root, repository, analyze })
    expect(await reloaded.project(request)).toEqual(first)
    expect(analyze).not.toHaveBeenCalled()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.each([
  [
    'vector subset',
    'paths <- c("inputs/unused.csv", "inputs/groups.csv")\ndf <- read.csv(paths[2])'
  ],
  ['named vector subset', 'paths <- c(csv="inputs/groups.csv")\ndf <- read.csv(paths["csv"])'],
  [
    'list subset extraction',
    'paths <- list(csv="inputs/groups.csv")\ndf <- read.csv(paths[1][[1]])'
  ],
  [
    'named list wrapper',
    'paths <- setNames(list("inputs/groups.csv"), c("csv"))\ndf <- read.csv(paths$csv)'
  ],
  [
    'bound list',
    'paths <- list(csv="inputs/groups.csv", other="inputs/unused.csv")\ndf <- read.csv(paths[["csv"]])'
  ],
  [
    'inline list',
    'df <- read.csv(list(csv="inputs/groups.csv", other="inputs/unused.csv")[["csv"]])'
  ],
  ['inline member', 'df <- read.csv(list(csv="inputs/groups.csv", other="inputs/unused.csv")$csv)'],
  ['composed vector', 'df <- read.csv(file.path("inputs", c("unused.csv", "groups.csv"))[[2]])'],
  [
    'named arguments',
    'df <- read.csv(setNames(nm=c("csv"), object=c("inputs/groups.csv"))[["csv"]])'
  ],
  [
    'named structure',
    'df <- read.csv(structure(names=c("csv"), .Data=c("inputs/groups.csv"))[["csv"]])'
  ]
])('captures an R %s extraction', async (_label, script) => {
  expect(await analyzeNotebookSourceFileAccess('r', script)).toMatchObject({
    reads: ['inputs/groups.csv'],
    readState: 'complete',
    writeState: 'complete'
  })
})

it.each([
  'read.csv(list(csv="inputs/groups.csv")[[index]])',
  'read.csv(list(csv="inputs/groups.csv")[[0]])',
  'read.csv(list(csv="inputs/groups.csv")[[1.5]])',
  'read.csv(list(csv="inputs/groups.csv")[["missing"]])',
  'read.csv(list(csv="inputs/groups.csv")[1])',
  'read.csv(c(csv="inputs/groups.csv")$csv)',
  'paths <- c(csv="inputs/groups.csv"); read.csv(paths$csv)',
  'paths <- list(csv="inputs/groups.csv"); read.csv(paths[1])',
  'paths <- c("inputs/groups.csv"); read.csv(paths[0])',
  'paths <- c("inputs/groups.csv"); read.csv(paths[2])',
  'read.csv(structure(c("inputs/groups.csv"), names=c("csv"), class="custom")[["csv"]])'
])('does not certify dynamic, invalid or custom R extraction: %s', async (script) => {
  expect((await analyzeNotebookSourceFileAccess('r', script)).readState).toBe('partial')
})

it.each(['python', 'python-slice', 'r-vector', 'r-list', 'r-subset'] as const)(
  'retains %s collection order and duplicate paths across blocks and reload',
  async (variant) => {
    const language = variant.startsWith('python') ? 'python' : 'r'
    const root = await mkdtemp(join(tmpdir(), 'collection-order-'))
    const scripts =
      language === 'r'
        ? [
            `paths <- ${variant === 'r-list' ? 'list' : 'c'}("inputs/unused.csv", "inputs/groups.csv", "inputs/unused.csv")`,
            `df <- read.csv(paths[2]${variant === 'r-list' ? '[[1]]' : ''})\nwrite.csv(df, list(csv="copy.csv")[1][[1]], row.names=FALSE)`
          ]
        : [
            'paths = ["inputs/unused.csv", "inputs/groups.csv", "inputs/unused.csv"]',
            'import pandas as pd\ndf = pd.read_csv(paths[1])\ndf.to_csv("copy.csv", index=False)'
          ]
    if (variant === 'python-slice') {
      scripts[0] += '\nselected = paths[1::-1]'
      scripts[1] =
        'import pandas as pd\ndf = pd.read_csv(selected[0])\ndf.to_csv("copy.csv", index=False)'
    }
    if (variant === 'r-subset') {
      scripts[0] += '\nselected <- paths[c(2,1)]'
      scripts[1] = 'df <- read.csv(selected[[1]])\nwrite.csv(df, "copy.csv", row.names=FALSE)'
    }
    const runs = scripts.map((script, index) => run(script, language, index))
    const repository = { readSessionRuns: async () => runs }
    const request = { projectId: 'project', sessionId: 'session' }
    try {
      await new NotebookDependencyAnalyzer({ storageRoot: root, repository }).project({
        ...request,
        completedRun: runs[0]
      })
      const analyzer = new NotebookDependencyAnalyzer({ storageRoot: root, repository })
      const context = await analyzer.sourceFileAccessContext({
        ...request,
        currentRunId: 'run-1',
        language,
        environment: `default-${language}`,
        kernelEpochId: 'epoch'
      })
      expect(context?.staticCollections.find(({ name }) => name === 'paths')?.values).toEqual([
        'inputs/unused.csv',
        'inputs/groups.csv',
        'inputs/unused.csv'
      ])
      if (language === 'r') {
        expect(context?.staticCollections.find(({ name }) => name === 'paths')?.rKind).toBe(
          variant === 'r-list' ? 'list' : 'vector'
        )
      }
      expect(await analyzeNotebookSourceFileAccess(language, scripts[1]!, context)).toMatchObject({
        reads: ['inputs/groups.csv'],
        writes: ['copy.csv'],
        readState: 'complete',
        writeState: 'complete'
      })
      const projection = await analyzer.project({ ...request, completedRun: runs[1] })
      expect(projection.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
      expect(projection.dependenciesByRunId?.['run-1']).toEqual(['run-0'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

it.each([
  '["inputs/unused.csv", "inputs/groups.csv"][1]',
  '("inputs/unused.csv", "inputs/groups.csv")[-1]',
  '{"csv": "inputs/groups.csv"}["csv"]'
])('captures Python inline path selection: %s', async (path) => {
  expect(
    await analyzeNotebookSourceFileAccess(
      'python',
      `import pandas as pd\ndf = pd.read_csv(${path})`
    )
  ).toMatchObject({
    reads: ['inputs/groups.csv'],
    readState: 'complete',
    writeState: 'complete'
  })
})

it.each(['paths[1.5]', 'paths[0.0]', 'paths[True]', 'paths[index]', 'paths[20]'])(
  'does not certify invalid or unresolved Python indexing: %s',
  async (path) => {
    expect(
      (
        await analyzeNotebookSourceFileAccess(
          'python',
          `import pandas as pd\npaths = ["inputs/groups.csv"]\ndf = pd.read_csv(${path})`
        )
      ).readState
    ).toBe('partial')
  }
)
