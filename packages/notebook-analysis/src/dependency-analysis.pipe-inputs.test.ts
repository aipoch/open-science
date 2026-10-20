import { expect, it } from 'vitest'
import { analyzeRNotebookSource } from './dependency-analysis-r'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'

it.each([
  'df %>% mutate(.data = ., doubled = value * 2)',
  'df |> dplyr::mutate(.data = _, doubled = value * 2)',
  'df %>% filter(., value > 0) %>% mutate(doubled = value * 2)',
  'df |> tidyr::drop_na(data = _, value) |> dplyr::mutate(doubled = value * 2)',
  'df %>% tidyr::pivot_longer(data = ., cols = value, names_to = "key", values_to = "amount")',
  'df |> dplyr::group_by(.data = _, id) |> dplyr::summarise(total = sum(value))'
])('preserves the table input through %s', async (expression) => {
  const script = `library(dplyr); library(tidyr)\ndf<-read.csv("input.csv")\nout<-${expression}\nout$label<-"ok"\nwrite.csv(out,"output.csv")`
  const { facts } = await analyzeRNotebookSource(script)
  expect(facts.copyOnModifyNames, JSON.stringify(facts)).toContain('out')
  expect(facts.copyOnModifyInvalidatedNames ?? []).not.toContain('out')
  expect(facts.priorUsedNames ?? []).not.toContain('_')
  expect(facts.priorUsedNames ?? []).not.toContain('.')
  expect(await analyzeNotebookSourceFileAccess('r', script)).toMatchObject({
    readState: 'complete',
    writeState: 'complete',
    reads: ['input.csv'],
    writes: ['output.csv']
  })
})

it.each(['df %>% mutate(.data = custom(.), value = value * 2)'])(
  'keeps unsupported pipe input placement uncertain: %s',
  async (expression) => {
    const { facts } = await analyzeRNotebookSource(
      `library(dplyr); df<-read.csv("input.csv"); out<-${expression}`
    )
    expect(facts.state === 'unknown' ? facts.reasons : []).toContain('opaque-call')
  }
)

it.each([
  ['df |> mutate(value = _, .data = other)', 'mutate(value=df,.data=other)'],
  ['df %>% mutate(.data = other, value = value * 2)', 'mutate(df,.data=other,value=value*2)']
])('preserves explicit data overrides: %s', async (piped, direct) => {
  const setup = 'library(dplyr); df<-read.csv("input.csv"); '
  const a = (await analyzeRNotebookSource(`${setup}out <- ${piped}`)).facts
  const b = (await analyzeRNotebookSource(`${setup}out <- ${direct}`)).facts
  expect(a.priorUsedNames).toContain('other')
  expect(a.copyOnModifyNames ?? []).not.toContain('out')
  expect(a.copyOnModifyBindings).toEqual(b.copyOnModifyBindings)
  expect(a.state === 'unknown' ? a.reasons : []).toEqual(b.state === 'unknown' ? b.reasons : [])
})
