import { expect, it } from 'vitest'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { nativeMatrixOwners } from '../../src/reader/native-matrix-packets.js'

type Request = Parameters<typeof nativeMatrixOwners>
const literalPieces = [0, 1, 3, 4, 16, 17]

function derivative(fault: string): Request {
  const rows = [
    ['d', 100.75, 303, 5.5],
    ['dt', 99, 289, 9],
    ['[', 112, 311, 5],
    ['q', 117.4, 302, 5.7],
    ['v', 117.4, 290, 5.7],
    [']', 124, 311, 5],
    ['=', 131, 296, 7],
    ['[', 141, 311, 5],
    ['0', 156, 302, 5],
    ['1', 179, 302, 5],
    ['/s', 184, 302, 12],
    ['−', 147, 290, 8],
    ['sθ', 155, 290, 14],
    ['2', 169, 294, 4],
    ['0', 185, 290, 5],
    ['] [', 201, 311, 12],
    ['q', 213.4, 302, 5.7],
    [fault === 'changed variable' ? 'u' : 'v', 213.4, 290, 5.7],
    [']', 220, 311, 5],
    ['.', 227, 296, 2],
    ['(8)', 258, 296, 12]
  ] as const
  const brackets = new Set([2, 5, 7, 15, 18])
  const items: Request[2]['items'] = rows.map(([str, x, y, width], index) => {
    const height = index === 13 ? 7 : 10
    return {
      str,
      width,
      height,
      dir: 'ltr',
      fontName: brackets.has(index) ? 'math' : 'body',
      transform: [height, 0, 0, height, x, y],
      hasEOL: index === rows.length - 1
    }
  })
  const { has, get } = (() => {
    const body = [0, 0.03, 0, 1, 0.46, 0, 1, 0.46, 0.65, 1, 0.03, 0.65, 4]
    const left = [
      0, 0.25, -2.35, 1, 0.51, -2.35, 1, 0.51, -2.29, 1, 0.31, -2.29, 1, 0.31, -0.01, 1, 0.51,
      -0.01, 1, 0.51, 0.05, 1, 0.25, 0.05, 4
    ]
    const right = left.map((n, i) => (i % 3 === 1 ? 0.52 - n : n))
    const fonts = new Map(
      ['body', 'math'].map((name) => [
        name,
        {
          loadedName: name,
          name,
          data: new Uint8Array([1]),
          fontMatrix: [0.001, 0, 0, 0.001, 0, 0],
          missingFile: false,
          isInvalidPDFjsFont: false,
          isType3Font: false,
          vertical: false
        }
      ])
    )
    const paths = new Map<string, { path: Float32Array }>()
    return {
      has: (key: string): boolean => fonts.has(key) || key.includes('_path_'),
      get: (key: string): unknown => {
        if (fonts.has(key)) return fonts.get(key)
        if (!paths.has(key))
          paths.set(key, {
            path: new Float32Array(
              key.endsWith('[')
                ? fault === 'ordinary bracket'
                  ? body
                  : left
                : key.endsWith(']')
                  ? right
                  : body
            )
          })
        return paths.get(key)
      }
    }
  })()
  const glyph = (
    unicode: string,
    width: number
  ): { unicode: string; fontChar: string; width: number; isInFont: true } => ({
    unicode,
    width,
    fontChar: unicode,
    isInFont: true
  })
  const args = items.flatMap((entry) => {
    if (!('str' in entry)) throw Error('Expected native text')
    const width = (entry.width * 1000) / entry.height,
      run =
        entry.str === '] [' ? [glyph(']', 500), -200, glyph('[', 500)] : [glyph(entry.str, width)]
    return [[entry.fontName, entry.height], [run]]
  })
  const paint =
    fault === 'missing rule'
      ? []
      : [OPS.save, OPS.transform, OPS.paintSolidColorImageMask, OPS.restore]
  const ops = {
    fnArray: [...items.flatMap(() => [OPS.setFont, OPS.showText]), ...paint],
    argsArray: [...args, ...(paint.length ? [[], [9, 0, 0, -0.4, 99, 297], [], []] : [])]
  }
  const getOperatorList = async (): Promise<typeof ops> => ops
  const page = { commonObjs: { has, get }, getOperatorList }
  const viewport = {
    width: 480,
    height: 600,
    scale: 1,
    rotation: 0,
    transform: [1, 0, 0, -1, 0, 600]
  }
  const units = rows.map(([str], index) => ({
    id: 'owner-' + index,
    source: str,
    fragments: [
      {
        pageNumber: 1,
        rect: { x: 0.2, y: 0.4, width: 0.1, height: 0.04 },
        items: [{ index, text: str }]
      }
    ],
    ...(!literalPieces.includes(index)
      ? { sourceOnly: true as const, preserve: 'formula' as const }
      : {})
  }))
  return [
    units,
    page as unknown as Request[1],
    { items, styles: {} },
    viewport as Request[3],
    1,
    {} as Request[5]
  ]
}

it.each([
  ['closed display', true],
  ['changed variable', false],
  ['ordinary bracket', false],
  ['missing rule', false]
] as const)(
  'protects complete derivative vectors only with native bracket and rule evidence (%s)',
  async (fault, retained) => {
    expect(await nativeMatrixOwners(...derivative(fault))).toEqual(
      new Set(retained ? literalPieces.map((index) => 'owner-' + index) : [])
    )
  }
)
