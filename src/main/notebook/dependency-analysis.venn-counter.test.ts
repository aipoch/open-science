import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'
import { analyzePythonNotebookSource } from './dependency-analysis-python'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import { projectNotebookDependencies } from './dependency-projection'
import type { NotebookRunRecord } from '../../shared/notebook'
import cells from './reported-mixed-venn-counter.fixture.json'

it.each([0, 2])('captures workbook and outputs in reported cell %s', async (index) => {
  const language = index === 0 ? 'python' : 'r'
  const { facts } = await (index === 0 ? analyzePythonNotebookSource : analyzeRNotebookSource)(
    cells[index]
  )
  expect(
    await analyzeNotebookSourceFileAccess(language, cells[index]),
    JSON.stringify(facts)
  ).toMatchObject({
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete',
    reads: ['inputs/set-membership-111111111111.xlsx'],
    writes: index === 0 ? [] : ['venn_5sets.pdf', 'venn_5sets.png']
  })
})

it.each([
  cells[0],
  'import pandas as pd\ndf=pd.read_excel("inputs/book.xlsx")\n' + cells[1],
  'from collections import Counter\nreg=Counter()\nfor key in ["a","b"]:\n    reg[key]+=1\nprint(reg)',
  'sets={"a":set([1,2]),"b":set([2,3])}\nallids=set().union(*sets.values())\nprint(allids)'
])('projects Python operations: %s', async (script) => {
  const { facts } = await analyzePythonNotebookSource(script)
  const run: NotebookRunRecord = {
    runId: '0',
    cellId: '0',
    script,
    kernelKind: 'python',
    kernelEpochId: 'py',
    environment: 'python',
    source: 'agent',
    status: 'completed',
    kernelDispatched: true,
    startedAt: 0,
    endedAt: 1,
    text: { stdout: '', stderr: '', traceback: '', plain: [] },
    outputs: [],
    workingFiles: []
  }
  const result = projectNotebookDependencies([{ run, facts }])
  expect(
    result.stalenessByRunId['0'],
    JSON.stringify({ result, calls: facts.receiverCalls, bindings: facts.typeBindings })
  ).toEqual({ state: 'clear' })
})

it.each(
  ['color', 'colour', 'fill'].flatMap((aesthetic) =>
    ['brewer', 'distiller', 'fermenter'].map((family) => `scale_${aesthetic}_${family}`)
  )
)('recognizes palette scale %s without hiding custom effects', async (name) => {
  expect(
    await analyzeNotebookSourceFileAccess('r', `ggplot2::${name}(palette="RdYlBu")`)
  ).toMatchObject({ readState: 'complete', writeState: 'complete', externalState: 'complete' })
  for (const script of [
    `other::${name}()`,
    `${name}<-custom;${name}()`,
    `ggplot2::${name}(palette=custom())`
  ])
    expect((await analyzeNotebookSourceFileAccess('r', script)).externalState).toBe('partial')
})

it.each([
  'set=custom\nout=set().union({1,2})',
  'class Hidden:\n    def __iter__(self):\n        return iter(open("hidden.txt"))\nout=set().union(Hidden())',
  'out=set().unknown_operation({1,2})'
])('does not certify unknown set operations: %s', async (script) => {
  const { facts } = await analyzePythonNotebookSource(script)
  const run: NotebookRunRecord = {
    runId: '0',
    cellId: '0',
    script,
    kernelKind: 'python',
    kernelEpochId: 'py',
    environment: 'python',
    source: 'agent',
    status: 'completed',
    kernelDispatched: true,
    startedAt: 0,
    endedAt: 1,
    text: { stdout: '', stderr: '', traceback: '', plain: [] },
    outputs: [],
    workingFiles: []
  }
  expect(projectNotebookDependencies([{ run, facts }]).stalenessByRunId['0']?.state).toBe('unknown')
})

it('keeps Python inspection separate from self-contained R output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'venn-counter-'))
  const runs: NotebookRunRecord[] = cells.map((script, index) => ({
    runId: String(index),
    cellId: String(index),
    script,
    kernelKind: index === 2 ? 'r' : 'python',
    kernelEpochId: index === 2 ? 'r' : 'python',
    environment: index === 2 ? 'r' : 'python',
    source: 'agent',
    status: 'completed',
    kernelDispatched: true,
    startedAt: index,
    endedAt: index + 1,
    text: { stdout: '', stderr: '', traceback: '', plain: [] },
    outputs: [],
    workingFiles: []
  }))
  try {
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot: root,
      repository: { readSessionRuns: async () => runs }
    })
    const result = await analyzer.project({ projectId: 'p', sessionId: 's', throughRunId: '2' })
    expect(result.stalenessByRunId['0'], JSON.stringify(result)).toEqual({ state: 'clear' })
    expect(result.stalenessByRunId['2'], JSON.stringify(result)).toEqual({ state: 'clear' })
    expect(result.dependenciesByRunId?.['2']).toEqual([])
    // df is assigned inside a possibly empty loop. It must not be guaranteed afterward.
    expect(result.stalenessByRunId['1']?.state).toBe('unknown')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('analyzes Counter aggregation when the worksheet is selected explicitly', async () => {
  const script = 'import pandas as pd\ndf=pd.read_excel("inputs/book.xlsx")\n' + cells[1]
  const { facts } = await analyzePythonNotebookSource(script)
  expect(
    await analyzeNotebookSourceFileAccess('python', script),
    JSON.stringify(facts)
  ).toMatchObject({ readState: 'complete', writeState: 'complete', externalState: 'complete' })
})
