import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { readPdfFixture } from './read-fixture'

interface NativeToken {
  text: string
  rect: number[]
  height: number
  baseline: number
  horizontal: boolean
}
interface ProofInput {
  table: {
    id: string
    cropRect: number[]
    structure: { objects: { label: string; rect: number[] }[] }
  }
  tokens: NativeToken[]
  rules: number[][]
}

const { refineTable } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-refine.mjs')).href
)
const { resolveTableCellMerges } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-cell-merges.mjs')).href
)
const fixture = (name: string): ProofInput =>
  readPdfFixture(resolve(`src/main/literature/pdf-structure/fixtures/source-grids/${name}.jsonl`))
const replay = (x: ProofInput): ReturnType<typeof refineTable> =>
  refineTable(x.table, x.tokens, [], [], x.rules)
const validateProposal = (x: ProofInput): Set<string> => {
  const rows = x.table.structure.objects.filter((o: { label: string }) => o.label === 'table row'),
    columns = x.table.structure.objects.filter(
      (o: { label: string }) => o.label === 'table column'
    ),
    baseCells = rows.flatMap((r: { rect: number[] }, row: number) =>
      columns.map((c: { rect: number[] }, column: number) => ({
        row,
        column,
        rowSpan: 1,
        colSpan: 1,
        rect: [c.rect[0], r.rect[1], c.rect[2], r.rect[3]]
      }))
    ),
    span = x.table.structure.objects.find(
      (o: { label: string }) => o.label === 'table spanning cell'
    )!.rect,
    slots = baseCells.filter(
      (c: { rect: number[] }) =>
        c.rect[0] >= span[0] && c.rect[1] >= span[1] && c.rect[2] <= span[2] && c.rect[3] <= span[3]
    ),
    issues = new Set<string>()
  resolveTableCellMerges({
    proposals: [
      {
        slots,
        origin: 'model-span',
        sectionHeader: slots.every((c: { row: number }) => c.row === slots[0].row)
      }
    ],
    baseCells,
    items: x.tokens,
    rows,
    headerRows: [0],
    headerRuns: new Map(),
    rules: x.rules,
    recordGrid: { completeSpans: true },
    populatedColumns: (): number[] => [0, 1, 2, 3, 4],
    issues,
    repairs: []
  })
  return issues
}

it.each([
  ['numeric-category-with-complete-peer-records', 'span-conflicts-with-source-columns'],
  ['native-divider-between-header-and-numeric-record', 'span-conflicts-with-source-rows']
])('rejects the model span with complete native proof: %s', (name, issue): void => {
  const x = fixture(name),
    result = replay(x),
    separate = structuredClone(x)
  separate.table.structure.objects = separate.table.structure.objects.filter(
    (o: { label: string }) => o.label !== 'table spanning cell'
  )
  const expected = replay(separate)
  expect(result.issues).not.toContain(issue)
  expect(result.repairs).toContain('source-record-boundary-restored')
  expect(result.grid).toEqual(expected.grid)
  expect(result.cells).toEqual(expected.cells)
  expect(result.unassigned).toEqual([])
  expect(
    result.cells.every(
      (c: { rowSpan: number; colSpan: number }) => c.rowSpan === 1 && c.colSpan === 1
    )
  ).toBe(true)
})

for (const mode of [
  'missing-column',
  'baseline',
  'two-peers',
  'cross-column',
  'numeric-matrix',
  'category-text'
] as const)
  it(`keeps numeric-category diagnostic without complete proof: ${mode}`, (): void => {
    const x = fixture('numeric-category-with-complete-peer-records')
    if (mode === 'missing-column')
      x.tokens = x.tokens.filter((t) => !(t.rect[0] === 210 && t.rect[1] === 40))
    if (mode === 'baseline') {
      const t = x.tokens.find((t) => t.rect[0] === 410 && t.rect[1] === 40)!
      t.baseline += 6
      t.rect[1] += 6
      t.rect[3] += 6
    }
    if (mode === 'two-peers') x.tokens = x.tokens.filter((t) => t.rect[1] !== 130)
    if (mode === 'cross-column') x.tokens.find((t) => t.text === '42')!.rect[2] = 110
    if (mode === 'numeric-matrix')
      x.tokens
        .filter((t) => t.text.startsWith('Record'))
        .forEach((t): void => {
          t.text = '51'
        })
    if (mode === 'category-text') x.tokens.find((t) => t.text === '42')!.text = '42%'
    expect(validateProposal(x)).toContain('span-conflicts-with-source-columns')
  })

for (const mode of [
  'missing-rule',
  'short-rule',
  'competing-rule',
  'crossing-ink',
  'cross-column',
  'nonnumeric-body',
  'body-baseline',
  'body-to-body'
] as const)
  it(`keeps vertical-span diagnostic without a unique native boundary: ${mode}`, (): void => {
    const x = fixture('native-divider-between-header-and-numeric-record')
    if (mode === 'missing-rule') x.rules = []
    if (mode === 'short-rule') x.rules = [[405, 30, 445, 30]]
    if (mode === 'competing-rule') x.rules.push([0, 32, 500, 32])
    if (mode === 'crossing-ink') {
      const t = x.tokens.find((t) => t.text === 'P')!
      t.rect[3] = 32
      t.height = 22
      t.baseline = 32
    }
    if (mode === 'cross-column')
      x.tokens.push({
        text: '‡',
        rect: [395, 10, 405, 20],
        height: 10,
        baseline: 20,
        horizontal: true
      })
    if (mode === 'nonnumeric-body')
      x.tokens.find((t) => t.rect[0] === 410 && t.rect[1] === 40)!.text = 'Unknown'
    if (mode === 'body-baseline') {
      x.tokens.find((t) => t.rect[0] === 410 && t.rect[1] === 40)!.text = '1'
      x.tokens.push({
        text: '5',
        rect: [450, 46, 460, 56],
        height: 10,
        baseline: 56,
        horizontal: true
      })
    }
    if (mode === 'body-to-body') {
      x.table.structure.objects.push({ label: 'table row', rect: [0, 60, 500, 90] })
      x.tokens.push({
        text: '17',
        rect: [410, 70, 440, 80],
        height: 10,
        baseline: 80,
        horizontal: true
      })
      x.table.structure.objects.find(
        (o: { label: string }) => o.label === 'table spanning cell'
      )!.rect = [400, 30, 500, 90]
      x.rules = [[0, 60, 500, 60]]
    }
    expect(validateProposal(x)).toContain('span-conflicts-with-source-rows')
  })
