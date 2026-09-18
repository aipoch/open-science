import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import { analyzePythonNotebookSource } from './dependency-analysis-python'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'
import cells from './reported-cross-language-volcano.fixture.json'

it.each(['language', 'epoch', 'environment'] as const)(
  'does not borrow memory across a different %s',
  async (boundary) => {
    const root = await mkdtemp(join(tmpdir(), 'kernel-memory-boundary-'))
    const run = (index: number): NotebookRunRecord => ({
      runId: `run-${index}`,
      cellId: `cell-${index}`,
      kernelKind: 'r',
      kernelEpochId: 'epoch',
      environment: 'default',
      source: 'agent',
      status: 'completed',
      kernelDispatched: true,
      startedAt: index,
      endedAt: index + 1,
      script: '',
      text: { stdout: '', stderr: '', traceback: '', plain: [] },
      outputs: [],
      workingFiles: []
    })
    const producer = run(0),
      consumer = run(1)
    producer.script = 'df<-data.frame(value=1)'
    consumer.script = 'print(df$value)'
    if (boundary === 'language') {
      producer.kernelKind = 'python'
      producer.script = 'import pandas as pd\ndf=pd.DataFrame({"value":[1]})'
    }
    if (boundary === 'epoch') consumer.kernelEpochId = 'new-epoch'
    if (boundary === 'environment') consumer.environment = 'other'
    const recovered = {
      ...consumer,
      runId: 'recovered',
      cellId: 'recovered',
      startedAt: 2,
      endedAt: 3,
      script: 'df<-read.csv("intermediate.csv"); print(df$value)'
    }
    try {
      const options = {
        storageRoot: root,
        repository: { readSessionRuns: async () => [producer, consumer, recovered] }
      }
      const projection = await new NotebookDependencyAnalyzer(options).project({
        projectId: 'p',
        sessionId: 's',
        throughRunId: recovered.runId
      })
      expect(projection.dependenciesByRunId?.[consumer.runId] ?? []).not.toContain(producer.runId)
      expect(projection.stalenessByRunId[consumer.runId].state).toBe('unknown')
      expect(projection.stalenessByRunId[recovered.runId]).toEqual({ state: 'clear' })
      const cached = await new NotebookDependencyAnalyzer(options).project({
        projectId: 'p',
        sessionId: 's',
        throughRunId: recovered.runId
      })
      expect(cached).toEqual(projection)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)
it.each(cells)('captures reported cell $index', async (cell) => {
  const language = cell.language as 'r' | 'python'
  const { facts } = await (language === 'r'
    ? analyzeRNotebookSource(cell.script)
    : analyzePythonNotebookSource(cell.script))
  const detail = JSON.stringify({
    reasons: facts.state === 'unknown' ? facts.reasons : [],
    copies: facts.copyOnModifyNames,
    invalid: facts.copyOnModifyInvalidatedNames,
    receiver: facts.receiverCalls
  })
  expect(facts.state === 'unknown' ? facts.reasons : [], detail).not.toContain('opaque-call')
  expect(await analyzeNotebookSourceFileAccess(language, cell.script), detail).toMatchObject({
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete'
  })
})

it.each([
  'pull(df, id)',
  'dplyr::pull(df, id)',
  'pull(var = id, .data = df)',
  'df %>% pull(id)',
  'df %>% pull(., id)',
  'df |> dplyr::pull(var = id, .data = _)',
  'df %>% head(8) %>% pull(id)',
  'pull(df, -1)',
  'pull(df, id, name = label)'
])('preserves column extraction ownership: %s', async (expression) => {
  const script = `library(dplyr)\ndf<-read.csv("input.csv")\nids<-${expression}\ndf$label<-ifelse(df$id %in% ids, df$id, "")\nwrite.csv(df,"out.csv")`
  const { facts } = await analyzeRNotebookSource(script)
  expect(facts.state === 'unknown' ? facts.reasons : [], JSON.stringify(facts)).not.toContain(
    'opaque-call'
  )
  expect(facts.copyOnModifyNames).toContain('ids')
  expect(facts.copyOnModifyInvalidatedNames ?? []).not.toContain('df')
  expect(await analyzeNotebookSourceFileAccess('r', script)).toMatchObject({
    readState: 'complete',
    writeState: 'complete',
    reads: ['input.csv'],
    writes: ['out.csv']
  })
})

it.each([
  'library(dplyr); df<-readRDS("object.rds"); ids<-pull(df,id)',
  'library(dplyr); df<-read.csv("input.csv"); ids<-pull(df,unknown_selector())',
  'library(dplyr); pull<-custom_pull; df<-read.csv("input.csv"); ids<-df %>% pull(id)'
])('retains uncertainty for unsupported extraction: %s', async (script) => {
  const { facts } = await analyzeRNotebookSource(script)
  expect(facts.state === 'unknown' ? facts.reasons : []).toContain('opaque-call')
})

it.each([
  { prefix: 'library(dplyr);', call: 'pull(df,id)', prior: false },
  { prefix: '', call: 'dplyr::pull(df,id)', prior: false },
  { prefix: '', call: 'pull(df,id)', prior: true }
])('tracks the package source for $prefix $call', async ({ prefix, call, prior }) => {
  const { facts } = await analyzeRNotebookSource(`${prefix}df<-read.csv("input.csv"); ids<-${call}`)
  expect(facts.rPackageReads?.includes('dplyr') ?? false).toBe(prior)
})
