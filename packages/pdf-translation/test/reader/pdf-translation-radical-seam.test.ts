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

it.each([
  'same line',
  'next line',
  'full prose continuation',
  'missing vinculum',
  'writable stem',
  'wrong claim'
])('protects a logarithmic operand only under its native vinculum: %s', async (shape) => {
  const [, page, template, viewport] = packet('missing rule')
  const item = (str: string, x: number, width: number, y = 500): Item => ({
    str,
    dir: 'ltr',
    height: 10,
    width,
    transform: [10, 0, 0, 10, x, y],
    fontName: 'body',
    hasEOL: false
  })
  const sameLine = shape !== 'next line' && shape !== 'full prose continuation'
  const fullContinuation = shape === 'full prose continuation'
  const nextLineProse = fullContinuation ? 'Then continue the proof.' : 'Then'
  const nextLineWidth = fullContinuation ? 120 : 22
  const items = [
    item('√', 190, 10, 509),
    item('k/', 200, 11),
    item('log', 212, 12),
    item('m', 226, 6),
    ...(sameLine
      ? [
          item('are enough for the estimate.', 235, 115),
          item('This also bounds the norm.', 72, 120, 485)
        ]
      : [item('.', 232, 3, 485), item(nextLineProse, 239, nextLineWidth, 485)])
  ]
  const fragment = (
    indices: number[],
    x: number,
    y: number,
    width: number
  ): Request[0][number]['fragments'][number] => ({
    pageNumber: 1,
    rect: { x: x / 600, y: y / 800, width: width / 600, height: 10 / 800 },
    items: indices.map((index) => ({
      index: shape === 'wrong claim' && index === 3 ? 4 : index,
      text: items[index].str
    }))
  })
  const units: Request[0] = [
    {
      id: 'root',
      source: '√',
      sourceOnly: true,
      preserve: 'formula',
      fragments: [fragment([0], 190, 288, 10)]
    },
    {
      id: 'stem',
      source: 'k/',
      ...(shape === 'writable stem' ? {} : { sourceOnly: true, preserve: 'formula' }),
      fragments: [fragment([1], 200, 293, 11)]
    },
    {
      id: 'tail',
      source: sameLine
        ? 'log m are enough for the estimate. This also bounds the norm.'
        : 'log m . ' + nextLineProse,
      fragments: sameLine
        ? [fragment([2, 3, 4], 212, 293, 138), fragment([5], 72, 308, 120)]
        : [fragment([2, 3], 212, 293, 20), fragment([4, 5], 232, 308, 7 + nextLineWidth)]
    }
  ]
  const operators =
    shape === 'missing vinculum'
      ? { fnArray: [], argsArray: [] }
      : {
          fnArray: [OPS.save, OPS.transform, OPS.paintSolidColorImageMask, OPS.restore],
          argsArray: [[], [32, 0, 0, -0.48, 200, 509.2], [], []]
        }
  const result = await nativeShortMathContinuations(
    units,
    { ...page, getOperatorList: async () => operators } as Request[1],
    { ...template, items },
    viewport,
    1
  )
  expect(result.flatMap((u) => u.fragments.flatMap((f) => f.items))).toEqual(
    units.flatMap((u) => u.fragments.flatMap((f) => f.items))
  )
  if (shape === 'next line') {
    expect(result[2]).toEqual({ ...units[2], sourceOnly: true, preserve: 'formula' })
  } else if (shape === 'same line') {
    expect(result[2]).toMatchObject({ source: 'log m', sourceOnly: true, preserve: 'formula' })
    expect(result[3].source).toBe('are enough for the estimate. This also bounds the norm.')
    expect(result[3].sourceOnly).toBeUndefined()
    expect(result[3].fragments[0].rect.x).toBe(235 / 600)
  } else {
    expect(result).toEqual(units)
  }
})
