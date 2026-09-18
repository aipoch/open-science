import { expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'
import { startWorkingFileObservation } from './working-file-observer'
import { analyzePythonNotebookSource } from './dependency-analysis-python'
import { projectNotebookDependencies } from './dependency-analysis'
import type { NotebookRunRecord } from '../../shared/notebook'
import type { NotebookSourceFileAccessContext } from './dependency-analysis-types'

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

it.skipIf(!process.env.RUN_KERNEL).each(['python', 'r'] as const)(
  'captures %s snapshot iteration with real file reads and writes',
  async (language) => {
    const command =
      language === 'python'
        ? process.env.OPEN_SCIENCE_TEST_PYTHON
        : process.env.OPEN_SCIENCE_TEST_R_COMMAND
    expect(command).toBeTruthy()
    const root = await mkdtemp(join(tmpdir(), 'iteration-snapshot-'))
    const script =
      language === 'python'
        ? `paths = ["a.csv", "b.csv"]
for path in paths[::-1]:
    paths.clear()
    with open(path) as source:
        text = source.read()
    with open(path + ".copy", "w") as output:
        output.write(text)`
        : `paths <- c("a.csv", "b.csv")
for (path in paths[c(2,1)]) {
  paths[2] <- "missing.csv"
  writeLines(readLines(path), paste0(path, ".copy"))
}`
    try {
      for (const name of ['original', 'replay']) {
        const notebookSessionRoot = join(root, name)
        const dataRoot = join(notebookSessionRoot, 'data')
        await mkdir(dataRoot, { recursive: true })
        await writeFile(join(dataRoot, 'a.csv'), 'Ctrl\n')
        await writeFile(join(dataRoot, 'b.csv'), 'IRI\n')
        const observer = await startWorkingFileObservation({
          dataRoot,
          notebookSessionRoot,
          cwd: dataRoot,
          language,
          code: script,
          runId: name
        })
        await promisify(execFile)(
          command!,
          language === 'python' ? ['-c', script] : ['--vanilla', '-e', script],
          { cwd: dataRoot, timeout: 30_000 }
        )
        const files = await observer.finish()
        expect(files.fileEvidence).toMatchObject({
          state: 'available',
          fileReads: 'complete',
          writerAttribution: 'complete',
          reasonCodes: []
        })
        expect(files.confirmedReadPaths).toEqual(['data/a.csv', 'data/b.csv'])
        expect(files.workingFiles.map(({ relativePath }) => relativePath).sort()).toEqual([
          'data/a.csv.copy',
          'data/b.csv.copy'
        ])
        expect(await readFile(join(dataRoot, 'a.csv.copy'), 'utf8')).toBe('Ctrl\n')
        expect(await readFile(join(dataRoot, 'b.csv.copy'), 'utf8')).toBe('IRI\n')
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

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
