import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import { analyzePythonNotebookSource } from './dependency-analysis-python'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'
import cells from './reported-mixed-joined-volcano.fixture.json'

it.each([
  'inner_join',
  'left_join',
  'right_join',
  'full_join',
  'semi_join',
  'anti_join',
  'cross_join'
])('retains both inputs to an ordinary dplyr %s', async (join) => {
  const script = `a<-read.csv("a.csv");b<-read.csv("b.csv");d<-dplyr::${join}(y=b,x=a);head(d)`
  expect(await analyzeNotebookSourceFileAccess('r', script)).toMatchObject({
    readState: 'complete',
    writeState: 'complete',
    reads: ['a.csv', 'b.csv']
  })
})
it.each([
  'd<-read.csv("x.csv");a<-dplyr::summarise(d,dplyr::across(dplyr::everything(),mean));head(a)',
  'd<-read.csv("x.csv");a<-dplyr::summarise(d,dplyr::across(dplyr::everything(),list(avg=mean,total=sum)));head(a)',
  'd<-read.csv("x.csv");a<-dplyr::mutate(d,dplyr::across(dplyr::everything()));head(a)',
  'd<-read.csv("x.csv");a<-dplyr::mutate(d,dplyr::across(dplyr::everything(),~.x));head(a)',
  'd<-read.csv("x.csv");d$p<-pmax(d$p,.Machine$double.xmin);base::sign(d$p)',
  'a<-read.csv("a.csv");b<-read.csv("b.csv");d<-a |> dplyr::left_join(y=b,x=_);head(d)',
  'a<-c(1,2);b<-c(2,3);base::intersect(a,b);base::setdiff(a,b);base::union(a,b);base::setequal(a,b)'
])('tracks ordinary transform results: %s', async (script) => {
  expect(await analyzeNotebookSourceFileAccess('r', script)).toMatchObject({
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete'
  })
})
it.each([
  'a<-read.csv("x.csv");b<-readRDS("unknown.rds");x<-dplyr::inner_join(a,b);head(x)',
  'd<-read.csv("x.csv");a<-dplyr::mutate(d,dplyr::across(dplyr::everything(),function(x) external));head(a)',
  'd<-read.csv("x.csv");a<-dplyr::mutate(d,dplyr::across(dplyr::everything(),function(x)readRDS("hidden.rds")));head(a)',
  '.Machine<-readRDS("unknown.rds");d<-data.frame(p=0);d$p<-pmax(d$p,.Machine$double.xmin);head(d)',
  '.Machine$double.xmin<-readRDS("unknown.rds");d<-data.frame(p=0);d$p<-pmax(d$p,.Machine$double.xmin);head(d)',
  'sign<-custom;d<-data.frame(x=1);sign(d$x)',
  'summary.lm<-custom;x<-1:3;y<-2:4;summary(lm(y~x))',
  'x<-readRDS("model.rds");summary(x)',
  'd<-readRDS("unknown.rds");base::intersect(1:3,d)'
])('retains uncertainty for unproven values and dispatch: %s', async (script) => {
  const a = await analyzeNotebookSourceFileAccess('r', script)
  expect([a.readState, a.writeState, a.externalState]).not.toEqual([
    'complete',
    'complete',
    'complete'
  ])
})

it('retains the real failed plot and recovers from the required inputs in a fresh epoch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'joined-recovery-'))
  const runs = runsFor(true)
  const analyzer = new NotebookDependencyAnalyzer({
    storageRoot: root,
    repository: { readSessionRuns: async () => runs }
  })
  try {
    const before = await analyzer.project({
      projectId: 'p',
      sessionId: 's',
      completedRun: runs.at(-1)!
    })
    expect(before.stalenessByRunId['12']).toMatchObject({ state: 'unknown' })
    for (const index of [2, 4, 5, 12])
      runs.push({
        ...runs.find((r) => r.runId === String(index))!,
        runId: `retry-${index}`,
        cellId: `retry-${index}`,
        kernelEpochId: 'fresh',
        startedAt: 100 + index,
        endedAt: 101 + index
      })
    const after = await analyzer.project({
      projectId: 'p',
      sessionId: 's',
      completedRun: runs.at(-1)!
    })
    expect(after.stalenessByRunId['retry-12'], JSON.stringify(after)).toEqual({ state: 'clear' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
it.each(['None', '[0, 1]'])('tracks ExcelFile.parse with sheet selection %s', async (sheets) => {
  const source = `import pandas as pd\nxl=pd.ExcelFile("input.xlsx")\nframes=xl.parse(sheet_name=${sheets})\nfor frame in frames.values():\n    print(frame.head())`
  const { facts } = await analyzePythonNotebookSource(source)
  expect(
    facts.state === 'unknown' ? facts.reasons.filter((r) => r !== 'external-state') : [],
    JSON.stringify(facts)
  ).toEqual([])
  expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
    readState: 'complete',
    reads: ['input.xlsx']
  })
})
it('does not certify unknown workbook methods', async () => {
  const source =
    'import pandas as pd\nxl=pd.ExcelFile("input.xlsx")\nxl.custom_reader("hidden.xlsx")'
  expect(await analyzeNotebookSourceFileAccess('python', source)).toMatchObject({
    externalState: 'partial'
  })
})

it('does not invent a workbook path for an inherited handle', async () => {
  expect(
    await analyzeNotebookSourceFileAccess('python', 'df=xl.parse("Sheet 1")', {
      staticStrings: [],
      staticCollections: [],
      localFileWrappers: [],
      resolvedKernelNames: ['xl'],
      pythonBindings: [{ name: 'xl', qualifiedName: 'pandas.ExcelFile', kind: 'object' }]
    })
  ).toMatchObject({ readState: 'partial', reads: [] })
})

it('retains workbook sources across cells, aliases, rebindings and cached analysis', async () => {
  const root = await mkdtemp(join(tmpdir(), 'excel-handle-context-'))
  const scripts = [
    'import pandas as pd\nxl=pd.ExcelFile("first.xlsx")\nalias=xl',
    'df=xl.parse(0)\nprint(df.head())',
    'xl=pd.ExcelFile("second.xlsx")',
    'a=alias.parse(0)\nb=xl.parse(0)\nprint(a.head(),b.head())',
    'c=xl.parse(0)\nprint(c.head())'
  ]
  const runs: NotebookRunRecord[] = scripts.map((script, index) => ({
    ...runsFor()[0],
    script,
    runId: String(index),
    cellId: String(index),
    kernelKind: 'python',
    environment: 'python',
    kernelEpochId: 'python',
    startedAt: index,
    endedAt: index + 1
  }))
  try {
    for (const [index, script] of scripts.entries()) {
      // Recreate the analyzer to exercise serialized metadata, not a live handle.
      const analyzer = new NotebookDependencyAnalyzer({
        storageRoot: root,
        repository: { readSessionRuns: async () => runs }
      })
      const context = await analyzer.sourceFileAccessContext({
        projectId: 'p',
        sessionId: 's',
        currentRunId: String(index),
        language: 'python',
        environment: 'python',
        kernelEpochId: 'python'
      })
      const access = await analyzeNotebookSourceFileAccess('python', script, context)
      expect(access).toMatchObject({
        readState: 'complete',
        writeState: 'complete',
        externalState: 'complete',
        reads:
          index < 2 ? ['first.xlsx'] : index === 3 ? ['first.xlsx', 'second.xlsx'] : ['second.xlsx']
      })
      if (index === 4)
        expect(context?.pythonBindings).toContainEqual({
          name: 'xl',
          qualifiedName: 'pandas.ExcelFile',
          kind: 'object',
          filePath: 'second.xlsx'
        })
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.each([
  'xl._io="other.xlsx"\nxl.parse(0)',
  'xl.custom_reader("other.xlsx")\nxl.parse(0)',
  'xl=external\nxl.parse(0)'
])('invalidates unproven workbook changes: %s', async (suffix) => {
  const source = `import pandas as pd\nxl=pd.ExcelFile("first.xlsx")\n${suffix}`
  const access = await analyzeNotebookSourceFileAccess('python', source)
  expect([access.readState, access.writeState, access.externalState]).not.toEqual([
    'complete',
    'complete',
    'complete'
  ])
})

it('keeps Python exploration and the failed image preview outside the R dependency chain', async () => {
  const root = await mkdtemp(join(tmpdir(), 'joined-mixed-'))
  const runs: NotebookRunRecord[] = cells
    .filter((c) => c.runId !== '11')
    .map((cell, i) => ({
      ...runsFor()[0],
      runId: cell.runId,
      cellId: cell.runId,
      script: cell.script,
      kernelKind: cell.language as NotebookRunRecord['kernelKind'],
      environment: cell.language,
      kernelEpochId: cell.language,
      status: cell.status === 'failed' ? 'failed' : 'completed',
      startedAt: i,
      endedAt: i + 1
    }))
  try {
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot: root,
      repository: { readSessionRuns: async () => runs }
    })
    const result = await analyzer.project({
      projectId: 'p',
      sessionId: 's',
      completedRun: runs.at(-1)!
    })
    expect(result.stalenessByRunId['12'], JSON.stringify(result)).toEqual({ state: 'clear' })
    expect(result.dependenciesByRunId?.['12']).not.toContain('8')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

const runsFor = (includeFailed = false): NotebookRunRecord[] =>
  cells
    .filter((cell) => cell.language === 'r' && (includeFailed || cell.status === 'completed'))
    .map((cell, index) => ({
      runId: cell.runId,
      cellId: cell.runId,
      script: cell.script,
      kernelKind: 'r',
      kernelEpochId: 'epoch',
      environment: 'r',
      source: 'agent',
      status: cell.status === 'failed' ? 'failed' : 'completed',
      kernelDispatched: true,
      startedAt: index,
      endedAt: index + 1,
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      outputs: [],
      workingFiles: []
    }))
it.each(cells.filter((c) => c.language === 'r' && c.status === 'completed'))(
  'captures joined volcano cell $runId with its upstream values',
  async ({ script, runId }) => {
    const root = await mkdtemp(join(tmpdir(), 'joined-cell-'))
    const runs = runsFor()
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot: root,
      repository: { readSessionRuns: async () => runs }
    })
    try {
      const context = await analyzer.sourceFileAccessContext({
        projectId: 'p',
        sessionId: 's',
        currentRunId: runId,
        language: 'r',
        environment: 'r',
        kernelEpochId: 'epoch'
      })
      const { facts } = await analyzeRNotebookSource(script, context)
      expect(
        facts.state === 'unknown' ? facts.reasons.filter((r) => r !== 'external-state') : [],
        JSON.stringify(facts)
      ).toEqual([])
      const access = await analyzeNotebookSourceFileAccess('r', script, context)
      expect(
        access,
        JSON.stringify({
          access,
          unresolved: facts.priorUsedNames?.filter(
            (n) => !facts.safeCallNames?.includes(n) && !context?.resolvedKernelNames?.includes(n)
          ),
          facts
        })
      ).toMatchObject({
        readState: 'complete',
        writeState: 'complete',
        externalState: 'complete'
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

it('reconstructs the producer through CSV preparation and joined test cells', async () => {
  const root = await mkdtemp(join(tmpdir(), 'joined-volcano-'))
  const runs = runsFor()
  try {
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot: root,
      repository: { readSessionRuns: async () => runs }
    })
    const projection = await analyzer.project({
      projectId: 'p',
      sessionId: 's',
      completedRun: runs.at(-1)!
    })
    expect(projection.stalenessByRunId['12'], JSON.stringify(projection)).toEqual({
      state: 'clear'
    })
    const upstream = new Set<string>()
    const pending = ['12']
    while (pending.length) {
      for (const dependency of projection.dependenciesByRunId?.[pending.pop()!] ?? []) {
        if (upstream.has(dependency)) continue
        upstream.add(dependency)
        pending.push(dependency)
      }
    }
    expect([...upstream].sort()).toEqual(['2', '4', '5', '6'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('captures the ExcelFile preview and its workbook input', async () => {
  const script = cells[0].script
  const { facts } = await analyzePythonNotebookSource(script)
  expect(
    facts.state === 'unknown' ? facts.reasons.filter((r) => r !== 'external-state') : [],
    JSON.stringify(facts)
  ).toEqual([])
  expect(await analyzeNotebookSourceFileAccess('python', script)).toMatchObject({
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete',
    reads: ['inputs/differential-results-333333333333.xlsx']
  })
})
