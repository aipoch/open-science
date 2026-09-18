import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { NotebookRunRecord } from '../../shared/notebook'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

import vennCells from './reported-venn.fixture.json'

it.each(['union', 'intersect', 'setdiff', 'setequal'])(
  'reduces ordinary sets with %s',
  async (op) => {
    for (const call of [
      `Reduce(${op}, sets)`,
      `base::Reduce(x=sets, f=base::${op}, init=character())`
    ]) {
      const { facts } = await analyzeRNotebookSource(
        `sets <- list(c('a','b'), c('b','c')); result <- ${call}`
      )
      expect(facts.state).toBe('available')
      expect(facts.copyOnModifyNames).toContain('result')
    }
    const { facts } = await analyzeRNotebookSource(
      `a <- base::${op}(1:3,2:4); b <- Reduce(union, list(a, 3:5))`
    )
    expect(facts.state).toBe('available')
    expect(facts.copyOnModifyNames).toEqual(expect.arrayContaining(['a', 'b']))
  }
)

it.each([
  'sets <- readRDS("sets.rds"); Reduce(union, sets)',
  'sets <- list(1:3); union <- custom; Reduce(union, sets)',
  'sets <- list(1:3); Reduce(other::union, sets)',
  'sets <- list(1:3); Reduce(union, sets, init=readRDS("seed.rds"))',
  'sets <- list(1:3); Reduce <- custom; Reduce(union, sets)',
  'sets <- list(1:3); Reduce(function(a,b) custom(a,b), sets)'
])('retains uncertain reducer dispatch: %s', async (script) => {
  expect((await analyzeNotebookSourceFileAccess('r', script)).externalState).toBe('partial')
})

it.each(['|>', '%>%'])(
  'preserves value ownership through %s conversion/filter chains',
  async (pipe) => {
    const { facts } = await analyzeRNotebookSource(
      `x <- c('a', NA, 'b'); y <- x ${pipe} stats::na.omit() ${pipe} base::as.character() ${pipe} unique()`
    )
    expect(facts.state).toBe('available')
    expect(facts.copyOnModifyNames).toContain('y')
  }
)

it.each([
  'x <- 1:3; as.character <- custom; x |> as.character()',
  'x <- readRDS("x.rds"); y <- x |> na.omit(); Reduce(union, list(y))',
  'x <- 1:3; x |> other::as.character()',
  'x <- 1:3; x %>% as.character(custom(.))'
])('retains uncertain piped conversion: %s', async (script) => {
  expect((await analyzeNotebookSourceFileAccess('r', script)).externalState).toBe('partial')
})

it.each([
  'ggVennDiagram::ggVennDiagram(list(A=1:3,B=2:4), show_intersect=TRUE)',
  'ggVennDiagram::ggVennDiagram(list(A=1:3,B=2:4), show_intersect=interactive)',
  'ggVennDiagram::ggVennDiagram(list(A=1:3,B=2:4), show_i=TRUE)',
  'ggVennDiagram::ggVennDiagram(readRDS("sets.rds"))',
  'ggVennDiagram::ggVennDiagram(list(A=1:3,B=2:4), label_color=custom())',
  'ggVennDiagram <- custom; ggVennDiagram(list(A=1:3,B=2:4))',
  'other::ggVennDiagram(list(A=1:3,B=2:4))',
  'f <- function(x) ggVennDiagram::ggVennDiagram(x, show_intersect=TRUE); f(list(A=1:3,B=2:4))'
])('retains unsupported Venn modes and effects: %s', async (script) => {
  expect((await analyzeNotebookSourceFileAccess('r', script)).externalState).toBe('partial')
})

it.each(['color', 'colour', 'fill'])(
  'recognizes gradient %s scales and checks callbacks',
  async (aesthetic) => {
    for (const suffix of ['gradient', 'gradient2', 'gradientn']) {
      const name = `scale_${aesthetic}_${suffix}`
      const parameters =
        suffix === 'gradientn' ? "colours=c('white','red')" : "low='white', high='red'"
      expect((await analyzeRNotebookSource(`ggplot2::${name}(${parameters})`)).facts.state).toBe(
        'available'
      )
      expect(
        (
          await analyzeNotebookSourceFileAccess(
            'r',
            `ggplot2::${name}(limits=function(x) custom(x))`
          )
        ).externalState
      ).toBe('partial')
    }
  }
)

it('captures the Venn plot through its set preparation and skips inspection cells', async () => {
  const root = await mkdtemp(join(tmpdir(), 'venn-analysis-'))
  const runs: NotebookRunRecord[] = vennCells.map((script, index) => ({
    runId: String(index),
    cellId: String(index),
    kernelKind: 'r',
    kernelEpochId: 'epoch',
    environment: 'r',
    source: 'agent',
    status: 'completed',
    kernelDispatched: true,
    startedAt: index,
    endedAt: index + 1,
    script,
    text: { stdout: '', stderr: '', traceback: '', plain: [] },
    outputs: [],
    workingFiles: []
  }))
  try {
    const analyzer = new NotebookDependencyAnalyzer({
      storageRoot: root,
      repository: { readSessionRuns: async () => runs }
    })
    const projection = await analyzer.project({ projectId: 'p', sessionId: 's', throughRunId: '3' })
    for (let index = 0; index < runs.length; index++) {
      const context = await analyzer.sourceFileAccessContext({
        projectId: 'p',
        sessionId: 's',
        currentRunId: String(index),
        language: 'r',
        environment: 'r',
        kernelEpochId: 'epoch'
      })
      const { facts } = await analyzeRNotebookSource(vennCells[index], context)
      expect
        .soft(facts.state === 'unknown' ? facts.reasons : [], `cell ${index}`)
        .toEqual(index === 3 ? [] : ['external-state'])
      const atRun = await analyzer.project({
        projectId: 'p',
        sessionId: 's',
        throughRunId: String(index)
      })
      expect
        .soft(atRun.stalenessByRunId[String(index)], `cell ${index}`)
        .toEqual({ state: 'clear' })
      expect
        .soft(
          await analyzeNotebookSourceFileAccess('r', vennCells[index], context),
          `cell ${index}`
        )
        .toMatchObject({
          readState: 'complete',
          writeState: 'complete',
          externalState: 'complete',
          reads: index < 3 ? ['inputs/set-membership-111111111111.xlsx'] : [],
          writes: index === 3 ? ['proportional_venn_5sets.png'] : []
        })
    }
    expect(projection.dependenciesByRunId?.['2']).toEqual([])
    expect(projection.dependenciesByRunId?.['3']).toEqual(['2'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
