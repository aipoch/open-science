import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readPdfFixture } from './read-fixture'

const { captionKind, findCaptionCandidates, groupPageLines } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-caption-group.mjs')).href
)
const { associateTableCaptions } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/native-caption-context-ownership.jsonl'
    )
  )

const centeredCaptionStack = (): ReturnType<typeof JSON.parse> => {
  const row = (
    text: string,
    x: number,
    y: number,
    width: number,
    fontSize: number
  ): ReturnType<typeof JSON.parse> => ({
    text,
    x,
    y,
    width,
    height: fontSize,
    fontSize
  })
  const titles = [
    row('Table S2: Complete independent comparison of measured source records.', 60, 70, 480, 10),
    row('The separate observations terminate in this centered title.', 120, 82, 360, 10),
    row(
      'Table S3: Complete independent comparison of additional source records.',
      60,
      196.5,
      480,
      10
    ),
    row('The additional observations terminate in this title.', 150, 208.5, 300, 10)
  ]
  return {
    pageNumber: 1,
    width: 600,
    height: 800,
    graphicsBounds: [],
    lines: [
      ...titles,
      row('First group   Second group', 240, 104.4, 160, 8),
      row('Record Method Left Right', 200, 117.5, 200, 8),
      ...Array.from({ length: 6 }, (_, i) =>
        row(`Record ${i + 1} 1.25 2.50`, 200, 127.5 + i * 9, 200, 8)
      ),
      row('Primary response   Auxiliary response', 250, 230.3, 160, 9),
      row('Record Method Left Right', 190, 243.6, 220, 9),
      ...Array.from({ length: 8 }, (_, i) =>
        row(`Record ${i + 1} 3.75 4.50`, 190, 255.5 + i * 10, 220, 9)
      ),
      row(
        'A complete independent body paragraph begins below both framed tables.',
        60,
        400,
        480,
        12
      )
    ],
    tables: [{ rect: [190, 104.4, 410, 181] }, { rect: [180, 230.3, 420, 334.5] }],
    captions: [titles[0], titles[2]].map((l) => ({
      page: 1,
      lines: [l.text],
      rect: [l.x, l.y, l.x + l.width, l.y + l.height]
    })),
    rules: [
      [195, 106, 405, 106],
      [195, 128.6, 405, 128.6],
      [195, 182, 405, 182],
      [185, 232, 415, 232],
      [185, 257, 415, 257],
      [185, 337.4, 415, 337.4]
    ],
    expected: [
      { page: 1, lines: titles.slice(0, 2).map((l) => l.text), rect: [60, 70, 540, 92] },
      { page: 1, lines: titles.slice(2).map((l) => l.text), rect: [60, 196.5, 540, 218.5] }
    ]
  }
}

it('keeps both complete centered titles with their own narrow ruled table despite truncated candidates', () => {
  const page = centeredCaptionStack()
  const before = structuredClone(page)
  expect(associateTableCaptions(page, page.tables, page.captions, page.rules)).toEqual(
    page.expected.map((caption: unknown) => ({ caption }))
  )
  expect(page).toEqual(before)
})

it.each([
  'missing-close',
  'missing-divider',
  'competing-frame',
  'foreign-corridor',
  'crossing-font'
])('does not complete centered table titles without unique whole-source %s proof', (variant) => {
  const page = centeredCaptionStack()
  if (variant === 'missing-close') page.rules.splice(2, 1)
  if (variant === 'missing-divider') page.rules.splice(1, 1)
  if (variant === 'competing-frame') page.tables[1].rect[1] = 170
  if (variant === 'foreign-corridor')
    page.lines.push({ text: 'Foreign prose', x: 210, y: 95, width: 70, height: 8, fontSize: 8 })
  if (variant === 'crossing-font') page.lines[6].x = 192
  const before = structuredClone(page)
  expect(
    associateTableCaptions(page, page.tables, page.captions, page.rules).map(
      (result: ReturnType<typeof JSON.parse>) => result.caption
    )
  ).not.toEqual(page.expected)
  expect(page).toEqual(before)
})

const directionalCaptionPage = (): ReturnType<typeof JSON.parse> => ({
  pageNumber: 1,
  width: 600,
  height: 800,
  lines: [
    ['Figure 4. Left panel: Separate native observations continue across', 60, 300, 480],
    ['the independent left observations in this complete description.', 60, 312, 480],
    ['Right panel: Separate native records continue across the complete view', 60, 329, 480],
    ['with all observations retained in their original physical rows', 60, 341, 480],
    ['before the complete paragraph ends.', 200, 353, 200],
    ['The independent body paragraph remains outside the caption.', 60, 420, 480]
  ].map(([text, x, y, width], i) => ({
    text,
    x,
    y,
    width,
    height: i === 5 ? 12 : 10,
    fontSize: i === 5 ? 12 : 10
  })),
  graphicsBounds: [{ kind: 'image', normalizedRect: [80 / 600, 80 / 800, 520 / 600, 296 / 800] }]
})

it('retains the complete Left and Right caption paragraphs with the centered terminal row', () => {
  const page = directionalCaptionPage()
  const before = structuredClone(page)
  expect(findCaptionCandidates([page])[0]).toEqual({
    page: 1,
    lines: page.lines.slice(0, 5).map((l: { text: string }) => l.text),
    rect: [60, 300, 540, 363]
  })
  expect(page).toEqual(before)
})

it.each(['missing-raster', 'unclosed-tail', 'foreign-font', 'caption-paint'])(
  'does not join separate Left and Right rows without complete %s ownership',
  (variant) => {
    const page = directionalCaptionPage()
    if (variant === 'missing-raster') page.graphicsBounds = []
    if (variant === 'unclosed-tail') page.lines[4].text = page.lines[4].text.replace(/\.$/u, '')
    if (variant === 'foreign-font')
      page.lines.push({ text: 'foreign', x: 90, y: 320, width: 40, height: 10, fontSize: 10 })
    if (variant === 'caption-paint')
      page.graphicsBounds.push({ kind: 'path', normalizedRect: [0.2, 0.42, 0.3, 0.44] })
    const before = structuredClone(page)
    expect(findCaptionCandidates([page])[0].lines).not.toEqual(
      page.lines.slice(0, 5).map((l: { text: string }) => l.text)
    )
    expect(page).toEqual(before)
  }
)

const internalReferenceCaption = (): ReturnType<typeof JSON.parse> => {
  const text = [
    'Figure 4. Complete source responses are displayed in',
    'Fig. 2 with the matched source records across all views,',
    'with each response continuing in the same physical paragraph,',
    'and every source explanation retained at its native baseline,',
    'before the independent body begins.'
  ]
  return {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    expectedLines: text,
    lines: [
      ...text.map((value, i) => ({
        text: value,
        x: 60,
        y: 260 + i * 12,
        width: i === 4 ? 240 : 480,
        height: 10,
        fontSize: 10
      })),
      {
        text: 'An independent body paragraph follows the complete native caption.',
        x: 60,
        y: 340,
        width: 480,
        height: 12,
        fontSize: 12
      }
    ],
    graphicsBounds: [
      [80, 80, 520, 240],
      [90, 90, 510, 230],
      [95, 95, 505, 225]
    ].map((rect) => ({
      kind: 'path',
      normalizedRect: rect.map((value, i) => value / (i % 2 ? 800 : 600))
    }))
  }
}

it('retains all five native caption rows across an internal Figure reference', () => {
  const page = internalReferenceCaption()
  const before = structuredClone(page)
  expect(findCaptionCandidates([page])).toEqual([
    { page: 1, lines: page.expectedLines, rect: [60, 260, 540, 318] }
  ])
  expect(page).toEqual(before)
})

it.each([
  'closed-parent',
  'independent-title',
  'reference-font',
  'reference-column',
  'reference-leading',
  'clipped-parent-font',
  'unclosed-tail',
  'missing-graphic',
  'foreign-paint',
  'separator',
  'missing-body-gap',
  'same-font-body'
])('does not bridge an internal Figure reference without complete %s proof', (missing) => {
  const page = internalReferenceCaption()
  const first = page.lines[0],
    reference = page.lines[1],
    last = page.lines[4],
    body = page.lines[5]
  if (missing === 'closed-parent') first.text += '.'
  if (missing === 'independent-title') reference.text = 'Fig. 2: An independent source comparison.'
  if (missing === 'reference-font') reference.fontSize += 1
  if (missing === 'reference-column') reference.x += 20
  if (missing === 'reference-leading') reference.y += 3
  if (missing === 'clipped-parent-font') first.height = 1
  if (missing === 'unclosed-tail') last.text = last.text.replace(/\.$/u, '')
  if (missing === 'missing-graphic') page.graphicsBounds = []
  if (missing === 'foreign-paint')
    page.graphicsBounds.push({ kind: 'path', normalizedRect: [0.3, 0.34, 0.6, 0.38] })
  if (missing === 'missing-body-gap') body.y = 319
  if (missing === 'same-font-body') body.fontSize = 10
  const expected = page.lines.slice(0, 5).map((line: { text: string }) => line.text)
  const rules = missing === 'separator' ? new Map([[1, [[60, 275, 540, 275]]]]) : new Map()
  const before = structuredClone(page)
  expect(
    findCaptionCandidates([page], rules).some(
      (caption: { lines: string[] }) => JSON.stringify(caption.lines) === JSON.stringify(expected)
    )
  ).toBe(false)
  expect(page).toEqual(before)
})

it.each([0.73, 1.7])(
  'preserves an internal-reference caption under source scaling and permutation (%s)',
  (scale) => {
    const page = internalReferenceCaption()
    page.width *= scale
    page.height *= scale
    for (const line of page.lines)
      for (const key of ['x', 'y', 'width', 'height', 'fontSize']) line[key] *= scale
    page.lines.reverse()
    page.graphicsBounds.reverse()
    const before = structuredClone(page)
    const captions = findCaptionCandidates([page])
    expect(captions).toHaveLength(1)
    expect(captions[0].lines).toEqual(page.expectedLines)
    for (const [i, value] of [60, 260, 540, 318].entries())
      expect(captions[0].rect[i]).toBeCloseTo(value * scale, 8)
    expect(page).toEqual(before)
  }
)

it('keeps each complete native below-caption with its preceding table despite shuffled detections', () => {
  const page = fixture()[7]
  const order = [2, 0, 3, 1]
  const before = structuredClone(page)
  expect(
    associateTableCaptions(
      page,
      order.map((i) => ({ rect: page.tableRects[i] })),
      page.tableCaptions,
      page.captionRules
    ).map((a: { caption?: { lines: string[] } }) => a.caption?.lines)
  ).toEqual(order.map((i) => page.tableCaptions[i].lines))
  expect(page).toEqual(before)
})

it.each(['closing', 'caption', 'foreign-corridor', 'native-records'])(
  'does not force below-caption orientation without the complete %s witness',
  (missing) => {
    const page = fixture()[7]
    if (missing === 'closing')
      page.captionRules = page.captionRules.filter((r: number[]) => r[1] !== 200)
    if (missing === 'caption') page.tableCaptions.pop()
    if (missing === 'foreign-corridor')
      page.lines.push({
        text: 'Independent source text',
        x: 120,
        y: 207,
        width: 120,
        height: 10,
        fontSize: 10
      })
    if (missing === 'native-records')
      page.lines = page.lines.filter((l: { y: number }) => l.y < 120 || l.y >= 200)
    const result = associateTableCaptions(
      page,
      page.tableRects.map((rect: number[]) => ({ rect })),
      page.tableCaptions,
      page.captionRules
    )
    expect(result.map((a: { caption?: { lines: string[] } }) => a.caption?.lines)).not.toEqual(
      fixture()[7].tableCaptions.map((c: { lines: string[] }) => c.lines)
    )
  }
)

it.each([
  ['caption-bottom', { x: 60, y: 265, width: 25, height: 5 }],
  ['caption-left', { x: 57, y: 254, width: 25, height: 5 }],
  ['frame-left', { x: 107, y: 128, width: 25, height: 5 }],
  ['frame-bottom', { x: 120, y: 198, width: 25, height: 5 }]
])('does not reserve a below-caption across an intersecting full font at %s', (_edge, bounds) => {
  const page = fixture()[7]
  page.lines.push({ text: 'Foreign', fontSize: 5, ...bounds })
  const before = structuredClone(page)
  const result = associateTableCaptions(
    page,
    page.tableRects.map((rect: number[]) => ({ rect })),
    page.tableCaptions,
    page.captionRules
  )
  expect(result.map((a: { caption?: { lines: string[] } }) => a.caption?.lines)).not.toEqual(
    page.tableCaptions.map((c: { lines: string[] }) => c.lines)
  )
  expect(page).toEqual(before)
})

it.each(['caption', 'frame'])('requires complete native font height in the %s owner', (owner) => {
  const page = fixture()[7]
  const line = page.lines.find((l: { y: number }) => l.y === (owner === 'caption' ? 226 : 120))
  line.height = 1
  const before = structuredClone(page)
  const result = associateTableCaptions(
    page,
    page.tableRects.map((rect: number[]) => ({ rect })),
    page.tableCaptions,
    page.captionRules
  )
  expect(result.map((a: { caption?: { lines: string[] } }) => a.caption?.lines)).not.toEqual(
    page.tableCaptions.map((c: { lines: string[] }) => c.lines)
  )
  expect(page).toEqual(before)
})

it('preserves a complete canonical script envelope larger than its native font em', () => {
  const page = fixture()[7]
  page.lines.find((l: { y: number }) => l.y === 226).height += 2
  const before = structuredClone(page)
  expect(
    associateTableCaptions(
      page,
      page.tableRects.map((rect: number[]) => ({ rect })),
      page.tableCaptions,
      page.captionRules
    ).map((a: { caption?: { lines: string[] } }) => a.caption?.lines)
  ).toEqual(page.tableCaptions.map((c: { lines: string[] }) => c.lines))
  expect(page).toEqual(before)
})

it.each([0.73, 1.7])(
  'preserves complete below-caption ownership under scale and source permutation (%s)',
  (scale) => {
    const page = fixture()[7]
    page.width *= scale
    page.height *= scale
    for (const line of page.lines)
      for (const key of ['x', 'y', 'width', 'height', 'fontSize']) line[key] *= scale
    page.lines.reverse()
    page.captionRules = page.captionRules.map((r: number[]) => r.map((v) => v * scale)).reverse()
    page.tableRects = page.tableRects.map((r: number[]) => r.map((v) => v * scale)).reverse()
    for (const caption of page.tableCaptions)
      caption.rect = caption.rect.map((v: number) => v * scale)
    const result = associateTableCaptions(
      page,
      page.tableRects.map((rect: number[]) => ({ rect })),
      [...page.tableCaptions].reverse(),
      page.captionRules
    )
    expect(result.map((a: { caption?: { lines: string[] } }) => a.caption?.lines)).toEqual(
      [...page.tableCaptions].reverse().map((c: { lines: string[] }) => c.lines)
    )
  }
)

it.each([0, 1])('keeps a tightly wrapped native reference in its body paragraph (%s)', (index) => {
  const page = fixture()[index]
  const before = structuredClone(page)
  expect(findCaptionCandidates([page])).toEqual([])
  expect(page).toEqual(before)
})

it.each(['font', 'spacing', 'column', 'rule', 'plate'])(
  'does not infer a wrapped reference without %s ownership proof',
  (missing) => {
    const page = fixture()[0]
    if (missing === 'font') page.lines[2].fontSize += 2
    if (missing === 'spacing') page.lines[3].y += 20
    if (missing === 'column') page.lines[0].x -= 40
    if (missing === 'plate')
      page.graphicsBounds.push({ kind: 'image', normalizedRect: [0.08, 0.04, 0.89, 0.129] })
    const rules = missing === 'rule' ? new Map([[1, [[50, 111, 530, 111]]]]) : new Map()
    expect(
      findCaptionCandidates([page], rules).some(
        (caption: { lines: string[] }) => caption.lines[0] === page.lines[3].text
      )
    ).toBe(true)
  }
)

it('does not bridge a foreign source column on the same physical row', () => {
  const page = fixture()[0]
  page.lines.push({
    text: 'A foreign paragraph continues in',
    x: 550,
    y: 100,
    width: 180,
    height: 10,
    fontSize: 10
  })
  expect(findCaptionCandidates([page])).toHaveLength(1)
})

it('does not infer body indentation beyond one native font em', () => {
  const page = fixture()[1]
  page.lines[0].x += 10
  expect(findCaptionCandidates([page])).toHaveLength(1)
})

it('admits a closed smaller title only with a unique adjacent native photo', () => {
  const page = fixture()[2]
  const before = structuredClone(page)
  expect(captionKind(page.lines[0].text)).toBeUndefined()
  expect(findCaptionCandidates([page])).toEqual([
    { page: 1, lines: [page.lines[0].text], rect: [150, 286, 450, 295] }
  ])
  expect(page).toEqual(before)
})

it.each([
  'image',
  'foreign',
  'spacing',
  'body-font',
  'closure',
  'lowercase',
  'interposed',
  'caption',
  'competing'
])('requires independent photo-title %s proof', (missing) => {
  const page = fixture()[2]
  if (missing === 'image') page.graphicsBounds[0].kind = 'path'
  if (missing === 'foreign') page.graphicsBounds[0].normalizedRect = [0, 0.15, 0.45, 0.35]
  if (missing === 'spacing') page.graphicsBounds[0].normalizedRect[3] -= 0.1
  if (missing === 'body-font') for (const line of page.lines.slice(1)) line.fontSize = 9
  if (missing === 'closure') page.lines[0].text = page.lines[0].text.replace(/\.$/, '')
  if (missing === 'lowercase') page.lines[0].text = page.lines[0].text.replace(' The ', ' the ')
  if (missing === 'interposed')
    page.lines.push({
      text: 'An independent prose fragment.',
      x: 150,
      y: 281,
      width: 300,
      height: 3,
      fontSize: 3
    })
  if (missing === 'caption')
    page.lines.push({
      text: 'Figure 2: Separate native title.',
      x: 150,
      y: 281,
      width: 300,
      height: 3,
      fontSize: 3
    })
  if (missing === 'competing')
    page.graphicsBounds.push({ kind: 'image', normalizedRect: [0.09, 0.15, 0.89, 0.35] })
  expect(
    findCaptionCandidates([page]).some(
      (caption: { lines: string[] }) => caption.lines[0] === page.lines[0].text
    )
  ).toBe(false)
})

it.each([0, 1, 2])('preserves source ownership under scaling and ordering (%s)', (index) => {
  for (const scale of [0.73, 1.7]) {
    const page = fixture()[index]
    page.width *= scale
    page.height *= scale
    for (const line of page.lines)
      for (const key of ['x', 'y', 'width', 'height', 'fontSize']) line[key] *= scale
    page.lines.reverse()
    page.graphicsBounds.reverse()
    const before = structuredClone(page)
    expect(
      findCaptionCandidates([page]).map((caption: { lines: string[] }) => caption.lines)
    ).toEqual(index === 2 ? [[fixture()[2].lines[0].text]] : [])
    expect(page).toEqual(before)
  }
})

it('retains punctuated titles without using the contextual photo admission', () => {
  const page = fixture()[2]
  page.graphicsBounds = []
  page.lines[0].text = 'Figure 8. The panels contain the separate measured records.'
  expect(captionKind(page.lines[0].text)).toBe('figure')
  expect(findCaptionCandidates([page])[0].lines).toEqual([page.lines[0].text])
})

it('separates a narrow framed table title from independently painted neighboring prose', () => {
  const page = fixture()[3]
  const before = structuredClone(page)
  expect(
    groupPageLines(page).find((line: { text: string }) => line.text === page.lines[0].text)
  ).toMatchObject({ x: page.lines[0].x, y: page.lines[0].y })
  expect(findCaptionCandidates([page])).toEqual([
    { page: 1, lines: [page.lines[2].text, page.lines[3].text], rect: [349, 291, 533, 315.5] }
  ])
  expect(page).toEqual(before)
})

it('uses the same narrow title ownership when the requested page supplies exact operator borders', () => {
  const page = fixture()[3]
  const rules = new Map([
    [
      1,
      [
        [351, 319, 528, 319],
        [351, 346, 528, 346],
        [351, 375, 528, 375]
      ]
    ]
  ])
  expect(
    findCaptionCandidates([page], rules).map((caption: { lines: string[] }) => caption.lines)
  ).toEqual([[page.lines[2].text, page.lines[3].text]])
})

it.each([
  'pipe',
  'opening',
  'divider',
  'closing',
  'headers',
  'records',
  'continuation',
  'closure',
  'neighbor',
  'competing'
])(
  'requires independent narrow table-title %s proof before separating a native source row',
  (missing) => {
    const page = fixture()[3]
    if (missing === 'pipe') page.lines[2].text = page.lines[2].text.replace(' | ', '. ')
    if (missing === 'opening') page.graphicsBounds.splice(0, 1)
    if (missing === 'divider') page.graphicsBounds.splice(1, 1)
    if (missing === 'closing') page.graphicsBounds.splice(2, 1)
    if (missing === 'headers') page.lines.splice(4, 2)
    if (missing === 'records') page.lines.pop()
    if (missing === 'continuation') page.lines[3].x += 20
    if (missing === 'closure') page.lines[3].text = page.lines[3].text.replace(/\.$/, '')
    if (missing === 'neighbor') page.lines[1].x += 10
    if (missing === 'competing') page.graphicsBounds.push(structuredClone(page.graphicsBounds[1]))
    expect(
      findCaptionCandidates([page]).some(
        (caption: { lines: string[] }) => caption.lines[0] === page.lines[2].text
      )
    ).toBe(false)
  }
)

it('preserves the narrow framed title and source paragraph under native scaling and stream ordering', () => {
  for (const scale of [0.73, 1.7]) {
    const page = fixture()[3]
    const title = [page.lines[2].text, page.lines[3].text]
    page.width *= scale
    page.height *= scale
    for (const line of page.lines)
      for (const key of ['x', 'y', 'width', 'height', 'fontSize']) line[key] *= scale
    page.lines.reverse()
    page.graphicsBounds.reverse()
    const before = structuredClone(page)
    expect(
      findCaptionCandidates([page]).map((caption: { lines: string[] }) => caption.lines)
    ).toEqual([title])
    expect(page).toEqual(before)
  }
})

it.each([4, 5, 6])('retains a complete single-spaced native caption paragraph (%s)', (index) => {
  const page = fixture()[index]
  const before = structuredClone(page)
  const rules = new Map([[page.pageNumber, page.captionRules]])
  const captions = findCaptionCandidates([page], rules)
  expect(captions).toHaveLength(1)
  expect(captions[0].lines).toEqual(page.expectedLines)
  expect(captions[0].rect[3]).toBe(page.expectedRect[3])
  expect(page).toEqual(before)
})

it.each([
  'graphic',
  'competing-graphic',
  'center',
  'font',
  'leading',
  'foreign-box',
  'caption',
  'closure',
  'closed-previous'
])('requires complete native centered-terminal %s ownership', (missing) => {
  const page = fixture()[4]
  const last = page.lines.at(-2)
  if (missing === 'graphic') page.graphicsBounds = []
  if (missing === 'competing-graphic')
    page.graphicsBounds.push({ kind: 'path', normalizedRect: [0.09, 0.07, 0.497, 0.274] })
  if (missing === 'center') last.x += 2
  if (missing === 'font') last.fontSize += 1
  if (missing === 'leading') last.y += 5
  if (missing === 'foreign-box')
    page.lines.push({
      text: 'Independent foreign source.',
      x: last.x - 8,
      y: last.y - 3,
      width: 270,
      height: 12,
      fontSize: 12
    })
  if (missing === 'caption')
    page.lines.push({
      text: 'Figure 3: Independent source.',
      x: 54,
      y: last.y - 3,
      width: 240,
      height: 3,
      fontSize: 3
    })
  if (missing === 'closure') last.text = last.text.replace(/\.$/u, '')
  if (missing === 'closed-previous') page.lines.at(-3).text += '.'
  const before = structuredClone(page)
  expect(
    findCaptionCandidates([page]).some((c: { lines: string[] }) => c.lines.includes(last.text))
  ).toBe(false)
  expect(page).toEqual(before)
})

it('treats repeated exact paint as one native paragraph owner', () => {
  const page = fixture()[4]
  page.graphicsBounds.push(structuredClone(page.graphicsBounds[0]))
  expect(findCaptionCandidates([page])[0].lines).toEqual(page.expectedLines)
})

it.each(['opening', 'divider', 'closing', 'left-wall', 'right-wall'])(
  'requires the complete native Table %s before borrowing a centered ending',
  (missing) => {
    const page = fixture()[6]
    const horizontal = page.captionRules
      .filter((r: number[]) => r[1] === r[3])
      .sort((a: number[], b: number[]) => a[1] - b[1])
    const remove =
      missing === 'opening' ? horizontal[0] : missing === 'divider' ? horizontal[1] : horizontal[2]
    page.captionRules = page.captionRules.filter((r: number[]) => {
      if (missing === 'left-wall') return !(r[0] === r[2] && Math.abs(r[0] - horizontal[0][0]) < 1)
      if (missing === 'right-wall') return !(r[0] === r[2] && Math.abs(r[0] - horizontal[0][2]) < 1)
      return r !== remove
    })
    const captions = findCaptionCandidates([page], new Map([[1, page.captionRules]]))
    expect(
      captions.some((c: { lines: string[] }) => c.lines.includes(page.expectedLines.at(-1)))
    ).toBe(false)
  }
)

it.each([4, 5, 6])(
  'preserves finite caption ownership under source permutation and scale (%s)',
  (index) => {
    for (const scale of [0.73, 1.7]) {
      const page = fixture()[index]
      page.width *= scale
      page.height *= scale
      for (const line of page.lines)
        for (const key of ['x', 'y', 'width', 'height', 'fontSize']) line[key] *= scale
      page.captionRules = page.captionRules.map((r: number[]) => r.map((v) => v * scale))
      page.lines.reverse()
      page.graphicsBounds.reverse()
      const before = structuredClone(page)
      expect(
        findCaptionCandidates([page], new Map([[1, page.captionRules]])).map(
          (c: { lines: string[] }) => c.lines
        )
      ).toEqual([page.expectedLines])
      expect(page).toEqual(before)
    }
  }
)

it('retains a native Table row whose measured right edge includes existing small glyphs', () => {
  const page = fixture()[6]
  const row = page.lines[1]
  row.width -= 5
  const edge = row.x + row.width
  page.lines.push(
    { text: '†', x: edge + 0.45, y: row.y - 1.26, width: 3.43, height: 5.9776, fontSize: 5.9776 },
    { text: 'z', x: edge, y: row.y + 5.57, width: 4.4, height: 5.9776, fontSize: 5.9776 }
  )
  const before = structuredClone(page)
  const caption = findCaptionCandidates([page], new Map([[1, page.captionRules]]))[0]
  expect(caption.lines).toEqual([page.expectedLines[0], row.text + ' † z', page.expectedLines[2]])
  expect(page).toEqual(before)
})

it.each(['missing-parent', 'competing-parent', 'foreign-font-box'])(
  'refuses to reconstruct a caption with %s small-fragment ownership',
  (missing) => {
    const page = fixture()[5]
    const lowered = page.lines[6]
    if (missing === 'missing-parent') lowered.x += 2
    if (missing === 'competing-parent')
      page.lines.push({ ...page.lines[5], text: 'Independent source.' })
    if (missing === 'foreign-font-box')
      page.lines.push({
        text: 'z',
        x: lowered.x,
        y: lowered.y - 20,
        width: 4,
        height: 40,
        fontSize: 5
      })
    expect(
      findCaptionCandidates([page]).some((c: { lines: string[] }) =>
        c.lines.includes(page.expectedLines.at(-1))
      )
    ).toBe(false)
  }
)

it('retains the complete bounded caption with one uniquely owned leading native digit', () => {
  const page = fixture()[8]
  const before = structuredClone(page)
  expect(
    findCaptionCandidates([page]).map((caption: { lines: string[] }) => caption.lines)
  ).toEqual([page.expectedLines])
  expect(page).toEqual(before)
})

it('preserves the existing left parent instead of reinterpreting an inline small font', () => {
  const page = fixture()[8]
  page.lines[9].width = page.lines[10].x - page.lines[9].x - 0.2
  page.lines[10].text = 'z'
  page.expectedLines[7] = [page.lines[9].text, 'z', page.lines[11].text].join(' ')
  expect(
    findCaptionCandidates([page]).map((caption: { lines: string[] }) => caption.lines)
  ).toEqual([page.expectedLines])
})

it.each([
  'non-digit',
  'three-digits',
  'not-raised',
  'far-right-parent',
  'ambiguous-right-parent',
  'missing-right-parent',
  'clipped-script',
  'clipped-right-parent'
])('refuses a leading native digit without its complete %s witness', (missing) => {
  const page = fixture()[8]
  const script = page.lines[10]
  const parent = page.lines[11]
  if (missing === 'non-digit') script.text = 'z'
  if (missing === 'three-digits') script.text = '123'
  if (missing === 'not-raised') script.y = parent.y
  if (missing === 'far-right-parent') parent.x += 3
  if (missing === 'ambiguous-right-parent')
    page.lines.push({ ...parent, text: 'Independent ordinary input' })
  if (missing === 'missing-right-parent') page.lines.splice(11, 1)
  if (missing === 'clipped-script') script.height = 1
  if (missing === 'clipped-right-parent') parent.height = 1
  // Changed literals remain coherent with the native input. A stale expected
  // string must not masquerade as a successful ownership refusal.
  if (missing === 'non-digit' || missing === 'three-digits')
    page.expectedLines[7] = [page.lines[9].text, script.text, parent.text].join(' ')
  const before = structuredClone(page)
  expect(
    findCaptionCandidates([page]).some(
      (caption: { lines: string[] }) =>
        JSON.stringify(caption.lines) === JSON.stringify(page.expectedLines)
    )
  ).toBe(false)
  expect(page).toEqual(before)
})

const ordinarySuffixPage = (): ReturnType<typeof JSON.parse> => {
  const page = fixture()[4]
  const first = page.lines.shift()
  const em = first.fontSize
  const font = (text: string, x: number, y: number, width: number, fontSize = em): object => ({
    text,
    x,
    y,
    width,
    height: fontSize,
    fontSize
  })
  page.lines.unshift(
    font('FIG. 8. Complete native record comparison of q', 54, first.y, 110),
    font('2', 164.003, first.y - 0.8202, 3.653, (em * 2) / 3),
    font('input in K', 170.55, first.y, 23.45),
    font('+', 195.2, first.y - 0.82, 5.59, (em * 2) / 3),
    font('K', 201.3, first.y, 8.7),
    font('−', 211.3, first.y - 0.82, 5.756, (em * 2) / 3),
    font('ordinary records continue on the right.', 220, first.y, 79.08399104)
  )
  page.lines.push(font('¯', 250, first.y - 2.366, 4.6078))
  const closing = page.lines.find((line: { text: string }) => line.text.startsWith('x ≫'))
  closing.x = 54
  closing.width = 100
  closing.text = 'Independent closing source records.'
  page.expectedLines[0] =
    'FIG. 8. Complete native record comparison of q² input in K K − ordinary records continue on the right.'
  page.expectedLines[6] = closing.text
  page.graphicsBounds = [
    [72, 60, 190, 225],
    [73, 65, 189, 222],
    [74, 66, 188, 221]
  ].map((rect) => ({
    kind: 'path',
    normalizedRect: rect.map((value, axis) => value / (axis % 2 ? page.height : page.width))
  }))
  return page
}

it('retains an ordinary first-row suffix across its uniquely owned small native font', () => {
  const page = ordinarySuffixPage()
  const before = structuredClone(page)
  const captions = findCaptionCandidates([page])
  expect(captions.map((caption: { lines: string[] }) => caption.lines)).toEqual([
    page.expectedLines
  ])
  expect(captions[0].rect).toEqual([54, page.lines[1].y, 299.0848876799999, 308.8090000000001])
  expect(page).toEqual(before)
})

it.each([
  'missing-bridge',
  'clipped-bridge',
  'wrong-font',
  'bridge-gap',
  'ambiguous-parent',
  'clipped-parent',
  'ambiguous-bridge',
  'missing-graphic'
])('does not bridge an ordinary suffix without its complete %s witness', (missing) => {
  const page = ordinarySuffixPage()
  const bridge = page.lines.find((line: { text: string }) => line.text === '−')
  const parent = page.lines.find((line: { text: string }) => line.text === 'K')
  if (missing === 'missing-bridge')
    page.lines = page.lines.filter((line: object) => line !== bridge)
  if (missing === 'clipped-bridge') bridge.height = 1
  if (missing === 'wrong-font') bridge.fontSize = parent.fontSize
  if (missing === 'bridge-gap') bridge.x += 2
  if (missing === 'ambiguous-parent') page.lines.push({ ...parent, text: 'R' })
  if (missing === 'clipped-parent') parent.height = 1
  if (missing === 'ambiguous-bridge') page.lines.push({ ...bridge, text: '+' })
  if (missing === 'missing-graphic') page.graphicsBounds = []
  const before = structuredClone(page)
  expect(
    findCaptionCandidates([page]).some((caption: { lines: string[] }) =>
      caption.lines[0].includes('ordinary records continue on the right.')
    )
  ).toBe(false)
  expect(page).toEqual(before)
})

it('preserves the already complete same-baseline font program', () => {
  const page = ordinarySuffixPage()
  const parent = page.lines.find((line: { text: string }) => line.text === 'K')
  page.lines.find((line: { text: string }) => line.text === '−').y = parent.y
  const before = structuredClone(page)
  expect(findCaptionCandidates([page])[0].lines).toEqual(page.expectedLines)
  expect(page).toEqual(before)
})

const wrappedPanelPage = (): ReturnType<typeof JSON.parse> => ({
  pageNumber: 1,
  width: 612,
  height: 792,
  graphicsBounds: [],
  lines: [
    {
      text: 'A staged consistency update. As illustrated in',
      x: 69.369,
      y: 304.8094,
      width: 228.8309594,
      height: 9.9626,
      fontSize: 9.9626
    },
    {
      text: 'Fig. 7.b, records sharing the same category form matched pairs,',
      x: 54.425,
      y: 315.7674,
      width: 243.7748594,
      height: 9.9626,
      fontSize: 9.9626
    },
    {
      text: 'while records with different categories are compared separately.',
      x: 54.425,
      y: 326.7264,
      width: 243.7748594,
      height: 9.9626,
      fontSize: 9.9626
    }
  ]
})

it('keeps a dotted panel pointer in its tightly led native paragraph', () => {
  const page = wrappedPanelPage()
  const before = structuredClone(page)
  expect(findCaptionCandidates([page])).toEqual([])
  expect(page).toEqual(before)
})

it.each([
  'cue',
  'indent',
  'column',
  'right-edge',
  'font',
  'font-overlap',
  'leading',
  'separator',
  'plate',
  'panel-comma'
])('retains an independent panel title without its complete %s continuation witness', (missing) => {
  const page = wrappedPanelPage()
  const cue = page.lines[0]
  if (missing === 'cue') cue.text = 'An independent ordinary explanation of the matched records.'
  if (missing === 'indent') {
    const right = cue.x + cue.width
    cue.x = page.lines[1].x
    cue.width = right - cue.x
  }
  if (missing === 'column') cue.x += 260
  if (missing === 'right-edge') cue.width -= 25
  if (missing === 'font') cue.fontSize *= 0.9
  if (missing === 'font-overlap') cue.height += 2
  if (missing === 'leading') cue.y -= 20
  if (missing === 'panel-comma') page.lines[1].text = 'Fig. 7.b. Matched record comparison.'
  if (missing === 'plate')
    page.graphicsBounds.push({
      kind: 'image',
      normalizedRect: [
        54.425 / page.width,
        270 / page.height,
        298.2049 / page.width,
        315 / page.height
      ]
    })
  const rules =
    missing === 'separator' ? new Map([[1, [[54.425, 315.2, 298.2049, 315.2]]]]) : new Map()
  const before = structuredClone(page)
  expect(
    findCaptionCandidates([page], rules).some((caption: { lines: string[] }) =>
      caption.lines[0].startsWith('Fig. 7.b')
    )
  ).toBe(true)
  expect(page).toEqual(before)
})
