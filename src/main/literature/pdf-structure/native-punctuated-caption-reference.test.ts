import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const { captionKind, findCaptionCandidates } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-caption-group.mjs')).href
)

it('recognizes a punctuated full figure keyword while preserving source text', () => {
  const text = 'Figure. 9. Native descriptor for independent panels.'
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    lines: [{ text, x: 50, y: 250, width: 480, height: 10, fontSize: 10 }]
  }
  expect(captionKind(text)).toBe('figure')
  expect(findCaptionCandidates([page])).toEqual([
    { page: 1, lines: [text], rect: [50, 250, 530, 260] }
  ])
})

it.each([
  'Fig. S5| Independent native panels with a complete descriptor.',
  'Fig. S5| Independent panels for |x| and |y| with an unchanged descriptor.'
])('recognizes an adjacent supplementary pipe while preserving the source: %s', (text) => {
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    lines: [{ text, x: 50, y: 250, width: 480, height: 10, fontSize: 10 }]
  }
  expect(captionKind(text)).toBe('figure')
  expect(findCaptionCandidates([page])[0].lines).toEqual([text])
  for (const source of [
    'Fig. S5| compares the separate measurements.',
    'Fig. S5|| Independent descriptor.',
    'Table S5| Independent descriptor.',
    'Fig. S5| x + y = z'
  ])
    expect(captionKind(source)).toBeUndefined()
})

it('does not promote finite comparisons or inline punctuation into captions', () => {
  for (const text of [
    'Figure 9 compares the separate measurements in the following paragraph.',
    'Figure. 9 compares the separate measurements in the following paragraph.',
    'Figure 9 compared the separate measurements in the preceding paragraph.',
    'Figure 9 shows the values described in the paragraph.',
    'Figure 9 retains the complete measured period.',
    'Figure 9 also retains the complete measured period.',
    'Figure 9 measures this effort before the independent evaluation.',
    'Figure 9 also measures this effort before the independent evaluation.',
    'Figure 9 contrasts the separate native measurements.',
    'Figure 9 (a) contrasts the separate native measurements.',
    'Figure 9 further contrast the separate native measurements.',
    'The preceding Figure. 9. has the same values.',
    'figure. this continuation describes the remaining panels.'
  ])
    expect(captionKind(text)).toBeUndefined()
})

it('retains descriptive comparison titles and existing numbered labels', () => {
  for (const text of [
    'Figure 9: Comparison of separate native measurements.',
    'Fig. 9. Native descriptor.',
    'Figure 9: Independent native panel description.',
    'Figure 9: Retains the complete measured period.',
    'Figure 9: Measures of the independent evaluation.',
    'Figure 9: Contrasts between the independent measured panels.',
    'Table A.2: Comparison of separate native measurements.',
    'Table 1 Compared sets',
    'Table 1 List of independent measurements',
    'Figure 9 Compared measurements'
  ])
    expect(captionKind(text)).toBe(text.startsWith('Table') ? 'table' : 'figure')
})

it('keeps a finite contrast reference in native body text beside a legitimate caption', () => {
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    lines: [
      {
        text: 'Figure 9: Independent comparison of measured records.',
        x: 50,
        y: 250,
        width: 480,
        height: 10,
        fontSize: 10
      },
      {
        text: 'Figure 9 contrasts the independent measured records.',
        x: 50,
        y: 290,
        width: 480,
        height: 12,
        fontSize: 12
      }
    ]
  }
  const before = structuredClone(page)
  expect(
    findCaptionCandidates([page]).map((caption: { lines: string[] }) => caption.lines)
  ).toEqual([[page.lines[0].text]])
  expect(page).toEqual(before)
})

type NativeLine = {
  text: string
  x: number
  y: number
  width: number
  height: number
  fontSize: number
}
type NativePage = {
  pageNumber: number
  width: number
  height: number
  lines: NativeLine[]
  graphicsBounds: {
    kind: string
    normalizedRect: number[]
    imageHash?: string
    operationIndex?: number
    imageEnvelopeNormalizedRect?: number[]
  }[]
}

function closedOutdentedParagraph(): NativePage {
  const texts = [
    'Figure 4: Complete independent panel observations begin with a measured view',
    'and continue across the complete native source rows without a new paragraph',
    'while all of the independent measurements retain their native placement',
    'before this complete separately printed explanation terminates.'
  ]
  return {
    pageNumber: 1,
    width: 600,
    height: 800,
    lines: [
      ...texts.map((text, i) => ({
        text,
        x: i ? 50 : 52.5,
        y: 300 + i * 17.2,
        width: i === 3 ? 460 : 480,
        height: 10,
        fontSize: 10
      })),
      { text: '9', x: 296, y: 760, width: 8, height: 10, fontSize: 10 }
    ],
    graphicsBounds: [{ kind: 'image', normalizedRect: [70 / 600, 90 / 800, 530 / 600, 285 / 800] }]
  }
}

it('retains a closed wide-leading native caption with a small first-row outdent at the page end', () => {
  const page = closedOutdentedParagraph()
  const before = structuredClone(page)
  expect(findCaptionCandidates([page])[0]).toEqual({
    page: 1,
    lines: page.lines.slice(0, 4).map((l) => l.text),
    rect: [50, 300, 532.5, 361.6]
  })
  expect(page).toEqual(before)
})

function closedStyledParagraph(): NativePage {
  const texts = [
    'Figure 4: (a) Independent native observations are printed in the first panel.',
    '(b) Separate complete native observations continue across the second panel',
    '(c) All independently printed records retain the complete panel description',
    'before the complete description terminates.'
  ]
  return {
    pageNumber: 1,
    width: 600,
    height: 800,
    lines: [
      { text: '(a) (b) (c)', x: 150, y: 276.5, width: 360, height: 14, fontSize: 14 },
      ...texts.map((text, i) => ({
        text,
        x: i === 0 ? 51 : i === 2 ? 50.5 : 50,
        y: 300 + (i ? 14.6 + (i - 1) * 13.55 : 0),
        width: i === 3 ? 280 : 480,
        height: i ? 10.9 : 12,
        fontSize: i ? 10.9 : 12
      })),
      {
        text: 'Table 4: Independent records remain outside the caption.',
        x: 50,
        y: 367.2,
        width: 480,
        height: 10.9,
        fontSize: 10.9
      },
      {
        text: 'whose complete printed description continues independently of the upper plate',
        x: 50,
        y: 380,
        width: 480,
        height: 12,
        fontSize: 12
      },
      {
        text: 'and retains its separate native table ownership and measured records.',
        x: 50,
        y: 394,
        width: 480,
        height: 12,
        fontSize: 12
      }
    ],
    graphicsBounds: Array.from({ length: 3 }, (_, i) => ({
      kind: 'image',
      imageHash: String(i + 1).repeat(64),
      operationIndex: i,
      normalizedRect: [(60 + i * 160) / 600, 100 / 800, (200 + i * 160) / 600, 276 / 800]
    }))
  }
}

it('retains a closed styled caption only under its complete native panel keys and raster owners', () => {
  const page = closedStyledParagraph()
  const before = structuredClone(page)
  expect(findCaptionCandidates([page])[0]).toEqual({
    page: 1,
    lines: page.lines.slice(1, 5).map((l) => l.text),
    rect: [50, 300, 531, page.lines[4].y + page.lines[4].height]
  })
  expect(page).toEqual(before)
})

it.each(['missing-raster', 'unclosed-tail', 'nonuniform-leading', 'missing-footer'])(
  'does not recover an outdented native paragraph without complete %s proof',
  (variant) => {
    const page = closedOutdentedParagraph()
    if (variant === 'missing-raster') page.graphicsBounds = []
    if (variant === 'unclosed-tail') page.lines[3].text = page.lines[3].text.replace(/\.$/u, '')
    if (variant === 'nonuniform-leading') page.lines[2].y += 3
    if (variant === 'missing-footer') page.lines.pop()
    const before = structuredClone(page)
    expect(findCaptionCandidates([page])[0].lines).not.toEqual(
      page.lines.slice(0, 4).map((l) => l.text)
    )
    expect(page).toEqual(before)
  }
)

it.each(['missing-key-row', 'duplicate-image-owner', 'missing-raster', 'unclosed-tail'])(
  'does not recover a styled native paragraph without complete %s proof',
  (variant) => {
    const page = closedStyledParagraph()
    const expected = page.lines.slice(1, 5).map((l) => l.text)
    if (variant === 'missing-key-row') page.lines.splice(0, 1)
    if (variant === 'duplicate-image-owner') page.graphicsBounds[1].operationIndex = 0
    if (variant === 'missing-raster') page.graphicsBounds = []
    if (variant === 'unclosed-tail') page.lines[4].text = page.lines[4].text.replace(/\.$/u, '')
    const before = structuredClone(page)
    expect(findCaptionCandidates([page])[0].lines).not.toEqual(expected)
    expect(page).toEqual(before)
  }
)

function nativeParagraphPage(mode: 'small-indent' | 'wide' | 'double' | 'styled'): NativePage {
  const em = 10
  const texts =
    mode === 'wide'
      ? [
          'Figure 3: Independent measured panels under a complete native descriptor.',
          ...Array.from({ length: 8 }, () => 'The independent native panel measurements continue'),
          'and terminate inside this separately printed caption.'
        ]
      : mode === 'double'
        ? [
            'Figure 3: Independent measured panels under a complete native descriptor.',
            'The complete native paragraph terminates before the body.'
          ]
        : [
            mode === 'styled'
              ? 'FIG. 3: Independent measured panels with a separately printed description'
              : 'Figure 3: Independent measured panels with a separately printed description',
            'whose complete source paragraph follows the original native baseline',
            'and terminates inside this separately printed caption.'
          ]
  const leading = mode === 'wide' ? 18.125 : mode === 'double' ? 21.75 : 10.45
  const lines: NativeLine[] = texts.map((text, i) => ({
    text,
    x: mode === 'small-indent' && i === 0 ? 53.5 : 50,
    y: 300 + (mode === 'styled' && i ? 13.2 + (i - 1) * 12 : i * leading),
    width: i === texts.length - 1 ? (mode === 'double' ? 460 : 330) : 460,
    height: mode === 'styled' && i ? 9 : em,
    fontSize: mode === 'styled' && i ? 9 : em
  }))
  lines.push({
    text: 'The following body paragraph belongs to the article and remains outside the caption.',
    x: 50,
    y: lines.at(-1)!.y + (mode === 'double' ? 33 : 30),
    width: 460,
    height: mode === 'double' ? em : 12,
    fontSize: mode === 'double' ? em : 12
  })
  return {
    pageNumber: 1,
    width: 600,
    height: 800,
    lines,
    graphicsBounds:
      mode === 'styled'
        ? [
            { kind: 'path', normalizedRect: [0.1, 0.08, 0.3, 0.34] },
            { kind: 'path', normalizedRect: [0.35, 0.08, 0.55, 0.34] },
            { kind: 'path', normalizedRect: [0.6, 0.08, 0.82, 0.34] }
          ]
        : [{ kind: 'image', normalizedRect: [0.12, 0.08, 0.82, 0.34] }]
  }
}

it.each(['small-indent', 'wide', 'double', 'styled'] as const)(
  'retains a complete graphic-owned %s native caption paragraph',
  (mode) => {
    const page = nativeParagraphPage(mode)
    const before = structuredClone(page)
    const caption = findCaptionCandidates([page])[0]
    expect(caption.lines).toEqual(page.lines.slice(0, -1).map((line) => line.text))
    expect(caption.rect).toEqual([
      50,
      300,
      mode === 'small-indent' ? 513.5 : 510,
      page.lines.at(-2)!.y + page.lines.at(-2)!.height
    ])
    expect(page).toEqual(before)
  }
)

function envelopeParagraphPage(): NativePage {
  const page = nativeParagraphPage('styled')
  page.graphicsBounds = [
    {
      kind: 'image',
      imageHash: 'a'.repeat(64),
      normalizedRect: [0.24, 0.09, 0.72, 0.38],
      imageEnvelopeNormalizedRect: [
        149.86666666666667 / 600,
        78.86666666666667 / 800,
        421.23333333333335 / 600,
        294.8333333333333 / 800
      ]
    }
  ]
  return page
}

it('retains the complete styled native paragraph using only a qualified raster upper-bound separation witness', () => {
  const page = envelopeParagraphPage()
  const before = structuredClone(page)
  const caption = findCaptionCandidates([page])[0]
  expect(caption.lines).toEqual(page.lines.slice(0, -1).map((l) => l.text))
  expect(caption.rect).toEqual([50, 300, 510, 334.2])
  expect(page).toEqual(before)
})

it.each([
  'missing-envelope',
  'invalid-envelope',
  'outside-operation',
  'upper-font-overlap',
  'missing-source-hash',
  'competing-image',
  'foreign-caption',
  'foreign-source',
  'missing-close',
  'unequal-baselines',
  'clipped-font-box',
  'foreign-font-corridor',
  'first-raised-font'
])('does not let the new envelope bypass complete native paragraph ownership: %s', (variant) => {
  const page = envelopeParagraphPage()
  const g = page.graphicsBounds[0]
  if (variant === 'missing-envelope') delete g.imageEnvelopeNormalizedRect
  if (variant === 'invalid-envelope') g.imageEnvelopeNormalizedRect![3] = Number.NaN
  if (variant === 'outside-operation') g.imageEnvelopeNormalizedRect![0] = 0.1
  if (variant === 'upper-font-overlap') g.imageEnvelopeNormalizedRect![3] = (300 + 0.001) / 800
  if (variant === 'missing-source-hash') delete g.imageHash
  if (variant === 'competing-image') page.graphicsBounds.push(structuredClone(g))
  if (variant === 'foreign-caption')
    page.lines[1].text = 'Figure 4: This source row belongs to another caption.'
  if (variant === 'foreign-source')
    page.lines.push({
      text: 'Separate source prose.',
      x: 80,
      y: 309,
      width: 180,
      height: 8,
      fontSize: 8
    })
  if (variant === 'missing-close') page.lines[2].text = 'an unfinished native continuation'
  if (variant === 'unequal-baselines') page.lines[2].y += 4
  if (variant === 'clipped-font-box') page.lines[1].height = 1
  if (variant === 'foreign-font-corridor')
    page.lines.push({ text: 'x', x: 180, y: 296, width: 4, height: 4, fontSize: 4 })
  if (variant === 'first-raised-font') {
    page.lines.push({ text: '2', x: 510, y: 299, width: 4, height: 6.5, fontSize: 6.5 })
    g.imageEnvelopeNormalizedRect![3] = 299.25 / 800
  }
  expect(findCaptionCandidates([page])[0].lines).not.toEqual(
    page.lines.slice(0, 3).map((l) => l.text)
  )
})

it.each(['small-indent', 'wide', 'double', 'styled'] as const)(
  'requires an independent native graphic for the %s paragraph override',
  (mode) => {
    const page = nativeParagraphPage(mode)
    page.graphicsBounds = []
    expect(findCaptionCandidates([page])[0].lines).not.toEqual(
      page.lines.slice(0, -1).map((line) => line.text)
    )
  }
)

it('refuses ambiguous or unbounded native paragraph ownership', () => {
  for (const variation of [
    'interposed-prose',
    'competing-caption',
    'missing-close',
    'unequal-leading'
  ]) {
    const page = nativeParagraphPage('wide')
    if (variation === 'interposed-prose')
      page.lines.push({
        text: 'This separate body sentence is printed between the plate and its caption.',
        x: 50,
        y: 276,
        width: 460,
        height: 10,
        fontSize: 10
      })
    if (variation === 'competing-caption') page.lines[4].text = 'Figure 4: A different caption.'
    if (variation === 'missing-close') page.lines.at(-2)!.text = 'an unfinished continuation'
    if (variation === 'unequal-leading') page.lines[4].y += 5
    expect(findCaptionCandidates([page])[0].lines).not.toEqual(
      page.lines.slice(0, -1).map((line) => line.text)
    )
  }
})

it('retains a closed native paragraph before a unique printed page ordinal', () => {
  const page = nativeParagraphPage('wide')
  page.lines.at(-1)!.text = '9'
  page.lines.at(-1)!.x = 296
  page.lines.at(-1)!.width = 8
  page.lines.at(-1)!.y = 760
  page.lines.at(-1)!.fontSize = 10
  expect(findCaptionCandidates([page])[0].lines).toEqual(
    page.lines.slice(0, -1).map((line) => line.text)
  )
  page.lines.at(-1)!.text = 'The separate body paragraph remains below this descriptor.'
  page.lines.at(-1)!.x = 50
  page.lines.at(-1)!.width = 460
  page.lines.at(-1)!.y = page.lines.at(-2)!.y + 18.125
  expect(findCaptionCandidates([page])[0].lines).not.toEqual(
    page.lines.slice(0, -1).map((line) => line.text)
  )
})

it('retains a small source label indent and its literal em-dash delimiter', () => {
  const page = nativeParagraphPage('small-indent')
  page.lines[0].text = 'Fig. 3.— Independent panels with a separately printed native description'
  page.graphicsBounds = [
    { kind: 'path', normalizedRect: [0.1, 0.08, 0.3, 0.34] },
    { kind: 'path', normalizedRect: [0.35, 0.08, 0.55, 0.34] },
    { kind: 'path', normalizedRect: [0.6, 0.08, 0.82, 0.34] }
  ]
  expect(findCaptionCandidates([page])[0].lines).toEqual(
    page.lines.slice(0, -1).map((line) => line.text)
  )
})

it('allows only a uniquely edge-attached source script to prove the compact baseline transition', () => {
  const page = nativeParagraphPage('small-indent')
  page.lines.splice(2, 0, {
    text: 'The next native baseline contains a uniquely attached script',
    x: 50,
    y: 322.4,
    width: 450,
    height: 10,
    fontSize: 10
  })
  page.lines[3].y = 332.85
  page.lines[4].y = 365
  const script = { text: '2', x: 500, y: 321.4, width: 4, height: 7, fontSize: 7 }
  page.lines.push(script)
  expect(findCaptionCandidates([page])[0].lines).toContain(page.lines[2].text + '²')
  page.lines.pop()
  expect(findCaptionCandidates([page])[0].lines).not.toContain(page.lines[2].text)
})

function nativeRadicalPage(): NativePage {
  const em = 10,
    texts = [
      'Figure 3: Independent native panels with a complete mathematical descriptor',
      'whose measured entries continue on the following native baselines',
      'under an unchanged source-font caption paragraph',
      'and an independently painted finite plate',
      '√',
      'n-scaled entries continue inside the same physical caption',
      'with all remaining native literal glyphs conserved',
      'through the separately printed terminal sentence.'
    ]
  const lines = texts.map((text, i) => ({
    text,
    x: i === 5 ? 79.004 : 70,
    y: i === 4 ? 344.8 : 300 + (i > 4 ? i - 1 : i) * 12.4,
    width: i === 4 ? 9 : i === 7 ? 330 : i === 5 ? 450.996 : 460,
    height: em,
    fontSize: em
  }))
  lines.push({
    text: 'The following article paragraph is separated from the complete caption.',
    x: 70,
    y: 410,
    width: 460,
    height: 12,
    fontSize: 12
  })
  return {
    pageNumber: 1,
    width: 600,
    height: 800,
    lines,
    graphicsBounds: [
      { kind: 'path', normalizedRect: [0.15, 0.1, 0.35, 0.34] },
      { kind: 'path', normalizedRect: [0.4, 0.1, 0.6, 0.34] },
      { kind: 'path', normalizedRect: [0.65, 0.1, 0.85, 0.34] }
    ]
  }
}

function twoThirdCaptionPage(closedTitle = false): NativePage {
  const texts = [
    closedTitle
      ? 'Figure 4.2: Separate native measurements with a closed title.'
      : 'Figure 4.2: Separate native measurements with an open descriptor',
    'The smaller native descriptor continues along the complete printed width',
    'with separately measured entries on the next physical source baseline',
    'and all of the original source words inside the independently owned paragraph',
    'through its terminal sentence.'
  ]
  const lines = texts.map((text, n) => ({
    text,
    x: 50,
    y: n ? 313.5 + (n - 1) * 9.5 : 300,
    width: n === 4 ? 200 : 460,
    height: n ? 8 : 12,
    fontSize: n ? 8 : 12
  }))
  lines.push({
    text: 'The following independent body paragraph remains separate.',
    x: 50,
    y: 365,
    width: 460,
    height: 12,
    fontSize: 12
  })
  return {
    pageNumber: 1,
    width: 600,
    height: 800,
    lines,
    graphicsBounds: [{ kind: 'image', normalizedRect: [50 / 600, 90 / 800, 510 / 600, 289 / 800] }]
  }
}

it.each([false, true])(
  'retains a complete two-thirds native caption body after a closed title: %s',
  (closed) => {
    const page = twoThirdCaptionPage(closed),
      before = structuredClone(page),
      caption = findCaptionCandidates([page])[0]
    expect(caption.lines).toEqual(page.lines.slice(0, 5).map((l) => l.text))
    expect(caption.rect).toEqual([50, 300, 510, 350])
    expect(page).toEqual(before)
  }
)

it.each([
  'missing-plate',
  'duplicate-plate',
  'unequal-leading',
  'wrong-size',
  'clipped-font',
  'foreign-caption',
  'unfinished',
  'foreign-crossing'
])('refuses an unproved two-thirds caption paragraph: %s', (reason) => {
  const page = twoThirdCaptionPage(true)
  if (reason === 'missing-plate') page.graphicsBounds = []
  if (reason === 'duplicate-plate')
    page.graphicsBounds.push(structuredClone(page.graphicsBounds[0]))
  if (reason === 'unequal-leading') page.lines[2].y += 2
  if (reason === 'wrong-size') page.lines[2].fontSize += 0.5
  if (reason === 'clipped-font') page.lines[2].height = 7
  if (reason === 'foreign-caption') page.lines[2].text = 'Figure 7: A separate native descriptor.'
  if (reason === 'unfinished') page.lines[4].text = 'through an unfinished terminal sentence'
  if (reason === 'foreign-crossing')
    page.lines.push({
      text: 'Independent body text.',
      x: 100,
      y: 326,
      width: 410,
      height: 12,
      fontSize: 12
    })
  expect(findCaptionCandidates([page])[0].lines).not.toEqual(
    page.lines.slice(0, 5).map((l) => l.text)
  )
})

function independentPanelPage(): NativePage {
  const texts = [
    'Figure 4. Separate native panels with a complete title.',
    'A. The first independent panel contains the measured source entries',
    'continued along the complete explanatory paragraph in the original type',
    'and its native baseline. B. The next panel contains separate measurements',
    'with complete source words. C. The last panel preserves the printed entries',
    'through the terminal sentence.'
  ]
  const lines = texts.map((text, n) => ({
    text,
    x: 50,
    y: n ? 322.25 + (n - 1) * 17.25 : 300,
    width: n === 0 ? 350 : n === 5 ? 210 : 460,
    height: 10,
    fontSize: 10
  }))
  lines.push({
    text: 'Independent article heading',
    x: 50,
    y: 430,
    width: 300,
    height: 10,
    fontSize: 10
  })
  return {
    pageNumber: 1,
    width: 600,
    height: 800,
    lines,
    graphicsBounds: [{ kind: 'image', normalizedRect: [50 / 600, 80 / 800, 510 / 600, 290 / 800] }]
  }
}

it('keeps a separately spaced native panel explanation with its unique raster title', () => {
  const page = independentPanelPage(),
    before = structuredClone(page)
  expect(findCaptionCandidates([page])[0].lines).toEqual(page.lines.slice(0, 6).map((l) => l.text))
  expect(findCaptionCandidates([page])[0].rect).toEqual([50, 300, 510, 401.25])
  expect(page).toEqual(before)
})

it.each([
  'missing-plate',
  'competing-plate',
  'nonsequential-keys',
  'section-heading',
  'wrong-font',
  'clipped-font',
  'wrong-leading',
  'foreign-caption',
  'open-terminal',
  'foreign-source'
])('rejects an independently unproved panel paragraph: %s', (reason) => {
  const page = independentPanelPage()
  if (reason === 'missing-plate') page.graphicsBounds = []
  if (reason === 'competing-plate')
    page.graphicsBounds.push(structuredClone(page.graphicsBounds[0]))
  if (reason === 'nonsequential-keys') page.lines[3].text = page.lines[3].text.replace('B.', 'D.')
  if (reason === 'section-heading')
    page.lines[3].text = 'B. Independent article section with a separate paragraph'
  if (reason === 'wrong-font') page.lines[3].fontSize = 11
  if (reason === 'clipped-font') page.lines[3].height = 9
  if (reason === 'wrong-leading') page.lines[3].y += 3
  if (reason === 'foreign-caption') page.lines[3].text = 'Figure 7: Independent native descriptor.'
  if (reason === 'open-terminal') page.lines[5].text = 'through an unfinished terminal sentence'
  if (reason === 'foreign-source')
    page.lines.push({
      text: 'Independent article prose.',
      x: 80,
      y: 350,
      width: 400,
      height: 12,
      fontSize: 12
    })
  expect(findCaptionCandidates([page])[0].lines).not.toEqual(
    page.lines.slice(0, 6).map((l) => l.text)
  )
})

it('keeps asking narrative pointers out of figure ownership while retaining descriptive titles', () => {
  expect(
    captionKind('Figure 5 asks whether conventional metrics recover the printed results.')
  ).toBeUndefined()
  expect(captionKind('Figure 5: Asking whether separate measurements agree.')).toBe('figure')
})

it('retains a uniquely adjoining raised radical and the remaining native caption', () => {
  const page = nativeRadicalPage(),
    before = structuredClone(page),
    caption = findCaptionCandidates([page])[0]
  expect(caption.lines).toEqual([
    ...page.lines.slice(0, 4).map((line) => line.text),
    '√ n-scaled entries continue inside the same physical caption',
    ...page.lines.slice(6, 8).map((line) => line.text)
  ])
  expect(caption.rect).toEqual([70, 300, 530, 384.4])
  expect(page).toEqual(before)
})

it('requires unique full-font radical attachment and a distinct caption boundary', () => {
  for (const variation of ['detached', 'duplicate', 'wrong-font', 'foreign-body']) {
    const page = nativeRadicalPage()
    if (variation === 'detached') page.lines[4].x -= 5
    if (variation === 'duplicate') page.lines.push({ ...page.lines[4] })
    if (variation === 'wrong-font') page.lines[4].fontSize = 6
    if (variation === 'foreign-body')
      page.lines.push({
        text: 'A separate foreign body line crosses the proposed caption paragraph.',
        x: 80,
        y: 362,
        width: 440,
        height: 12,
        fontSize: 12
      })
    expect(findCaptionCandidates([page])[0].lines).not.toContain(
      '√ n-scaled entries continue inside the same physical caption'
    )
  }
})
