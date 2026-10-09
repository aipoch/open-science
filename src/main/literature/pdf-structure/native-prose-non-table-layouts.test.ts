import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

const { hasTableEvidence } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-evidence.mjs')).href
)
const item = (
  text: string,
  x: number,
  y: number,
  width: number,
  height = 10
): { text: string; rect: number[]; height: number; horizontal: boolean; baseline: number } => ({
  text,
  rect: [x, y, x + width, y + height],
  height,
  horizontal: true,
  baseline: y + height
})
const table = (
  grid: string[][],
  cropRect = [0, 0, 500, 180]
): {
  grid: string[][]
  cropRect: number[]
  cells: {
    text: string
    row: number
    column: number
    colSpan: number
    rowSpan: number
    rect: number[]
  }[]
  issues: string[]
  repairs: string[]
  unassigned: string[]
} => ({
  grid,
  cropRect,
  cells: grid.flatMap((r, row) =>
    r.map((text, column) => ({
      text,
      row,
      column,
      colSpan: 1,
      rowSpan: 1,
      rect: [column * 250, row * 40, (column + 1) * 250, row * 40 + 40]
    }))
  ),
  issues: [],
  repairs: [],
  unassigned: []
})
interface Input {
  case: string
  table: ReturnType<typeof table>
  tokens: ReturnType<typeof item>[]
  rules: number[][]
}
const inputs: Input[] = readFileSync(
  resolve('src/main/literature/pdf-structure/fixtures/native-prose-non-table-layouts.jsonl'),
  'utf8'
)
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))

it.each(inputs)(
  'rejects $case without inventing a detector grid',
  ({ table: t, tokens, rules }) => {
    expect(hasTableEvidence(t, undefined, tokens, rules)).toBe(false)
    expect(hasTableEvidence(t, { lines: ['Table 1. Native comparison.'] }, tokens, rules)).toBe(
      true
    )
    expect(
      hasTableEvidence(t, undefined, tokens, [
        [0, 0, 500, 0],
        [0, 170, 500, 170]
      ])
    ).toBe(true)
    expect(hasTableEvidence(t, undefined, [], rules)).toBe(true)
    expect(hasTableEvidence(t, undefined, tokens)).toBe(true)
  }
)

it('preserves a citation column paired with independent values or descriptive records', () => {
  const original = inputs[0]
  for (const numeric of [true, false]) {
    const t = structuredClone(original.table)
    const tokens = structuredClone(original.tokens)
    t.grid.forEach((r, row) => {
      r[1] = numeric ? String(row + 4) : 'Independent native description'
      t.cells[row * 2 + 1].text = r[1]
      tokens.push(item(r[1], 300, 20 + row * 40, numeric ? 15 : 190))
    })
    expect(hasTableEvidence(t, undefined, tokens, [])).toBe(true)
  }
})

it('requires repeated right-hand ordinals and connecting native math rows', () => {
  const original = inputs[1]
  for (const missing of ['ordinal', 'connection', 'introduction']) {
    const tokens = original.tokens.filter((i) =>
      missing === 'ordinal'
        ? !/^\(A.2\)$/.test(i.text)
        : missing === 'connection'
          ? !/^\+/.test(i.text)
          : !/^Another/.test(i.text)
    )
    expect(hasTableEvidence(original.table, undefined, tokens, [])).toBe(true)
  }
})

it('recognizes native footnote separators and small raised ordinals in a partial footer crop', () => {
  const t = table(
    [
      ['A native paragraph continues with several ordinary words', '12'],
      ['An independent footnote starts with several ordinary words', 'tail']
    ],
    [0, 0, 500, 110]
  )
  t.cells.forEach((c) => {
    c.rect[0] = c.column === 0 ? 0 : 400
    c.rect[2] = c.column === 0 ? 400 : 500
  })
  const tokens = [
    item('A native paragraph continues with several ordinary words', 10, 5, 380, 12),
    item('12', 410, 25, 9, 8),
    item('11', 9, 45, 9, 8),
    item('An independent footnote starts with several ordinary words', 23, 45, 367, 12),
    item('A following native line ends here.', 10, 59, 190, 12),
    item('tail', 411, 59, 25, 12)
  ]
  const rules = [
    [10, 44, 170, 44],
    [410, 24, 570, 24]
  ]
  expect(hasTableEvidence(t, undefined, tokens, rules)).toBe(false)
  expect(hasTableEvidence(t, undefined, tokens, rules.slice(0, 1))).toBe(true)
  expect(
    hasTableEvidence(
      t,
      undefined,
      tokens.filter((i) => i.text !== '11'),
      rules
    )
  ).toBe(true)
})

const numberedReferences = (): Input => {
  const grid = [
    [
      '1.',
      'Arden, A. Complete estimates in independent records. Journal of Measurements 12, 34 (2021).'
    ],
    ['2.', 'Barton, B. & Cairn, C. Native comparisons using complete paragraphs.'],
    ['https://doi.org/10.1234/anonymous.42.', ''],
    ['3.', 'Dale, D. & Elm, E. Comparing ordinary estimates using independent records'],
    ['', 'with complete native paragraphs. Journal of Records 4, 45 (2023).']
  ]
  const t = table(grid, [0, 0, 500, 200])
  t.cells.forEach((c) => {
    c.rect[0] = c.column === 0 ? 0 : 30
    c.rect[2] = c.column === 0 ? 30 : 500
  })
  t.unassigned = ['8']
  return {
    case: 'complete numbered reference paragraphs',
    table: t,
    rules: [],
    tokens: [
      item('1.', 10, 20, 15),
      item('Arden, A. Complete estimates in independent records.', 40, 20, 260),
      item('Journal of Measurements', 305, 20, 70),
      item('12', 376, 20, 10),
      item(', 34 (2021).', 387, 20, 60),
      item('2.', 10, 60, 15),
      item('Barton, B. & Cairn, C. Native comparisons using complete paragraphs.', 40, 60, 410),
      item('https://doi.org/10.1234/anonymous.42.', 10, 80, 220),
      item('3.', 10, 110, 15),
      item(
        'Dale, D. & Elm, E. Comparing ordinary estimates using independent records',
        40,
        110,
        420
      ),
      item('with complete native paragraphs.', 10, 130, 220),
      item('Journal of Records', 235, 130, 100),
      item('4', 336, 130, 10),
      item(', 45 (2023).', 347, 130, 100),
      item('8', 10, 180, 10)
    ]
  }
}

it('rejects complete numbered citation paragraphs with hanging native continuations', () => {
  const { table: t, tokens, rules } = numberedReferences()
  expect(hasTableEvidence(t, undefined, tokens, rules)).toBe(false)
})

type ReferenceControl = Omit<Input, 'rules'> & {
  rules: number[][] | undefined
  caption?: { lines: string[] }
}
const referenceOrdinal = (x: ReferenceControl): ReturnType<typeof item> =>
  x.tokens.find((i) => i.text === '2.')!
const referenceContinuation = (x: ReferenceControl): ReturnType<typeof item> =>
  x.tokens.find((i) => /^with complete/.test(i.text))!
const referenceRefusals: [string, (x: ReferenceControl) => void][] = [
  ['missing opening ordinal', (x) => x.tokens.splice(x.tokens.indexOf(referenceOrdinal(x)), 1)],
  ['skipped reference ordinal', (x) => (referenceOrdinal(x).text = '4.')],
  ['incomplete year ending', (x) => (x.tokens.find((i) => /2021/.test(i.text))!.text = ', 34.')],
  [
    'incomplete DOI continuation',
    (x) => (x.tokens.find((i) => /^https:/.test(i.text))!.text = 'Unqualified independent record.')
  ],
  [
    'independent scalar lane',
    (x) => {
      const scalar = x.tokens.find((i) => i.text === '12')!
      scalar.rect[0] += 20
      scalar.rect[2] += 20
    }
  ],
  [
    'wrong continuation margin',
    (x) => {
      const font = referenceContinuation(x)
      font.rect[0] += 30
      font.rect[2] += 30
    }
  ],
  ['crossing full font', (x) => (referenceContinuation(x).rect[0] = -1)],
  ['unowned font', (x) => x.tokens.push(item('Foreign field', 450, 160, 40))],
  ['ambiguous duplicate font', (x) => x.tokens.push(structuredClone(referenceContinuation(x)))],
  ['incomplete font height', (x) => (referenceContinuation(x).height += 1)],
  ['unavailable native rules', (x) => (x.rules = undefined)],
  ['spanning table rule', (x) => x.rules?.push([0, 5, 500, 5])],
  ['explicit table caption', (x) => (x.caption = { lines: ['Table 1. Study comparisons.'] })]
]

it.each(referenceRefusals)('retains reference comparison candidates with %s', (_, mutate) => {
  const x: ReferenceControl = numberedReferences()
  mutate(x)
  expect(hasTableEvidence(x.table, x.caption, x.tokens, x.rules)).toBe(true)
})

// The model cuts through a complete list paragraph, rather than independent
// source fields. The nearby caption belongs to the separately ruled comparison.
const singleDisplayParagraph = (): {
  table: ReturnType<typeof table>
  caption: { lines: string[]; rect: number[] }
  tokens: ReturnType<typeof item>[]
  rules: number[][]
  graphics: { kind: string; rect: number[] }[]
} => {
  const t = table(
    [
      ['Native', 'opening', 'words', 'remain'],
      ['x', '2', 'y', '3'],
      ['where', 'ordinary', 'words', 'continue']
    ],
    [100, 150, 260, 220]
  )
  t.repairs = ['closed-numeric-grid-recovered']
  t.cells.forEach((c) => {
    c.rect = [100 + c.column * 40, 150 + c.row * 20, 140 + c.column * 40, 170 + c.row * 20]
  })
  const caption = {
    lines: [
      'Table 1: Independent native records.',
      'Each record has a separate native owner.',
      'The complete comparison ends above the list.'
    ],
    rect: [20 / 1.5, 73 / 1.5, 330 / 1.5, 105 / 1.5]
  }
  const tokens = [
    ...[90, 145, 200, 255].map((x) => item('Native', x, 3, 20)),
    ...[90, 145, 200, 255].map((x) => item('Records', x, 14, 25)),
    ...[31, 42, 53].map((y) => item('Ordinary record', 25, y, 50)),
    ...caption.lines.map((text, n) => item(text, 20, 73 + n * 11, 310)),
    item('•', 30, 150, 4),
    item('Complete native expression records:', 40, 150, 75),
    item('These ordinary words introduce one complete expression below', 116, 150, 204),
    item('The following native line continues the same ordinary paragraph', 40, 161, 280),
    item('Another complete native line closes this ordinary introductory paragraph', 40, 172, 280),
    ...[
      'x',
      '≤',
      'a',
      '2',
      '/',
      'b',
      'y',
      '≤',
      'c',
      '3',
      '/',
      'd',
      'z',
      '≥',
      'e',
      '2',
      '+',
      'f',
      '1',
      '−',
      'g',
      '4'
    ].map((text, n) => item(text, 80 + n * 10, 195, 6, /^\d$/.test(text) ? 7 : 10)),
    item('where', 40, 212, 25),
    item('the complete native variables remain in this ordinary paragraph', 67, 212, 253),
    item('A second native line carries the whole ordinary continuation', 40, 223, 280),
    item('The final native line closes the same complete paragraph', 40, 234, 280),
    item('•', 30, 255, 4),
    item('Another independent native record:', 40, 255, 220)
  ]
  const rules = [
    [20, 0, 330, 0],
    [20, 30, 330, 30],
    [20, 75, 330, 75],
    [100, 192, 126, 192],
    [100, 203, 126, 203],
    [220, 192, 246, 192],
    [220, 203, 246, 203]
  ]
  return { table: t, caption, tokens, rules, graphics: [] as { kind: string; rect: number[] }[] }
}

it.each([true, false])(
  'rejects a whole single-display paragraph with borrowed caption=%s',
  (borrowed) => {
    const x = singleDisplayParagraph()
    expect(
      hasTableEvidence(x.table, borrowed ? x.caption : undefined, x.tokens, x.rules, x.graphics)
    ).toBe(false)
  }
)

type DisplayControl = ReturnType<typeof singleDisplayParagraph>
const displayWhere = (x: DisplayControl): ReturnType<typeof item> =>
  x.tokens.find((i) => i.text === 'where')!
const displayRefusals: [string, (x: DisplayControl) => void][] = [
  ['missing next list boundary', (x) => x.tokens.splice(x.tokens.length - 2, 2)],
  ['incomplete fraction pair', (x) => x.rules.pop()],
  [
    'independent relation baseline',
    (x) => {
      const relation = x.tokens.find((i) => i.text === '≥')!
      relation.rect[1] += 2
      relation.rect[3] += 2
      relation.baseline += 2
    }
  ],
  [
    'independent continuation margin',
    (x) => {
      displayWhere(x).rect[0] += 4
      displayWhere(x).rect[2] += 4
    }
  ],
  ['full width table separator', (x) => x.rules.push([40, 190, 320, 190])],
  ['comparison closing absent', (x) => x.rules.splice(2, 1)],
  ['foreign complete source field', (x) => x.tokens.push(item('Independent field', 200, 160, 50))],
  ['ambiguous source font', (x) => x.tokens.push(structuredClone(displayWhere(x)))],
  ['unknown meaningful coordinates', (x) => x.tokens.push(item('Independent field', NaN, 160, 50))],
  ['incomplete whole font metric', (x) => (displayWhere(x).height += 1)],
  ['nonupright source font', (x) => (displayWhere(x).horizontal = false)],
  [
    'intersecting source raster',
    (x) => x.graphics.push({ kind: 'image', rect: [60, 190, 300, 210] })
  ],
  ['incomplete caption program', (x) => (x.caption.lines = [])],
  ['unknown cell owner', (x) => Object.assign(x.table, { cells: [...x.table.cells, null] })],
  ['nonfinite cell geometry', (x) => (x.table.cells[0].rect[0] = NaN)],
  ['unknown paint record', (x) => Object.assign(x, { graphics: [null] })],
  ['unknown paint rectangle', (x) => x.graphics.push({ kind: 'path', rect: [0, NaN, 40, 20] })],
  ['unknown source scale', (x) => Object.assign(x.table, { sourceViewport: { scale: 0 } })]
]

it.each(displayRefusals)('retains unproved single-display candidates with %s', (_, mutate) => {
  const x = singleDisplayParagraph()
  mutate(x)
  expect(hasTableEvidence(x.table, x.caption, x.tokens, x.rules, x.graphics)).toBe(true)
})
