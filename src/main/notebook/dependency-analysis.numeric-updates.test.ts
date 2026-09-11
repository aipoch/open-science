import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { NotebookRunRecord } from '../../shared/notebook'
import type { NotebookDependencyProjection } from './dependency-analysis-types'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

const project = async (
  language: 'python' | 'r',
  scripts: string[]
): Promise<NotebookDependencyProjection> => {
  const root = await mkdtemp(join(tmpdir(), 'numeric-updates-'))
  const runs: NotebookRunRecord[] = scripts.map((script, index) => ({
    runId: `run-${index}`,
    cellId: `cell-${index}`,
    source: 'agent',
    kernelKind: language,
    kernelEpochId: 'epoch',
    environment: `default-${language}`,
    script,
    status: 'completed',
    startedAt: index,
    endedAt: index + 1,
    text: { stdout: '', stderr: '', traceback: '', plain: [] },
    outputs: [],
    artifacts: [],
    workingFiles: [],
    inputFiles: []
  }))
  try {
    return await new NotebookDependencyAnalyzer({
      storageRoot: root,
      repository: { readSessionRuns: async () => runs }
    }).project({ projectId: 'project', sessionId: 'session', completedRun: runs.at(-1)! })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const numericalFunctions = [
  'sin',
  'cos',
  'tan',
  'sqrt',
  'exp',
  'log',
  'log1p',
  'floor',
  'ceil',
  'abs'
]

it.each(numericalFunctions)(
  'analyzes fresh Python numpy.%s values followed by conditional updates',
  async (fn) => {
    const script = `import numpy as np
source = np.array([0.5])
value = np.${fn}(source)
if value[0] > 0: value -= 1
if value[0] < 0: value += 2
np.savetxt('result.csv', value)`
    expect((await project('python', [script])).stalenessByRunId['run-0']).toEqual({
      state: 'clear'
    })
    expect(await analyzeNotebookSourceFileAccess('python', script)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      writes: ['result.csv']
    })
  }
)

it.each(numericalFunctions.map((fn) => (fn === 'ceil' ? 'ceiling' : fn)))(
  'analyzes R base::%s values followed by conditional replacement',
  async (fn) => {
    const script = `source <- 0.5
value <- base::${fn}(source)
if (value > 0) value <- value - 1
if (value < 0) value <- value + 2
write.csv(data.frame(value=value), 'result.csv', row.names=FALSE)`
    expect((await project('r', [script])).stalenessByRunId['run-0']).toEqual({ state: 'clear' })
    expect(await analyzeNotebookSourceFileAccess('r', script)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      writes: ['result.csv']
    })
  }
)

it.each([
  [
    'python',
    'import numpy as np\nsource = np.array([0.5])',
    'value = np.sin(source)\nif value[0] > 0: value -= 1',
    'source[0] = 1'
  ],
  ['r', 'source <- 0.5', 'value <- sin(source)\nif (value > 0) value <- value - 1', 'source <- 1']
] as const)(
  'retains the upstream input dependency in %s',
  async (language, setup, update, change) => {
    const before = await project(language, [setup, update])
    expect(before.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
    expect(before.dependenciesByRunId?.['run-1']).toContain('run-0')
    const after = await project(language, [setup, update, change])
    expect(after.stalenessByRunId['run-1']?.state).toBe('stale')
  }
)

it.each([
  [
    'python',
    'import numpy as np\nsource = np.array([0.5])',
    'value = np.sin(source)\nif value[0] > 0: value -= 1'
  ],
  ['r', 'source <- 0.5', 'value <- sin(source)\nif (value > 0) value <- value - 1']
] as const)(
  'keeps a fresh result separate from the input object in %s',
  async (language, setup, update) => {
    const result = await project(language, [setup, 'print(source)', update])
    expect(result.stalenessByRunId['run-1']).toEqual({ state: 'clear' })
  }
)

it.each([
  'value <- unknown; if (value > 0) value <- value - 1',
  'flag <- 1; if (flag > 0) value <- 1; print(value)',
  'source <- structure(0.5, class="custom"); value <- sin(source); if (value > 0) value <- value - 1',
  'source <- 0.5; sin <- custom; value <- sin(source); if (value > 0) value <- value - 1',
  'value <- 1; if (custom()) value <- value - 1',
  'value <- 1; if (value > 0) value <<- value - 1',
  'value <- new.env(); if (flag) value$x <- 1'
])('retains R uncertainty for nonlocal values, dispatch and side effects: %s', async (script) => {
  expect((await project('r', [script])).stalenessByRunId['run-0']?.state).not.toBe('clear')
})

it.each(['value <- new.env()', 'class(value) <- "custom"', 'if (flag) value <- new.env()'])(
  'invalidates prior R atomic knowledge after %s',
  async (change) => {
    const result = await project('r', ['value <- 0.5', change, 'if (value > 0) value <- value - 1'])
    expect(result.stalenessByRunId['run-2']?.state).not.toBe('clear')
  }
)

it('does not claim a single R input path from an unresolved branch', async () => {
  const access = await analyzeNotebookSourceFileAccess(
    'r',
    `flag <- 1
path <- 'inputs/original.csv'
if (flag > 0) path <- 'inputs/a.csv' else path <- 'inputs/b.csv'
value <- read.csv(path)`
  )
  expect(
    access.readState === 'partial' ||
      ['inputs/a.csv', 'inputs/b.csv'].every((path) => access.reads.includes(path))
  ).toBe(true)
})

it.each(['out=buffer', 'buffer', '**options'])(
  'preserves Python output-buffer effects: %s',
  async (output) => {
    const result = await project('python', [
      'import numpy as np\nsource = np.array([0.5])\nbuffer = np.zeros(1)\noptions = {"out": buffer}',
      'print(buffer)',
      `value = np.sin(source, ${output})\nif value[0] > 0: value -= 1`
    ])
    expect(result.stalenessByRunId[output === '**options' ? 'run-2' : 'run-1']?.state).not.toBe(
      'clear'
    )
  }
)

it.each(['np.asarray(source)', 'source.view()', 'source[:]', 'source.astype(float, copy=False)'])(
  'keeps a Python view connected to its source: %s',
  async (expression) => {
    const result = await project('python', [
      'import numpy as np\nsource = np.array([0.5])',
      'print(source)',
      `value = ${expression}\nif value[0] > 0: value -= 1`
    ])
    expect(result.stalenessByRunId['run-1']?.state).not.toBe('clear')
  }
)

it.skipIf(process.env.RUN_KERNEL !== '1' || !process.env.OPEN_SCIENCE_TEST_R_COMMAND)(
  'validates R value replacement and deterministic exports in fresh processes',
  async () => {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const { readFile } = await import('node:fs/promises')
    const root = await mkdtemp(join(tmpdir(), 'native-r-numeric-'))
    const source = `source <- 0.5
values <- numeric()
for (fn in c("sin", "cos", "tan", "sqrt", "exp", "log", "log1p", "floor", "ceiling", "abs")) {
  value <- do.call(fn, list(source))
  if (value > 0) value <- value - 1
  if (value < 0) value <- value + 2
  stopifnot(identical(source, 0.5))
  values <- c(values, value)
}
write.csv(data.frame(value=values), "result.csv", row.names=FALSE)`
    try {
      const outputs: Buffer[] = []
      for (let i = 0; i < 2; i++) {
        await promisify(execFile)(
          process.env.OPEN_SCIENCE_TEST_R_COMMAND!,
          ['--vanilla', '-e', source],
          { cwd: root, timeout: 30000 }
        )
        outputs.push(await readFile(join(root, 'result.csv')))
      }
      expect(outputs[0]).toEqual(outputs[1])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

it('retains the prior R value when a conditional replacement may be skipped', async () => {
  const result = await project('r', ['value <- 0.5', 'flag <- 0', 'if (flag > 0) value <- 1'])
  expect(result.stalenessByRunId['run-2']).toEqual({ state: 'clear' })
  expect(result.dependenciesByRunId?.['run-2']).toEqual(expect.arrayContaining(['run-0', 'run-1']))
})
