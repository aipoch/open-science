import { expect, it } from 'vitest'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { nativeScopedDisplayOwners } from '../../src/reader/native-display-packets.js'

type Request = Parameters<typeof nativeScopedDisplayOwners>
type LayoutItem = Extract<Request[2]['items'][number], { str: string }>

function integralDisplay(fault = ''): Request {
  const make = (str: string, x: number, width: number, extended = false): LayoutItem => ({
    str,
    dir: 'ltr',
    height: 10,
    width,
    transform: [10, 0, 0, 10, x, extended ? 614 : 600],
    fontName: extended ? 'extensible' : 'body',
    hasEOL: str === '(7)'
  })
  const items = [
      make('z', 160, 6),
      make('=', 169, 7),
      make('∫[', 180, 13, true),
      make('exp', 195, 15),
      make('(∫', 212, 14, true),
      make('h(u)', 230, 18),
      make('du', 250, 10),
      make(fault === 'unbalanced' ? ')' : ')]', 260, 12, true),
      make('du,', 274, 12),
      make('(7)', 500, 15)
    ],
    body = { fontFamily: 'serif', vertical: false, ascent: 0.75, descent: -0.25 },
    extensible = { ...body, ascent: 0.04, descent: -2.359 },
    fonts = {
      body: {
        ...body,
        loadedName: 'body',
        name: 'Body',
        data: new Uint8Array([1, 2]),
        missingFile: false,
        isType3Font: false,
        isInvalidPDFjsFont: false,
        systemFontInfo: null
      },
      extensible: {
        ...extensible,
        loadedName: 'extensible',
        name: 'CMEX10',
        data: fault === 'missing program' ? undefined : new Uint8Array([3, 4]),
        missingFile: false,
        isType3Font: false,
        isInvalidPDFjsFont: false,
        systemFontInfo: null
      }
    },
    top = { width: 600, height: 800, rotation: 0, scale: 1, transform: [1, 0, 0, -1, 0, 800] },
    ops = {
      fnArray: [OPS.save, OPS.transform, OPS.paintSolidColorImageMask, OPS.restore],
      argsArray: [[], [15, 0, 0, -0.5, 190, fault === 'intersecting mask' ? 604 : 560], [], []]
    },
    content = { items, styles: { body, extensible } },
    page = {
      getOperatorList: async (): Promise<typeof ops> => ops,
      commonObjs: {
        get: (key: keyof typeof fonts): (typeof fonts)[keyof typeof fonts] => fonts[key],
        has: (key: string): boolean => key in fonts
      }
    },
    units = items.map((item, index) => ({
      id: `formula-owner-${index}`,
      source: item.str,
      fragments: [
        {
          pageNumber: 1,
          rect: { x: item.transform[4] / 600, y: 0.25, width: item.width / 600, height: 0.02 },
          items: [{ index, text: item.str }]
        }
      ],
      ...(![3, 8].includes(index)
        ? { preserve: 'formula' as const, sourceOnly: true as const }
        : {})
    }))
  return [
    units,
    page as unknown as Request[1],
    content,
    top as Request[3],
    1,
    { read: async () => undefined, dispose: async () => {} }
  ]
}

it.each([
  ['closed formula', true],
  ['unbalanced', false],
  ['missing program', false],
  ['intersecting mask', false]
] as const)(
  'protects only a closed native integral display with isolated paint: %s',
  async (fault, protects) => {
    expect(await nativeScopedDisplayOwners(...integralDisplay(fault))).toEqual(
      new Set(protects ? ['formula-owner-3', 'formula-owner-8'] : [])
    )
  }
)
