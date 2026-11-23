import { expect, it } from 'vitest'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { nativeScopedDisplayOwners } from '../../src/reader/native-display-packets.js'

type Request = Parameters<typeof nativeScopedDisplayOwners>
type LayoutItem = Extract<Request[2]['items'][number], { str: string }>

function fractionDisplay(fault: string, single = false): Request {
  const row = single
    ? ([
        ['N', 100, 600, 8, 10],
        ['=', 112, 600, 8, 10],
        ['u', 126, 607, 5, 10],
        ['k ', 126.4, 593, 6.7, 10],
        ['P.', fault === 'detached factor' ? 138 : 133.1, 600, 8, 10],
        ['(8)', 500, 600, 15, 10]
      ] as const)
    : ([
        ['E', 100, 600, 8, 10],
        ['=', 112, 600, 8, 10],
        ['v', 129, 607, 5, 10],
        ['2', 134, 611, 4, 7],
        ['3', 127, 593, 5, 10],
        ['q', 132, 593, 7, 10],
        ['+', 144, 600, 8, 10],
        ['kσ', 156, 607, 14, 10],
        ['2', 170, fault === 'flat exponent' ? 607 : 611, 4, 7],
        ['h', 174, 607, 6, 10],
        ['2', 180, 611, 4, 7],
        ['4', 166, 593, 5, 10],
        [',', 186, 600, 3, 10],
        ['(8)', 500, 600, 15, 10]
      ] as const)
  const items: LayoutItem[] = row.map(([str, x, y, width, height]) => ({
    str,
    dir: 'ltr',
    height,
    width,
    transform: [height, 0, 0, height, x, y],
    fontName: 'body',
    hasEOL: str === '(8)'
  }))
  const body = { fontFamily: 'serif', vertical: false, ascent: 0.75, descent: -0.25 }
  const font = {
    ...body,
    loadedName: 'body',
    name: 'Body',
    data: new Uint8Array([1, 2]),
    missingFile: false,
    isType3Font: false,
    isInvalidPDFjsFont: false,
    systemFontInfo: null
  }
  const viewport = {
    width: 600,
    height: 800,
    rotation: 0,
    scale: 1,
    transform: [1, 0, 0, -1, 0, 800]
  }
  const paint = (width: number, x: number): { operators: number[]; args: number[][] } => ({
    operators: [OPS.save, OPS.transform, OPS.paintSolidColorImageMask, OPS.restore],
    args: [[], [width, 0, 0, -0.5, x, 603], [], []]
  })
  const bars = single
    ? fault === 'missing rule'
      ? []
      : [paint(6.2, 126)]
    : [paint(12, 127), paint(28, fault === 'misplaced rule' ? 158 : 156)]
  if (fault === 'extra paint') bars.push(paint(8, 110))
  const ops = {
    fnArray: bars.flatMap((bar) => bar.operators),
    argsArray: bars.flatMap((bar) => bar.args)
  }
  const page = {
    getOperatorList: async (): Promise<typeof ops> => ops,
    commonObjs: { get: (): typeof font => font, has: (id: string): boolean => id === 'body' }
  }
  const units = items.map((item, index) => ({
    id: `math-owner-${index}`,
    source: item.str,
    fragments: [
      {
        pageNumber: 1,
        rect: { x: item.transform[4] / 600, y: 0.25, width: item.width / 600, height: 0.02 },
        items: [{ index, text: item.str }]
      }
    ],
    ...(!(single ? [2, 3, 4] : [2, 4]).includes(index)
      ? { preserve: 'formula' as const, sourceOnly: true as const }
      : {})
  }))
  return [
    units,
    page as unknown as Request[1],
    { items, styles: { body } },
    viewport as Request[3],
    1,
    { read: async () => undefined, dispose: async () => {} }
  ]
}

it.each([
  ['two scoped fraction bars', true],
  ['flat exponent', false],
  ['misplaced rule', false],
  ['extra paint', false]
] as const)('protects the full numbered display with %s', async (fault, protectedOwners) => {
  expect(await nativeScopedDisplayOwners(...fractionDisplay(fault))).toEqual(
    new Set(protectedOwners ? ['math-owner-2', 'math-owner-4'] : [])
  )
})

it.each([
  ['scoped fraction bar', true],
  ['missing rule', false],
  ['detached factor', false]
] as const)(
  'protects the numbered fraction and adjacent factor with %s',
  async (fault, protectedOwners) => {
    expect(await nativeScopedDisplayOwners(...fractionDisplay(fault, true))).toEqual(
      new Set(protectedOwners ? ['math-owner-2', 'math-owner-3', 'math-owner-4'] : [])
    )
  }
)
