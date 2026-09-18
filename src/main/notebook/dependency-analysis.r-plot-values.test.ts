import { expect, it } from 'vitest'
import { analyzeNotebookSourceFileAccess } from './source-file-access-analysis'
import { analyzeRNotebookSource } from './dependency-analysis-r'

const valueExamples = [
  'ggplot2::theme_dark()',
  'ggplot2::theme_linedraw()',
  'ggplot2::theme_test()',
  'ggplot2::theme_grey()',
  'ggplot2::element_point(colour="red", size=2)',
  'ggplot2::element_polygon(fill="white")',
  'ggplot2::guide_legend(nrow=2, override.aes=list(size=3))',
  'ggplot2::guide_colourbar(barheight=grid::unit(2,"cm"))',
  'ggplot2::guide_axis(n.dodge=2)',
  'ggplot2::unit(4,"mm")',
  'grid::unit.c(grid::unit(1,"cm"),grid::unit(2,"mm"))',
  'grid::unit.pmax(grid::unit(1,"cm"),grid::unit(2,"mm"))',
  'scales::alpha(c("red","blue"),0.5)',
  'ggplot2::alpha("red",0.5)'
]

it.each(valueExamples)('analyzes R plot configuration values: %s', async (expression) => {
  expect(await analyzeNotebookSourceFileAccess('r', `value <- ${expression}`)).toMatchObject({
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete'
  })
})

it.each([
  'ggplot2::theme_set(ggplot2::theme_dark())',
  'ggplot2::theme_update(text=ggplot2::element_text(size=20))'
])('tracks theme state independently of file effects: %s', async (source) => {
  const { facts } = await analyzeRNotebookSource(source)
  expect(facts.rThemeState).toEqual({ reads: true, writes: true })
  expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete'
  })
})

it.each([
  'grid::convertUnit(grid::unit(1,"npc"),"cm")',
  'grid::unit(1,"grobwidth",data=custom_grob)',
  'grid::unit(1,"grobwidth",d=quote(custom()))',
  'grid::unit(1,"grobwidth",quote(custom()))',
  'ggplot2::guide_custom(custom_grob)',
  'other::guide_legend()',
  'library(ggplot2); guide_legend <- custom; guide_legend()',
  'ggplot2::guide_legend(title=custom())'
])('retains state changes and unknown effects: %s', async (source) => {
  expect((await analyzeNotebookSourceFileAccess('r', source)).externalState, source).toBe('partial')
})

it.each(['ggplot2', 'grid', 'scales'])('recognizes attached %s value constructors', async (pkg) => {
  const source =
    pkg === 'ggplot2'
      ? 'guide_legend(nrow=2)'
      : pkg === 'grid'
        ? 'unit(2,"cm")'
        : 'alpha("red",0.5)'
  expect(
    await analyzeNotebookSourceFileAccess(
      'r',
      `suppressPackageStartupMessages(library(${pkg})); ${source}`
    )
  ).toMatchObject({
    readState: 'complete',
    writeState: 'complete',
    externalState: 'complete'
  })
})

it('retains file reads nested in theme dimensions', async () => {
  expect(
    await analyzeNotebookSourceFileAccess(
      'r',
      'ggplot2::theme(legend.key.size=grid::unit(as.numeric(readLines("inputs/size.txt")),"cm"))'
    )
  ).toMatchObject({
    reads: ['inputs/size.txt']
  })
})

it.each(['size', 'alpha', 'shape', 'linetype', 'linewidth'])(
  'recognizes manual %s scales without hiding nested effects',
  async (aesthetic) => {
    const name = `scale_${aesthetic}_manual`
    for (const source of [
      `ggplot2::${name}(values=c(a=1,b=2))`,
      `library(ggplot2); ${name}(values=c(a=1,b=2))`
    ]) {
      expect(await analyzeNotebookSourceFileAccess('r', source)).toMatchObject({
        readState: 'complete',
        writeState: 'complete',
        externalState: 'complete'
      })
    }
    for (const source of [
      `other::${name}(values=c(a=1))`,
      `library(ggplot2); ${name} <- custom; ${name}(values=c(a=1))`,
      `ggplot2::${name}(values=custom())`
    ]) {
      expect((await analyzeNotebookSourceFileAccess('r', source)).externalState, source).toBe(
        'partial'
      )
    }
  }
)
