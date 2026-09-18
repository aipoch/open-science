import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import { analyzePythonNotebookSource } from './dependency-analysis-python'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'
import cells from './reported-venn-export-failure.fixture.json'

const corrected = readFileSync(join(__dirname, 'reported-venn-export-recovery.R'), 'utf8')
it.each([1, 2, 3, 5, 6, 13])(
  'captures data and file dependencies of reported cell %i',
  async (index) => {
    const { language, script } = cells[index]!
    const { facts } = await (language === 'r'
      ? analyzeRNotebookSource(script)
      : analyzePythonNotebookSource(script))
    expect(facts.state === 'unknown' ? facts.reasons : [], JSON.stringify(facts)).toEqual([
      'external-state'
    ])
    expect(
      await analyzeNotebookSourceFileAccess(language === 'r' ? 'r' : 'python', script)
    ).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: ['inputs/set-membership-111111111111.xlsx'],
      writes:
        index === 13
          ? ['proportional_venn_5sets.png', 'venn_region_counts.csv']
          : index === 6
            ? ['proportional_venn_5sets.png']
            : []
    })
  }
)

it.each([7, 8, 9, 10, 11, 12])(
  'keeps diagnostic and conditional state conservative in cell %i',
  async (index) => {
    expect((await analyzeRNotebookSource(cells[index]!.script)).facts.state).toBe('unknown')
  }
)

it.each(['df <- data.frame(A=c("a",NA), B=c("b","c"))', 'df <- readxl::read_excel("input.xlsx")'])(
  'tracks ordinary captured data through immediate callbacks: %s',
  async (setup) => {
    const { facts } = await analyzeRNotebookSource(
      setup + '\nsets<-lapply(colnames(df),function(c) unique(stats::na.omit(df[[c]])))'
    )
    expect(facts.state === 'unknown' ? facts.reasons : []).toEqual(
      setup.includes('read_excel') ? ['external-state'] : []
    )
    expect(facts.usedNames).toContain('df')
    expect(facts.copyOnModifyNames).toContain('sets')
  }
)

it.each([
  'df<-readRDS("unknown.rds");sets<-lapply(c("A"),function(c) unique(na.omit(df[[c]])))',
  'df<-data.frame(A=1:3);sets<-lapply(c("A"),function(c) { df<-custom();unique(na.omit(df[[c]])) })',
  'df<-data.frame(A=1:3);sets<-lapply(c("A"),function(c) { unique(na.omit(df[[c]]));df<-custom() })',
  'df<-data.frame(A=1:3);sets<-lapply(c("A"),function(c) { df<<-custom();unique(na.omit(df[[c]])) })',
  'df<-data.frame(A=1:3);na.omit<-custom;sets<-lapply(c("A"),function(c) unique(na.omit(df[[c]])))',
  'df<-data.frame(A=1:3);f<-function(c) unique(na.omit(df[[c]]));df<-custom();sets<-lapply(c("A"),f)'
])('does not borrow ordinary types for unknown or shadowed closure values: %s', async (script) => {
  const { facts } = await analyzeRNotebookSource(script)
  expect(facts.state).toBe('unknown')
  expect(facts.copyOnModifyNames ?? []).not.toContain('sets')
})

it('recovers in a fresh kernel and preserves the failed producer status', async () => {
  const root = await mkdtemp(join(tmpdir(), 'venn-export-'))
  const runs: NotebookRunRecord[] = cells.map((cell, index) => ({
    runId: String(index),
    cellId: String(index),
    script: cell.script,
    kernelKind: cell.language === 'r' ? 'r' : cell.language === 'python' ? 'python' : 'bash',
    kernelEpochId: cell.language,
    environment: cell.language,
    source: 'agent',
    status: cell.status === 'failed' ? 'failed' : 'completed',
    kernelDispatched: true,
    startedAt: index,
    endedAt: index + 1,
    text: { stdout: '', stderr: '', traceback: '', plain: [] },
    outputs: [],
    workingFiles: []
  }))
  runs.push({
    ...runs[13]!,
    runId: '14',
    cellId: '14',
    script: corrected,
    status: 'completed',
    kernelEpochId: 'fresh',
    startedAt: 14,
    endedAt: 15
  })
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const analyzer = new NotebookDependencyAnalyzer({
        storageRoot: root,
        repository: { readSessionRuns: async () => runs }
      })
      const result = await analyzer.project({ projectId: 'p', sessionId: 's', throughRunId: '14' })
      expect(result.stalenessByRunId['13']).toBeUndefined()
      expect(result.stalenessByRunId['14']).toEqual({ state: 'clear' })
      expect(result.dependenciesByRunId?.['14']).toEqual([])
      const context = await analyzer.sourceFileAccessContext({
        projectId: 'p',
        sessionId: 's',
        currentRunId: '4',
        language: 'r',
        environment: 'r',
        kernelEpochId: 'r'
      })
      expect(await analyzeNotebookSourceFileAccess('r', cells[4]!.script, context)).toMatchObject({
        readState: 'complete',
        writeState: 'complete',
        externalState: 'complete'
      })
    }
    expect(await analyzeNotebookSourceFileAccess('r', corrected)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      reads: ['inputs/set-membership-111111111111.xlsx'],
      writes: ['proportional_venn_5sets.png', 'venn_region_counts.csv']
    })
    // Reuse captured table types across cells without borrowing a Python df.
    const split = corrected.indexOf('sets <- lapply')
    const setup = { ...runs[14]!, runId: 'setup', script: corrected.slice(0, split), startedAt: 16 }
    const plot = { ...runs[14]!, runId: 'plot', script: corrected.slice(split), startedAt: 17 }
    for (const kernelEpochId of ['fresh', 'different']) {
      const chain = [setup, { ...plot, kernelEpochId }]
      const analyzer = new NotebookDependencyAnalyzer({
        storageRoot: root,
        repository: { readSessionRuns: async () => chain }
      })
      const result = await analyzer.project({
        projectId: 'p',
        sessionId: kernelEpochId,
        throughRunId: 'plot'
      })
      expect(result.stalenessByRunId['plot']?.state).toBe(
        kernelEpochId === 'fresh' ? 'clear' : 'unknown'
      )
      if (kernelEpochId === 'fresh') expect(result.dependenciesByRunId?.['plot']).toEqual(['setup'])
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
