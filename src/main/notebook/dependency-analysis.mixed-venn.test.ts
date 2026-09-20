import { expect, it } from 'vitest'
import { analyzePythonNotebookSource } from './dependency-analysis-python'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'
import cells from './reported-mixed-venn.fixture.json'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import type { NotebookDependencyProjection } from './dependency-analysis-types'

async function project(
  scripts: string[],
  language: 'r' | 'python' = 'python'
): Promise<NotebookDependencyProjection> {
  const root = await mkdtemp(join(tmpdir(), 'venn-cleaning-'))
  const runs: NotebookRunRecord[] = scripts.map((script, index) => ({
    runId: String(index),
    cellId: String(index),
    script,
    kernelKind: language,
    kernelEpochId: 'epoch',
    environment: language,
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
    return await new NotebookDependencyAnalyzer({
      storageRoot: root,
      repository: { readSessionRuns: async () => runs }
    }).project({ projectId: 'p', sessionId: 's', throughRunId: String(runs.length - 1) })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

it.each(['strip', 'lstrip', 'rstrip', 'lower', 'upper', 'capitalize', 'title', 'casefold'])(
  'tracks column iteration and .str.%s across cells',
  async (method) => {
    const result = await project([
      'import pandas as pd\ndf=pd.read_excel("inputs/book.xlsx")',
      `for col in df.columns:\n    s=df[col].dropna().astype(str).str.${method}()\n    print(s.head().tolist())`
    ])
    expect(result.stalenessByRunId['1']).toEqual({ state: 'clear' })
    expect(result.dependenciesByRunId?.['1']).toEqual(['0'])
  }
)

it.each(['str=custom\nx=str(value).strip()', 'x=str(custom()).strip()'])(
  'retains unknown Python operations: %s',
  async (script) => {
    const result = await project(['import pandas as pd\n' + script])
    expect(result.stalenessByRunId['0']?.state).not.toBe('clear')
  }
)

it.each([
  'df=pd.read_excel("inputs/book.xlsx")\ns=df[unknown].str.strip()',
  'df=pd.read_excel("inputs/book.xlsx")\ns=df["A"].str.custom_transform()'
])('does not certify file effects of unknown string access: %s', async (script) => {
  expect(
    (await analyzeNotebookSourceFileAccess('python', 'import pandas as pd\n' + script))
      .externalState
  ).toBe('partial')
})

it('retains a string conversion shadowed in an earlier cell', async () => {
  const result = await project(['str=custom', 'value=str(1).strip()'])
  expect(result.stalenessByRunId['1']?.state).not.toBe('clear')
})

it.each(['trimws', 'tolower', 'toupper', 'nzchar'])(
  'preserves base string results through R functions: %s',
  async (method) => {
    const script = `clean<-function(x){x<-as.character(x);base::${method}(x)}; y<-clean(c(' a ',NA))`
    const { facts } = await analyzeRNotebookSource(script)
    expect(facts.copyOnModifyNames).toContain('y')
    expect((await project([script], 'r')).stalenessByRunId['0']).toEqual({ state: 'clear' })
  }
)

it.each([
  'trimws<-custom;clean<-function(x)trimws(x);y<-clean(" a ")',
  'clean<-function(x)other::trimws(x);y<-clean(" a ")',
  'clean<-function(x)trimws(x);y<-clean(readRDS("unknown.rds"));Reduce(union,list(y))'
])('retains unknown R cleaning effects: %s', async (script) => {
  expect((await project([script], 'r')).stalenessByRunId['0']?.state).not.toBe('clear')
})

it('resolves each cell in its own kernel without depending on the other language', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixed-venn-'))
  const runs: NotebookRunRecord[] = cells.map((script, index) => ({
    runId: String(index),
    cellId: String(index),
    script,
    kernelKind: index === 2 ? 'r' : 'python',
    kernelEpochId: index === 2 ? 'r-epoch' : 'python-epoch',
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
    for (let attempt = 0; attempt < 2; attempt++) {
      const analyzer = new NotebookDependencyAnalyzer({
        storageRoot: root,
        repository: { readSessionRuns: async () => runs }
      })
      const result = await analyzer.project({ projectId: 'p', sessionId: 's', throughRunId: '2' })
      expect(result.stalenessByRunId).toEqual({
        '0': { state: 'clear' },
        '1': { state: 'clear' },
        '2': { state: 'clear' }
      })
      for (const index of [0, 1, 2]) expect(result.dependenciesByRunId?.[String(index)]).toEqual([])
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.each(['unique(trimws(x))', 'x <- x[!is.na(x) & nzchar(trimws(x))]; unique(x)'])(
  'preserves cleaned function results: %s',
  async (body) => {
    const { facts } = await analyzeRNotebookSource(
      `clean<-function(x){x<-as.character(x);${body}}; y<-clean(c(' a ',NA)); Reduce(union,list(y))`
    )
    expect(facts.state === 'unknown' ? facts.reasons : []).toEqual([])
    expect(facts.copyOnModifyNames).toContain('y')
  }
)

it.each([0, 1, 2])('captures mixed Venn cell %s', async (index) => {
  const language = index === 2 ? 'r' : 'python'
  const { facts } = await (language === 'r' ? analyzeRNotebookSource : analyzePythonNotebookSource)(
    cells[index]
  )
  expect(
    facts.state === 'unknown' ? facts.reasons : [],
    JSON.stringify({ state: facts.state, reasons: facts.state === 'unknown' ? facts.reasons : [] })
  ).toEqual(['external-state'])
  expect(
    await analyzeNotebookSourceFileAccess(language, cells[index]),
    JSON.stringify({ state: facts.state, reasons: facts.state === 'unknown' ? facts.reasons : [] })
  ).toMatchObject({
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete',
    reads: ['inputs/set-membership-111111111111.xlsx']
  })
})
