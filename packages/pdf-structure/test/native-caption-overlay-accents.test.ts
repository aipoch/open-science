import { describe, expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'

type NativeToken = {
  text: string
  rect: number[]
  baseline: number
  height: number
  horizontal: boolean
}
type SourceLine = {
  text: string
  x: number
  y: number
  width: number
  height: number
  fontSize: number
}
const { findCaptionCandidates } = await import(
  pathToFileURL(resolve('resources/literature-pdf-caption-group.mjs')).href
)
const { recoverNativeCaptionOverlayAccentLines } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-caption-overlay-accents.mjs')).href
)
const line = (text: string, x: number, y: number, width: number): SourceLine => ({
  text,
  x,
  y,
  width,
  height: 10,
  fontSize: 10
})

function centeredCaretSource(): {
  page: { pageNumber: number; width: number; height: number; lines: SourceLine[] }
  tokens: (NativeToken & { sourceItem: { pageNumber: number; index: number; text: string } })[]
  caption: { page: number; lines: string[]; rect: number[] }
  context: {
    content: {
      items: {
        str: string
        dir: string
        width: number
        height: number
        transform: number[]
        fontName: string
        sourceItem: { pageNumber: number; index: number; text: string }
      }[]
      styles: Record<
        string,
        { ascent: number; descent: number; vertical: boolean; fontFamily: string }
      >
    }
    operators: { fnArray: number[]; argsArray: unknown[] }
    viewport: { width: number; height: number; transform: number[] }
    fonts: {
      id: string
      missingFile: boolean
      isType3Font: boolean
      vertical: boolean
      remeasure: boolean
      fontMatrix: number[]
    }[]
    glyphPaths: { id: string; path: number[] }[]
  }
} {
  const fontId = 'loaded-caption-font',
    pageNumber = 1,
    scale = 1.5
  const raw: {
    str: string
    dir: string
    width: number
    height: number
    transform: number[]
    fontName: string
    sourceItem: { pageNumber: number; index: number; text: string }
  }[] = []
  const operators = { fnArray: [] as number[], argsArray: [] as unknown[] }
  const paths = new Map<string, number[]>()
  const op = (code: number, args: unknown): void => {
    operators.fnArray.push(code)
    operators.argsArray.push(args)
  }
  op(OPS.setFillRGBColor, ['#000000'])
  const add = (text: string, x: number, y: number, width: number, size = 10): void => {
    raw.push({
      str: text,
      dir: 'ltr',
      width,
      height: size,
      transform: [size, 0, 0, size, x, 800 - y - size],
      fontName: fontId,
      sourceItem: { pageNumber, index: raw.length, text }
    })
    const glyphs = Array.from(text, (char) => {
      const outline =
        char === 'ˆ'
          ? [0, 0.1, 0.54, 1, 0.2, 0.7, 1, 0.3, 0.54, 4]
          : /\s/u.test(char)
            ? []
            : [0, 0, 0, 1, 0.45, 0, 1, 0.45, 0.65, 1, 0, 0.65, 4]
      paths.set(`${fontId}_path_${char}`, outline)
      return {
        originalCharCode: char.codePointAt(0),
        fontChar: char,
        unicode: char,
        accent: null,
        width: (width / text.length / size) * 1000,
        isSpace: /\s/u.test(char),
        isInFont: true
      }
    })
    op(OPS.beginText, null)
    op(OPS.setFont, [fontId, size])
    op(OPS.moveText, [x, 800 - y - size])
    op(OPS.showText, [glyphs])
    op(OPS.endText, null)
  }
  add('Table I: ', 80, 100, 45)
  add('ˆ', 126, 97.5, 4)
  add('A', 125, 100, 5)
  add(' and B', 130, 100, 30)
  add('2', 160, 100.1, 3.5, 7)
  add(' value.', 163.5, 100, 35)
  add('Short continuation.', 60, 112, 158.5)
  add('Final line.', 80, 124, 118.5)
  const page = {
    pageNumber,
    width: 600,
    height: 800,
    lines: [
      line('Table I:', 80, 100, 45),
      line('ˆ', 126, 97.5, 4),
      line('A and B', 125, 100, 35),
      { ...line('2', 160, 100.1, 3.5), height: 7, fontSize: 7 },
      line('value.', 163.5, 100, 35),
      line('Short continuation.', 60, 112, 158.5),
      line('Final line.', 80, 124, 118.5)
    ]
  }
  const tokens = raw.map((item) => ({
    text: item.str,
    sourceItem: item.sourceItem,
    rect: [
      item.transform[4] * scale,
      (800 - item.transform[5] - item.height) * scale,
      (item.transform[4] + item.width) * scale,
      (800 - item.transform[5]) * scale
    ],
    baseline: (800 - item.transform[5]) * scale,
    height: item.height * scale,
    horizontal: true
  }))
  const caption = {
    page: pageNumber,
    lines: ['Table I: A and B² value.', 'Short continuation.', 'Final line.'],
    rect: [60, 100, 218.5, 134]
  }
  const context = {
    content: {
      items: raw,
      styles: { [fontId]: { ascent: 0.8, descent: -0.2, vertical: false, fontFamily: 'anonymous' } }
    },
    operators,
    viewport: { width: 900, height: 1200, transform: [scale, 0, 0, -scale, 0, 1200] },
    fonts: [
      {
        id: fontId,
        missingFile: false,
        isType3Font: false,
        vertical: false,
        remeasure: false,
        fontMatrix: [0.001, 0, 0, 0.001, 0, 0]
      }
    ],
    glyphPaths: Array.from(paths, ([id, path]) => ({ id, path }))
  }
  return { page, tokens, caption, context }
}

describe('source-visible centered caret', () => {
  it('retains the literal caret through the actual entry while preserving accepted scripts and tails', () => {
    const source = centeredCaretSource(),
      before = structuredClone(source)
    expect(
      recoverNativeCaptionOverlayAccentLines(
        source.page,
        source.caption,
        source.tokens,
        1.5,
        source.context
      )
    ).toEqual(['Table I: ˆA and B² value.', 'Short continuation.', 'Final line.'])
    expect(source).toEqual(before)
  })
  it('keeps the wider first-line/script path unavailable without original source evidence', () => {
    const source = centeredCaretSource()
    expect(
      recoverNativeCaptionOverlayAccentLines(source.page, source.caption, source.tokens)
    ).toBeUndefined()
  })
  it('binds actual operator positions to the original caret and owner tokens', () => {
    const source = centeredCaretSource()
    for (const literal of ['ˆ', 'A']) {
      const index = source.context.operators.fnArray.findIndex(
        (code, n) =>
          code === OPS.showText &&
          (source.context.operators.argsArray[n] as { unicode: string }[][])[0]
            .map((g) => g.unicode)
            .join('') === literal
      )
      ;(source.context.operators.argsArray[index - 1] as number[])[0] += 300
    }
    expect(
      recoverNativeCaptionOverlayAccentLines(
        source.page,
        source.caption,
        source.tokens,
        1.5,
        source.context
      )
    ).toBeUndefined()
  })
  it.each(['missingFile', 'isType3Font', 'vertical', 'remeasure'] as const)(
    'refuses unsupported loaded font flag %s',
    (flag) => {
      const source = centeredCaretSource()
      source.context.fonts[0][flag] = true
      expect(
        recoverNativeCaptionOverlayAccentLines(
          source.page,
          source.caption,
          source.tokens,
          1.5,
          source.context
        )
      ).toBeUndefined()
    }
  )
  it('refuses selected move-only and zero winding-area glyph outlines', () => {
    for (const path of [
      [0, 0.1, 0.54],
      [0, 0.1, 0.54, 1, 0.3, 0.7, 1, 0.1, 0.7, 1, 0.3, 0.54, 4]
    ]) {
      const source = centeredCaretSource()
      source.context.glyphPaths.find((p) => p.id.endsWith('_ˆ'))!.path = path
      expect(
        recoverNativeCaptionOverlayAccentLines(
          source.page,
          source.caption,
          source.tokens,
          1.5,
          source.context
        )
      ).toBeUndefined()
    }
  })
  it('refuses later opaque paint that covers the selected letter or caret', () => {
    const source = centeredCaretSource()
    source.context.operators.fnArray.push(OPS.setFillRGBColor, OPS.constructPath)
    source.context.operators.argsArray.push(
      ['#ffffff'],
      [OPS.fill, [[0, 124, 690, 1, 131, 690, 1, 131, 706, 1, 124, 706, 4]], [124, 690, 131, 706]]
    )
    expect(
      recoverNativeCaptionOverlayAccentLines(
        source.page,
        source.caption,
        source.tokens,
        1.5,
        source.context
      )
    ).toBeUndefined()
  })
  it.each(['hidden', 'restored'])(
    'requires visible selected ink after an earlier %s background',
    (mode) => {
      const source = centeredCaretSource()
      source.context.operators.fnArray.splice(1, 0, OPS.constructPath)
      source.context.operators.argsArray.splice(1, 0, [
        OPS.fill,
        [[0, 120, 685, 1, 135, 685, 1, 135, 708, 1, 120, 708, 4]],
        [120, 685, 135, 708]
      ])
      if (mode === 'restored') {
        source.context.operators.fnArray.splice(
          2,
          0,
          OPS.setFillRGBColor,
          OPS.constructPath,
          OPS.setFillRGBColor
        )
        source.context.operators.argsArray.splice(
          2,
          0,
          ['#ffffff'],
          [
            OPS.fill,
            [[0, 119, 684, 1, 136, 684, 1, 136, 709, 1, 119, 709, 4]],
            [119, 684, 136, 709]
          ],
          ['#000000']
        )
      }
      const before = structuredClone(source)
      const result = recoverNativeCaptionOverlayAccentLines(
        source.page,
        source.caption,
        source.tokens,
        1.5,
        source.context
      )
      if (mode === 'hidden') expect(result).toBeUndefined()
      else
        expect(result).toEqual(['Table I: ˆA and B² value.', 'Short continuation.', 'Final line.'])
      expect(source).toEqual(before)
    }
  )
  it('refuses clipping or unproved opacity states', () => {
    for (const [operation, args] of [
      [OPS.clip, null],
      [OPS.setGState, [[['ca', 0.5]]]]
    ] as const) {
      const source = centeredCaretSource()
      source.context.operators.fnArray.unshift(operation)
      source.context.operators.argsArray.unshift(args)
      expect(
        recoverNativeCaptionOverlayAccentLines(
          source.page,
          source.caption,
          source.tokens,
          1.5,
          source.context
        )
      ).toBeUndefined()
    }
  })
  it('refuses mismatched accepted scripts, repeated first lines and a displaced caption center', () => {
    for (const control of ['script', 'first', 'center']) {
      const source = centeredCaretSource()
      if (control === 'script') source.caption.lines[0] = source.caption.lines[0].replace('²', '³')
      if (control === 'first') source.page.lines.push({ ...source.page.lines[0] })
      if (control === 'center') source.caption.rect[2] += 2
      expect(
        recoverNativeCaptionOverlayAccentLines(
          source.page,
          source.caption,
          source.tokens,
          1.5,
          source.context
        )
      ).toBeUndefined()
    }
  })
  it('rejects array metadata and typed iterators before evaluating accessors', () => {
    let invoked = 0
    const source = centeredCaretSource()
    const tuple = new Float32Array(source.context.operators.argsArray[3] as number[])
    Object.defineProperty(tuple, Symbol.iterator, {
      get: () => {
        invoked++
        return Float32Array.prototype[Symbol.iterator]
      }
    })
    source.context.operators.argsArray[3] = tuple
    expect(
      recoverNativeCaptionOverlayAccentLines(
        source.page,
        source.caption,
        source.tokens,
        1.5,
        source.context
      )
    ).toBeUndefined()
    expect(invoked).toBe(0)
    const hole = centeredCaretSource()
    delete hole.context.fonts[0].fontMatrix[5]
    Object.defineProperty(hole.context.fonts[0].fontMatrix, '9007199254740991', {
      value: 0,
      enumerable: true
    })
    expect(
      recoverNativeCaptionOverlayAccentLines(
        hole.page,
        hole.caption,
        hole.tokens,
        1.5,
        hole.context
      )
    ).toBeUndefined()
  })
})
const native = (text: string, x: number, y: number, width: number): NativeToken => ({
  text,
  rect: [x * 1.5, y * 1.5, (x + width) * 1.5, (y + 10) * 1.5],
  height: 15,
  baseline: (y + 10) * 1.5,
  horizontal: true
})
function input(
  accent = 'ˆ',
  kind = 'Figure'
): {
  page: { pageNumber: number; width: number; height: number; lines: SourceLine[] }
  tokens: NativeToken[]
  caption: { page: number; lines: string[]; rect: number[] }
} {
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    lines: [
      line(`${kind} 4: Native reference frame.`, 50, 100, 200),
      line('Direction', 50, 114, 45),
      line(accent, 101, 111.4, 4),
      line('B remains literal.', 100, 114, 150),
      line('Terminal native description.', 50, 128, 200)
    ]
  }
  const tokens = [
    native(page.lines[0].text, 50, 100, 200),
    native('Direction', 50, 114, 45),
    native(accent, 101, 111.4, 4),
    native('B', 100, 114, 6),
    native('remains literal.', 110, 114, 140),
    native(page.lines[4].text, 50, 128, 200)
  ]
  return { page, tokens, caption: findCaptionCandidates([page])[0] }
}
it.each(['ˆ', '¯'])(
  'preserves the original %s above its unique native letter in a fused caption',
  (accent) => {
    const { page, tokens, caption } = input(accent)
    const before = structuredClone({ page, tokens, caption })
    expect(caption.lines[1]).toBe('Direction B remains literal.')
    const after = recoverNativeCaptionOverlayAccentLines(page, caption, tokens)
    expect(after).toEqual([
      'Figure 4: Native reference frame.',
      `Direction ${accent}B remains literal.`,
      'Terminal native description.'
    ])
    expect({ page, tokens, caption }).toEqual(before)
    expect(
      recoverNativeCaptionOverlayAccentLines(page, { ...caption, lines: after }, tokens)
    ).toBeUndefined()
  }
)

it('keeps an already retained accent and every separate same-letter occurrence unchanged', () => {
  const { page, tokens, caption } = input()
  page.lines[4].text = 'B remains a separate terminal letter.'
  tokens[5].text = page.lines[4].text
  caption.lines[2] = page.lines[4].text
  const after = recoverNativeCaptionOverlayAccentLines(page, caption, tokens)
  expect(after?.[1]).toBe('Direction ˆB remains literal.')
  expect(after?.[2]).toBe('B remains a separate terminal letter.')
  expect(
    recoverNativeCaptionOverlayAccentLines(page, { ...caption, lines: after }, tokens)
  ).toBeUndefined()
})

it('accepts a formal table caption and explicit native viewport scale without changing its frame', () => {
  const { page, tokens, caption } = input('¯', 'Table')
  const scaled = tokens.map((t) => ({
    ...t,
    rect: t.rect.map((n) => (n * 2) / 1.5),
    height: 20,
    baseline: (t.baseline * 2) / 1.5
  }))
  expect(recoverNativeCaptionOverlayAccentLines(page, caption, scaled, 2)?.[1]).toBe(
    'Direction ¯B remains literal.'
  )
  expect(caption.rect).toEqual([50, 100, 250, 138])
})

it.each([
  'foreign source',
  'foreign crossing source',
  'competing single owner',
  'missing native owner',
  'owner is not single',
  'nonfinite source',
  'nonfinite geometry',
  'zero width',
  'wrong rise',
  'different font',
  'different column',
  'different row',
  'ordinary baseline accent',
  'unmatched fused fragment',
  'ambiguous caption row',
  'body reference'
])('declines %s without changing literal caption text', (variant) => {
  const { page, tokens, caption } = input()
  if (variant === 'foreign source') tokens.push(native('Foreign', 115, 115, 20))
  if (variant === 'foreign crossing source') tokens.push(native('Foreign', 40, 114, 20))
  if (variant === 'competing single owner') {
    tokens.push({ ...tokens[3], rect: [...tokens[3].rect] })
    page.lines.push(line('B', 100, 114, 6))
  }
  if (variant === 'missing native owner') tokens.splice(3, 1)
  if (variant === 'owner is not single') {
    tokens[3].text = 'BB'
    page.lines[3].text = 'BB remains literal.'
    caption.lines[1] = 'Direction BB remains literal.'
  }
  if (variant === 'nonfinite source') tokens[2].baseline = NaN
  if (variant === 'nonfinite geometry') page.lines[2].height = Infinity
  if (variant === 'zero width') tokens[2].rect[2] = tokens[2].rect[0]
  if (variant === 'wrong rise') {
    tokens[2] = native('ˆ', 101, 106, 4)
    page.lines[2].y = 106
  }
  if (variant === 'different font') tokens[2].height = 12
  if (variant === 'different column') {
    tokens[2] = native('ˆ', 160, 111.4, 4)
    page.lines[2].x = 160
  }
  if (variant === 'different row') {
    tokens[2] = native('ˆ', 101, 125.4, 4)
    page.lines[2].y = 125.4
  }
  if (variant === 'ordinary baseline accent') {
    tokens[2] = native('ˆ', 101, 114, 4)
    page.lines[2].y = 114
  }
  if (variant === 'unmatched fused fragment') page.lines[3].x += 0.05
  if (variant === 'ambiguous caption row') caption.lines.push(caption.lines[1])
  if (variant === 'body reference')
    caption.lines[0] = 'Figure 4 summarizes the native reference frame.'
  const before = structuredClone(caption)
  expect(recoverNativeCaptionOverlayAccentLines(page, caption, tokens)).toBeUndefined()
  expect(caption).toEqual(before)
})
