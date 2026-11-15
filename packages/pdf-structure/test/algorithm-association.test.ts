import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
import { readFileSync } from 'node:fs'
import { compileFunction } from 'node:vm'
import ts from 'typescript'

const { findAlgorithmCandidates, associateFigures } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)
const line = (
  text: string,
  x: number,
  y: number,
  width = 160
): { text: string; x: number; y: number; width: number; height: number; fontSize: number } => ({
  text,
  x,
  y,
  width,
  height: 10,
  fontSize: 10
})
const sample = {
  pageNumber: 1,
  width: 600,
  height: 800,
  invalidGraphicsBounds: 0,
  lines: [
    line('Algorithm 1 Search', 50, 202),
    line('Require: query', 50, 220),
    line('1: Initialize', 55, 240),
    line('2: return result', 55, 260),
    line('Algorithm 2 Search', 320, 222),
    line('Require: documents', 320, 240),
    line('1: Initialize', 325, 260),
    line('2: return result', 325, 280)
  ],
  graphicsBounds: [
    [50, 200, 300, 204],
    [50, 215, 300, 219],
    [50, 280, 300, 284],
    [320, 220, 570, 224],
    [320, 235, 570, 239],
    [320, 300, 570, 304]
  ].map((r) => ({ kind: 'path', normalizedRect: r.map((v, i) => v / (i % 2 ? 800 : 600)) }))
}

it('keeps two-column algorithms separate and includes the title and closing rule', () => {
  const algorithms = findAlgorithmCandidates(sample)
  expect(
    algorithms.map((a: { caption: { lines: string[] }; rect: number[] }) => [
      a.caption.lines[0],
      a.rect.map(Math.round)
    ])
  ).toEqual([
    ['Algorithm 1 Search', [48, 198, 302, 286]],
    ['Algorithm 2 Search', [318, 218, 572, 306]]
  ])
})

it.each(['S1', 'A1', 'A.1'])(
  'keeps a complete supplemental algorithm %s in its own ruled column',
  (ordinal) => {
    const page = structuredClone(sample)
    page.lines[0].text = `Algorithm ${ordinal} Search`
    const algorithms = findAlgorithmCandidates(page)
    expect(
      algorithms.map((candidate: { caption: { lines: string[] }; rect: number[] }) => [
        candidate.caption.lines[0],
        candidate.rect.map(Math.round)
      ])
    ).toEqual([
      [`Algorithm ${ordinal} Search`, [48, 198, 302, 286]],
      ['Algorithm 2 Search', [318, 218, 572, 306]]
    ])
  }
)

it.each(
  ['1', 'S1'].flatMap((ordinal) =>
    ['title', 'pseudocode', 'closing-rule'].map((missing) => ({ ordinal, missing }))
  )
)('requires $missing evidence before classifying algorithm $ordinal', ({ ordinal, missing }) => {
  const page = structuredClone(sample)
  page.lines[0].text = `Algorithm ${ordinal} Search`
  if (missing === 'title') page.lines = page.lines.filter((l) => !l.text.startsWith('Algorithm'))
  if (missing === 'pseudocode') page.lines = page.lines.filter((l) => !l.text.startsWith('Require'))
  if (missing === 'closing-rule')
    page.graphicsBounds = page.graphicsBounds.filter((_, i) => i !== 2 && i !== 5)
  expect(findAlgorithmCandidates(page)).toEqual([])
})

it('keeps algorithm rules out of the preceding figure association', () => {
  const page = {
    ...sample,
    graphicsBounds: [
      ...sample.graphicsBounds,
      { kind: 'image', normalizedRect: [50 / 600, 60 / 800, 300 / 600, 140 / 800] }
    ]
  }
  const exclusions = findAlgorithmCandidates(page).map((a: { rect: number[] }) => a.rect)
  const [figure] = associateFigures(
    page,
    [{ page: 1, lines: ['Fig. 1. Flow'], rect: [50, 150, 300, 170] }],
    exclusions
  )
  expect(figure.rect.map(Math.round)).toEqual([50, 60, 300, 140])
})

it('compares inference table crops and native algorithms in the same coordinate space', () => {
  // Execute the extractor's actual admission statement, not a copied predicate.
  const source = readFileSync(resolve('resources/literature-pdf-extract.mjs'), 'utf8'),
    ast = ts.createSourceFile(
      'extract.mjs',
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS
    ),
    statements: string[] = []
  const visit = (node: import('typescript').Node): void => {
    if (
      ts.isExpressionStatement(node) &&
      ts.isBinaryExpression(node.expression) &&
      node.expression.left.getText(ast) === 'pageInference.tables' &&
      node.expression.right.getText(ast).includes('pageAlgorithms.some')
    )
      statements.push(node.getText(ast))
    ts.forEachChild(node, visit)
  }
  visit(ast)
  expect(statements).toHaveLength(1)
  const filter = compileFunction(statements[0], ['pageInference', 'pageAlgorithms']),
    candidates = [
      { id: 'ordinary-table-above', rect: [70, 130, 220, 150] },
      { id: 'algorithm-left', rect: [50, 200, 300, 284] },
      { id: 'algorithm-right', rect: [320, 220, 570, 304] },
      { id: 'ordinary-table-below', rect: [480, 350, 560, 410] }
    ].map(({ id, rect }) => ({ id, cropRect: rect.map((x) => x * 1.5) })),
    pageInference = { tables: candidates },
    algorithms = findAlgorithmCandidates(sample)
  filter(pageInference, algorithms)
  expect(pageInference.tables.map((t) => t.id)).toEqual([
    'ordinary-table-above',
    'ordinary-table-below'
  ])
  const noAlgorithms = { tables: candidates }
  filter(noAlgorithms, [])
  expect(noAlgorithms.tables).toEqual(candidates)
})
