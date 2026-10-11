import { expect, it } from 'vitest'

import { analyzeNotebookSourceFileAccess } from './index'

import { analyzePythonNotebookSource } from './index'

import { projectNotebookDependencies } from './index'

import type { NotebookRunRecord } from './analysis-test-support'

import type { NotebookSourceFileAccessContext } from './contracts'

it('keeps the copy read dependency without marking it as a shared reference', async () => {
  const scripts = [
    'paths = ["a.csv", "b.csv"]',
    'selected = paths[:]',
    'paths[0] = "changed.csv"',
    'open(selected[0]).read()'
  ]
  let context: NotebookSourceFileAccessContext | undefined
  const entries = []
  for (const [index, script] of scripts.entries()) {
    const { facts, fileAccess } = await analyzePythonNotebookSource(script, context)
    context = fileAccess?.context
    const run: NotebookRunRecord = {
      runId: `run-${index}`,
      cellId: `cell-${index}`,
      source: 'agent',
      kernelKind: 'python',
      kernelEpochId: 'epoch',
      environment: 'default-python',
      kernelDispatched: true,
      script,
      status: 'completed',
      startedAt: index,
      endedAt: index,
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      outputs: [],
      workingFiles: []
    }
    entries.push({ run, facts })
  }
  const projection = projectNotebookDependencies(entries.slice(0, 2))
  expect(projection.dependenciesByRunId?.['run-1']).toEqual(['run-0'])
  expect(entries[1]?.facts.aliases).toEqual([])
  expect(context?.staticCollections.find(({ name }) => name === 'selected')?.values).toEqual([
    'a.csv',
    'b.csv'
  ])
})

it.each([
  ['paths[:]', ['a.csv', 'b.csv']],
  ['paths[::-1]', ['a.csv', 'b.csv']],
  ['list(paths)', ['a.csv', 'b.csv']],
  ['tuple(paths)', ['a.csv', 'b.csv']],
  ['sorted(paths)', ['a.csv', 'b.csv']],
  ['paths[1:]', ['b.csv']]
])('captures Python iteration over an independent path snapshot: %s', async (iterable, reads) => {
  const script = `paths = ["a.csv", "b.csv"]
for path in ${iterable}:
    paths.clear()
    with open(path) as source:
        text = source.read()
    with open(path + ".copy", "w") as output:
        output.write(text)`
  expect(await analyzeNotebookSourceFileAccess('python', script)).toMatchObject({
    reads,
    writes: reads.map((path) => path + '.copy'),
    readState: 'complete',
    writeState: 'complete'
  })
})

it.each(['paths', 'reversed(paths)', 'enumerate(paths)', 'zip(paths, paths)'])(
  'keeps Python live iteration uncertain after mutation: %s',
  async (iterable) => {
    const target = iterable.startsWith('enumerate')
      ? 'index, path'
      : iterable.startsWith('zip')
        ? 'path, other'
        : 'path'
    const script = `paths = ["a.csv", "b.csv"]\nfor ${target} in ${iterable}:\n    paths.clear()\n    open(path).read()`
    expect(await analyzeNotebookSourceFileAccess('python', script)).toMatchObject({
      reads: [],
      readState: 'partial'
    })
  }
)

it.each([
  'paths = [["a.csv", "b.csv"], ["c.csv", "d.csv"]]\nfor src, dst in list(paths):\n    paths[1][0] = "changed.csv"\n    open(src).read()',
  'paths = ["a.csv", "b.csv"]\nlist = custom_factory\nfor path in list(paths):\n    paths.clear()\n    open(path).read()'
])(
  'does not treat mutable nested values or shadowed constructors as independent',
  async (script) => {
    expect((await analyzeNotebookSourceFileAccess('python', script)).readState).toBe('partial')
  }
)

it('keeps unknown R connection iterables uncertain', async () => {
  expect(
    (await analyzeNotebookSourceFileAccess('r', 'for (con in connections[indices]) readLines(con)'))
      .readState
  ).toBe('partial')
})

it.each(['paths', 'paths[c(2,1)]', 'paths[-1]'])(
  'preserves R iteration values when its source changes: %s',
  async (iterable) => {
    const reads = iterable === 'paths[-1]' ? ['b.csv'] : ['a.csv', 'b.csv']
    const script = `paths <- c("a.csv", "b.csv")
for (path in ${iterable}) {
  paths[2] <- "replacement.csv"
  text <- readLines(path)
  writeLines(text, paste0(path, ".copy"))
}`
    expect(await analyzeNotebookSourceFileAccess('r', script)).toMatchObject({
      reads,
      writes: reads.map((path) => path + '.copy'),
      readState: 'complete',
      writeState: 'complete'
    })
  }
)
