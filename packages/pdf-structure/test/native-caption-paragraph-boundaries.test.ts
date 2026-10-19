import { expect, it } from 'vitest'
import { resolve } from './paths'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'

const { captionKind, findCaptionCandidates, recoverStyledMathCaption } = await import(
  pathToFileURL(resolve('resources/literature-pdf-caption-group.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(resolve('test/fixtures/source-grids/native-caption-paragraph-boundaries.jsonl'))

function literalControlCaptionFixture(): ReturnType<typeof JSON.parse> {
  const specs: [string, number, number, number, number][] = [
    ['Fig. 1. Sample response.', 10, 100, 200, 10],
    ['Recorded values follow.', 10, 112, 200, 10],
    ['Response,', 10, 124, 50, 10],
    ['\u0000', 61, 116, 4, 10],
    ['f', 65, 124, 10, 10],
    ['\u0001', 76, 116, 4, 10],
    ['= (0.5 m', 84, 124, 30, 10],
    ['2', 114, 123, 4, 6],
    [', V', 120, 124, 15, 10],
    ['−1', 135, 123, 6, 6],
    [').', 145, 124, 10, 10]
  ]
  const lines = specs.map(([text, x, y, width, fontSize]) => ({
    text,
    x,
    y,
    width,
    height: fontSize,
    fontSize
  }))
  const items = lines.map((l, index) => ({
    str: l.text,
    width: l.width,
    height: l.height,
    transform: [l.fontSize, 0, 0, l.fontSize, l.x, 300 - l.y - l.height],
    fontName: index === 3 || index === 5 ? 'symbol' : 'body',
    sourceItem: { pageNumber: 1, index, text: l.text }
  }))
  const inventory = items.map((r, i) => ({
    text: r.str,
    fontName: r.fontName,
    sourceItem: r.sourceItem,
    horizontal: true,
    rect: [lines[i].x, lines[i].y, lines[i].x + r.width, lines[i].y + r.height]
  }))
  const caption = {
    page: 1,
    lines: lines.slice(0, 3).map((l) => l.text),
    rect: [10, 100, 210, 134]
  }
  return {
    caption,
    page: {
      pageNumber: 1,
      width: 300,
      height: 300,
      renderRotation: 0,
      invalidGraphicsBounds: 0,
      graphicsBounds: [{ kind: 'path', normalizedRect: [10 / 300, 20 / 300, 210 / 300, 80 / 300] }],
      lines
    },
    rules: [],
    fonts: structuredClone(inventory),
    context: {
      content: {
        items,
        styles: {
          symbol: { ascent: 0.8, descent: -0.2, vertical: false },
          body: { ascent: 0.8, descent: -0.2, vertical: false }
        }
      },
      inventory,
      viewport: { transform: [1, 0, 0, -1, 0, 300] },
      associations: [{ caption, rect: [10, 20, 210, 80] }],
      operators: {
        fnArray: items.flatMap(() => [OPS.setFont, OPS.showText]),
        argsArray: items.flatMap((r) => [
          [r.fontName, r.height],
          [
            [...r.str].map((unicode) => ({
              unicode,
              originalCharCode: unicode.charCodeAt(0),
              isInFont: true,
              isSpace: false,
              accent: null
            }))
          ]
        ])
      }
    }
  }
}

it('retains literal control glyphs only with complete native caption font and row ownership', () => {
  const f = literalControlCaptionFixture(),
    before = structuredClone(f)
  const result = recoverStyledMathCaption(f.caption, f.page, f.rules, f.fonts, f.context)
  expect(result?.lines).toEqual([
    'Fig. 1. Sample response.',
    'Recorded values follow.',
    'Response, \u0000 f \u0001 = (0.5 m² , V⁻¹ ).'
  ])
  expect(f).toEqual(before)
})

it.each([
  'glyph-unicode',
  'glyph-code',
  'glyph-not-in-font',
  'glyph-accent',
  'glyph-space',
  'font-stream-extra',
  'font-stream-missing',
  'font-stream-reversed',
  'font-state-underflow',
  'font-state-mismatched-end',
  'font-state-invalid-gstate',
  'inventory-missing',
  'inventory-duplicate',
  'source-alias',
  'wrong-native-font',
  'missing-style',
  'raw-neighbor-order',
  'competing-association',
  'caption-rule',
  'caption-paint',
  'unknown-paint',
  'invalid-paint-box',
  'ordinary-letter',
  'table-caption',
  'other-row',
  'unbounded-gap'
])('rejects an unproved literal control caption: %s', (fault) => {
  const f = literalControlCaptionFixture(),
    glyph = f.context.operators.argsArray[7][0][0]
  if (fault === 'glyph-unicode') glyph.unicode = 'X'
  if (fault === 'glyph-code') glyph.originalCharCode = 2
  if (fault === 'glyph-not-in-font') glyph.isInFont = false
  if (fault === 'glyph-accent') glyph.accent = { fontChar: 'x' }
  if (fault === 'glyph-space') glyph.isSpace = true
  if (fault === 'font-stream-extra') f.context.operators.argsArray[7][0].push({ ...glyph })
  if (fault === 'font-stream-missing') f.context.operators.argsArray[7][0] = []
  if (fault === 'font-stream-reversed') {
    const a = f.context.operators.argsArray
    ;[a[7], a[11]] = [a[11], a[7]]
  }
  if (fault === 'font-state-underflow') {
    f.context.operators.fnArray.unshift(OPS.restore)
    f.context.operators.argsArray.unshift([])
  }
  if (fault === 'font-state-mismatched-end') {
    f.context.operators.fnArray.unshift(OPS.save, OPS.endGroup)
    f.context.operators.argsArray.unshift([], [])
  }
  if (fault === 'font-state-invalid-gstate') {
    f.context.operators.fnArray.unshift(OPS.setGState)
    f.context.operators.argsArray.unshift([{}])
  }
  if (fault === 'inventory-missing') f.context.inventory.pop()
  if (fault === 'inventory-duplicate')
    f.context.inventory.push(structuredClone(f.context.inventory[3]))
  if (fault === 'source-alias') f.fonts[3].alias = { sourceItem: { ...f.fonts[3].sourceItem } }
  if (fault === 'wrong-native-font') f.context.inventory[3].fontName = 'other'
  if (fault === 'missing-style') delete f.context.content.styles.symbol
  if (fault === 'raw-neighbor-order') {
    const r = f.context.content.items
    ;[r[2], r[4]] = [r[4], r[2]]
  }
  if (fault === 'competing-association')
    f.context.associations.push(structuredClone(f.context.associations[0]))
  if (fault === 'caption-rule') f.rules.push([70, 100, 70, 135])
  if (fault === 'caption-paint')
    f.page.graphicsBounds.push({ kind: 'path', normalizedRect: [0.2, 0.33, 0.3, 0.45] })
  if (fault === 'unknown-paint') f.page.graphicsBounds[0].kind = 'unknown'
  if (fault === 'invalid-paint-box') f.page.graphicsBounds[0].normalizedRect[0] = -1
  if (fault === 'ordinary-letter') f.page.lines[3].text = 'X'
  if (fault === 'table-caption') f.caption.lines[0] = 'Table 1. Sample response.'
  if (fault === 'other-row') f.page.lines[4].y = 120
  if (fault === 'unbounded-gap') f.page.lines[4].x = 71
  expect(recoverStyledMathCaption(f.caption, f.page, f.rules, f.fonts, f.context)).toBeUndefined()
})

it('owns one taller interior native row only on the repeated closed caption baselines', () => {
  const text = [
    'Fig. 1. Measured distributions for all independent',
    'regions are drawn with the same boundary settings and',
    'all complete records are retained within the same region,',
    'including the measured X Y values across each region and',
    'the remaining complete comparisons are shown together with',
    'the final boundary.'
  ]
  const lines = text.map((text, i) => ({
    text,
    x: i ? 100 : 108,
    y: 200 + i * 11 - (i === 3 ? 1.25 : 0),
    width: i === 5 ? 100 : i ? 250 : 242,
    height: i === 3 ? 11.25 : 10,
    fontSize: i === 3 ? 11.25 : 10
  }))
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [
      ...lines,
      {
        text: 'The independent body paragraph starts beneath the figure.',
        x: 112,
        y: 280,
        width: 238,
        height: 12.5,
        fontSize: 12.5
      }
    ],
    graphicsBounds: [{ kind: 'image', normalizedRect: [100 / 600, 50 / 800, 350 / 600, 195 / 800] }]
  }
  expect(findCaptionCandidates([page])[0].lines).toEqual(text)
  for (const change of [
    'baseline',
    'second-outlier',
    'missing-row',
    'invalid',
    'graphic',
    'paint',
    'rule'
  ]) {
    const copy = structuredClone(page)
    if (change === 'baseline') copy.lines[3].y += 1.25
    if (change === 'second-outlier') {
      copy.lines[2].fontSize = 11.25
      copy.lines[2].height = 11.25
      copy.lines[2].y -= 1.25
    }
    if (change === 'missing-row') copy.lines.splice(2, 1)
    if (change === 'invalid') copy.lines[3].width = -250
    if (change === 'graphic') copy.graphicsBounds = []
    if (change === 'paint') copy.invalidGraphicsBounds = 1
    const rules = change === 'rule' ? new Map([[1, [[100, 240, 350, 240]]]]) : new Map()
    expect(findCaptionCandidates([copy], rules)[0].lines).not.toContain(text[5])
  }
})

it.each(['Tab. 2.', 'Fig. 2.'])(
  'retains a wrapped %s reference inside its complete native caption',
  (label) => {
    const texts = [
      'Fig. 1. Independent measurements across the observed regions.',
      'The complete measurements correspond to',
      `${label} The same measurements are shown with different scales,`,
      'and the remaining comparisons are measured independently.',
      'All regions are included.'
    ]
    const lines = texts.map((text, i) => ({
      text,
      x: 50,
      y: 300 + i * 11,
      width: i === 4 ? 170 : 500,
      height: 10,
      fontSize: 10
    }))
    const page = {
      pageNumber: 1,
      width: 600,
      height: 800,
      invalidGraphicsBounds: 0,
      lines: [
        ...lines,
        {
          text: 'A new body paragraph starts below the complete caption.',
          x: 50,
          y: 380,
          width: 250,
          height: 11.2,
          fontSize: 11.2
        }
      ],
      graphicsBounds: [0, 1, 2].map((i) => ({
        kind: 'image',
        normalizedRect: [(70 + i * 150) / 600, 0.1, (200 + i * 150) / 600, 0.34]
      }))
    }
    expect(findCaptionCandidates([page]).map((c: { lines: string[] }) => c.lines)).toEqual([texts])
    for (const change of ['closed-predecessor', 'font', 'rule', 'missing-graphic', 'invalid']) {
      const copy = structuredClone(page)
      if (change === 'closed-predecessor') copy.lines[1].text += '.'
      if (change === 'font') copy.lines[2].fontSize = 12
      if (change === 'missing-graphic') copy.graphicsBounds = []
      if (change === 'invalid') copy.lines[2].width = -500
      const rules = change === 'rule' ? new Map([[1, [[50, 321, 550, 321]]]]) : new Map()
      expect(findCaptionCandidates([copy], rules)[0].lines).not.toContain(copy.lines[2].text)
    }
  }
)

it('owns a short centered caption tail only inside a separated native caption band', () => {
  const line = (
    text: string,
    x: number,
    y: number,
    width: number,
    fontSize = 10
  ): {
    text: string
    x: number
    y: number
    width: number
    height: number
    fontSize: number
  } => ({ text, x, y, width, height: fontSize, fontSize })
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [
      line('Fig.1. Comparison of the independent methods in the', 100, 300, 400),
      line('three observed coordinates, respectively.', 200, 318, 200),
      line('A separately led body paragraph follows the caption.', 100, 350, 400, 12)
    ],
    graphicsBounds: [
      { kind: 'image', normalizedRect: [120 / 600, 100 / 800, 480 / 600, 280 / 800] }
    ]
  }
  expect(findCaptionCandidates([page])[0].lines).toEqual(page.lines.slice(0, 2).map((l) => l.text))
  for (const change of [
    'font',
    'miscentered',
    'missing-graphic',
    'rule',
    'invalid',
    'closed-title',
    'unknown-paint',
    'invalid-graphic'
  ]) {
    const copy = structuredClone(page)
    if (change === 'font') copy.lines[1].fontSize = 12
    if (change === 'miscentered') copy.lines[1].x += 25
    if (change === 'missing-graphic') copy.graphicsBounds = []
    if (change === 'invalid') copy.lines[1].width = -200
    if (change === 'closed-title') copy.lines[0].text += '.'
    if (change === 'unknown-paint') copy.invalidGraphicsBounds = 1
    if (change === 'invalid-graphic') copy.graphicsBounds[0].normalizedRect[2] = 0.1
    const rules = change === 'rule' ? new Map([[1, [[100, 314, 500, 314]]]]) : new Map()
    expect(findCaptionCandidates([copy], rules)[0].lines).not.toContain(copy.lines[1].text)
  }
})

it('retains a long native caption after a full-width intermediate sentence', () => {
  const page = fixture()[0]
  const before = structuredClone(page)
  const [caption] = findCaptionCandidates([page])
  expect(caption.lines).toEqual(page.lines.slice(0, 12).map((l: { text: string }) => l.text))
  expect(caption.rect[3]).toBeCloseTo(page.lines[11].y + page.lines[11].height)
  expect(caption.lines.join(' ')).not.toContain('A separate body paragraph')
  expect(page).toEqual(before)
})

it('does not borrow formula evidence from a separate paragraph after a closed short caption', () => {
  const page = fixture()[1]
  const before = structuredClone(page)
  const [caption] = findCaptionCandidates([page])
  expect(caption.lines).toEqual(page.lines.slice(0, 3).map((l: { text: string }) => l.text))
  expect(caption.rect[3]).toBeCloseTo(page.lines[2].y + page.lines[2].height)
  expect(caption.lines.join(' ')).not.toContain('independent predictions')
  expect(page).toEqual(before)
})

it('keeps a two-line closed caption separate from neighboring body formula fragments', () => {
  const page = fixture()[1]
  const removed = page.lines.splice(1, 1)[0]
  const leading = page.lines[1].y - removed.y
  for (const line of page.lines) if (line.y > removed.y) line.y -= leading
  const before = structuredClone(page)
  const [caption] = findCaptionCandidates([page])
  expect(caption.lines).toEqual(page.lines.slice(0, 2).map((l: { text: string }) => l.text))
  expect(caption.rect[3]).toBeCloseTo(page.lines[1].y + page.lines[1].height)
  expect(page).toEqual(before)
})

it.each([
  [0, 0.73],
  [0, 1.7],
  [1, 0.73],
  [1, 1.7]
])(
  'keeps native paragraph ownership under source reordering and scale (%s, %s)',
  (index, scale) => {
    const page = fixture()[index]
    const expected = findCaptionCandidates([page])[0].lines
    page.width *= scale
    page.height *= scale
    for (const line of page.lines)
      for (const key of ['x', 'y', 'width', 'height', 'fontSize']) line[key] *= scale
    page.lines.reverse()
    const before = structuredClone(page)
    expect(findCaptionCandidates([page])[0].lines).toEqual(expected)
    expect(page).toEqual(before)
  }
)

it.each(['B', 'C', 'G', 'H', 'T', 'Z'])(
  'distinguishes a finite-verb appendix reference from a literal title (%s)',
  (prefix) => {
    expect(
      captionKind(`Figure ${prefix}1 separates the measured values into independent groups.`)
    ).toBeUndefined()
    expect(captionKind(`Figure ${prefix}1: Separate measurements for independent groups.`)).toBe(
      'figure'
    )
  }
)

type WrappedReferenceCaptionLine = {
  text: string
  x: number
  y: number
  width: number
  height: number
  fontSize: number
}

type WrappedReferenceCaptionPage = {
  pageNumber: number
  width: number
  height: number
  invalidGraphicsBounds: number
  lines: WrappedReferenceCaptionLine[]
  headingCandidates: WrappedReferenceCaptionLine[]
  graphicsBounds: {
    kind: string
    operationIndex: number
    imageHash: string
    normalizedRect: number[]
  }[]
}

const wrappedReferenceCaptionFixture = (): WrappedReferenceCaptionPage => {
  const rows = [
    ['Fig. 1: Measured response for the collection under the', 400, 400],
    ['observed conditions. Values are reported in Table', 417, 400],
    ['2.', 434, 8],
    ['3.3 Independent Measurements', 456, 250],
    ['Independent body paragraph following the heading.', 480, 400]
  ] as const
  const lines = rows.map(([text, y, width]) => ({
    text,
    x: 50,
    y,
    width,
    height: 10,
    fontSize: 10
  }))
  return {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines,
    headingCandidates: [{ ...lines[3] }],
    graphicsBounds: [
      {
        kind: 'image',
        operationIndex: 7,
        imageHash: 'a'.repeat(64),
        normalizedRect: [200 / 600, 150 / 800, 400 / 600, 390 / 800]
      }
    ]
  }
}

// An existing caption ends with a split numbered reference before a separate section.
it.each([0.5, 2])(
  'owns a terminal reference at scale %s without consuming its section',
  (scale) => {
    const page = wrappedReferenceCaptionFixture()
    page.width *= scale
    page.height *= scale
    for (const line of [...page.lines, ...page.headingCandidates])
      for (const key of ['x', 'y', 'width', 'height', 'fontSize'] as const) line[key] *= scale
    expect(findCaptionCandidates([page])[0].lines).toEqual(
      page.lines.slice(0, 3).map((l) => l.text)
    )
  }
)
it('keeps a split reference unowned when its independent boundary or native inventory is ambiguous', () => {
  const original = wrappedReferenceCaptionFixture()
  for (const kind of [
    'reference',
    'heading',
    'image',
    'unknown-paint',
    'extra-image',
    'duplicate',
    'competition',
    'font',
    'column',
    'pitch',
    'caption',
    'rule'
  ]) {
    const page = structuredClone(original)
    if (kind === 'reference') page.lines[1].text = 'An independent descriptive sentence'
    if (kind === 'heading') page.headingCandidates = []
    if (kind === 'image') page.graphicsBounds = []
    if (kind === 'unknown-paint') page.invalidGraphicsBounds = 1
    if (kind === 'extra-image')
      page.graphicsBounds.push({ ...page.graphicsBounds[0], operationIndex: 8 })
    if (kind === 'duplicate') page.lines.push({ ...page.lines[2] })
    if (kind === 'competition')
      page.lines.push({ text: 'Other', x: 100, y: 430, width: 20, height: 5, fontSize: 5 })
    if (kind === 'font') page.lines[2].fontSize = 9
    if (kind === 'column') page.lines[2].x += 30
    if (kind === 'pitch') page.lines[2].y += 5
    if (kind === 'caption') page.lines[2].text = 'Figure 2. Other panel'
    const rules = kind === 'rule' ? new Map([[1, [[50, 430, 450, 430]]]]) : new Map()
    expect(findCaptionCandidates([page], rules)[0].lines, kind).not.toContain('2.')
  }
})

type StyledCaption = { page: number; lines: string[]; rect: number[] }
type StyledSource = { pageNumber: number; index: number; text: string }
type StyledFont = {
  text: string
  fontName: string
  sourceItem: StyledSource
  horizontal: boolean
  baseline: number
  height: number
  rect: number[]
}
type StyledViewport = { width: number; height: number; transform: number[] }
type StyledFixture = readonly [
  StyledCaption,
  {
    pageNumber: number
    width: number
    height: number
    lines: { text: string; x: number; y: number; width: number; height: number; fontSize: number }[]
    invalidGraphicsBounds: number
    graphicsBounds: { kind: string; operationIndex: number; normalizedRect: number[] }[]
  },
  never[],
  StyledFont[],
  {
    viewport: StyledViewport
    content: {
      items: {
        str: string
        dir: string
        width: number
        height: number
        transform: number[]
        fontName: string
        sourceItem: StyledSource
      }[]
      styles: Record<string, { ascent: number; descent: number; vertical: boolean }>
    }
    inventory: StyledFont[]
    associations: { caption: StyledCaption; graphicsCount: number; rect: number[] }[]
  }
]

function styledCaptionFixture(scale = 1, dx = 0, dy = 0): StyledFixture {
  const rows: [string, number, number, number][] = [
    ['Fig. 1: A comparison of the measured response', 50, 300, 400],
    ['q≈0 describes the repeated measured response', 50, 318, 400],
    ['showing the common response.', 50, 336, 180],
    ['The next independent paragraph starts here.', 70, 390, 380]
  ]
  const lines = rows.map(([text, x, y, width]) => ({
    text,
    x: x * scale + dx,
    y: y * scale + dy,
    width: width * scale,
    height: 10 * scale,
    fontSize: 10 * scale
  }))
  const viewport = {
    width: 600 * scale + dx,
    height: 800 * scale + dy,
    transform: [scale, 0, 0, -scale, dx, 800 * scale + dy]
  }
  const specs: [string, number, number, number, string, number][] = [
    [rows[0][0], 50, 300, 400, 'caption', 0],
    ['q', 50, 318, 5, 'caption', 0],
    ['≈', 55, 318, 6, 'math', 3.333],
    [rows[1][0].slice(2), 61, 318, 389, 'caption', 0],
    [rows[2][0], 50, 336, 180, 'caption', 0],
    [rows[3][0], 70, 390, 380, 'body', 0]
  ]
  const items = specs.map(([str, x, y, width, fontName, shear], index) => ({
    str,
    dir: 'ltr',
    width,
    height: Math.hypot(shear, 10),
    transform: [10, 0, shear, 10, x, 800 - y - 10],
    fontName,
    sourceItem: { pageNumber: 1, index, text: str }
  }))
  const inventory = items.map((r, i) => {
    const [, x, y, width] = specs[i]
    return {
      text: r.str,
      fontName: r.fontName,
      sourceItem: r.sourceItem,
      horizontal: true,
      baseline: (y + 10) * scale + dy,
      height: r.height * scale,
      rect: [
        x * scale + dx,
        (y + 10 - r.height) * scale + dy,
        (x + width) * scale + dx,
        (y + 10) * scale + dy
      ]
    }
  })
  lines[1].fontSize = Math.hypot(3.333, 10) * scale
  const caption = {
    page: 1,
    lines: [lines[0].text],
    rect: [lines[0].x, lines[0].y, lines[0].x + lines[0].width, lines[0].y + lines[0].height]
  }
  const graphic = [140, 80, 360, 280].map((v, i) => v * scale + (i % 2 ? dy : dx))
  const page = {
    pageNumber: 1,
    width: viewport.width,
    height: viewport.height,
    lines,
    invalidGraphicsBounds: 0,
    graphicsBounds: [
      {
        kind: 'path',
        operationIndex: 4,
        normalizedRect: graphic.map((v, i) => v / (i % 2 ? viewport.height : viewport.width))
      }
    ]
  }
  const context = {
    viewport,
    content: {
      items,
      styles: Object.fromEntries(
        ['caption', 'math', 'body'].map((n) => [n, { ascent: 0.9, descent: -0.2, vertical: false }])
      )
    },
    inventory,
    associations: [
      { caption, graphicsCount: 1, rect: graphic.map((v, i) => v + (i < 2 ? -1 : 1) * scale) }
    ]
  }
  return [caption, page, [], inventory, context] as const
}

it.each([0.75, 2])(
  'recovers a native math caption only after unique graphic association at scale %s',
  (scale) => {
    const args = styledCaptionFixture(scale, 12, 16),
      before = structuredClone(args)
    expect(typeof recoverStyledMathCaption).toBe('function')
    const result = recoverStyledMathCaption(...args)
    expect(result.lines).toEqual(args[1].lines.slice(0, 3).map((row) => row.text))
    expect(result.rect).toEqual([
      args[1].lines[0].x,
      args[1].lines[0].y,
      args[1].lines[1].x + args[1].lines[1].width,
      args[1].lines[2].y + args[1].lines[2].height
    ])
    expect(args).toEqual(before)
  }
)

it.each([
  'missing-metrics',
  'nonfinite-metrics',
  'word-font',
  'raw-literal',
  'raw-identity',
  'raw-alias',
  'token-alias',
  'missing-item',
  'duplicate-item',
  'font-mismatch',
  'same-body-font',
  'no-indent',
  'no-body',
  'competing-line',
  'unknown-paint',
  'missing-paint-counter',
  'second-figure',
  'outside-paint',
  'wrong-caption',
  'cross-page',
  'caption-override',
  'different-leading',
  'strip-rule',
  'duplicate-operation'
])('rejects uncertain late caption proof: %s', (change) => {
  const args = styledCaptionFixture(),
    [caption, page, , fonts, context] = args
  if (change === 'missing-metrics') delete context.content.styles.caption
  if (change === 'nonfinite-metrics') context.content.styles.math.ascent = NaN
  if (change === 'word-font') {
    context.content.items[3].fontName = 'body'
    fonts[3].fontName = 'body'
  }
  if (change === 'raw-literal') context.content.items[1].str = 'z'
  if (change === 'raw-identity')
    context.content.items[1].sourceItem = { ...fonts[1].sourceItem, index: 999 }
  if (change === 'raw-alias')
    Object.assign(context.content, {
      alias: { nested: [{ sourceItem: { ...fonts[1].sourceItem } }] }
    })
  if (change === 'token-alias')
    Object.assign(fonts[5], { alias: { nested: [{ sourceItem: { ...fonts[1].sourceItem } }] } })
  if (change === 'missing-item') context.inventory = context.inventory.filter((_, i) => i !== 2)
  if (change === 'duplicate-item') context.inventory = [...context.inventory, context.inventory[2]]
  if (change === 'font-mismatch') context.content.items[2].fontName = 'body'
  if (change === 'same-body-font') {
    context.content.items[5].fontName = 'caption'
    fonts[5].fontName = 'caption'
  }
  if (change === 'no-indent') page.lines[3].x = page.lines[0].x
  if (change === 'no-body') page.lines.pop()
  if (change === 'competing-line')
    page.lines.push({ ...page.lines[1], text: 'Unrelated note', x: 180, width: 90 })
  if (change === 'unknown-paint') page.invalidGraphicsBounds = 1
  if (change === 'missing-paint-counter') Reflect.deleteProperty(page, 'invalidGraphicsBounds')
  if (change === 'second-figure')
    context.associations.push(structuredClone(context.associations[0]))
  if (change === 'outside-paint') context.associations[0].rect[2] -= 2
  if (change === 'wrong-caption')
    context.associations[0] = {
      ...context.associations[0],
      caption: { ...caption, lines: ['Fig. 2: Other result'] }
    }
  if (change === 'cross-page')
    Object.assign(caption, { regions: [{ page: 2, rect: [1, 1, 2, 2] }] })
  if (change === 'caption-override')
    Object.assign(context.associations[0], { captionLines: ['Other caption'] })
  if (change === 'different-leading') page.lines[2].y += 4
  if (change === 'duplicate-operation') {
    page.graphicsBounds.push(structuredClone(page.graphicsBounds[0]))
    context.associations[0].graphicsCount++
  }
  const rules = change === 'strip-rule' ? [[50, 330, 450, 330.1]] : []
  const before = structuredClone(args)
  expect(typeof recoverStyledMathCaption).toBe('function')
  expect(recoverStyledMathCaption(caption, page, rules, fonts, context)).toBeUndefined()
  expect(args).toEqual(before)
})

it.each(['Figure A.', 'Figure B:', 'Fig. Z.', 'FIG. ED1.', 'FIG. SI12:'])(
  'classifies a punctuated publisher ordinal without rewriting its source: %s',
  (label) => {
    const text = `${label} Independent measurements in two regions.`
    expect(captionKind(text)).toBe('figure')
    const page = {
      pageNumber: 1,
      width: 600,
      height: 800,
      invalidGraphicsBounds: 0,
      lines: [{ text, x: 50, y: 200, width: 400, height: 10, fontSize: 10 }],
      graphicsBounds: [
        { kind: 'image', normalizedRect: [50 / 600, 50 / 800, 450 / 600, 190 / 800] }
      ]
    }
    expect(findCaptionCandidates([page]).map((c: { lines: string[] }) => c.lines)).toEqual([[text]])
  }
)

it.each([
  'Fig.4 and Fig.5 illustrate the independent measurements.',
  'FIG.4 and FIG.5 compare the measured regions.',
  'Figure A shows the measured regions.',
  'Figure A. Therefore, the regions differ.',
  'FIG. ED1 shows the measured regions.',
  'FIG. ED1. Therefore, the regions differ.',
  'Figure A.',
  'Figure A = the measured region'
])('preserves prose and incomplete labels through caption aliases: %s', (text) => {
  expect(captionKind(text)).toBeUndefined()
})

function unnumberedBodyNounPage(): {
  pageNumber: number
  width: number
  height: number
  invalidGraphicsBounds: number
  graphicsBounds: { kind: string; normalizedRect: number[] }[]
  lines: { text: string; x: number; y: number; width: number; height: number; fontSize: number }[]
} {
  return {
    pageNumber: 1,
    width: 500,
    height: 600,
    invalidGraphicsBounds: 0,
    graphicsBounds: [] as { kind: string; normalizedRect: number[] }[],
    lines: [
      'The measured response follows the complete construction of this sample',
      'figure. Only measured values are retained for the subsequent comparison',
      'and the independent observations remain available for further analysis'
    ].map((text, i) => ({ text, x: 50, y: 100 + i * 12.5, width: 400, height: 10, fontSize: 10 }))
  }
}

it('keeps an unnumbered lowercase noun inside its complete native body paragraph', () => {
  expect(findCaptionCandidates([unnumberedBodyNounPage()])).toEqual([])
})

it.each([
  'uppercase',
  'detached',
  'font',
  'unknown-paint',
  'graphic',
  'duplicate',
  'vertical-rule'
])(
  'retains an independently possible unnumbered caption when %s breaks body ownership',
  (change) => {
    const page = unnumberedBodyNounPage()
    let rules: number[][] = []
    if (change === 'uppercase')
      page.lines[1].text = page.lines[1].text.replace('figure.', 'Figure.')
    if (change === 'detached') page.lines[0].y -= 15
    if (change === 'font') page.lines[0].fontSize = 12
    if (change === 'unknown-paint') page.invalidGraphicsBounds = 1
    if (change === 'graphic')
      page.graphicsBounds.push({ kind: 'path', normalizedRect: [0.1, 0.17, 0.9, 0.18] })
    if (change === 'duplicate') page.lines.push({ ...page.lines[0] })
    if (change === 'vertical-rule') rules = [[250, 105, 250, 130]]
    expect(
      findCaptionCandidates([page], new Map([[1, rules]])).some(
        (c: { lines: string[] }) => c.lines[0] === page.lines[1].text
      )
    ).toBe(true)
  }
)

it.each([
  'Fig. 2 records two independent observations in the experiment.',
  'Figure 4 pairs the measured response with its control.',
  'Fig. 5 renders the observed distribution as a diagram.'
])('keeps a complete unpunctuated finite Figure subject as prose: %s', (text) => {
  expect(captionKind(text)).toBeUndefined()
})
it.each([
  'Figure 2: Records of independent observations.',
  'Figure 4. Pairs of measured response curves.',
  'Figure 5. Rendered observations.',
  'Figure 2 Records of independent observations'
])('preserves the noun or delimited Figure title: %s', (text) => {
  expect(captionKind(text)).toBe('figure')
})
