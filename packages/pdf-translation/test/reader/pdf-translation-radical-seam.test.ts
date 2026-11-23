import { expect, it } from 'vitest'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { nativeShortMathContinuations } from '../../src/reader/native-short-math-continuation.js'

type Request = Parameters<typeof nativeShortMathContinuations>
type Item = Extract<Request[2]['items'][number], { str: string }>

function packet(fault: string): Request {
  const item = (str: string, x: number, width: number, y = 500, size = 10): Item => ({
    str,
    dir: 'ltr',
    height: size,
    width,
    transform: [size, 0, 0, size, x, y],
    fontName: 'body',
    hasEOL: false
  })
  const first = [
    item('The area of the quadrilateral RSTU =', 100, 55),
    item('|', 158.3, 2.7),
    item('t', 162.3, 3.5, 504, 7),
    item('3', 162, 4, 496.5, 7)
  ]
  const radical = [item('√', fault === 'detached radical' ? 179 : 167.2, 10, 511.9)]
  const body = [
    item('k', 177.2, 5),
    item('−', 183, 4),
    item('z', 188, 6),
    item('|', 194, 2.7),
    item('.', 197, 2.7)
  ]
  const tail = [item('Thus from 2.3,', 100, 65, 486.4)]
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
  const ops =
    fault === 'missing rule'
      ? { fnArray: [], argsArray: [] }
      : {
          fnArray: [OPS.save, OPS.transform, OPS.paintSolidColorImageMask, OPS.restore],
          argsArray: [[], [4.08, 0, 0, -0.48, 162, 502.68], [], []]
        }
  const content = { items: [...first, ...radical, ...body, ...tail], styles }
  const page = {
    getOperatorList: async (): Promise<typeof ops> => ops,
    commonObjs: { get: (): typeof font => font, has: (name: string): boolean => name === 'body' }
  }
  const fragment = (
    items: Item[],
    x: number,
    y: number,
    width: number,
    height = 12
  ): Request[0][number]['fragments'][number] => ({
    pageNumber: 1,
    rect: { x: x / 600, y: y / 800, width: width / 600, height: height / 800 },
    items: items.map((run) => ({ index: content.items.indexOf(run), text: run.str }))
  })
  const units: Request[0] = [
    {
      id: 'radical',
      source: '√',
      sourceOnly: true,
      preserve: 'formula',
      fragments: [fragment(radical, 167.2, 288, 10)]
    },
    {
      id: 'mixed',
      source: first[0].str + ' | t/3 ' + tail[0].str,
      fragments: [fragment(first, 100, 290, 66, 18), fragment(tail, 100, 303, 65)]
    },
    {
      id: 'body',
      source: 'k − z | .',
      ...(fault === 'writable radical body' ? {} : { sourceOnly: true, preserve: 'formula' }),
      fragments: [fragment(body, 177, 290, 23)]
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

it.each(['closed equation', 'missing rule', 'detached radical', 'writable radical body'])(
  'separates prose while preserving the native coefficient: %s',
  async (fault) => {
    const request = packet(fault)
    const result = await nativeShortMathContinuations(...request)
    if (fault !== 'closed equation') {
      expect(result).toEqual(request[0])
      return
    }
    const [radical, prefix, coefficient, body, tail] = result
    expect(radical).toBe(request[0][0])
    expect(body).toBe(request[0][2])
    expect(prefix).toMatchObject({ source: 'The area of the quadrilateral RSTU =' })
    expect(prefix.sourceOnly).toBeUndefined()
    expect(coefficient).toMatchObject({ source: '| t/3', sourceOnly: true, preserve: 'formula' })
    expect(tail.source).toBe('Thus from 2.3,')
    expect(tail.sourceOnly).toBeUndefined()
    expect([...prefix.fragments[0].items, ...coefficient.fragments[0].items]).toEqual(
      request[0][1].fragments[0].items
    )
    expect(tail.fragments[0]).toBe(request[0][1].fragments[1])
  }
)
