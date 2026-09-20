import { expect, it } from 'vitest'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { NotebookDependencyAnalyzer } from './dependency-analysis'
import type { NotebookRunRecord } from '../../shared/notebook'

const examples = [
  {
    setup: 'x <- c(1,NA,2)',
    direct: 'as.character(na.omit(x))',
    rhs: 'na.omit() PIPE as.character()'
  },
  { setup: 'x <- list(1:3,2:4)', direct: 'Reduce(union,x)', rhs: 'Reduce(f=union)' },
  { setup: 'x <- list(1:3,2:4)', direct: 'lapply(x, length)', rhs: 'lapply(length)' },
  { setup: 'x <- c(1,NA,2)', direct: 'na.omit(object=x)', rhs: 'na.omit(object=PLACEHOLDER)' },
  { setup: 'x <- "input.csv"', direct: 'read.csv(x)', rhs: 'read.csv()' },
  {
    setup: 'x <- data.frame(a=1:3)',
    direct: 'write.csv(x,"output.csv")',
    rhs: 'write.csv("output.csv")'
  },
  { setup: 'x <- "inputs"', direct: 'file.path(x,"table.csv")', rhs: 'file.path("table.csv")' },
  {
    setup: 'x <- "inputs"',
    direct: 'read.csv(file.path(x,"table.csv"))',
    rhs: 'file.path("table.csv") PIPE read.csv()'
  },
  {
    setup: 'x <- "inputs/data.csv"',
    direct: 'read.csv(file=x)',
    rhs: 'read.csv(file=PLACEHOLDER)'
  },
  { setup: 'x <- 1:3', direct: 'paste("values",x)', rhs: 'paste("values",PLACEHOLDER)' },
  { setup: 'x <- data.frame(a=1:3)', direct: 'subset(x,a>1)', rhs: 'subset(a>1)' },
  { setup: 'x <- data.frame(a=1:3)', direct: 'transform(x,b=a*2)', rhs: 'transform(b=a*2)' },
  { setup: 'x <- 1:3; f <- function(x) x*2', direct: 'f(x)', rhs: 'f()' }
]

it.each(examples)(
  'shares pipe and direct-call analysis for $direct',
  async ({ setup, direct, rhs }) => {
    for (const pipe of ['|>', '%>%']) {
      // The native placeholder must be named; magrittr also accepts positional dots.
      if (pipe === '|>' && rhs === 'paste("values",PLACEHOLDER)') continue
      const piped = `x ${pipe} ${rhs.replaceAll('PIPE', pipe).replaceAll('PLACEHOLDER', pipe === '|>' ? '_' : '.')}`
      const scripts = [direct, piped].map((expr) => `${setup}; out <- ${expr}`)
      const [a, b] = await Promise.all(scripts.map((script) => analyzeRNotebookSource(script)))
      expect
        .soft(b.facts.state === 'unknown' ? b.facts.reasons : [], piped)
        .toEqual(a.facts.state === 'unknown' ? a.facts.reasons : [])
      expect
        .soft(b.facts.copyOnModifyNames?.includes('out') ?? false, piped)
        .toBe(a.facts.copyOnModifyNames?.includes('out') ?? false)
      const [af, bf] = await Promise.all(
        scripts.map((script) => analyzeNotebookSourceFileAccess('r', script))
      )
      expect.soft(bf, piped).toEqual(af)
    }
  }
)

it.each([
  'x %>% paste(., .)',
  'x %>% paste(toupper(.))',
  'x %>% { custom(.) }',
  'x %>% quote()',
  'x |> other::as.character()',
  'as.character <- custom; x |> as.character()',
  '`%>%` <- custom; x %>% as.character()'
])('retains uncertain semantics and callable effects: %s', async (expression) => {
  expect(
    (await analyzeNotebookSourceFileAccess('r', `x <- 'input'; ${expression}`)).externalState
  ).toBe('partial')
})

it('does not certify unresolved functions after pipe expansion', async () => {
  for (const expression of ['unknown(x)', 'x |> unknown()', 'x %>% unknown()']) {
    const result = await analyzeNotebookSourceFileAccess('r', `x <- 'input'; ${expression}`)
    expect(result.readState, expression).toBe('partial')
    expect(result.reasonCodes).toContain('source-analysis-unsupported-call')
  }
})

it.each(['|>', '%>%'])(
  'preserves ordinary values through chained callbacks with %s',
  async (pipe) => {
    const source = `sets <- list(A=c('1','2'), B=c('2','3')) ${pipe} lapply(unique); result <- sets ${pipe} Reduce(f=union); result ${pipe} writeLines(con='out.txt')`
    const { facts } = await analyzeRNotebookSource(source)
    expect(facts.state).toBe('available')
    expect(facts.copyOnModifyNames).toEqual(expect.arrayContaining(['sets', 'result']))
    expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
      readState: 'complete',
      writeState: 'complete',
      externalState: 'complete',
      writes: ['out.txt']
    })
  }
)

it.each(['as.character', 'read.csv', 'head'])(
  'does not trust rebound %s in either syntax',
  async (name) => {
    for (const expression of [`${name}(x)`, `x |> ${name}()`, `x %>% ${name}()`]) {
      expect(
        (
          await analyzeNotebookSourceFileAccess(
            'r',
            `x <- 'input'; ${name} <- custom; ${expression}`
          )
        ).externalState
      ).toBe('partial')
    }
  }
)

it('normalizes pipes in local helper bodies and preserves free variables', async () => {
  for (const pipe of ['|>', '%>%']) {
    const { facts } = await analyzeRNotebookSource(
      `f <- function(x) x ${pipe} as.character(); values <- 1:3; out <- f(values)`
    )
    expect(facts.state).toBe('available')
    expect(facts.copyOnModifyNames).toContain('out')
  }
})

it.each([false, true])(
  'keeps package and variable prerequisites across piped cells (helper: %s)',
  async (helper) => {
    const root = await mkdtemp(join(tmpdir(), 'pipe-prerequisites-'))
    const scripts = [
      'library(magrittr)',
      'file_path <- "inputs" |> file.path("data.csv")',
      helper ? 'convert <- function(data) data %>% as.character()' : 'unused <- 42',
      helper
        ? 'df <- read.csv(file_path); values <- convert(df$a); write.csv(data.frame(value=values),"out.csv",row.names=FALSE)'
        : 'df <- file_path %>% read.csv(); df %>% write.csv("out.csv",row.names=FALSE)'
    ]
    const runs: NotebookRunRecord[] = scripts.map((script, index) => ({
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
      const projection = await analyzer.project({
        projectId: 'p',
        sessionId: 's',
        throughRunId: '3'
      })
      expect(projection.stalenessByRunId['3'], JSON.stringify(projection)).toEqual({
        state: 'clear'
      })
      expect(projection.dependenciesByRunId?.['3']).toEqual(helper ? ['0', '1', '2'] : ['0', '1'])
      const context = await analyzer.sourceFileAccessContext({
        projectId: 'p',
        sessionId: 's',
        currentRunId: '3',
        language: 'r',
        environment: 'r',
        kernelEpochId: 'epoch'
      })
      expect(await analyzeNotebookSourceFileAccess('r', scripts[3], context)).toMatchObject({
        readState: 'complete',
        writeState: 'complete',
        externalState: 'complete',
        reads: ['inputs/data.csv'],
        writes: ['out.csv']
      })
      runs[3] = { ...runs[3], kernelEpochId: 'fresh' }
      const afterRestart = await new NotebookDependencyAnalyzer({
        storageRoot: root,
        repository: { readSessionRuns: async () => runs }
      }).project({ projectId: 'p', sessionId: 's', throughRunId: '3' })
      expect(afterRestart.stalenessByRunId['3'].state).not.toBe('clear')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)
