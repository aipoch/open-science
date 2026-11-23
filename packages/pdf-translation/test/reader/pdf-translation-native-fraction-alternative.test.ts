import { expect, it } from 'vitest'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { nativeShortMathContinuations } from '../../src/reader/native-short-math-continuation.js'

type Request = Parameters<typeof nativeShortMathContinuations>
type Item = Extract<Request[2]['items'][number], { str: string }>

function alternative(fault: string): Request {
  const item = (str: string, x: number, width: number, y = 500, size = 10): Item => ({
    str,
    dir: 'ltr',
    height: size,
    width,
    transform: [size, 0, 0, size, x, y],
    fontName: 'body',
    hasEOL: str === 'or'
  })
  const first = [
    item('(a)', 130, 12),
    item('H', 149, 7),
    item('(', 159, 4),
    item('t', 163, 4),
    item(') =', 168, 12),
    item('1', 195, 4, 504, 7),
    item('(', 185, 3, 496, 7),
    item('t', 188, 4, 496, 7),
    item('−', 192, 6, 496, 7),
    item('d', 198, 5, 496, 7),
    item(')', 203, 3, 496, 7),
    item('5', 206, 3.5, fault === 'detached power' ? 500 : 498.8, 5),
    item('or', 215, 9)
  ]
  const second = [item('(b)', 130, 12, 480), item('H', 149, 7, 480), item('(t) = 0', 159, 25, 480)]
  const styles = { body: { fontFamily: 'serif', vertical: false, ascent: 0.75, descent: -0.25 } }
  const font = {
    ...styles.body,
    loadedName: 'body',
    name: 'Body',
    data: new Uint8Array([1, 2]),
    missingFile: false,
    isType3Font: false,
    isInvalidPDFjsFont: false,
    systemFontInfo: null
  }
  const ops = {
    fnArray: [OPS.save, OPS.transform, OPS.paintSolidColorImageMask, OPS.restore],
    argsArray: [[], [fault === 'wide rule' ? 45 : 24.5, 0, 0, -0.4, 185, 502.5], [], []]
  }
  if (fault === 'missing rule') {
    ops.fnArray.length = 0
    ops.argsArray.length = 0
  }
  const content = { items: [...first, ...second], styles }
  const page = {
    getOperatorList: async (): Promise<typeof ops> => ops,
    commonObjs: { get: (): typeof font => font, has: (name: string): boolean => name === 'body' }
  }
  const units: Request[0] = [
    {
      id: 'first',
      source: '(a) H (t) = 1/((t−d))5 or',
      fragments: [
        {
          pageNumber: 1,
          rect: { x: 130 / 600, y: 289 / 800, width: 94 / 600, height: 19 / 800 },
          items: first.map(({ str }, index) => ({ index, text: str }))
        }
      ]
    },
    {
      id: 'second',
      source: '(b) H(t) = 0',
      sourceOnly: true,
      preserve: 'formula',
      fragments: [
        {
          pageNumber: 1,
          rect: { x: 130 / 600, y: 309 / 800, width: 54 / 600, height: 12 / 800 },
          items: second.map(({ str }, index) => ({ index: index + first.length, text: str }))
        }
      ]
    }
  ]
  const viewport = {
    width: 600,
    height: 800,
    scale: 1,
    rotation: 0,
    transform: [1, 0, 0, -1, 0, 800]
  }
  return [units, page as unknown as Request[1], content, viewport as Request[3], 1]
}

it.each(['native fraction', 'missing rule', 'wide rule', 'detached power'])(
  'isolates the conjunction only after proving a stacked alternative: %s',
  async (fault) => {
    const request = alternative(fault)
    const result = await nativeShortMathContinuations(...request)
    if (fault !== 'native fraction') {
      expect(result).toEqual(request[0])
      return
    }
    const [formula, conjunction, next] = result
    expect(formula).toMatchObject({
      source: '(a) H (t) = 1/((t−d))5',
      sourceOnly: true,
      preserve: 'formula'
    })
    expect(conjunction.source).toBe('or')
    expect(conjunction.sourceOnly).toBeUndefined()
    expect(formula.fragments[0].rect.x + formula.fragments[0].rect.width).toBeLessThan(
      conjunction.fragments[0].rect.x
    )
    expect([...formula.fragments[0].items, ...conjunction.fragments[0].items]).toEqual(
      request[0][0].fragments[0].items
    )
    expect(next).toBe(request[0][1])
  }
)
