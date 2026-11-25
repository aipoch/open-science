import { expect, it } from 'vitest'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { nativeScopedDisplayOwners } from '../../src/reader/native-display-packets.js'

type Request = Parameters<typeof nativeScopedDisplayOwners>

function display(missingRoof: boolean): Request {
  const row = [
    ['Q', 100, 600, 7, 10],
    ['net', 107, 598.5, 8, 7],
    ['=', 119, 600, 7, 10],
    ['p', 129, 609, 10, 10],
    ['(', 139, 600, 4, 10],
    ['L', 143, 600, 6, 10],
    ['old', 149, 598.5, 8, 7],
    [')', 157, 600, 4, 10],
    ['2', 161, 603, 4, 7],
    ['+ (3', 168, 600, 15, 10],
    ['·', 185, 600, 3, 10],
    ['R', 190, 600, 7, 10],
    ['new', 197, 598.5, 8, 7],
    [')', 205, 600, 4, 10],
    ['2', 209, 603, 4, 7],
    ['(7)', 500, 600, 15, 10],
    ['The two inputs were measured independently.', 52, 580, 210, 10]
  ] as const
  const items = row.map(([str, x, y, width, height]) => ({
    str,
    dir: 'ltr',
    height,
    width,
    transform: [height, 0, 0, height, x, y],
    fontName: str === 'p' ? 'root' : 'body',
    hasEOL: str === '(7)'
  }))
  const body = { fontFamily: 'serif', vertical: false, ascent: 0.7, descent: -0.2 }
  const root = { ...body, ascent: 0.04, descent: -0.6 }
  const embedded = {
    data: new Uint8Array([1, 2]),
    missingFile: false,
    isType3Font: false,
    isInvalidPDFjsFont: false,
    systemFontInfo: null
  }
  const fonts = {
    body: { ...body, ...embedded, loadedName: 'body', name: 'Body' },
    root: { ...root, ...embedded, loadedName: 'root', name: 'CMEX10', isSymbolicFont: true }
  }
  const viewport = {
    width: 600,
    height: 800,
    rotation: 0,
    scale: 1,
    transform: [1, 0, 0, -1, 0, 800]
  }
  const fnArray = [OPS.setFont, OPS.showText]
  const argsArray: unknown[] = [
    ['root', 10],
    [[{ originalCharCode: 112, unicode: 'p', isInFont: true }]]
  ]
  if (!missingRoof) {
    fnArray.push(OPS.save, OPS.transform, OPS.setLineWidth, OPS.constructPath, OPS.restore)
    argsArray.push(
      [],
      [1, 0, 0, 1, 139, 609.2],
      [0.4],
      [OPS.stroke, [new Float32Array([0, 0, 0, 1, 74, 0])], new Float32Array([0, 0, 74, 0])],
      []
    )
  }
  const page = {
    getOperatorList: async () => ({ fnArray, argsArray }),
    commonObjs: {
      get: (id: keyof typeof fonts) => fonts[id],
      has: (id: string) => Object.hasOwn(fonts, id)
    }
  }
  const unit = (
    id: string,
    first: number,
    last: number,
    protectedFormula = false
  ): Request[0][number] => ({
    id,
    source: items
      .slice(first, last)
      .map(({ str }) => str)
      .join(''),
    fragments: [
      {
        pageNumber: 1,
        rect: { x: 0.2, y: 0.24, width: 0.18, height: 0.025 },
        items: items.slice(first, last).map(({ str }, offset) => ({
          index: first + offset,
          text: str
        }))
      }
    ],
    ...(protectedFormula ? { preserve: 'formula' as const, sourceOnly: true as const } : {})
  })
  return [
    [
      unit('relation', 0, 3),
      unit('root-glyph', 3, 4, true),
      unit('first-operand', 4, 6, true),
      unit('radicand-tail', 6, 15),
      unit('number', 15, 16, true),
      unit('prose', 16, 17)
    ],
    page as unknown as Request[1],
    { items, styles: { body, root } },
    viewport as Request[3],
    1,
    { read: async () => undefined, dispose: async () => {} }
  ]
}

it.each([false, true])(
  'preserves split numbered radical owners only with their painted overbar (missing=%s)',
  async (missingRoof) => {
    expect(await nativeScopedDisplayOwners(...display(missingRoof))).toEqual(
      new Set(missingRoof ? [] : ['relation', 'radicand-tail'])
    )
  }
)
