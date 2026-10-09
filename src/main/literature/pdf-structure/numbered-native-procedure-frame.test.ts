import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

const { findAlgorithmCandidates } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)
interface ProcedureInput {
  case: string
  page: {
    pageNumber: number
    width: number
    height: number
    lines: { text: string; x: number; y: number; width: number; height: number; fontSize: number }[]
    graphicsBounds: { kind: string; normalizedRect: number[] }[]
  }
}
const inputs: ProcedureInput[] = readFileSync(
  resolve(
    'src/main/literature/pdf-structure/fixtures/numbered-native-procedures-without-line-ordinals.jsonl'
  ),
  'utf8'
)
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))

it.each(inputs)('preserves the complete numbered $case native procedure frame', ({ page }) => {
  const result = findAlgorithmCandidates(page)
  expect(result).toHaveLength(1)
  expect(result[0].caption.lines).toEqual([page.lines[0].text])
  expect(result[0].rect[1]).toBeLessThanOrEqual(98)
  expect(result[0].rect[3]).toBeGreaterThanOrEqual(283)
})

it.each(['no-number', 'no-opening', 'no-closing', 'no-structure', 'listing'])(
  'does not turn %s text into a numbered algorithm',
  (missing) => {
    for (const { page: original } of inputs) {
      const page = structuredClone(original)
      if (missing === 'no-number') page.lines[0].text = 'Native procedure'
      if (missing === 'listing') page.lines[0].text = 'Listing 1 Native procedure'
      if (missing === 'no-opening') page.graphicsBounds.shift()
      if (missing === 'no-closing') page.graphicsBounds.pop()
      if (missing === 'no-structure') page.lines = page.lines.slice(0, 2)
      expect(findAlgorithmCandidates(page)).toEqual([])
    }
  }
)

it('requires consecutive Step headings and complete loop controls', () => {
  const [loop, steps] = inputs.map(({ page }) => structuredClone(page))
  loop.lines = loop.lines.filter((line) => !/^end/i.test(line.text))
  expect(findAlgorithmCandidates(loop)).toEqual([])
  const secondStep = steps.lines.find((line) => /^Step 2/.test(line.text))!
  secondStep.text = 'Step 4: Native action'
  expect(findAlgorithmCandidates(steps)).toEqual([])
})

it('requires an indented native body before a conditional can close by dedenting', () => {
  const page = structuredClone(inputs[0].page)
  page.lines.find((line) => line.text === 'Apply the native action')!.x = 65
  expect(findAlgorithmCandidates(page)).toEqual([])
})

const numberedDeclaration = (declaration: string): ProcedureInput['page'] => ({
  pageNumber: 1,
  width: 600,
  height: 800,
  lines: [
    'Algorithm 1 Native framed records',
    declaration,
    '1: Observe the native input',
    '2: Apply the native operation',
    '3: Emit the native result'
  ].map((text, index) => ({
    text,
    x: index < 2 ? 50 : 55,
    y: [100, 120, 150, 175, 200][index],
    width: 260,
    height: index === 0 ? 12 : 10,
    fontSize: index === 0 ? 12 : 10
  })),
  graphicsBounds: [
    [50, 98, 550, 99],
    [50, 282, 550, 283]
  ].map((rect) => ({
    kind: 'path',
    normalizedRect: rect.map((value, index) => value / (index % 2 ? 800 : 600))
  }))
})

it.each(['Require', 'Ensure', 'Input', 'Output', 'Inputs', 'Outputs', 'inputs', 'outputs'])(
  'preserves the complete native numbered frame with a literal %s declaration',
  (label) => {
    expect(findAlgorithmCandidates(numberedDeclaration(`${label}: Native values`))).toEqual([
      {
        caption: {
          page: 1,
          lines: ['Algorithm 1 Native framed records'],
          rect: [50, 100, 310, 112]
        },
        rect: [48, 96, 552, 285]
      }
    ])
  }
)

it('preserves the existing complete-loop proof with plural native declarations', () => {
  const page = structuredClone(inputs[0].page)
  const expected = findAlgorithmCandidates(page)
  page.lines = page.lines.map((line) => ({
    ...line,
    text: line.text.replace(/^Input:/, 'Inputs:').replace(/^Output:/, 'Outputs:')
  }))
  expect(findAlgorithmCandidates(page)).toEqual(expected)
})

it.each([
  'Native values',
  'Inputs without a colon',
  'Inputss: Native values',
  'Outputss: Native values',
  'The Inputs: Native values'
])('does not treat %s as a literal native I/O declaration', (declaration) => {
  expect(findAlgorithmCandidates(numberedDeclaration(declaration))).toEqual([])
})

it.each(['opening', 'closing', 'ordinals', 'one-step', 'foreign-io', 'prose'])(
  'does not admit a plural declaration without the existing %s proof',
  (missing) => {
    const page = numberedDeclaration('Inputs: Native values')
    if (missing === 'opening') page.graphicsBounds.shift()
    if (missing === 'closing') page.graphicsBounds.pop()
    if (missing === 'ordinals') page.lines = page.lines.slice(0, 2)
    if (missing === 'one-step') page.lines = page.lines.slice(0, 3)
    if (missing === 'foreign-io') page.lines[1].x = 560
    if (missing === 'prose')
      page.lines = page.lines.map((line) => ({
        ...line,
        text: line.text.replace(/^\d+: /, 'This paragraph describes ')
      }))
    expect(findAlgorithmCandidates(page)).toEqual([])
  }
)

const insetDotProcedure = (): ProcedureInput['page'] => ({
  pageNumber: 1,
  width: 600,
  height: 800,
  lines: [
    ['Algorithm 1 Native framed operation', 58.8, 102, 280],
    ['Input: Native source records', 58.8, 130, 250],
    ['1) A native input parameter', 72, 148, 220],
    ['Output: Complete source records', 58.8, 166, 250],
    ['Procedure:', 58.8, 190, 100],
    ['1. Read the native input', 76, 212, 220],
    ['2. Process complete records', 76, 238, 220],
    ['3. Return the native result', 58.8, 266, 250]
  ].map(([text, x, y, width]) => ({
    text: text as string,
    x: x as number,
    y: y as number,
    width: width as number,
    height: 10,
    fontSize: 10
  })),
  graphicsBounds: [
    [50, 100, 550, 101],
    [50, 117, 550, 118],
    [50, 290, 550, 291]
  ].map((rect) => ({
    kind: 'path',
    normalizedRect: rect.map((v, n) => v / (n % 2 ? 800 : 600))
  }))
})

const exactRuleProcedure = (): { page: ProcedureInput['page']; rules: number[][] } => {
  const page = insetDotProcedure()
  page.graphicsBounds[2].normalizedRect[3] = 302 / page.height
  page.lines.push(
    { text: 'β', x: 96, y: 233, width: 10, height: 10, fontSize: 10 },
    { text: '̂', x: 100, y: 231, width: 0, height: 8, fontSize: 8 },
    { text: '1', x: 295, y: 297, width: 10, height: 10, fontSize: 10 }
  )
  return {
    page,
    rules: [
      [50, 100, 550, 100],
      [50, 117, 550, 117],
      [50, 291, 550, 291]
    ]
  }
}

it('uses exact native closure to preserve a uniquely based zero-advance mark and exclude the independent footer', () => {
  const { page, rules } = exactRuleProcedure(),
    before = structuredClone(page)
  expect(findAlgorithmCandidates(page)).toEqual([])
  expect(findAlgorithmCandidates(page, rules)).toEqual([
    {
      caption: {
        page: 1,
        lines: ['Algorithm 1 Native framed operation'],
        rect: [58.8, 102, 338.8, 112]
      },
      rect: [48, 98, 552, 293]
    }
  ])
  expect(page).toEqual(before)
})

it.each([
  'missing-native',
  'missing-divider',
  'wrong-end',
  'footer-intrusion',
  'non-horizontal',
  'non-finite-rule',
  'noncombining-zero',
  'orphan-mark',
  'ambiguous-base',
  'below-base'
])('refuses exact-rule recovery with %s', (mutation) => {
  const f = exactRuleProcedure()
  if (mutation === 'missing-native') f.rules = []
  if (mutation === 'missing-divider') f.rules.splice(1, 1)
  if (mutation === 'wrong-end') f.rules[2][2] -= 1
  if (mutation === 'footer-intrusion') f.rules[2][1] = f.rules[2][3] = 299
  if (mutation === 'non-horizontal') f.rules[2][3] += 1
  if (mutation === 'non-finite-rule') f.rules[2][3] = Infinity
  if (mutation === 'noncombining-zero') f.page.lines.find((l) => l.width === 0)!.text = '^'
  if (mutation === 'orphan-mark') f.page.lines = f.page.lines.filter((l) => l.text !== 'β')
  if (mutation === 'ambiguous-base')
    f.page.lines.push(structuredClone(f.page.lines.find((l) => l.text === 'β')!))
  if (mutation === 'below-base') f.page.lines.find((l) => l.width === 0)!.y = 235
  const before = structuredClone(f)
  expect(findAlgorithmCandidates(f.page, f.rules)).toEqual([])
  expect(f).toEqual(before)
})

it('preserves the whole inset native frame with I/O, Procedure and consecutive dot steps', () => {
  const page = insetDotProcedure(),
    before = structuredClone(page)
  expect(findAlgorithmCandidates(page)).toEqual([
    {
      caption: {
        page: 1,
        lines: ['Algorithm 1 Native framed operation'],
        rect: [58.8, 102, 338.8, 112]
      },
      rect: [48, 98, 552, 293]
    }
  ])
  expect(page).toEqual(before)
})

it.each([
  'title',
  'input',
  'output',
  'procedure',
  'divider',
  'closing',
  'rule-end',
  'sequence',
  'duplicate-step',
  'input-list-only',
  'inset',
  'competing-title',
  'foreign-left',
  'foreign-right',
  'foreign-top',
  'foreign-bottom',
  'opening',
  'wrong-role',
  'letter-steps',
  'ordinary-dot-list',
  'finite-font',
  'zero-font'
])('rejects an inset dot procedure without the complete %s proof', (missing) => {
  const page = insetDotProcedure()
  if (missing === 'title') page.lines[0].text = 'Example 1 Native numbered paragraphs'
  if (missing === 'input') page.lines.splice(1, 1)
  if (missing === 'output') page.lines.splice(3, 1)
  if (missing === 'procedure') page.lines.splice(4, 1)
  if (missing === 'divider') page.graphicsBounds.splice(1, 1)
  if (missing === 'opening') page.graphicsBounds.shift()
  if (missing === 'closing') page.graphicsBounds.pop()
  if (missing === 'rule-end') page.graphicsBounds[2].normalizedRect[2] -= 0.01
  if (missing === 'sequence') page.lines[6].text = '4. Process complete records'
  if (missing === 'duplicate-step') page.lines[6].text = '1. Process complete records'
  if (missing === 'input-list-only') page.lines = page.lines.slice(0, 5)
  if (missing === 'inset') page.lines[0].x += 10
  if (missing === 'competing-title')
    page.lines.push({ ...page.lines[4], text: 'Algorithm 2 Other operation' })
  if (missing === 'wrong-role') page.lines[5].y = 145
  if (missing === 'letter-steps')
    for (const l of page.lines.slice(5)) l.text = l.text.replace(/^\d+\./u, 'a.')
  if (missing === 'ordinary-dot-list') {
    page.lines[0].text = 'Example 1 Native numbered paragraphs'
    page.lines[4].text = 'Description:'
  }
  if (missing === 'finite-font') page.lines[6].height = Infinity
  if (missing === 'zero-font') page.lines[6].height = 0
  if (missing.startsWith('foreign-')) {
    const bounds = {
      'foreign-left': [47, 220, 10, 10],
      'foreign-right': [547, 220, 10, 10],
      'foreign-top': [100, 97, 20, 10],
      'foreign-bottom': [100, 290, 20, 10]
    }[missing]!
    page.lines.push({
      text: 'Foreign complete native font',
      x: bounds[0],
      y: bounds[1],
      width: bounds[2],
      height: bounds[3],
      fontSize: 10
    })
  }
  if (missing === 'finite-font') expect(() => findAlgorithmCandidates(page)).toThrow()
  else expect(findAlgorithmCandidates(page)).toEqual([])
})
