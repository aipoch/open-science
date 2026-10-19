import { resolve } from './paths'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { readPdfFixture } from './read-fixture'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
const { refineTable } = await import(
  pathToFileURL(resolve('resources/literature-pdf-table-refine.mjs')).href
)
const { recoverNativeStackedUncertainty, recoverNativeFusedStackedScalarOwners } = await import(
  pathToFileURL(resolve('resources/literature-pdf-native-stacked-uncertainty.mjs')).href
)
const { tableTextToken } = await import(
  pathToFileURL(resolve('resources/literature-pdf-orientation.mjs')).href
)
const { nativeWhitespaceGaps } = await import(
  pathToFileURL(resolve('resources/literature-pdf-symbol-text.mjs')).href
)
const { collectTableRules } = await import(
  pathToFileURL(resolve('resources/literature-pdf-graphics.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve('test/fixtures/source-grids/native-three-baseline-stacked-decimal-pair.jsonl')
  )
it('serializes each native stacked error in its own source baseline order', () => {
  const x = fixture(),
    r = refineTable(x.table, x.items, x.captions, [], x.rules),
    cell = r.cells.find((c: { text: string }) => c.text.includes('6.84'))
  expect(cell?.text).toBe('6.84+0.27−0.39')
  expect(cell?.textRuns).toEqual([
    { text: '6.84', position: 'normal' },
    { text: '+0.27', position: 'superscript' },
    { text: '−0.39', position: 'subscript' }
  ])
  expect(cell?.sourceRects).toHaveLength(x.items.length)
})
it('preserves every source fragment and character without mutating native input', () => {
  const x = fixture(),
    before = JSON.stringify(x.items),
    p = recoverNativeStackedUncertainty(x.items, x.rules)
  expect(p?.ownedTokens.size).toBe(x.items.length)
  expect(JSON.stringify(x.items)).toBe(before)
  const native = x.items.flatMap((i: { text: string }) => [...i.text]).sort(),
    emitted = p.runs.flatMap((r: { text: string }) => [...r.text]).sort()
  expect(emitted).toEqual(native)
})
it.each(['−', '-'])(
  'preserves a %s upper lane and positive lower lane in their printed order',
  (minus) => {
    const x = fixture()
    for (const item of x.items) {
      if (item.text === '+') item.text = minus
      else if (item.text === '−') item.text = '+'
    }
    const before = JSON.stringify(x.items)
    const expected = [
      { text: '6.84', position: 'normal' },
      { text: `${minus}0.27`, position: 'superscript' },
      { text: '+0.39', position: 'subscript' }
    ]
    const proof = recoverNativeStackedUncertainty(x.items, x.rules)
    expect(proof?.runs).toEqual(expected)
    expect(proof?.ownedTokens.size).toBe(x.items.length)
    expect(JSON.stringify(x.items)).toBe(before)
    const refined = refineTable(x.table, x.items, x.captions, [], x.rules)
    const cell = refined.cells.find((c: { text: string }) => c.text.includes('6.84'))
    expect(cell?.text).toBe(`6.84${minus}0.27+0.39`)
    expect(cell?.textRuns).toEqual(expected)
    expect(cell?.sourceRects).toHaveLength(x.items.length)
  }
)
it.each(['duplicate-sign', 'both-positive', 'both-negative', 'incomplete-lane', 'ordinary-prose'])(
  'does not infer reversed numeric script lanes for %s',
  (variant) => {
    const x = fixture()
    const upper = x.items.find((item: { text: string }) => item.text === '+')
    const lower = x.items.find((item: { text: string }) => item.text === '−')
    upper.text = '−'
    lower.text = '+'
    if (variant === 'duplicate-sign') upper.text = '−−'
    if (variant === 'both-positive') upper.text = '+'
    if (variant === 'both-negative') lower.text = '-'
    if (variant === 'incomplete-lane')
      x.items = x.items.filter(
        (item: { baseline: number }) => item === lower || item.baseline !== lower.baseline
      )
    if (variant === 'ordinary-prose') x.items[0].text = 'Mean'
    const before = JSON.stringify(x.items)
    expect(recoverNativeStackedUncertainty(x.items, x.rules)).toBeUndefined()
    expect(JSON.stringify(x.items)).toBe(before)
  }
)
it('does not reorder different native glyphs that claim the same whole source identity', () => {
  const x = fixture()
  x.items.forEach((item: ReturnType<typeof JSON.parse>, index: number) => {
    if (item.text === '+') item.text = '−'
    else if (item.text === '−') item.text = '+'
    item.sourceItem = { pageNumber: 1, index, text: item.text }
  })
  const zeros = x.items.filter((item: { text: string }) => item.text === '0')
  zeros[1].sourceItem = { ...zeros[0].sourceItem }
  const before = JSON.stringify(x.items)
  const refined = refineTable(x.table, x.items, x.captions, [], x.rules)
  const cell = refined.cells.find((c: { text: string }) => c.text.includes('6.84'))
  expect(cell?.text).not.toBe('6.84−0.27+0.39')
  expect(recoverNativeStackedUncertainty(x.items, x.rules)).toBeUndefined()
  expect(JSON.stringify(x.items)).toBe(before)
})
const measuredStack = (): ReturnType<typeof JSON.parse> => {
  const x = fixture()
  x.items.forEach((item: ReturnType<typeof JSON.parse>, index: number) => {
    item.sourceItem = { pageNumber: 1, index, text: item.text }
  })
  let offset = 0
  for (const item of x.items.filter((i: { baseline: number }) => i.baseline === 50)) {
    item.sourceSegment = {
      pageNumber: 1,
      index: 100,
      text: '6.84',
      start: offset,
      end: offset + item.text.length,
      rect: [...item.rect]
    }
    offset += item.text.length
    delete item.sourceItem
  }
  return x
}
it('retains valid measured fragments sharing a native parent when recovering scripts', () => {
  const x = measuredStack()
  expect(recoverNativeStackedUncertainty(x.items, x.rules)?.runs).toEqual([
    { text: '6.84', position: 'normal' },
    { text: '+0.27', position: 'superscript' },
    { text: '−0.39', position: 'subscript' }
  ])
  const refined = refineTable(x.table, x.items, x.captions, [], x.rules)
  expect(refined.cells.find((c: { text: string }) => c.text.includes('6.84'))?.text).toBe(
    '6.84+0.27−0.39'
  )
})
it.each(['duplicate-range', 'overlapping-range', 'whole-and-segment', 'wrong-text', 'wrong-rect'])(
  'declines script recovery with an unproved native range: %s',
  (variant) => {
    const x = measuredStack()
    const zeros = x.items.filter((i: { text: string }) => i.text === '0')
    if (variant === 'duplicate-range' || variant === 'overlapping-range') {
      for (const [n, item] of zeros.entries()) {
        delete item.sourceItem
        item.sourceSegment = {
          pageNumber: 1,
          index: 101,
          text: '00',
          start: 0,
          end: n === 1 && variant === 'overlapping-range' ? 2 : 1,
          rect: [...item.rect]
        }
        if (n === 1 && variant === 'overlapping-range') item.text = '00'
      }
    }
    if (variant === 'whole-and-segment')
      x.items[0].sourceItem = { pageNumber: 1, index: 100, text: '6.84' }
    if (variant === 'wrong-text') x.items[0].sourceSegment.text = '7.84'
    if (variant === 'wrong-rect') x.items[0].sourceSegment.rect[0] += 1
    const before = JSON.stringify(x.items)
    expect(recoverNativeStackedUncertainty(x.items, x.rules)).toBeUndefined()
    expect(JSON.stringify(x.items)).toBe(before)
  }
)
it.each(['wrong-whole-text', 'conflicting-parent', 'conflicting-parent-rect'])(
  'does not reorder a stack with inconsistent origin carriers: %s',
  (variant) => {
    const x = measuredStack()
    const token = x.items.find((item: { sourceItem?: unknown }) => item.sourceItem)
    if (variant === 'wrong-whole-text') token.sourceItem.text = 'different'
    else if (variant === 'conflicting-parent')
      token.sourceToken = { ...token, sourceItem: { ...token.sourceItem, index: 999 } }
    else {
      x.items[0].sourceToken = structuredClone(x.items[0])
      x.items[0].sourceToken.sourceSegment.rect[0]++
    }
    expect(recoverNativeStackedUncertainty(x.items, x.rules)).toBeUndefined()
  }
)
it('allows native font rounding at the three-quarter script size boundary', () => {
  const x = fixture()
  for (const item of x.items.filter((i: { baseline: number }) => i.baseline === 50)) {
    item.height = 13.3332
    item.rect[1] = item.baseline - item.height
  }
  const p = recoverNativeStackedUncertainty(x.items, x.rules)
  expect(p?.runs).toEqual([
    { text: '6.84', position: 'normal' },
    { text: '+0.27', position: 'superscript' },
    { text: '−0.39', position: 'subscript' }
  ])
})
it('keeps a signed script lane with one additional decimal digit intact', () => {
  const x = fixture(),
    tail = x.items.at(-1)
  x.items.push({
    ...tail,
    text: '5',
    rect: [tail.rect[2], tail.rect[1], tail.rect[2] + 6, tail.rect[3]]
  })
  expect(recoverNativeStackedUncertainty(x.items, x.rules)?.runs.at(-1)).toEqual({
    text: '−0.395',
    position: 'subscript'
  })
})
it.each([
  'one-sided',
  'same-sized scripts',
  'ordinary multiline',
  'nonadjacent',
  'different lane',
  'competing baseline',
  'repeated source',
  'rule between',
  'prose',
  'missing decimal'
])('declines an unproved stack: %s', (variant) => {
  const x = fixture()
  if (variant === 'one-sided')
    x.items = x.items.filter((i: { baseline: number }) => i.baseline !== 55)
  if (variant === 'same-sized scripts')
    for (const i of x.items.filter((i: { height: number }) => i.height === 10)) i.height = 14
  if (variant === 'ordinary multiline')
    for (const i of x.items.filter((i: { baseline: number }) => i.baseline === 55)) i.baseline += 15
  if (variant === 'nonadjacent')
    for (const i of x.items.filter((i: { height: number }) => i.height === 10)) {
      i.rect[0] += 8
      i.rect[2] += 8
    }
  if (variant === 'different lane')
    for (const i of x.items.filter((i: { baseline: number }) => i.baseline === 55)) {
      i.rect[0] += 4
      i.rect[2] += 4
    }
  if (variant === 'competing baseline')
    x.items.push({ ...x.items[0], rect: [20, 50, 27, 64], baseline: 64 })
  if (variant === 'repeated source') x.items.push(x.items[0])
  if (variant === 'rule between') x.rules.push([10, 45, 100, 45])
  if (variant === 'prose') x.items[0].text = 'value'
  if (variant === 'missing decimal') x.items.splice(5, 1)
  expect(recoverNativeStackedUncertainty(x.items, x.rules)).toBeUndefined()
})

it('allows only a table-proven tiny font-box overhang at the exact native divider', () => {
  const x = fixture(),
    top = Math.min(...x.items.map((i: { rect: number[] }) => i.rect[1])),
    divider = top + 0.05,
    rules = [[10, divider, 100, divider]],
    descriptor = { tokens: new Set(x.items), divider, smallFontBoundary: true }
  expect(recoverNativeStackedUncertainty(x.items, rules)).toBeUndefined()
  const p = recoverNativeStackedUncertainty(x.items, rules, [descriptor])
  expect(p?.runs.map((r: { text: string }) => r.text).join('')).toBe('6.84+0.27−0.39')
  expect(p?.ownedTokens.size).toBe(x.items.length)
})
it.each([
  'different divider',
  'competing proof',
  'incomplete owner',
  'excess overhang',
  'second divider',
  'missing sign'
])('rejects an ambiguous boundary stack: %s', (variant) => {
  const x = fixture(),
    divider = Math.min(...x.items.map((i: { rect: number[] }) => i.rect[1])) + 0.05,
    rules = [[10, divider, 100, divider]],
    descriptor = { tokens: new Set(x.items), divider, smallFontBoundary: true },
    context = [descriptor]
  if (variant === 'different divider') descriptor.divider += 1
  if (variant === 'competing proof') context.push(descriptor)
  if (variant === 'incomplete owner') descriptor.tokens.delete(x.items[0])
  if (variant === 'excess overhang')
    for (const i of x.items.filter(
      (i: { baseline: number }) =>
        i.baseline === Math.min(...x.items.map((t: { baseline: number }) => t.baseline))
    ))
      i.rect[1] -= 0.5
  if (variant === 'second divider') rules.push([10, divider + 1, 100, divider + 1])
  if (variant === 'missing sign') x.items.find((i: { text: string }) => i.text === '+').text = '0'
  expect(recoverNativeStackedUncertainty(x.items, rules, context)).toBeUndefined()
})

const labelledPairs = (): ReturnType<typeof JSON.parse> => {
  const token = (
    text: string,
    left: number,
    width: number,
    baseline: number,
    height: number
  ): ReturnType<typeof JSON.parse> => ({
    text,
    rect: [left, baseline - height, left + width, baseline],
    baseline,
    height,
    horizontal: true
  })
  const pair = (left: number, up: number): ReturnType<typeof JSON.parse>[] => [
    ...['+0', '.', '24'].map((t, n) => token(t, left + [0, 10, 12][n], [10, 2, 10][n], up, 7.5)),
    ...['−0', '.', '31'].map((t, n) => token(t, left + [0, 10, 12][n], [10, 2, 10][n], 53, 7.5))
  ]
  return [
    token('4.25', 10, 20, 50, 10),
    ...pair(32, 46),
    token('(first.)', 55, 30, 50, 10),
    ...pair(85, 45.5),
    token('(second.)', 108, 40, 50, 10)
  ]
}

it('orders two independently signed native script pairs around their whole baseline labels', () => {
  const items = labelledPairs(),
    before = structuredClone(items)
  const p = recoverNativeStackedUncertainty(items, [])
  expect(p?.runs).toEqual([
    { text: '4.25', position: 'normal' },
    { text: '+0.24', position: 'superscript' },
    { text: '−0.31', position: 'subscript' },
    { text: '(first.)', position: 'normal' },
    { text: '+0.24', position: 'superscript' },
    { text: '−0.31', position: 'subscript' },
    { text: '(second.)', position: 'normal' }
  ])
  expect(p?.ownedTokens.size).toBe(items.length)
  expect(p?.runs.flatMap((r: { text: string }) => [...r.text]).sort()).toEqual(
    items.flatMap((i: { text: string }) => [...i.text]).sort()
  )
  expect(items).toEqual(before)
})

it.each([
  'missing lower lane',
  'unsigned upper lane',
  'ordinary baseline',
  'foreign font',
  'crossing rule',
  'unlabelled prose',
  'shortened top',
  'shortened bottom',
  'extra coordinate'
])('declines a serial script pair without complete %s proof', (variant) => {
  const items = labelledPairs(),
    rules: number[][] = []
  if (variant === 'missing lower lane')
    items.splice(
      items.findIndex((i: { text: string }) => i.text === '−0'),
      1
    )
  if (variant === 'unsigned upper lane') items[1].text = '0'
  if (variant === 'ordinary baseline') items[1].baseline = 50
  if (variant === 'foreign font') items[1].height = 10
  if (variant === 'shortened top') items[1].rect[1] += 0.5
  if (variant === 'shortened bottom') items[1].rect[3] -= 0.5
  if (variant === 'extra coordinate') items[1].rect.push(0)
  if (variant === 'crossing rule') rules.push([0, 49, 200, 49])
  if (variant === 'unlabelled prose')
    items.find((i: { text: string }) => i.text === '(first.)').text = 'first'
  expect(recoverNativeStackedUncertainty(items, rules)).toBeUndefined()
})

const fusedStackedFixture = (fieldGap = 6): ReturnType<typeof JSON.parse> => {
  const viewport = {
    width: 260,
    height: 300,
    scale: 1,
    rotation: 0,
    transform: [1, 0, 0, -1, 0, 300],
    convertToViewportPoint: (x: number, y: number): number[] => [x, 300 - y]
  }
  const content: ReturnType<typeof JSON.parse> = {
    items: [],
    styles: { font: { ascent: 0.8, descent: -0.2, vertical: false } }
  }
  const operators: ReturnType<typeof JSON.parse> = {
    fnArray: [OPS.dependency],
    argsArray: [['font']]
  }
  const draw = (
    str: string,
    x: number,
    baseline: number,
    size = 10,
    glyphWidth = size / 2,
    gaps: number[] = []
  ): ReturnType<typeof JSON.parse> => {
    let width = 0,
      gap = 0
    const glyphs: ReturnType<typeof JSON.parse>[] = []
    for (const unicode of str) {
      if (unicode === ' ') {
        const advance = gaps[gap++]
        glyphs.push((-advance * 1000) / size)
        width += advance
      } else {
        glyphs.push({
          unicode,
          fontChar: unicode,
          originalCharCode: unicode.codePointAt(0),
          width: (glyphWidth * 1000) / size,
          isInFont: true,
          operatorListId: null
        })
        width += glyphWidth
      }
    }
    const item = {
      str,
      fontName: 'font',
      transform: [size, 0, 0, size, x, 300 - baseline],
      width,
      height: size,
      dir: 'ltr',
      sourceItem: { pageNumber: 1, index: content.items.length, text: str }
    }
    content.items.push(item)
    operators.fnArray.push(OPS.setFont, OPS.beginText, OPS.setTextMatrix, OPS.showText, OPS.endText)
    operators.argsArray.push(
      ['font', size],
      null,
      [new Float32Array([1, 0, 0, 1, x, 300 - baseline])],
      [glyphs],
      null
    )
    return tableTextToken(item, viewport, 0)
  }
  const cell = (
    row: number,
    column: number,
    tokens: ReturnType<typeof JSON.parse>[]
  ): ReturnType<typeof JSON.parse> => {
    const proof = recoverNativeStackedUncertainty(tokens, [])
    return {
      row,
      column,
      rowSpan: 1,
      colSpan: 1,
      rect: [
        column ? 70 : 10,
        row ? 45 + (row - 1) * 25 : 20,
        column ? 230 : 70,
        row ? 70 + (row - 1) * 25 : 45
      ],
      text: proof
        ? proof.runs.map((r: { text: string }) => r.text).join('')
        : tokens.map((i) => i.text).join(''),
      ...(proof ? { textRuns: proof.runs } : {}),
      sourceTokens: tokens,
      sourceRects: tokens.map((i) => i.rect),
      sourceItems: tokens.map((i) => i.sourceItem),
      opaque: { retained: column }
    }
  }
  const cells = [cell(0, 0, [draw('Label', 20, 38)]), cell(0, 1, [draw('Value', 100, 38)])]
  for (let n = 0; n < 5; n++) {
    const y = 60 + n * 25,
      left = draw(n === 2 ? 'Kind alpha 4.25' : `Kind${n}`, 20, y, 10, 5, [3.2, fieldGap]),
      value: ReturnType<typeof JSON.parse>[] = n === 2 ? [] : [draw(`${n + 4}.25`, 74.2, y)]
    const pair = (x: number, upper: number): void => {
      for (const [baseline, sign] of [
        [upper, '+'],
        [y + 3, '−']
      ] as const) {
        value.push(draw(sign + '0', x, baseline, 7.5, 5))
        value.push(draw('.', x + 10, baseline, 7.5, 2))
        value.push(draw('24', x + 12, baseline, 7.5, 5))
      }
    }
    pair(96.2, y - 4)
    value.push(draw('(first.)', 119.2, y, 10, 30 / 8))
    pair(150.2, y - 4.5)
    value.push(draw('(second.)', 173.2, y, 10, 40 / 9))
    cells.push(cell(n + 1, 0, [left]), cell(n + 1, 1, value))
  }
  for (const y of [20, 45, 180]) {
    operators.fnArray.push(OPS.constructPath)
    operators.argsArray.push([
      OPS.stroke,
      [new Float32Array([0, 10, 300 - y, 1, 230, 300 - y])],
      new Float32Array([10, 300 - y, 230, 300 - y])
    ])
  }
  const paint = new Map(),
    rules = collectTableRules(operators, viewport, paint),
    items = content.items.map((i: object) => tableTextToken(i, viewport, 0)),
    context = {
      content,
      operators,
      viewport,
      rulePaintBounds: paint,
      nativeEvidenceGraphics: [
        [9.140625, 18.75, 231.5625, 22.265625],
        [9.140625, 43.359375, 231.5625, 46.875],
        [9.140625, 179.296875, 231.5625, 182.8125]
      ].map((rect) => ({ kind: 'path', rect }))
    }
  return {
    table: {
      readingRotation: 0,
      cropRect: [10, 20, 230, 180],
      cells,
      grid: Array.from({ length: 6 }, (_, row) =>
        cells.filter((c) => c.row === row).map((c) => c.text)
      )
    },
    items,
    rules,
    runs: nativeWhitespaceGaps(content, operators, viewport),
    context
  }
}

it('proves a single measured stub/central field beside four complete native labelled stacks', () => {
  const f = fusedStackedFixture(),
    before = JSON.stringify(f),
    p = recoverNativeFusedStackedScalarOwners(f.table, f.items, f.rules, f.runs, f.context)
  expect(p?.label.text).toBe('Kind alpha')
  expect(p?.runs.map((r: { text: string }) => r.text).join('')).toBe(
    '4.25+0.24−0.24(first.)+0.24−0.24(second.)'
  )
  expect(p?.label.sourceToken).toBe(p?.targetTokens[0].sourceToken)
  expect(p?.targetOrigins.sourceItems).toContainEqual(p?.donorOrigins.sourceItems[0])
  expect(JSON.stringify(f)).toBe(before)
})

it('moves only the measured central field through the existing refinement entry', () => {
  const f = fusedStackedFixture()
  f.table.structure = {
    objects: [
      { label: 'table column', rect: [0, 0, 60, 160] },
      { label: 'table column', rect: [60, 0, 220, 160] },
      { label: 'table column header', rect: [0, 0, 220, 25] },
      ...[0, 25, 50, 75, 100, 125].map((y) => ({
        label: 'table row',
        rect: [0, y, 220, y === 125 ? 160 : y + 25]
      }))
    ]
  }
  const r = refineTable(
    f.table,
    f.items,
    [],
    [],
    f.rules,
    f.runs,
    undefined,
    f.context.rulePaintBounds,
    f.context
  )
  expect(r.grid[3]).toEqual(['Kind alpha', '4.25+0.24−0.24(first.)+0.24−0.24(second.)'])
  expect(
    r.cells.find((c: { row: number; column: number }) => c.row === 3 && c.column === 1).textRuns
  ).toHaveLength(7)
  expect(r.grid.filter((_: unknown, n: number) => n !== 3)).toEqual(
    f.table.grid.filter((_: unknown, n: number) => n !== 3)
  )
})

it.each([
  'missing packet',
  'ordinary prose gap',
  'different run',
  'ambiguous peer',
  'foreign font',
  'literal mismatch',
  'duplicate body owner',
  'changed donor origin',
  'white paint'
])('refuses a fused stack without complete %s evidence atomically', (variant) => {
  const f = fusedStackedFixture(variant === 'ordinary prose gap' ? 3.2 : 6)
  if (variant === 'missing packet') f.context.operators = undefined
  if (variant === 'different run')
    f.runs.find((r: { text: string }) => r.text === 'Kind alpha 4.25').glyphRuns[9]++
  if (variant === 'ambiguous peer')
    f.table.cells.find(
      (c: { row: number; column: number }) => c.row === 1 && c.column === 1
    ).sourceTokens[0].height = 8
  if (variant === 'foreign font') f.items[2].rect[0] += 1
  if (variant === 'literal mismatch') f.context.content.items[2].str += '!'
  if (variant === 'duplicate body owner') f.table.cells.push(structuredClone(f.table.cells[2]))
  if (variant === 'changed donor origin')
    f.table.cells.find(
      (c: { row: number; column: number }) => c.row === 3 && c.column === 0
    ).sourceItems[0].text += '!'
  if (variant === 'white paint') {
    f.context.operators.fnArray.unshift(OPS.setFillRGBColor)
    f.context.operators.argsArray.unshift(['#ffffff'])
  }
  const before = JSON.stringify(f)
  expect(
    recoverNativeFusedStackedScalarOwners(f.table, f.items, f.rules, f.runs, f.context)
  ).toBeUndefined()
  expect(JSON.stringify(f)).toBe(before)
})
