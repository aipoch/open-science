import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from './paths'
import { readPdfFixture } from './read-fixture'

const { findCaptionCandidates, applyRuledCaptionRecovery } = await import(
  pathToFileURL(resolve('resources/literature-pdf-caption-group.mjs')).href
)
const { associateFigures } = await import(
  pathToFileURL(resolve('resources/literature-pdf-association.mjs')).href
)
type NativeLine = {
  text: string
  x: number
  y: number
  width: number
  height: number
  fontSize: number
}
const line = (text: string, x: number, y: number, width: number, fontSize = 10): NativeLine => ({
  text,
  x,
  y,
  width,
  fontSize,
  height: fontSize
})
const page = (
  lines: NativeLine[]
): { pageNumber: number; width: number; height: number; lines: NativeLine[] } => ({
  pageNumber: 1,
  width: 600,
  height: 800,
  lines
})

const romanVariableCaption = (): ReturnType<typeof JSON.parse> => {
  const p = {
    ...page([
      line('TABLE IV', 280, 200, 40, 8),
      line('MEASURED CASES FOLLOW THE COMPLETE SOURCE CONFIGURATION', 60, 209, 480, 8),
      line('VALUES FOR a REMAIN THE SAME FOR THE COMPLETE SOURCE CONFIGURATION', 60, 218, 480, 8),
      line('THE FINAL ANGLE ω', 250, 227, 100, 8),
      line('LEFT RIGHT VALUE', 130, 249, 340, 8),
      line('2 3 4', 130, 265, 340, 8),
      line('5 6 7', 130, 277, 340, 8)
    ]),
    invalidGraphicsBounds: 0,
    graphicsBounds: [
      { kind: 'path', normalizedRect: [120 / 600, 246 / 800, 480 / 600, 246.2 / 800] }
    ]
  }
  let index = 0
  const token = (
    text: string,
    x: number,
    baseline: number,
    width: number,
    height: number,
    fontDescent = -0.2
  ): ReturnType<typeof JSON.parse> => ({
    text,
    rect: [x, baseline - height, x + width, baseline],
    baseline,
    height,
    horizontal: true,
    fontDescent,
    sourceItem: { pageNumber: 1, index: index++, text }
  })
  const fonts = [
    token('TABLE IV', 280, 208, 40, 8),
    token('M', 60, 217, 8, 8),
    token('EASURED CASES FOLLOW THE COMPLETE SOURCE CONFIGURATION', 68, 217, 472, 6.4),
    token('VALUES FOR', 60, 226, 80, 6.4),
    token('a', 140, 226, 8, 8, -0.18),
    token('REMAIN THE SAME FOR THE COMPLETE SOURCE CONFIGURATION', 148, 226, 392, 6.4),
    token('THE FINAL ANGLE', 250, 235, 95, 6.4),
    token('ω', 345, 235, 5, 8, -0.18),
    ...p.lines.slice(4).map((l) => token(l.text, l.x, l.y + l.height, l.width, l.height))
  ]
  const rules = [
    [120, 246, 480, 246],
    [120, 258, 480, 258],
    [120, 298, 480, 298],
    ...[120, 240, 360, 480].map((x) => [x, 246, x, 298])
  ]
  return { p, fonts, rules }
}

const centeredRuledTitle = (): ReturnType<typeof JSON.parse> => ({
  ...page([
    line('TABLE II. COMPARISON OF COMPLETE MEASUREMENTS FOR', 100, 200, 400),
    line('SEPARATE GROUPS', 240, 211.5, 120),
    line('Group', 80, 244, 60),
    line('Response', 400, 244, 70)
  ]),
  invalidGraphicsBounds: 0,
  graphicsBounds: [],
  rules: [
    [60, 239, 540, 239],
    [60, 264, 540, 264]
  ]
})

it('completes a centered capitalized title above its separate native header face', () => {
  const p = centeredRuledTitle()
  const before = structuredClone(p)
  const initial = findCaptionCandidates([p])
  const ruled = findCaptionCandidates([p], new Map([[1, p.rules]]))
  applyRuledCaptionRecovery(initial, ruled, p, p.rules)
  expect(initial[0].lines).toEqual([
    'TABLE II. COMPARISON OF COMPLETE MEASUREMENTS FOR',
    'SEPARATE GROUPS'
  ])
  expect(p).toEqual(before)
})

it.each([
  'missing-opening',
  'missing-close',
  'miscentered',
  'font',
  'foreign-text',
  'paint',
  'duplicate',
  'mixed-case',
  'closed-title',
  'unknown-kind',
  'out-of-page',
  'reversed-paint'
])('leaves a centered title unchanged without its complete %s evidence', (variant) => {
  const p = centeredRuledTitle()
  if (variant === 'missing-opening') p.rules.shift()
  if (variant === 'missing-close') p.rules.pop()
  if (variant === 'miscentered') p.lines[1].x += 15
  if (variant === 'font') p.lines[1].fontSize = 11
  if (variant === 'foreign-text') p.lines.push(line('Side note', 75, 224, 50))
  if (variant === 'paint')
    p.graphicsBounds.push({ kind: 'path', normalizedRect: [0.2, 0.26, 0.8, 0.27] })
  if (variant === 'duplicate') p.lines.push({ ...p.lines[1] })
  if (variant === 'mixed-case') p.lines[1].text = 'Separate groups'
  if (variant === 'closed-title') p.lines[0].text += '.'
  if (variant === 'unknown-kind')
    p.graphicsBounds.push({ kind: 'unknown', normalizedRect: [0.1, 0.1, 0.2, 0.2] })
  if (variant === 'out-of-page')
    p.graphicsBounds.push({ kind: 'path', normalizedRect: [-0.1, 0.1, 0.2, 0.2] })
  if (variant === 'reversed-paint')
    p.graphicsBounds.push({ kind: 'path', normalizedRect: [0.2, 0.1, 0.1, 0.2] })
  expect(findCaptionCandidates([p], new Map([[1, p.rules]]))[0].lines).not.toContain(
    p.lines[1].text
  )
})

const hangingCaptionBeforeSection = (): ReturnType<typeof JSON.parse> => ({
  ...page([
    line('Figure 2: Separate observations and complete measurements of', 70, 300, 420),
    line('the final independent response.', 90, 311.5, 240),
    line('4 INDEPENDENT ANALYSIS', 170, 343, 260, 12)
  ]),
  invalidGraphicsBounds: 0,
  graphicsBounds: [
    {
      kind: 'image',
      operationIndex: 2,
      imageHash: 'a'.repeat(64),
      normalizedRect: [0.1, 0.1, 0.9, 0.36]
    }
  ]
})

it('owns an inward two-line caption between native graphics and a separate larger section', () => {
  const p = hangingCaptionBeforeSection()
  const before = structuredClone(p)
  expect(findCaptionCandidates([p])[0].lines).toEqual([
    'Figure 2: Separate observations and complete measurements of',
    'the final independent response.'
  ])
  expect(p).toEqual(before)
})

it('keeps a full hanging terminal row under several independent raster panels', () => {
  const p = hangingCaptionBeforeSection()
  p.lines[1] = line('the complete measurements across every independent panel', 90, 311.5, 400)
  p.graphicsBounds = [0, 1].map((i) => ({
    kind: 'image',
    operationIndex: i,
    imageHash: 'b'.repeat(64),
    normalizedRect: [(70 + i * 210) / 600, 0.1, (260 + i * 210) / 600, 0.36]
  }))
  expect(findCaptionCandidates([p])[0].lines).toEqual(
    p.lines.slice(0, 2).map((l: NativeLine) => l.text)
  )
})

it.each([
  'missing-raster',
  'unknown-paint',
  'tail-paint',
  'foreign-text',
  'duplicate',
  'font',
  'indent',
  'section',
  'rule'
])('refuses a hanging caption without its complete %s boundary', (variant) => {
  const p = hangingCaptionBeforeSection()
  if (variant === 'missing-raster') p.graphicsBounds = []
  if (variant === 'unknown-paint') p.invalidGraphicsBounds = 1
  if (variant === 'tail-paint') p.graphicsBounds[0].normalizedRect[3] = 0.4
  if (variant === 'foreign-text') p.lines.push(line('Foreign text', 400, 325, 80))
  if (variant === 'duplicate') p.lines.push({ ...p.lines[1] })
  if (variant === 'font') p.lines[1].fontSize = 12
  if (variant === 'indent') p.lines[1].x += 8
  if (variant === 'section') p.lines[2].fontSize = 10
  const rules = variant === 'rule' ? new Map([[1, [[70, 310.5, 490, 310.5]]]]) : new Map()
  expect(findCaptionCandidates([p], rules)[0].lines).not.toContain(p.lines[1].text)
})

it('recovers a centered Roman caption only from complete native smallcaps and literal variable carriers', () => {
  const { p, fonts, rules } = romanVariableCaption(),
    original = structuredClone(p),
    originalFonts = structuredClone(fonts)
  const captions = findCaptionCandidates([p]),
    ruled = findCaptionCandidates([p], new Map([[1, rules]]))
  expect(captions[0].lines).toHaveLength(2)
  applyRuledCaptionRecovery(captions, ruled, p, rules, fonts)
  expect(captions[0].lines).toEqual(p.lines.slice(0, 4).map((l) => l.text))
  expect(captions[0].rect).toEqual([60, 200, 540, 235])
  expect(p).toEqual(original)
  expect(fonts).toEqual(originalFonts)
})

it.each([
  'no fonts',
  'missing carrier',
  'duplicate carrier',
  'wrong source page',
  'source text mismatch',
  'misaligned variable',
  'ordinary body font',
  'no smallcaps',
  'different smallcaps descent',
  'wrong variable size',
  'changed row cadence',
  'shifted terminal row',
  'foreign carrier',
  'intervening caption',
  'intervening image',
  'unbound path',
  'extra rule',
  'missing closing rule',
  'missing frame side',
  'broken frame side',
  'duplicate opening',
  'incorrect native row text',
  'lowercase prose',
  'bad caption rectangle',
  'duplicate caption',
  'lower-gap source text',
  'wide path through opening',
  'nonfinite source rectangle',
  'nonfinite header baseline',
  'nonfinite caption rectangle',
  'header reuses caption source',
  'path crosses footer',
  'nonfinite rule',
  'truncated graphic bounds',
  'reversed graphic bounds',
  'reversed extra font',
  'zero extra font',
  'inconsistent extra font height'
])('refuses a Roman variable-caption expansion with %s', (variant) => {
  const { p, fonts, rules } = romanVariableCaption()
  if (variant === 'no fonts') fonts.length = 0
  if (variant === 'missing carrier') fonts.splice(4, 1)
  if (variant === 'duplicate carrier') fonts.push(structuredClone(fonts[4]))
  if (variant === 'wrong source page') fonts[4].sourceItem.pageNumber = 2
  if (variant === 'source text mismatch') fonts[4].sourceItem.text = 'b'
  if (variant === 'misaligned variable') {
    fonts[4].baseline -= 1
    fonts[4].rect[1] -= 1
    fonts[4].rect[3] -= 1
  }
  if (variant === 'ordinary body font') fonts[4].fontDescent = fonts[0].fontDescent
  if (variant === 'no smallcaps')
    for (const i of fonts)
      if (i.height === 6.4) {
        i.height = 8
        i.rect[1] = i.baseline - 8
      }
  if (variant === 'different smallcaps descent') fonts[5].fontDescent = -0.25
  if (variant === 'wrong variable size') {
    fonts[4].height = 6.4
    fonts[4].rect[1] = fonts[4].baseline - 6.4
  }
  if (variant === 'changed row cadence') p.lines[2].y += 1
  if (variant === 'shifted terminal row') p.lines[3].x += 10
  if (variant === 'foreign carrier')
    fonts.push({
      ...structuredClone(fonts[4]),
      baseline: 239,
      rect: [60, 231, 68, 239],
      sourceItem: { pageNumber: 1, index: 100, text: 'a' }
    })
  if (variant === 'intervening caption')
    p.lines.push(line('Table V: Separate source caption.', 50, 238, 480, 8))
  if (variant === 'intervening image')
    p.graphicsBounds.push({
      kind: 'image',
      normalizedRect: [60 / 600, 236 / 800, 540 / 600, 242 / 800]
    })
  if (variant === 'unbound path')
    p.graphicsBounds.push({
      kind: 'path',
      normalizedRect: [60 / 600, 243 / 800, 540 / 600, 245 / 800]
    })
  if (variant === 'extra rule') rules.push([60, 240, 540, 240])
  if (variant === 'missing closing rule') rules.splice(2, 1)
  if (variant === 'missing frame side') rules.pop()
  if (variant === 'broken frame side') rules[3][3] = 290
  if (variant === 'duplicate opening') rules.push(structuredClone(rules[0]))
  if (variant === 'incorrect native row text') p.lines[2].text += ' MORE'
  if (variant === 'lowercase prose')
    p.lines[2].text = 'ordinary body prose continues in the surrounding paragraph'
  if (variant === 'lower-gap source text')
    fonts.push({
      ...structuredClone(fonts[4]),
      text: 'x',
      baseline: 245,
      height: 2,
      rect: [200, 243, 205, 245],
      sourceItem: { pageNumber: 1, index: 100, text: 'x' }
    })
  if (variant === 'wide path through opening')
    p.graphicsBounds.push({
      kind: 'path',
      normalizedRect: [60 / 600, 242 / 800, 540 / 600, 247 / 800]
    })
  if (variant === 'nonfinite source rectangle') fonts[8].rect[0] = Number.NaN
  if (variant === 'nonfinite header baseline') fonts[8].baseline = Number.POSITIVE_INFINITY
  if (variant === 'header reuses caption source')
    fonts[8].sourceItem.index = fonts[0].sourceItem.index
  if (variant === 'path crosses footer')
    p.graphicsBounds.push({
      kind: 'path',
      normalizedRect: [120 / 600, 244 / 800, 480 / 600, 400 / 800]
    })
  if (variant === 'nonfinite rule') rules.push([Number.NaN, 240, 540, 240])
  if (variant === 'truncated graphic bounds')
    p.graphicsBounds.push({ kind: 'path', normalizedRect: [60 / 600, 240 / 800, 540 / 600] })
  if (variant === 'reversed graphic bounds')
    p.graphicsBounds.push({
      kind: 'path',
      normalizedRect: [540 / 600, 240 / 800, 60 / 600, 245 / 800]
    })
  if (
    ['reversed extra font', 'zero extra font', 'inconsistent extra font height'].includes(variant)
  ) {
    const i = {
      ...structuredClone(fonts[4]),
      text: 'x',
      baseline: 350,
      rect: [200, 342, 205, 350],
      sourceItem: { pageNumber: 1, index: 100, text: 'x' }
    }
    if (variant === 'reversed extra font') i.rect[0] = 210
    if (variant === 'zero extra font') i.rect[0] = 205
    if (variant === 'inconsistent extra font height') i.height = 4
    fonts.push(i)
  }
  const captions = findCaptionCandidates([p]),
    ruled = findCaptionCandidates([p], new Map([[1, rules]]))
  if (variant === 'bad caption rectangle') {
    captions[0].rect[2] += 1
    ruled[0].rect[2] += 1
  }
  if (variant === 'nonfinite caption rectangle') {
    captions[0].rect[2] = Number.NaN
    ruled[0].rect[2] = Number.NaN
  }
  if (variant === 'duplicate caption') captions.push(structuredClone(captions[0]))
  applyRuledCaptionRecovery(captions, ruled, p, rules, fonts)
  expect(captions[0].lines).not.toEqual(
    romanVariableCaption()
      .p.lines.slice(0, 4)
      .map((l: NativeLine) => l.text)
  )
})

const mixedLabelCaption = (): ReturnType<typeof JSON.parse> => ({
  ...page([
    line('Table 2:', 70, 200, 35),
    line('Complete comparison of independent measured responses with', 108, 202, 400, 8),
    line('consistent source records from every separate calibration group', 70, 212, 440, 8),
    line('and the complete repeated observations.', 70, 222, 260, 8),
    line('A separate larger body paragraph starts below this closed caption.', 70, 260, 440, 12)
  ]),
  invalidGraphicsBounds: 0,
  graphicsBounds: [{ kind: 'path', normalizedRect: [90 / 600, 190 / 800, 490 / 600, 190.2 / 800] }]
})

const ledMixedCaption = (): ReturnType<typeof JSON.parse> => {
  const p = {
    ...page([
      line(
        'Figure 3: Complete measured responses under the separate calibration conditions',
        60,
        200,
        480
      ),
      line(
        'show consistent independent records for the complete comparison.',
        60,
        216.21,
        350,
        9.13
      ),
      line('The larger body paragraph is separated from the caption.', 60, 255, 480)
    ]),
    invalidGraphicsBounds: 0,
    graphicsBounds: [{ kind: 'image', normalizedRect: [60 / 600, 80 / 800, 540 / 600, 180 / 800] }]
  }
  const font = (
    text: string,
    x: number,
    baseline: number,
    width: number,
    height: number,
    index: number
  ): ReturnType<typeof JSON.parse> => ({
    text,
    rect: [x, baseline - height, x + width, baseline],
    baseline,
    height,
    horizontal: true,
    sourceItem: { pageNumber: 1, index, text }
  })
  return {
    p,
    fonts: [
      font('Figure 3:', 60, 210, 43, 10, 0),
      font(
        'Complete measured responses under the separate calibration conditions',
        107,
        210,
        433,
        9.13,
        1
      ),
      font(p.lines[1].text, 60, 225.34, 350, 9.13, 2),
      font(p.lines[2].text, 60, 265, 480, 10, 3)
    ]
  }
}

it('recovers a widely led smaller continuation only from its distinct same-baseline native label', () => {
  const { p, fonts } = ledMixedCaption(),
    captions = findCaptionCandidates([p]),
    before = structuredClone(p)
  expect(captions[0].lines).toHaveLength(1)
  applyRuledCaptionRecovery(captions, findCaptionCandidates([p]), p, [], fonts)
  expect(captions[0].lines).toEqual(p.lines.slice(0, 2).map((l: NativeLine) => l.text))
  expect(p).toEqual(before)
})

it('uses the existing opening table rule with the same complete mixed-size native paragraph', () => {
  const { p, fonts } = ledMixedCaption()
  p.lines[0].text = p.lines[0].text.replace('Figure 3:', 'Table 3:')
  fonts[0].text = fonts[0].sourceItem.text = 'Table 3:'
  p.graphicsBounds = [
    { kind: 'path', normalizedRect: [70 / 600, 234 / 800, 530 / 600, 234.2 / 800] }
  ]
  const rules = [[70, 234, 530, 234]],
    captions = findCaptionCandidates([p])
  applyRuledCaptionRecovery(
    captions,
    findCaptionCandidates([p], new Map([[1, rules]])),
    p,
    rules,
    fonts
  )
  expect(captions[0].lines).toEqual(p.lines.slice(0, 2).map((l: NativeLine) => l.text))
  const withoutRule = findCaptionCandidates([p])
  applyRuledCaptionRecovery(withoutRule, findCaptionCandidates([p]), p, [], fonts)
  expect(withoutRule[0].lines).toHaveLength(1)
})

it.each([undefined, null])('refuses an unknown original token orientation %s', (orientation) => {
  const { p, fonts } = ledMixedCaption(),
    captions = findCaptionCandidates([p])
  fonts.push({
    text: 'Measured axis',
    rect: [70, 100, 80, 160],
    baseline: 160,
    height: 10,
    horizontal: orientation,
    sourceItem: { pageNumber: 1, index: 4, text: 'Measured axis' }
  })
  applyRuledCaptionRecovery(captions, findCaptionCandidates([p]), p, [], fonts)
  expect(captions[0].lines).toHaveLength(1)
})

it.each([false, true])(
  'keeps original rotated native bounds and refuses caption overlap=%s',
  (overlap) => {
    const { p, fonts } = ledMixedCaption(),
      captions = findCaptionCandidates([p])
    fonts.push({
      text: 'Measured axis',
      rect: overlap ? [100, 216, 110, 225] : [70, 100, 80, 160],
      baseline: overlap ? 225 : 160,
      height: 10,
      horizontal: false,
      sourceItem: { pageNumber: 1, index: 4, text: 'Measured axis' }
    })
    const original = structuredClone(fonts)
    applyRuledCaptionRecovery(captions, findCaptionCandidates([p]), p, [], fonts)
    expect(captions[0].lines).toHaveLength(overlap ? 1 : 2)
    expect(fonts).toEqual(original)
  }
)

it.each([
  ['width', Number.NaN],
  ['height', Number.NaN],
  ['width', 0],
  ['height', 0],
  ['width', -600],
  ['height', -800],
  ['width', Number.POSITIVE_INFINITY],
  ['height', Number.POSITIVE_INFINITY]
])('refuses mixed table recovery with invalid page %s=%s', (dimension, value) => {
  const { p, fonts } = ledMixedCaption()
  p.lines[0].text = p.lines[0].text.replace('Figure 3:', 'Table 3:')
  fonts[0].text = fonts[0].sourceItem.text = 'Table 3:'
  p.graphicsBounds = []
  const rules = [[70, 234, 530, 234]],
    captions = findCaptionCandidates([p]),
    ruled = findCaptionCandidates([p], new Map([[1, rules]]))
  p[dimension] = value
  applyRuledCaptionRecovery(captions, ruled, p, rules, fonts)
  expect(captions[0].lines).toHaveLength(1)
})

it.each([
  'missing fonts',
  'label shares body size',
  'wrong literal',
  'shifted baseline',
  'foreign caption',
  'foreign font',
  'invalid font',
  'duplicate source',
  'no graphic',
  'caption paint',
  'truncated graphic',
  'reversed graphic',
  'reversed font',
  'duplicate label'
])('refuses a led mixed caption with %s', (variant) => {
  const { p, fonts } = ledMixedCaption()
  if (variant === 'missing fonts') fonts.length = 0
  if (variant === 'label shares body size') {
    fonts[0].height = 9.13
    fonts[0].rect[1] = fonts[0].baseline - 9.13
  }
  if (variant === 'wrong literal')
    fonts[1].text = fonts[1].sourceItem.text = 'Different native spelling'
  if (variant === 'shifted baseline') {
    fonts[1].baseline += 2
    fonts[1].rect[1] += 2
    fonts[1].rect[3] += 2
  }
  if (variant === 'foreign caption')
    p.lines[1].text =
      fonts[2].text =
      fonts[2].sourceItem.text =
        'Figure 4: Independently measured responses.'
  if (variant === 'foreign font')
    fonts.push({
      ...structuredClone(fonts[2]),
      sourceItem: { pageNumber: 1, index: 5, text: 'extra' },
      text: 'extra',
      rect: [420, 230, 450, 239],
      baseline: 239
    })
  if (variant === 'invalid font') fonts[3].rect[2] = Number.NaN
  if (variant === 'duplicate source') fonts[2].sourceItem.index = fonts[0].sourceItem.index
  if (variant === 'no graphic') p.graphicsBounds = []
  if (variant === 'caption paint')
    p.graphicsBounds.push({
      kind: 'path',
      normalizedRect: [70 / 600, 214 / 800, 530 / 600, 214.2 / 800]
    })
  if (variant === 'truncated graphic') p.graphicsBounds[0].normalizedRect.pop()
  if (variant === 'reversed graphic') p.graphicsBounds[0].normalizedRect.reverse()
  if (variant === 'reversed font') fonts[2].rect[2] = fonts[2].rect[0] - 1
  if (variant === 'duplicate label')
    fonts.push({ ...structuredClone(fonts[0]), sourceItem: { ...fonts[0].sourceItem, index: 5 } })
  const captions = findCaptionCandidates([p])
  applyRuledCaptionRecovery(captions, findCaptionCandidates([p]), p, [], fonts)
  expect(captions[0].lines).toHaveLength(1)
})

it('owns a closed smaller-body caption only with its separate larger native label', () => {
  const p = mixedLabelCaption(),
    before = structuredClone(p)
  expect(findCaptionCandidates([p])[0].lines).toEqual([
    p.lines[0].text + ' ' + p.lines[1].text,
    p.lines[2].text,
    p.lines[3].text
  ])
  expect(p).toEqual(before)
  for (const mutate of [
    (p: ReturnType<typeof JSON.parse>): void => {
      p.graphicsBounds = []
    },
    (p: ReturnType<typeof JSON.parse>): void => {
      p.lines[2].fontSize = p.lines[2].height = 6
    },
    (p: ReturnType<typeof JSON.parse>): void => {
      p.lines[2].x = 160
    },
    (p: ReturnType<typeof JSON.parse>): void => {
      p.lines[3].text = 'and an open caption continuation'
    },
    (p: ReturnType<typeof JSON.parse>): void => {
      p.lines.push(line('Foreign prose carrier', 200, 224, 100, 8))
    }
  ]) {
    const refusal = mixedLabelCaption()
    mutate(refusal)
    expect(findCaptionCandidates([refusal])[0].lines).not.toHaveLength(3)
  }
})

it('restores a closed colon caption behind independent native plots without relaxing prose classification', () => {
  const p = {
    ...page([
      line(
        'Figure 3: For the independent system, the response is stable across all groups',
        100,
        280,
        400
      ),
      line('while the complete repeated observations remain within the measured', 100, 292, 400),
      line('boundary for every independent calibration.', 100, 304, 260)
    ]),
    invalidGraphicsBounds: 0,
    graphicsBounds: [100, 235, 370].map((x) => ({
      kind: 'path',
      normalizedRect: [x / 600, 180 / 800, (x + 125) / 600, 268 / 800]
    }))
  }
  expect(findCaptionCandidates([p])[0].lines).toEqual(p.lines.map((l) => l.text))
  const candidate = findCaptionCandidates([p])[0]
  expect(associateFigures(p, [candidate])).toHaveLength(1)
  expect(associateFigures(p, [candidate])[0].caption).toBe(candidate)
  const badRect = structuredClone(candidate)
  badRect.rect[0] += 1
  expect(associateFigures(p, [badRect])).toHaveLength(0)
  const badLines = structuredClone(candidate)
  badLines.lines[1] += ' extra'
  expect(associateFigures(p, [badLines])).toHaveLength(0)
  for (const mutate of [
    (p: ReturnType<typeof JSON.parse>): void => {
      p.graphicsBounds = []
    },
    (p: ReturnType<typeof JSON.parse>): void => {
      p.lines[2].text = 'boundary for every open calibration'
    },
    (p: ReturnType<typeof JSON.parse>): void => {
      p.lines.push(line('A competing body row.', 100, 272, 300))
    }
  ]) {
    const refusal = structuredClone(p)
    mutate(refusal)
    expect(findCaptionCandidates([refusal])).toHaveLength(0)
    expect(associateFigures(refusal, [candidate])).toHaveLength(0)
  }
})

it('preserves a tall literal radical only through its unique two-sided prose junction', () => {
  const p = mixedLabelCaption()
  p.lines.splice(
    3,
    1,
    line('and the measured response has norm', 70, 222, 150, 8),
    line('√', 222, 215.5, 7, 8.3),
    line('n − 1, with independent results across every measured group', 229.2, 221.7, 280.8, 8.3),
    line('in the complete comparison.', 70, 234, 180, 8)
  )
  p.graphicsBounds.push({
    kind: 'path',
    normalizedRect: [228 / 600, 221 / 800, 250 / 600, 226 / 800]
  })
  const expected = p.lines[3].text + ' √ ' + p.lines[5].text
  expect(findCaptionCandidates([p])[0].lines).toContain(expected)
  for (const mutate of [
    (p: ReturnType<typeof JSON.parse>): void => {
      p.lines.push({ ...p.lines[4] })
    },
    (p: ReturnType<typeof JSON.parse>): void => {
      p.lines[4].x = 215
    },
    (p: ReturnType<typeof JSON.parse>): void => {
      p.lines[5].y -= 4
    },
    (p: ReturnType<typeof JSON.parse>): void => {
      p.graphicsBounds.push({ ...p.graphicsBounds[1] })
    },
    (p: ReturnType<typeof JSON.parse>): void => {
      p.graphicsBounds[1].normalizedRect[2] = 320 / 600
    },
    (p: ReturnType<typeof JSON.parse>): void => {
      p.graphicsBounds[1].kind = 'image'
    }
  ]) {
    const q = structuredClone(p)
    mutate(q)
    expect(findCaptionCandidates([q])[0].lines).not.toContain(expected)
  }
})

const indentedRasterCaption = (): ReturnType<typeof JSON.parse> => ({
  ...page([
    line('Figure 4. Measured area', 100, 250, 100),
    line('2', 200, 250, 5, 6.5),
    line('from the complete independent instrument and', 207, 250, 293),
    line('its separate calibrated response boundary.', 81.8, 263.2, 280),
    line('3. Independent source analysis', 100, 290, 300, 12),
    line('The following body has its own independent larger type.', 100, 322, 400, 12)
  ]),
  graphicsBounds: [
    {
      kind: 'image',
      operationIndex: 3,
      imageHash: 'a'.repeat(64),
      normalizedRect: [130 / 600, 100 / 800, 480 / 600, 238 / 800]
    }
  ]
})

it('owns a complete indented two-line caption below a unique native raster and above a section', () => {
  const p = indentedRasterCaption()
  const before = structuredClone(p)
  const captions = findCaptionCandidates([p])
  expect(captions).toHaveLength(1)
  expect(captions[0].lines).toEqual([
    'Figure 4. Measured area² from the complete independent instrument and',
    p.lines[3].text
  ])
  expect(captions[0].rect).toEqual([81.8, 250, 500, 273.2])
  expect(p).toEqual(before)
})

it('requires complete native fonts, a unique visible raster and a separate section boundary', () => {
  for (const mutate of [
    (p: ReturnType<typeof JSON.parse>): void => {
      p.graphicsBounds = []
    },
    (p: ReturnType<typeof JSON.parse>): void => {
      p.graphicsBounds.push(structuredClone(p.graphicsBounds[0]))
    },
    (p: ReturnType<typeof JSON.parse>): void => {
      p.graphicsBounds[0].imageHash = 'unbound'
    },
    (p: ReturnType<typeof JSON.parse>): void => {
      p.graphicsBounds[0].normalizedRect[3] = 270 / 800
    },
    (p: ReturnType<typeof JSON.parse>): void => {
      p.lines.splice(4)
    },
    (p: ReturnType<typeof JSON.parse>): void => {
      p.lines[4].fontSize = p.lines[4].height = 10
    },
    (p: ReturnType<typeof JSON.parse>): void => {
      p.lines[3].text = 'A separate open source continuation'
    },
    (p: ReturnType<typeof JSON.parse>): void => {
      p.lines.push(line('Foreign source font', 400, 259, 50))
    },
    (p: ReturnType<typeof JSON.parse>): void => {
      p.lines.push(structuredClone(p.lines[0]))
    },
    (p: ReturnType<typeof JSON.parse>): void => {
      p.lines[3].x = 330
    }
  ]) {
    const p = indentedRasterCaption()
    mutate(p)
    expect(findCaptionCandidates([p])[0].lines).not.toContain(p.lines[3].text)
  }
  const p = indentedRasterCaption()
  expect(findCaptionCandidates([p], new Map([[1, [[80, 260, 510, 260]]]]))[0].lines).not.toContain(
    p.lines[3].text
  )
  const malformed = indentedRasterCaption()
  malformed.lines[3].width = Number.NaN
  expect(() => findCaptionCandidates([malformed])).toThrow()
})

it('owns every full intermediate row of the same indented raster paragraph', () => {
  const p = indentedRasterCaption()
  p.lines.splice(
    3,
    0,
    line('The independently measured intermediate row continues with', 81.8, 263.2, 418)
  )
  p.lines[4].y = 276.4
  p.lines[5].y = 303.2
  expect(findCaptionCandidates([p])[0].lines.slice(1)).toEqual(
    p.lines.slice(3, 5).map((l) => l.text)
  )
  p.lines[3].width = 150
  expect(findCaptionCandidates([p])[0].lines).not.toContain(p.lines[4].text)
})

const centeredLargerTail = (): ReturnType<typeof JSON.parse> => ({
  ...page([
    line(
      'Fig. 2. The complete independent drawing shows the measured comparison and',
      50,
      250,
      500,
      8
    ),
    line(
      'the independently bounded source observations continue across the full drawing',
      50,
      259,
      500,
      8
    ),
    line(
      'while each original caption row describes the complete controlled experiment',
      50,
      268,
      500,
      8
    ),
    line('and the final observation remains connected to the measured response', 50, 277, 400, 8),
    line('over the complete response interval.', 240, 283.56, 120, 10),
    line('A separate body starts in the independently aligned left column.', 50, 316.2, 245, 10),
    line('The right column contains its own independent source paragraph.', 305, 316.2, 245, 10)
  ]),
  graphicsBounds: [
    {
      kind: 'path',
      operationIndex: 1,
      normalizedRect: [50 / 600, 100 / 800, 295 / 600, 220 / 800]
    },
    {
      kind: 'path',
      operationIndex: 2,
      normalizedRect: [305 / 600, 100 / 800, 550 / 600, 220 / 800]
    },
    {
      kind: 'path',
      operationIndex: 3,
      normalizedRect: [200 / 600, 225 / 800, 400 / 600, 238 / 800]
    }
  ]
})

it('keeps a whole centered larger terminal caption row above independent two-column body', () => {
  const p = centeredLargerTail()
  const before = structuredClone(p)
  expect(findCaptionCandidates([p])[0].lines).toEqual(p.lines.slice(0, 5).map((l) => l.text))
  expect(findCaptionCandidates([p])[0].rect).toEqual([50, 250, 550, 293.56])
  expect(p).toEqual(before)
})

it('refuses an unbound centered larger caption tail or missing independent source boundary', () => {
  for (const mutate of [
    (p: ReturnType<typeof JSON.parse>): void => {
      p.lines[3].text += '.'
    },
    (p: ReturnType<typeof JSON.parse>): void => {
      p.lines[4].x = 260
    },
    (p: ReturnType<typeof JSON.parse>): void => {
      p.lines[4].y = 300
    },
    (p: ReturnType<typeof JSON.parse>): void => {
      p.lines[4].fontSize = p.lines[4].height = 12
    },
    (p: ReturnType<typeof JSON.parse>): void => {
      p.lines.splice(6)
    },
    (p: ReturnType<typeof JSON.parse>): void => {
      p.lines[6].x = 200
    },
    (p: ReturnType<typeof JSON.parse>): void => {
      p.lines.push(structuredClone(p.lines[4]))
    },
    (p: ReturnType<typeof JSON.parse>): void => {
      p.lines.push(line('Foreign source', 390, 285, 80, 8))
    },
    (p: ReturnType<typeof JSON.parse>): void => {
      p.graphicsBounds = []
    },
    (p: ReturnType<typeof JSON.parse>): void => {
      p.graphicsBounds[0].operationIndex = -1
    },
    (p: ReturnType<typeof JSON.parse>): void => {
      p.graphicsBounds[2].normalizedRect[3] = 290 / 800
    }
  ]) {
    const p = centeredLargerTail()
    mutate(p)
    expect(findCaptionCandidates([p])[0].lines).not.toContain(p.lines[4].text)
  }
  const p = centeredLargerTail()
  expect(findCaptionCandidates([p], new Map([[1, [[50, 280, 550, 280]]]]))[0].lines).not.toContain(
    p.lines[4].text
  )
})

it('keeps the hanging terminal line below the measured table closing rule', () => {
  const p = page([
    line('Table 2: Measured results and their independently observed comparisons', 50, 250, 450),
    line('are described by the controlled experiment.', 90, 264, 250),
    line('The next body paragraph has its own measured paragraph gap.', 65, 304, 430)
  ])
  const result = findCaptionCandidates([p], new Map([[1, [[50, 238, 500, 238]]]]))
  expect(result[0].lines).toEqual(p.lines.slice(0, 2).map((l) => l.text))
})

it('keeps a slightly outdented short caption definition above the table opening', () => {
  const p = page([
    line('Table 3: Recorded measurements from the independent validation.', 50, 250, 450),
    line('“Offset” is the measured residual; see §4.', 47.5, 264, 240),
    line('Group count response', 90, 290, 240, 9)
  ])
  expect(findCaptionCandidates([p], new Map([[1, [[45, 282, 510, 282]]]]))[0].lines).toEqual(
    p.lines.slice(0, 2).map((l) => l.text)
  )
})

it('keeps a terminal bare table reference inside its proven figure paragraph', () => {
  const p = page([
    line('Figure 2: The complete plotted result complements the analysis in', 50, 250, 430),
    line('Table 7', 50, 264, 35),
    line('A separate body paragraph starts below the caption.', 50, 294, 400, 12)
  ])
  const result = findCaptionCandidates([p])
  expect(result).toHaveLength(1)
  expect(result[0].lines).toEqual(p.lines.slice(0, 2).map((l) => l.text))
})

it('retains same-baseline prose across an owned formula and literal negative exponent', () => {
  const p = readPdfFixture(resolve('test/fixtures/native-caption-negative-exponent.jsonl')).page
  const result = findCaptionCandidates([p])[0]
  expect(result.lines[1]).toBe('A density of 8 units⁻² belongs to the measured contour.')
})

it('does not bridge a column gutter, absorb a separate caption or a body paragraph', () => {
  const p = page([
    line('Table 2: Complete caption.', 50, 250, 230),
    line('Foreign prose in the other column.', 350, 264, 200),
    line('Table 3: A separate caption.', 50, 284, 230),
    line('A separate body paragraph.', 65, 304, 230)
  ])
  const result = findCaptionCandidates([p], new Map([[1, [[50, 238, 280, 238]]]]))
  expect(result[0].lines).toEqual([p.lines[0].text])
})

it('retains both literal operands of a source-witnessed short fraction without synthesizing punctuation', () => {
  const p = page([
    line('Figure 5: Complete native probability comparison.', 50, 250, 420),
    line('The measured probability is', 50, 264, 120),
    line('k+1', 174, 262, 20, 7),
    line('2', 181, 270, 6, 7),
    line('in the complete source statement.', 198, 264, 230),
    line('The native terminal sentence.', 50, 278, 300)
  ])
  const c = findCaptionCandidates([p], new Map([[1, [[174, 271, 194, 271]]]]))[0]
  expect(c.lines[1]).toBe('The measured probability is k+1 2 in the complete source statement.')
  expect(c.lines.join(' ')).not.toContain('/')
})

it('recovers only a unique figure with the same formal ordinal and source position', () => {
  const original = { page: 1, lines: ['Figure A.2: Probability P ≈ 1.'], rect: [50, 250, 480, 278] }
  const recovered = {
    ...original,
    lines: ['Figure A.2: Probability P ≈ 1 2.'],
    rect: [50, 250, 480, 282]
  }
  const p = page([])
  for (const wrong of [
    { ...recovered, lines: ['Figure A.3: Probability P ≈ 1 2.'] },
    { ...recovered, rect: [50, 280, 480, 310] },
    { ...recovered, rect: [350, 250, 580, 282] },
    { ...recovered, page: 2 }
  ]) {
    const c = structuredClone(original)
    applyRuledCaptionRecovery([c], [wrong], p, [])
    expect(c).toEqual(original)
  }
  const ambiguous = structuredClone(original)
  applyRuledCaptionRecovery([ambiguous], [recovered, structuredClone(recovered)], p, [])
  expect(ambiguous).toEqual(original)
  const c = structuredClone(original)
  applyRuledCaptionRecovery([c], [recovered], p, [])
  expect(c).toEqual(recovered)
})

it('does not move a distant source fraction into the closest caption row', () => {
  const p = page([
    line('1', 120, 80, 6, 7),
    line('2', 120, 88, 6, 7),
    line('Figure 8: A complete measured native comparison.', 50, 250, 420),
    line('The measured density is', 50, 264, 120),
    line('units', 174, 264, 22),
    line('−2', 196, 262, 8, 7),
    line('in the independent measurement.', 208, 264, 225),
    line('The complete terminal description.', 50, 278, 420)
  ])
  const result = findCaptionCandidates([p], new Map([[1, [[120, 89, 126, 89]]]]))[0]
  expect(result.lines).toEqual(findCaptionCandidates([p])[0].lines)
  expect(result.lines.join(' ')).not.toContain('1 2')
})

it('keeps an opening stroke above an overhanging header font out of the completed caption', () => {
  const p = page([
    line('TABLE III. Independently measured comparison values', 50, 60, 250, 9),
    line('for the complete controlled observations.', 50, 72, 200, 9),
    line('Record Left Right', 50, 83.5, 250, 9),
    line('Item amber 1.25 2.50', 50, 96, 250, 9)
  ])
  const result = findCaptionCandidates(
    [p],
    new Map([
      [
        1,
        [
          [50, 85, 300, 85],
          [50, 94, 300, 94],
          [50, 108, 300, 108]
        ]
      ]
    ])
  )
  expect(result[0].lines).toEqual(p.lines.slice(0, 2).map((l) => l.text))
  expect(result[0].rect[3]).toBe(81)
})

it('retains a whole continuation above the same opening stroke', () => {
  const p = page([
    line('TABLE III. Independently measured comparison values', 50, 60, 250, 9),
    line('for the complete controlled observations.', 50, 72, 200, 9)
  ])
  expect(findCaptionCandidates([p], new Map([[1, [[50, 85, 300, 85]]]]))[0].lines).toEqual(
    p.lines.map((l) => l.text)
  )
})

const ruledLongCaption = (): ReturnType<typeof page> =>
  page([
    line('Table 6: Complete native measurements are independently compared', 50, 60, 300),
    line('within the observed source configuration and its controlled baseline', 50, 75, 300),
    line('under the same native conditions and the separately measured values', 50, 90, 300),
    line('before this complete description terminates.', 50, 105, 220),
    line('Category Left Right', 50, 127, 300),
    line('Item cyan 1.25 2.50', 50, 147, 300)
  ])

it('retains the short flush ending of a long caption above three matching native table fences', () => {
  const p = ruledLongCaption(),
    rules = [
      [50, 125, 350, 125],
      [50, 145, 350, 145],
      [50, 205, 350, 205]
    ]
  expect(findCaptionCandidates([p], new Map([[1, rules]]))[0].lines).toEqual(
    p.lines.slice(0, 4).map((l) => l.text)
  )
})

it.each(['different font', 'different column', 'intervening caption'])(
  'does not complete a long flush caption through %s',
  (variant) => {
    const p = ruledLongCaption(),
      rules = [
        [50, 125, 350, 125],
        [50, 145, 350, 145],
        [50, 205, 350, 205]
      ]
    if (variant === 'different font') p.lines[3].fontSize = 14
    if (variant === 'different column') p.lines[3].x += 25
    if (variant === 'intervening caption') p.lines[3].text = 'Table 7: Independent observations.'
    expect(findCaptionCandidates([p], new Map([[1, rules]]))[0].lines).not.toEqual(
      p.lines.slice(0, 4).map((l) => l.text)
    )
  }
)

const captionedDiagramPointer = (): ReturnType<typeof JSON.parse> => ({
  ...page([
    line('Figure 3: A complete independent source diagram', 130, 300, 250, 10),
    line('Figure 3. The observed distribution is assumed to be', 60, 335, 420, 12),
    line('of the following form', 60, 349.4, 140, 12)
  ]),
  invalidGraphicsBounds: 0,
  graphicsBounds: [{ kind: 'path', normalizedRect: [0.1, 0.15, 0.8, 0.36] }]
})

it('does not emit a second plate for a source body assumption referencing its earlier caption', () => {
  const p = captionedDiagramPointer()
  expect(findCaptionCandidates([p])).toHaveLength(1)
  expect(findCaptionCandidates([p])[0].lines).toEqual([p.lines[0].text])
})

it.each(['new carrier', 'no prior caption', 'uncertain graphics'])(
  'retains the descriptive candidate without a unique %s exclusion proof',
  (variant) => {
    const p = captionedDiagramPointer()
    if (variant === 'new carrier')
      p.graphicsBounds.push({ kind: 'path', normalizedRect: [0.1, 0.4, 0.8, 0.43] })
    if (variant === 'no prior caption') p.lines.shift()
    if (variant === 'uncertain graphics') p.invalidGraphicsBounds = 1
    expect(
      findCaptionCandidates([p]).some((c: { lines: string[] }) =>
        c.lines[0].startsWith('Figure 3. The')
      )
    ).toBe(true)
  }
)

it.each([
  'complete',
  'missing font',
  'missing fence',
  'foreign font',
  'detached column',
  'different title'
])('contracts a polluted table title only with whole ruled header proof: %s', (variant) => {
  const original = {
    page: 1,
    lines: ['Table 6: Complete observation inventory.', 'Field Value'],
    rect: [50, 60, 250, 93]
  }
  const recovered = { page: 1, lines: [original.lines[0]], rect: [51, 60, 250, 70] }
  const token = (
    text: string,
    x: number,
    y: number,
    w: number,
    index: number
  ): ReturnType<typeof JSON.parse> => ({
    text,
    rect: [x, y, x + w, y + 10],
    height: 10,
    baseline: y + 10,
    horizontal: true,
    sourceItem: { pageNumber: 1, index, text }
  })
  const fonts = [
    token(original.lines[0], 51, 60, 199, 0),
    token('Field', 50, 83, 45, 1),
    token('Value', 200, 83, 45, 2)
  ]
  const rules = [
    [50, 74, 250, 74],
    [50, 98, 250, 98],
    [50, 140, 250, 140]
  ]
  if (variant === 'missing font') fonts.pop()
  if (variant === 'missing fence') rules.pop()
  if (variant === 'foreign font') fonts[1].sourceItem.pageNumber = 2
  if (variant === 'detached column') recovered.rect[0] = 100
  if (variant === 'different title') recovered.lines[0] = 'Table 7: Another inventory.'
  const candidate = structuredClone(original)
  applyRuledCaptionRecovery([candidate], [recovered], page([]), rules, fonts)
  expect(candidate).toEqual(variant === 'complete' ? recovered : original)
})

const centeredSourceCaption = (
  kind: 'figure' | 'table' | 'opening' | 'page-end' | 'reference'
): ReturnType<typeof JSON.parse> => {
  const isTable = kind === 'table' || kind === 'opening'
  const top = kind === 'opening' ? 150 : 250
  const head =
    kind === 'reference'
      ? line('Figure 2 Evaluation of complete independent observations', 60, top, 480, 9)
      : line(
          `${isTable ? 'TABLE II:' : 'FIG. 2:'} Complete independent measured observations`,
          60,
          top,
          480
        )
  const captionRows =
    kind === 'reference'
      ? [
          head,
          line('The complete measurement details are provided in', 60, top + 11, 480, 9),
          line(
            'Supplementary Table 2. Error bars describe independent observations',
            60,
            top + 22,
            480,
            9
          ),
          line('The complete final measurements.', 60, top + 33, 190, 9)
        ]
      : [
          head,
          line(
            kind === 'page-end' ? '(b) MEASURED' : 'MEASURED complete independent observations.',
            220,
            top + 12,
            160
          )
        ]
  const p = {
    ...page([
      ...(isTable && kind !== 'opening'
        ? [line('LEFT RIGHT VALUE', 170, 200, 260, 8), line('2 3 4', 170, 215, 260, 8)]
        : []),
      ...captionRows,
      ...(kind === 'opening'
        ? [line('LEFT RIGHT VALUE', 170, 205, 260, 8), line('2 3 4', 170, 220, 260, 8)]
        : []),
      ...(kind !== 'page-end'
        ? [
            line(
              'A separate complete body paragraph begins here.',
              60,
              top + (kind === 'reference' ? 60 : 70),
              480
            )
          ]
        : [])
    ]),
    invalidGraphicsBounds: 0,
    graphicsBounds: isTable
      ? [
          {
            kind: 'path',
            normalizedRect: [
              150 / 600,
              (kind === 'opening' ? 190 : 180) / 800,
              450 / 600,
              (kind === 'opening' ? 240 : 235) / 800
            ]
          }
        ]
      : [
          { kind: 'path', normalizedRect: [60 / 600, 70 / 800, 215 / 600, 235 / 800] },
          { kind: 'path', normalizedRect: [222 / 600, 70 / 800, 377 / 600, 235 / 800] },
          { kind: 'path', normalizedRect: [385 / 600, 70 / 800, 540 / 600, 235 / 800] }
        ]
  }
  const rules = isTable
    ? [
        [150, kind === 'opening' ? 190 : 180, 450, kind === 'opening' ? 190 : 180],
        [150, kind === 'opening' ? 240 : 235, 450, kind === 'opening' ? 240 : 235]
      ]
    : []
  const fonts = p.lines.map((l: NativeLine, index: number) => ({
    text: l.text,
    rect: [l.x, l.y, l.x + l.width, l.y + l.height],
    baseline: l.y + l.height,
    height: l.height,
    horizontal: true,
    sourceItem: { pageNumber: 1, index, text: l.text }
  }))
  return { p, fonts, rules, captionRows }
}

const recoverCenteredSource = (
  packet: ReturnType<typeof JSON.parse>
): ReturnType<typeof JSON.parse> => {
  const { p, fonts, rules } = packet
  const captions = findCaptionCandidates([p]),
    ruled = findCaptionCandidates([p], new Map([[1, rules]]))
  applyRuledCaptionRecovery(captions, ruled, p, rules, fonts)
  return captions
}

it.each(['figure', 'table', 'opening', 'page-end'] as const)(
  'recovers only a complete centered native %s block beside its independent owner',
  (kind) => {
    const packet = centeredSourceCaption(kind),
      original = structuredClone(packet)
    expect(recoverCenteredSource(packet)[0].lines).toEqual(
      packet.captionRows.map((l: NativeLine) => l.text)
    )
    expect(packet).toEqual(original)
  }
)

it('keeps a same-cadence interior supplementary-table pointer with its complete Figure owner', () => {
  const packet = centeredSourceCaption('reference'),
    original = structuredClone(packet)
  expect(recoverCenteredSource(packet)[0].lines).toEqual(
    packet.captionRows.map((l: NativeLine) => l.text)
  )
  expect(packet).toEqual(original)
})

it.each([
  'shifted-center',
  'broken-cadence',
  'missing-native',
  'duplicate-source',
  'unknown-orientation',
  'invalid-font-rect',
  'unknown-graphic',
  'foreign-horizontal',
  'foreign-rotated',
  'interposed-rule',
  'missing-owner',
  'unknown-ink',
  'raised-head-mark',
  'upper-short-token',
  'lower-short-token'
])('refuses centered recovery when complete native proof is broken by %s', (control) => {
  const packet = centeredSourceCaption('figure'),
    { p, fonts, rules } = packet
  if (control === 'shifted-center') p.lines[1].x += 10
  if (control === 'broken-cadence') p.lines[1].y += 4
  if (control === 'missing-native') fonts.splice(1, 1)
  if (control === 'duplicate-source') fonts[1].sourceItem.index = fonts[0].sourceItem.index
  if (control === 'unknown-orientation') delete fonts[1].horizontal
  if (control === 'invalid-font-rect') fonts[1].rect[2] = NaN
  if (control === 'unknown-graphic')
    p.graphicsBounds.push({ kind: 'path', normalizedRect: [0.1, 0.3, 0.9] })
  if (control === 'missing-owner') p.graphicsBounds = []
  if (control === 'unknown-ink') p.invalidGraphicsBounds = 1
  if (control === 'interposed-rule') rules.push([60, 261, 540, 261])
  if (control === 'upper-short-token' || control === 'lower-short-token') {
    const y = control === 'upper-short-token' ? 240 : 287,
      text = 'Foreign gap token'
    fonts.push({
      text,
      rect: [250, y, 300, y + 4],
      baseline: y + 4,
      height: 4,
      horizontal: true,
      sourceItem: { pageNumber: 1, index: 50, text }
    })
  }
  if (
    control === 'raised-head-mark' ||
    control === 'foreign-horizontal' ||
    control === 'foreign-rotated'
  ) {
    const text = control === 'raised-head-mark' ? 'ˆ' : 'Foreign observation'
    fonts.push({
      text,
      rect: control === 'raised-head-mark' ? [200, 247, 207, 254] : [250, 259, 300, 263],
      baseline: control === 'raised-head-mark' ? 254 : 263,
      height: control === 'raised-head-mark' ? 7 : 4,
      horizontal: control !== 'foreign-rotated',
      sourceItem: { pageNumber: 1, index: 50, text }
    })
  }
  expect(recoverCenteredSource(packet)[0].lines).toHaveLength(1)
})

it.each([
  'separate-table-rule',
  'changed-pointer-font',
  'broken-pointer-cadence',
  'closed-predecessor'
])('retains the interior pointer boundary when it is independent through %s', (control) => {
  const packet = centeredSourceCaption('reference')
  if (control === 'separate-table-rule') packet.rules.push([60, 271, 540, 271])
  if (control === 'changed-pointer-font') packet.p.lines[2].fontSize = 10
  if (control === 'broken-pointer-cadence') packet.p.lines[2].y += 4
  if (control === 'closed-predecessor') {
    packet.p.lines[1].text = 'The complete measurement details end here.'
    packet.fonts[1].text = packet.p.lines[1].text
    packet.fonts[1].sourceItem.text = packet.p.lines[1].text
  }
  expect(recoverCenteredSource(packet)[0].lines.length).toBeLessThan(4)
})

it('refuses an unowned path in the complete table-footer caption corridor', () => {
  const packet = centeredSourceCaption('table')
  packet.p.graphicsBounds.push({
    kind: 'path',
    normalizedRect: [148 / 600, 233 / 800, 452 / 600, 245 / 800]
  })
  expect(recoverCenteredSource(packet)[0].lines).toHaveLength(1)
})

const centeredLiteralTail = (): ReturnType<typeof JSON.parse> => {
  const captionRows = [
    line('TABLE VI: Complete score D² describes measured observations', 60, 250, 480),
    line('Controlled parameters follow the complete measured configuration.', 100, 262, 400),
    line('Default values remain unchanged.', 180, 274, 240)
  ]
  const marks = [line('ˆ', 200, 247.5, 5), line('\\', 280, 247.2, 23), line('\\', 390, 247.2, 23)]
  const p = {
    ...page([
      line('LEFT RIGHT', 170, 200, 260, 8),
      line('2 3', 170, 215, 260, 8),
      ...marks,
      ...captionRows,
      line('A separate body paragraph begins below the caption.', 60, 310, 480)
    ]),
    invalidGraphicsBounds: 0,
    graphicsBounds: [{ kind: 'path', normalizedRect: [150 / 600, 180 / 800, 450 / 600, 235 / 800] }]
  }
  const sourceRows = [
    p.lines[0],
    p.lines[1],
    captionRows[0],
    ...marks,
    ...captionRows.slice(1),
    p.lines.at(-1)
  ]
  const fonts = sourceRows.map((l: NativeLine, index: number) => {
    const text = l === captionRows[0] ? l.text.replace('²', '2') : l.text
    return {
      text,
      rect: [l.x, l.y, l.x + l.width, l.y + l.height],
      baseline: l.y + l.height,
      height: l.height,
      horizontal: true,
      sourceItem: { pageNumber: 1, index, text }
    }
  })
  const rules = [
    [150, 180, 450, 180],
    [150, 235, 450, 235],
    [150, 180, 150, 235],
    [450, 180, 450, 235]
  ]
  return { p, fonts, rules, captionRows }
}

const recoverLiteralTail = (
  packet: ReturnType<typeof JSON.parse>
): ReturnType<typeof JSON.parse> => {
  const head = packet.captionRows[0]
  const captions = [
    {
      page: 1,
      lines: [head.text],
      rect: [head.x, head.y, head.x + head.width, head.y + head.height]
    }
  ]
  applyRuledCaptionRecovery(
    captions,
    structuredClone(captions),
    packet.p,
    packet.rules,
    packet.fonts
  )
  return captions
}

it('preserves a canonical mathematical head while recovering only its two centered native tails', () => {
  const packet = centeredLiteralTail(),
    original = structuredClone(packet)
  const captions = recoverLiteralTail(packet)
  expect(captions[0].lines).toEqual(packet.captionRows.map((l: NativeLine) => l.text))
  expect(captions[0].lines[0]).toBe(original.captionRows[0].text)
  expect(captions[0].rect).toEqual([60, 250, 540, 284])
  expect(packet).toEqual(original)
})

it.each([
  'missing-mark',
  'duplicate-source',
  'foreign-mark',
  'unbound-mark',
  'shifted-tail',
  'broken-cadence',
  'unclosed-tail',
  'interposed-rule',
  'missing-frame-side',
  'broken-frame-side',
  'competing-frame-side',
  'upper-token',
  'lower-token',
  'foreign-header',
  'unknown-graphic',
  'unknown-ink',
  'second-caption',
  'invalid-native'
])('refuses the narrow literal-tail branch with %s', (control) => {
  const packet = centeredLiteralTail(),
    { p, fonts, rules } = packet
  if (control === 'missing-mark') fonts.splice(3, 1)
  if (control === 'duplicate-source') fonts[4].sourceItem.index = fonts[3].sourceItem.index
  if (control === 'foreign-mark') {
    fonts[3].text = 'x'
    fonts[3].sourceItem.text = 'x'
  }
  if (control === 'unbound-mark') p.lines.splice(2, 1)
  if (control === 'shifted-tail') packet.captionRows[1].x += 1
  if (control === 'broken-cadence') packet.captionRows[1].y += 1
  if (control === 'unclosed-tail') {
    packet.captionRows[2].text = packet.captionRows[2].text.slice(0, -1)
    fonts[7].text = packet.captionRows[2].text
    fonts[7].sourceItem.text = fonts[7].text
  }
  if (control === 'interposed-rule') rules.push([60, 261, 540, 261])
  if (control === 'missing-frame-side') rules.splice(2, 1)
  if (control === 'broken-frame-side') rules[2][1] += 1
  if (control === 'competing-frame-side') rules.push([150.3, 180, 150.3, 235])
  if (control === 'unknown-graphic')
    p.graphicsBounds.push({ kind: 'path', normalizedRect: [0.1, 0.3, 0.9] })
  if (control === 'unknown-ink') p.invalidGraphicsBounds = 1
  if (control === 'second-caption')
    packet.captionRows[1].text = 'TABLE V: A competing independent caption.'
  if (control === 'invalid-native') fonts[4].rect[2] = NaN
  if (control === 'upper-token' || control === 'lower-token' || control === 'foreign-header') {
    const text = 'Foreign native source',
      y = control === 'upper-token' ? 240 : control === 'lower-token' ? 296 : 256
    fonts.push({
      text,
      rect: [200, y, 250, y + 4],
      height: 4,
      baseline: y + 4,
      horizontal: true,
      sourceItem: { pageNumber: 1, index: 99, text }
    })
  }
  expect(recoverLiteralTail(packet)[0].lines).toHaveLength(1)
})

function wideCadenceCenteredSource(): ReturnType<typeof centeredSourceCaption> {
  const packet = centeredSourceCaption('figure')
  packet.captionRows = [
    line('FIG. 2: Complete independent sample observations.', 60, 250, 480),
    line('Measured samples remain independently available in this panel', 75, 267.5, 450),
    line('The repeated observations describe the full measured response', 90, 285, 420),
    line('Final sample values.', 220, 302.5, 160)
  ]
  packet.p.lines = [
    ...packet.captionRows,
    line('Independent body paragraph begins below this complete caption.', 60, 350, 480)
  ]
  packet.fonts = packet.p.lines.map((l: NativeLine, index: number) => ({
    text: l.text,
    rect: [l.x, l.y, l.x + l.width, l.y + l.height],
    baseline: l.y + l.height,
    height: l.height,
    horizontal: true,
    sourceItem: { pageNumber: 1, index, text: l.text }
  }))
  return packet
}

it('recovers a centered complete native caption from its repeated wider measured cadence', () => {
  const packet = wideCadenceCenteredSource()
  expect(recoverCenteredSource(packet)[0].lines).toEqual(
    packet.captionRows.map((l: NativeLine) => l.text)
  )
})

it.each([
  'center',
  'cadence',
  'missing-font',
  'alias',
  'foreign-font',
  'rule',
  'unknown-ink',
  'missing-graphic',
  'unclosed-tail'
])('refuses wider centered recovery without complete %s proof', (control) => {
  const packet = wideCadenceCenteredSource()
  if (control === 'center') packet.p.lines[1].x += 3
  if (control === 'cadence') packet.p.lines[2].y += 3
  if (control === 'missing-font') packet.fonts.splice(1, 1)
  if (control === 'alias') packet.fonts[1].sourceItem.index = 0
  if (control === 'foreign-font')
    packet.fonts.push({
      ...packet.fonts[1],
      sourceItem: { ...packet.fonts[1].sourceItem, index: 99 }
    })
  if (control === 'rule') packet.rules.push([300, 260, 300, 300])
  if (control === 'unknown-ink') packet.p.invalidGraphicsBounds = 1
  if (control === 'missing-graphic') packet.p.graphicsBounds = []
  if (control === 'unclosed-tail') {
    packet.p.lines[3].text = 'An unfinished final sample'
    packet.fonts[3].text = packet.p.lines[3].text
    packet.fonts[3].sourceItem.text = packet.p.lines[3].text
  }
  expect(recoverCenteredSource(packet)[0].lines).toHaveLength(1)
})
