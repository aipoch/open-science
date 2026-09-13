import { expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const { captionKind, findCaptionCandidates, groupPageLines } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-caption-group.mjs')).href
)
const { associateTableNotes } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-table-notes.mjs')).href
)
const { associateFigures, associateTableCaptions } = await import(
  pathToFileURL(resolve('resources/pdf-structure/literature-pdf-association.mjs')).href
)

it('keeps consecutive above-table captions with their own compact tables', () => {
  const page = { pageNumber: 6, height: 783, lines: [] }
  const tables = [{ rect: [38, 74, 225, 109] }, { rect: [35, 144, 245, 193] }]
  const captions = [
    { page: 6, lines: ['Table 2. Functional recovery'], rect: [45, 50, 224, 62] },
    { page: 6, lines: ['Table 3. Recovery scores'], rect: [45, 120, 169, 130] }
  ]
  expect(
    associateTableCaptions(page, tables, captions).map((m: { caption: unknown }) => m.caption)
  ).toEqual(captions)
  // A single title between two tables does not establish an above-table convention.
  expect(associateTableCaptions(page, tables, [captions[1]])[1].caption).toBeUndefined()
})

it('keeps an aligned German translation with its numbered English table title', () => {
  const line = (text: string, y: number): object => ({
    text,
    x: 40,
    y,
    width: 260,
    height: 8,
    fontSize: 8
  })
  const page = {
    pageNumber: 1,
    lines: [
      line('Table 3. Events after treatment.', 20),
      line('Tabelle 3. Ereignisse nach der Be-', 34),
      line('handlung.', 44),
      line('Treatment Count Percent', 64)
    ]
  }
  const rules = new Map([[1, [[40, 58, 320, 58]]]])
  expect(findCaptionCandidates([page], rules)[0].lines).toEqual([
    'Table 3. Events after treatment.',
    'Tabelle 3. Ereignisse nach der Be-',
    'handlung.'
  ])
  expect(findCaptionCandidates([page])[0].lines).toEqual(['Table 3. Events after treatment.'])
  const different = { ...page, lines: [page.lines[0], line('Tabelle 4. Other results.', 34)] }
  expect(findCaptionCandidates([different], rules)[0].lines).toEqual([
    'Table 3. Events after treatment.'
  ])
  const prose = { ...page, lines: [...page.lines, line('Unrelated paragraph.', 54)] }
  expect(findCaptionCandidates([prose], new Map([[1, [[40, 69, 320, 69]]]]))[0].lines).toEqual([
    'Table 3. Events after treatment.'
  ])
})

it('uses matching inset rules and keeps footnotes clear of a neighboring prose column', () => {
  const line = (text: string, x: number, y: number, width: number): object => ({
    text,
    x,
    y,
    width,
    height: 7,
    fontSize: 7
  })
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    lines: [
      line('*Results include screened patients', 350, 680, 200),
      line('The neighboring paragraph continues here.', 150, 686, 180),
      line('with earlier diagnoses and subsequent examinations.', 350, 690, 200),
      line('Further prose at the same vertical position.', 150, 696, 180),
      line('All cases were independently reviewed.', 350, 700, 200)
    ]
  }
  const tables = [{ rect: [328, 562, 555, 671] }]
  const caption = { page: 1, rect: [350, 739, 520, 746], lines: ['Table 1: Reasons for referral'] }
  const rules = [
    [350, 582, 552, 582],
    [350, 737, 552, 737]
  ]
  expect(associateTableCaptions(page, tables, [caption], rules)[0].caption).toBe(caption)
  expect(associateTableNotes(page, tables)[0][0].text).toBe(
    '*Results include screened patients with earlier diagnoses and subsequent examinations. All cases were independently reviewed.'
  )
})

it('includes a descriptive title in its own ruled strip below a bare table number', () => {
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    lines: [
      { text: 'Table 3', x: 40, y: 45, width: 25, height: 8, fontSize: 8 },
      {
        text: 'Recordings during anaesthesia. Values are mean±SD.',
        x: 40,
        y: 65,
        width: 300,
        height: 8,
        fontSize: 8
      },
      { text: 'Treatment Control', x: 300, y: 82, width: 120, height: 8, fontSize: 8 }
    ]
  }
  const rules = [
    [40, 60, 550, 60],
    [40, 77, 550, 77],
    [40, 94, 550, 94]
  ]
  expect(findCaptionCandidates([page], new Map([[1, rules]]))[0].lines).toEqual([
    'Table 3',
    'Recordings during anaesthesia. Values are mean±SD.'
  ])
  expect(findCaptionCandidates([page])[0].lines).toEqual(['Table 3'])
  expect(findCaptionCandidates([page], new Map([[1, rules.slice(1)]]))[0].lines).toEqual([
    'Table 3'
  ])
})

it('includes wrapped prose inside a ruled title strip without absorbing column headings', () => {
  const line = (text: string, x: number, y: number, width: number): object => ({
    text,
    x,
    y,
    width,
    height: 8,
    fontSize: 8
  })
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    lines: [
      line('Table 2', 40, 45, 25),
      line('Recordings during surgery. Values are mean±SD.', 40, 65, 300),
      line('No significant differences between groups.', 40, 77, 260),
      line('Treatment Control', 300, 96, 120)
    ]
  }
  const rules = [
    [40, 60, 550, 60],
    [40, 90, 550, 90],
    [40, 108, 550, 108]
  ]
  expect(findCaptionCandidates([page], new Map([[1, rules]]))[0].lines).toEqual([
    'Table 2',
    'Recordings during surgery. Values are mean±SD.',
    'No significant differences between groups.'
  ])
  const columns = {
    ...page,
    lines: [page.lines[0], page.lines[1], line('A separate column.', 380, 77, 150), page.lines[3]]
  }
  expect(findCaptionCandidates([columns], new Map([[1, rules]]))[0].lines).toEqual(['Table 2'])
})

it('keeps a bottom caption with its matching header and footer rules above a nearby table', () => {
  const page = { pageNumber: 1, width: 600, height: 800, lines: [] }
  const tables = [{ rect: [270, 130, 550, 220] }, { rect: [270, 280, 470, 580] }]
  const captions = [
    { page: 1, rect: [268, 256, 450, 263], lines: ['Table 2: Sensitivity'] },
    { page: 1, rect: [268, 603, 466, 619], lines: ['Table 3: Demographic profiles'] }
  ]
  const rules = [
    [268, 145, 560, 145],
    [268, 254, 560, 254],
    [268, 320, 470, 320],
    [268, 601, 470, 601]
  ]
  expect(
    associateTableCaptions(page, tables, captions, rules).map(
      (m: { caption: unknown }) => m.caption
    )
  ).toEqual(captions)
  const unrelated = rules.map((r) => [r[0], r[1], r[2] + 100, r[3]])
  expect(associateTableCaptions(page, tables, captions, unrelated)[0].caption).toBeUndefined()
})

it('keeps a centered table-caption continuation above the header rule', () => {
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    lines: [
      { text: 'Table 4. Toxicity by dosing', x: 100, y: 20, width: 300, height: 10, fontSize: 10 },
      { text: 'Schedule (n = 572)', x: 200, y: 32, width: 100, height: 10, fontSize: 10 },
      { text: 'Toxicity Grade', x: 200, y: 55, width: 100, height: 10, fontSize: 10 }
    ]
  }
  const rules = new Map([
    [
      1,
      [
        [90, 46, 410, 46],
        [90, 68, 410, 68]
      ]
    ]
  ])
  expect(findCaptionCandidates([page], rules)[0].lines).toEqual([
    'Table 4. Toxicity by dosing',
    'Schedule (n = 572)'
  ])
  expect(findCaptionCandidates([page])[0].lines).toEqual(['Table 4. Toxicity by dosing'])
  const offset = {
    ...page,
    lines: page.lines.map((line, i) => (i === 1 ? { ...line, x: 230 } : line))
  }
  expect(findCaptionCandidates([offset], rules)[0].lines).toEqual(['Table 4. Toxicity by dosing'])
  const wider = {
    ...page,
    lines: page.lines.map((line, i) => (i === 1 ? { ...line, x: 95, width: 310 } : line))
  }
  expect(findCaptionCandidates([wider], rules)[0].lines).toEqual([
    'Table 4. Toxicity by dosing',
    'Schedule (n = 572)'
  ])
})

it('stops a table caption at a full-width rule before identically styled column headers', () => {
  const lines = ['Table 1', 'Baseline characteristics.', 'Characteristic Treatment Control'].map(
    (text, i) => ({
      text,
      x: 50,
      y: 20 + i * 14,
      width: 280,
      height: 10,
      fontSize: 10
    })
  )
  const page = { pageNumber: 1, width: 600, height: 800, lines }
  const rules = new Map([[1, [[50, 46, 330, 46]]]])
  expect(findCaptionCandidates([page], rules)[0].lines).toEqual([
    'Table 1',
    'Baseline characteristics.'
  ])
  expect(findCaptionCandidates([page], new Map([[1, [[50, 46, 80, 46]]]]))[0].lines).toHaveLength(3)
})

it('associates a bottom table caption across its marked footnote, but not ordinary prose', () => {
  const caption = { page: 1, lines: ['Table 4. Biological profiles'], rect: [50, 250, 330, 262] }
  const text =
    'Determined by scoring size, nuclear grade, presence of necroses, and margin width in the study.'
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    lines: [{ text: '*' + text, x: 50, y: 220, width: 280, height: 8, fontSize: 8 }]
  }
  const tables = [{ rect: [45, 50, 340, 210] }]
  expect(associateTableCaptions(page, tables, [caption])[0].caption).toBe(caption)
  expect(
    associateTableCaptions({ ...page, lines: [{ ...page.lines[0], text }] }, tables, [caption])[0]
      .caption
  ).toBeUndefined()
})

it('recognizes wrapped abbreviation definitions and indented raised footnotes', () => {
  const textLine = (
    text: string,
    x: number,
    y: number,
    width = 280,
    fontSize = 8
  ): { text: string; x: number; y: number; width: number; height: number; fontSize: number } => ({
    text,
    x,
    y,
    width,
    height: fontSize,
    fontSize
  })
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    lines: [
      textLine('ABC, first definition; DEF, second defini-', 50, 220),
      textLine('tion; GHI, third definition.', 50, 230),
      textLine('a', 56, 241, 3, 5),
      textLine('Includes missing values in both groups', 63, 242, 265),
      textLine('where noted.', 50, 252, 80)
    ]
  }
  const notes = associateTableNotes(page, [{ rect: [45, 50, 340, 210] }])[0]
  expect(notes).toHaveLength(2)
  expect(notes[0].text).toContain('GHI, third definition.')
  expect(notes[1].text).toContain('where noted.')
  const prose = { ...page, lines: [textLine('ABC, one acronym in ordinary prose.', 50, 220)] }
  expect(associateTableNotes(prose, [{ rect: [45, 50, 340, 210] }])[0]).toEqual([])
})

it('uses the same ruled note evidence when associating a caption below the note', () => {
  const line = (text: string, y: number): object => ({
    text,
    x: 50,
    y,
    width: 280,
    height: 8,
    fontSize: 8
  })
  const text =
    'Treatment events recorded in the first study group (n = 1) and the second study group (n = 2).'
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    lines: [
      line('Response 12 (40) 15 (50)', 180),
      line('Survival 20 (65) 21 (70)', 200),
      line(text, 216)
    ]
  }
  const tables = [{ rect: [50, 50, 330, 208] }]
  const rules = [[50, 212, 330, 212]]
  const caption = { page: 1, lines: ['Table 4. Biological profiles'], rect: [50, 250, 330, 262] }
  expect(associateTableNotes(page, tables, rules)[0][0].text).toBe(text)
  expect(associateTableCaptions(page, tables, [caption], rules)[0].caption).toBe(caption)
  expect(associateTableCaptions(page, tables, [caption])[0].caption).toBeUndefined()
  expect(
    associateTableCaptions(page, tables, [caption], [[50, 212, 130, 212]])[0].caption
  ).toBeUndefined()
  const prose = {
    ...page,
    lines: [
      ...page.lines.slice(0, 2),
      line(
        'The authors discuss the implications of the findings for future clinical studies and treatment recommendations.',
        216
      )
    ]
  }
  expect(associateTableCaptions(prose, tables, [caption], rules)[0].caption).toBeUndefined()
})

it('recognizes same-size counted explanations only below a ruled numeric table', () => {
  const line = (
    text: string,
    y: number
  ): { text: string; x: number; y: number; width: number; height: number; fontSize: number } => ({
    text,
    x: 50,
    y,
    width: 280,
    height: 8,
    fontSize: 8
  })
  const body = [line('Response 12 (40) 15 (50)', 180), line('Survival 20 (65) 21 (70)', 200)]
  const tables = [{ rect: [50, 50, 330, 208] }]
  const rules = [[50, 212, 330, 212]]
  const note = line('Treatment events in the first group (n = 1) and second group (n = 2).', 216)
  expect(associateTableNotes({ lines: [...body, note] }, tables, rules)[0][0].text).toBe(note.text)
  expect(associateTableNotes({ lines: [...body, note] }, tables, [])[0]).toEqual([])
  expect(
    associateTableNotes(
      { lines: [...body, line('Ordinary discussion with a single count (n = 1).', 216)] },
      tables,
      rules
    )[0]
  ).toEqual([])
})

it('keeps a No. abbreviation definition below a table as a note', () => {
  const line = {
    text: 'No. = number of patients.',
    x: 50,
    y: 220,
    width: 150,
    height: 8,
    fontSize: 8
  }
  const page = { pageNumber: 1, width: 600, height: 800, lines: [line] }
  expect(associateTableNotes(page, [{ rect: [45, 50, 340, 210] }])[0][0].text).toBe(line.text)
  expect(associateTableNotes(page, [{ rect: [45, 50, 340, 230] }])[0]).toEqual([])
})

it.each([
  ['spaced figure heading', 'F I G U R E 3 Results'],
  ['spaced figure abbreviation', 'F I G. 2 Results'],
  ['supplement figure number', 'Figure S1. Supplement'],
  ['supplementary figure heading', 'Supplementary Fig. 2: Details'],
  ['Simplified Chinese figure', '\u56fe 1\uff1a\u7ed3\u679c'],
  ['Traditional Chinese figure', '\u57162. \u7d50\u679c']
])('recognizes figure caption format: %s', (_, text) => expect(captionKind(text)).toBe('figure'))
it.each([
  ['partially spaced table heading', 'TA B L E 1 Results'],
  ['spaced table heading', 'T A B L E 2 Results'],
  ['supplement table number', 'Table S2. Results'],
  ['supplemental table heading', 'Supplemental Table 3: Results'],
  ['uppercase Roman numeral', 'TABLE I'],
  ['Roman numeral with title', 'Table IV. Results'],
  ['lowercase Roman numeral from small capitals', 'table ii. Results'],
  ['Chinese table', '\u8868 2\uff1a\u7ed3\u679c']
])('recognizes table caption format: %s', (_, text) => expect(captionKind(text)).toBe('table'))
it('does not truncate a continuous long legend or absorb the next caption', () => {
  const lines = Array.from({ length: 25 }, (_, i) => ({
    text: i ? `Legend line ${i}` : 'Figure S1. Results',
    x: 10,
    y: i * 14,
    width: 180,
    height: 10,
    fontSize: 10
  }))
  lines.push({ ...lines[0], text: 'Table S2. Results', y: 350 })
  const result = findCaptionCandidates([{ pageNumber: 1, rotation: 0, lines }])
  expect(result[0].lines).toHaveLength(25)
  expect(result[0].lines.at(-1)).toBe('Legend line 24')
  expect(result).toHaveLength(2)
})

const page = {
  pageNumber: 1,
  width: 600,
  height: 800,
  invalidGraphicsBounds: 0,
  lines: [],
  graphicsBounds: [{ normalizedRect: [0.1, 0.25, 0.8, 0.5] }]
}
it('keeps a stroked border whose quantized bounds slightly overlap the caption edge', () => {
  const sample = {
    ...page,
    graphicsBounds: [
      { kind: 'path', normalizedRect: [0.1, 0.2, 0.8, 0.6045] },
      { kind: 'path', normalizedRect: [0.15, 0.25, 0.75, 0.58] }
    ]
  }
  const [result] = associateFigures(sample, [
    { page: 1, lines: ['Fig. 1. Workflow'], rect: [60, 480, 480, 490] }
  ])
  expect(result.rect).toEqual([60, 160, 480, 478])
})
it('keeps a figure above its caption when a recognized table lies below it', () => {
  const sample = {
    ...page,
    graphicsBounds: [...page.graphicsBounds, { normalizedRect: [0.15, 0.56, 0.4, 0.59] }]
  }
  const [result] = associateFigures(
    sample,
    [{ page: 1, lines: ['Figure 4. Training curves'], rect: [50, 402, 540, 425] }],
    [[85, 440, 250, 480]]
  )
  expect(result.rect).toEqual([60, 200, 480, 400])
})
it.each([
  [
    [0.1, 0.3, 0.28, 0.4],
    [0.42, 0.3, 0.6, 0.4]
  ],
  [
    [0.1, 0.3, 0.28, 0.4],
    [0.3, 0.1, 0.4, 0.28]
  ]
])('rejects mixed side directions without producing an inverted crop', (left, other) => {
  const mixed = {
    ...page,
    width: 1000,
    height: 1000,
    graphicsBounds: [left, other].map((normalizedRect) => ({ normalizedRect }))
  }
  const [result] = associateFigures(mixed, [
    { page: 1, lines: ['Figure 1. Results'], rect: [300, 300, 400, 400] }
  ])
  expect(result.rect).toBeUndefined()
  expect(result.reason).toBe('ambiguous-graphic-direction')
})
it('does not cross another caption to match a side legend', () => {
  const sample = {
    ...page,
    width: 1000,
    height: 1000,
    graphicsBounds: [{ normalizedRect: [0.05, 0.1, 0.2, 0.25] }]
  }
  const [result] = associateFigures(sample, [
    { page: 1, lines: ['Figure 1. Results'], rect: [250, 100, 400, 250] },
    { page: 1, lines: ['Table 1. Other'], rect: [210, 100, 240, 250] }
  ])
  expect(result.rect).toBeUndefined()
})
it('matches side captions without crossing the neighboring figure or including the caption', () => {
  const sidePage = {
    ...page,
    graphicsBounds: [
      { normalizedRect: [0.08, 0.08, 0.62, 0.4] },
      { normalizedRect: [0.08, 0.46, 0.62, 0.77] }
    ]
  }
  const figures = associateFigures(sidePage, [
    { page: 1, lines: ['Figure 6. Upper'], rect: [400, 60, 550, 275] },
    { page: 1, lines: ['Figure 7. Lower'], rect: [400, 360, 550, 520] }
  ])
  expect(figures.map((f: { rect: number[] }) => f.rect)).toEqual([
    [48, 64, 372, 320],
    [48, 368, 372, 616]
  ])
})
it('does not publish a divider rule as the figure belonging to a detached caption', () => {
  const divider = { ...page, graphicsBounds: [{ normalizedRect: [0.08, 0.75, 0.92, 0.758] }] }
  expect(
    associateFigures(divider, [
      { page: 1, lines: ['Figure 2. Next page'], rect: [48, 610, 552, 740] }
    ])[0].rect
  ).toBeUndefined()
})
it.each(['image', 'labelled-path', 'small-path'])('retains narrow real graphics: %s', (kind) => {
  const sample = {
    ...page,
    lines:
      kind === 'labelled-path' ? [{ text: 'A → B', x: 100, y: 190, width: 50, height: 8 }] : [],
    graphicsBounds: [
      {
        kind: kind === 'image' ? 'image' : 'path',
        normalizedRect: [0.055, 0.23, kind === 'small-path' ? 0.09 : 0.93, 0.246]
      }
    ]
  }
  expect(
    associateFigures(sample, [
      { page: 1, lines: ['Figure 1. Results'], rect: [36, 56, 558, 180] }
    ])[0].rect
  ).toBeDefined()
})
it('keeps a real figure above the caption when only a border rule lies below it', () => {
  const bordered = {
    ...page,
    graphicsBounds: [
      { normalizedRect: [0.1, 0.2, 0.8, 0.5] },
      { normalizedRect: [0.1, 0.62, 0.8, 0.627] }
    ]
  }
  const [result] = associateFigures(bordered, [
    { page: 1, lines: ['Figure 1. Results'], rect: [60, 410, 480, 480] }
  ])
  expect(result.rect).toEqual([60, 160, 480, 400])
})
it.each([
  [60, 150, 480, 180],
  [60, 420, 480, 450]
])('associates a caption above or below the graphic', (...rect) => {
  const result = associateFigures(page, [{ page: 1, lines: ['Figure S1. Results'], rect }])
  expect(result[0].rect).toEqual([60, 200, 480, 400])
})
it('leaves equidistant captions unresolved and refuses to cross intervening prose', () => {
  const candidates = [
    { page: 1, lines: ['Figure 1. Above'], rect: [60, 150, 480, 180] },
    { page: 1, lines: ['Figure 2. Below'], rect: [60, 420, 480, 450] }
  ]
  expect(associateFigures(page, candidates).every((c: { rect?: number[] }) => !c.rect)).toBe(true)
  const blocked = {
    ...page,
    lines: [{ text: 'Body prose '.repeat(10), x: 60, y: 185, width: 420, height: 10 }]
  }
  expect(associateFigures(blocked, [candidates[0]])[0].rect).toBeUndefined()
})

const noteLine = (
  text: string,
  x: number,
  y: number,
  width = 170,
  fontSize = 9
): { text: string; x: number; y: number; width: number; height: number; fontSize: number } => ({
  text,
  x,
  y,
  width,
  height: fontSize,
  fontSize
})
it('keeps table notes with their source rectangle without taking neighboring column prose', () => {
  const notes = associateTableNotes(
    {
      ...page,
      lines: [
        noteLine('* Reported', 60, 510, 80),
        noteLine('23', 141, 508, 8, 7),
        noteLine('results.', 151, 510, 60),
        noteLine('Main text in the other column.', 340, 514, 200, 10),
        noteLine('Continuation of the note.', 60, 523),
        noteLine('New body paragraph.', 60, 550, 200, 11)
      ]
    },
    [{ rect: [60, 100, 300, 500] }]
  )
  expect(notes[0]).toEqual([
    { text: '* Reported²³ results. Continuation of the note.', rect: [60, 508, 230, 532] }
  ])
})
it('associates an unnumbered abbreviation key and its continuation below a table', () => {
  const glossary = 'CLDN18.2, claudin 18.2; CPS, combined positive score; EBV, Epstein–Barr virus;'
  const result = associateTableNotes(
    {
      ...page,
      lines: [
        noteLine(glossary, 60, 510, 240),
        noteLine('MSI, microsatellite instability.', 60, 523, 240),
        noteLine('New body paragraph.', 60, 550, 240, 11)
      ]
    },
    [{ rect: [60, 100, 300, 500] }]
  )
  expect(result[0]).toEqual([
    { text: `${glossary} MSI, microsatellite instability.`, rect: [60, 510, 300, 532] }
  ])
  for (const text of ['CPS, a score used in this study; results follow.', glossary]) {
    expect(
      associateTableNotes({ ...page, lines: [noteLine(text, 60, 600, 240)] }, [
        { rect: [60, 100, 300, 500] }
      ])[0]
    ).toEqual([])
  }
  expect(
    associateTableNotes(
      {
        ...page,
        lines: [noteLine('CPS, a score used in this study; results follow.', 60, 510, 240)]
      },
      [{ rect: [60, 100, 300, 500] }]
    )[0]
  ).toEqual([])
})

it('preserves separate footnotes even when the last note is farther from the table', () => {
  const result = associateTableNotes(
    {
      ...page,
      lines: [
        noteLine('* First note.', 60, 510),
        noteLine('First continuation.', 60, 523),
        noteLine('† Second note.', 60, 536),
        noteLine('Second continuation.', 60, 549),
        noteLine('‡ Third note.', 60, 562)
      ]
    },
    [{ rect: [60, 100, 300, 500] }]
  )
  expect(result[0].map((note: { text: string }) => note.text)).toEqual([
    '* First note. First continuation.',
    '† Second note. Second continuation.',
    '‡ Third note.'
  ])
  expect(result[0][2].rect).toEqual([60, 562, 230, 571])
})
it('does not assign a note to tied tables or cross the next table', () => {
  const lines = [noteLine('* A note.', 60, 510), noteLine('Another table row.', 60, 523)]
  expect(
    associateTableNotes({ ...page, lines }, [
      { rect: [60, 100, 300, 500] },
      { rect: [60, 100, 300, 500] }
    ])
  ).toEqual([[], []])
  expect(
    associateTableNotes({ ...page, lines }, [
      { rect: [60, 100, 300, 500] },
      { rect: [60, 520, 300, 600] }
    ])[0][0].text
  ).toBe('* A note.')
})

it('does not union graphics on opposite sides of one caption and silently crop one side', () => {
  const bothSides = {
    ...page,
    width: 200,
    height: 200,
    graphicsBounds: [
      { normalizedRect: [0.2, 0.2, 0.8, 0.4] },
      { normalizedRect: [0.2, 0.65, 0.8, 0.85] }
    ]
  }
  expect(
    associateFigures(bothSides, [
      { page: 1, lines: ['Figure 1. Results'], rect: [40, 100, 160, 110] }
    ])[0]
  ).toMatchObject({ reason: 'ambiguous-graphic-direction' })
})
it('never treats a marked cell of the next table as a preceding table note', () => {
  const result = associateTableNotes(
    { ...page, lines: [noteLine('* Second table cell', 60, 515)] },
    [{ rect: [60, 100, 300, 500] }, { rect: [60, 510, 300, 600] }]
  )
  expect(result).toEqual([[], []])
})

it('prefers a nearby aligned caption over an equally close caption in the other column', () => {
  const sample = {
    ...page,
    graphicsBounds: [{ kind: 'image', normalizedRect: [48 / 600, 139 / 800, 304 / 600, 198 / 800] }]
  }
  const matches = associateFigures(sample, [
    { page: 1, lines: ['Fig. 5. Lower left'], rect: [49, 205, 300, 231] },
    { page: 1, lines: ['Fig. 6. Upper right'], rect: [312, 163, 563, 189] }
  ])
  expect(matches[0].rect).toEqual([48, 139, 304, 198])
  expect(matches[1].rect).toBeUndefined()
})

it('does not extend a figure into nearby column prose but retains its axis labels', () => {
  const sample = {
    ...page,
    graphicsBounds: [{ kind: 'image', normalizedRect: [48 / 600, 56 / 800, 304 / 600, 149 / 800] }],
    lines: [
      { text: 'Neighboring column prose', x: 312, y: 60, width: 250, height: 10 },
      { text: 'Axis', x: 35, y: 90, width: 10, height: 20 }
    ]
  }
  expect(
    associateFigures(sample, [
      { page: 1, lines: ['Fig. 16. Results'], rect: [49, 154, 300, 171] }
    ])[0].rect.map(Math.round)
  ).toEqual([35, 56, 304, 149])
})

it.each(['above', 'below'])('excludes the tail of an external paragraph %s a figure', (side) => {
  const above = side === 'above'
  const sample = {
    ...page,
    lines: [
      ...[0, 1, 2].map((i) => ({
        text: 'A continuous body paragraph with enough words to span the text column.',
        x: 70,
        y: above ? 149 + i * 14 : 410 + i * 14,
        width: 190,
        height: 10
      })),
      { text: 'A', x: 65, y: 202, width: 8, height: 10 },
      { text: 'Axis', x: 48, y: 280, width: 10, height: 20 }
    ]
  }
  const caption = {
    page: 1,
    lines: ['Fig. 2. Results'],
    rect: above ? [60, 410, 480, 425] : [60, 170, 480, 190]
  }
  expect(associateFigures(sample, [caption])[0].rect).toEqual([48, 200, 480, 400])
})

it('retains a two-line external chart title and text inside the graphic', () => {
  const sample = {
    ...page,
    lines: [
      ...[0, 1].map((i) => ({
        text: 'A long chart title that wraps into a second line of descriptive text',
        x: 80,
        y: 176 + i * 12,
        width: 350,
        height: 10
      })),
      ...[0, 1, 2].map((i) => ({
        text: 'A long explanatory label inside the image must remain visible.',
        x: 70,
        y: 220 + i * 12,
        width: 190,
        height: 10
      }))
    ]
  }
  expect(
    associateFigures(sample, [
      { page: 1, lines: ['Fig. 2. Results'], rect: [60, 410, 480, 425] }
    ])[0].rect
  ).toEqual([60, 176, 480, 400])
})

it('associates a short edge-aligned caption with a wider raster figure', () => {
  const sample = {
    ...page,
    graphicsBounds: [{ kind: 'image', normalizedRect: [0.25, 0.5, 0.95, 0.8] }]
  }
  const caption = { page: 1, lines: ['Fig. 1. Study flowchart.'], rect: [160, 646, 325, 655] }
  expect(associateFigures(sample, [caption])[0].rect).toEqual([150, 400, 570, 640])
  // A distant short caption or one in a different column cannot claim the image.
  expect(
    associateFigures(sample, [{ ...caption, rect: [160, 700, 325, 710] }])[0].rect
  ).toBeUndefined()
  expect(
    associateFigures(sample, [{ ...caption, rect: [10, 646, 80, 655] }])[0].rect
  ).toBeUndefined()
})

it.each(['Extended Data Fig. 1 | Results', 'Extended Data Figure 9. Results'])(
  'recognizes %s',
  (text) => {
    expect(captionKind(text)).toBe('figure')
  }
)

it('retains a two-column caption in reading order without absorbing an independent caption', () => {
  const line = (text: string, x: number, y: number, fontSize = 7): Record<string, unknown> => ({
    text,
    x,
    y,
    width: 250,
    height: fontSize,
    fontSize
  })
  const left = [
    line('Fig. 1 | Summary of results in the study.', 40, 500),
    line('The second line describes the first panel.', 40, 510)
  ]
  const right = [
    line('The right column continues the same detailed caption.', 305, 500),
    line('This final line describes the remaining panels.', 305, 510)
  ]
  const result = findCaptionCandidates([{ rotation: 0, pageNumber: 1, lines: [...left, ...right] }])
  expect(result[0].lines).toEqual([...left, ...right].map((l) => l.text))
  expect(result[0].rect).toEqual([40, 500, 555, 517])
  const independent = [
    { ...right[0], text: 'Fig. 2 | A separate caption for the next figure.' },
    right[1]
  ]
  expect(
    findCaptionCandidates([{ rotation: 0, pageNumber: 1, lines: [...left, ...independent] }])
  ).toHaveLength(2)
  const body = right.map((l) => ({ ...l, fontSize: 9, height: 9 }))
  expect(
    findCaptionCandidates([{ rotation: 0, pageNumber: 1, lines: [...left, ...body] }])[0].lines
  ).toHaveLength(2)
})

it('uses publisher separators to keep the next figure legend and body glyphs out of a captioned figure', () => {
  const sample = {
    ...page,
    graphicsBounds: [
      { kind: 'path', normalizedRect: [0.06, 0.045, 0.95, 0.05] },
      { kind: 'path', normalizedRect: [0.2, 0.07, 0.8, 0.75] },
      { kind: 'path', normalizedRect: [0.06, 0.82, 0.95, 0.83] },
      { kind: 'path', normalizedRect: [0.2, 0.85, 0.25, 0.88] },
      { kind: 'path', normalizedRect: [0.6, 0.85, 0.65, 0.88] },
      { kind: 'path', normalizedRect: [0.06, 0.95, 0.95, 0.96] }
    ]
  }
  const caption = { page: 1, lines: ['Fig. 1 | A tall figure.'], rect: [40, 610, 555, 645] }
  expect(associateFigures(sample, [caption])[0].rect).toEqual([120, 56.00000000000001, 480, 600])
})

it('retains a panel letter just above the graphic without crossing a publisher rule', () => {
  const sample = {
    ...page,
    lines: [{ text: 'a', x: 120, y: 54, width: 6, height: 10, fontSize: 10 }],
    graphicsBounds: [
      { kind: 'path', normalizedRect: [0.06, 0.045, 0.95, 0.05] },
      { kind: 'image', normalizedRect: [0.2, 0.1, 0.8, 0.5] }
    ]
  }
  const caption = { page: 1, lines: ['Fig. 1 | Results.'], rect: [40, 410, 555, 430] }
  expect(associateFigures(sample, [caption])[0].rect).toEqual([120, 54, 480, 400])
  sample.lines[0].y = 24
  expect(associateFigures(sample, [caption])[0].rect).toEqual([120, 80, 480, 400])
})

it('recognizes an adjacent-page arrow without losing the aligned legend continuation', () => {
  const source = {
    pageNumber: 2,
    rotation: 0,
    lines: [
      { text: '◂', x: 45, y: 55, width: 5, height: 8, fontSize: 8 },
      { text: 'Fig. 1 Results', x: 51, y: 55, width: 200, height: 8, fontSize: 8 },
      { text: 'The complete explanation.', x: 51, y: 65, width: 200, height: 8, fontSize: 8 }
    ]
  }
  expect(findCaptionCandidates([source])[0]?.lines).toEqual([
    'Fig. 1 Results',
    'The complete explanation.'
  ])
})

it('keeps both vector flowchart branches under a short figure number', () => {
  const sample = {
    ...page,
    graphicsBounds: [
      { kind: 'path', normalizedRect: [0.1, 0.3, 0.35, 0.5] },
      { kind: 'path', normalizedRect: [0.6, 0.3, 0.9, 0.5] }
    ]
  }
  const result = associateFigures(sample, [
    { page: 1, lines: ['Fig. 1'], rect: [60, 200, 90, 210] }
  ])[0]
  expect(result.rect).toEqual([60, 240, 540, 400])
})

it('recognizes pathology Image captions but not decorated inline references', () => {
  for (const text of [
    '❚Image 1❚ A, Core biopsy specimen.',
    '❚Image 2❚ Medium-power view.',
    'Image 3. Immunostain.'
  ])
    expect(captionKind(text)).toBe('figure')
  for (const text of [
    '❚Image 3❚. The tumor cells close to the probe application',
    'smudging ❚Image 1❚. In some cases'
  ])
    expect(captionKind(text)).toBeUndefined()
})

it('keeps a smaller continuation font in a side legend beside a substantial plot', () => {
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    graphicsBounds: [{ kind: 'path', normalizedRect: [0.1, 0.1, 0.6, 0.4] }],
    lines: [
      {
        text: 'Figure 1. The prevalence of signifi-',
        x: 380,
        y: 130,
        width: 150,
        height: 10,
        fontSize: 10
      },
      { text: 'cant postoperative pain.', x: 380, y: 141, width: 150, height: 9, fontSize: 9 },
      {
        text: 'Patients were followed for a year.',
        x: 380,
        y: 151,
        width: 150,
        height: 9,
        fontSize: 9
      }
    ]
  }
  expect(findCaptionCandidates([page])[0].lines).toHaveLength(3)
  expect(findCaptionCandidates([{ ...page, graphicsBounds: [] }])[0].lines).toHaveLength(1)
})

it('includes outlined axis glyphs close to a side-captioned plot', () => {
  const graphic = (r: number[]): { kind: string; normalizedRect: number[] } => ({
    kind: 'path',
    normalizedRect: r.map((v, i) => v / (i % 2 ? 800 : 600))
  })
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [],
    graphicsBounds: [
      graphic([100, 100, 350, 300]),
      ...Array.from({ length: 6 }, (_, i) => graphic([73, 125 + i * 20, 79, 133 + i * 20]))
    ]
  }
  const result = associateFigures(page, [
    { page: 1, lines: ['Figure 1. Side legend'], rect: [380, 130, 540, 220] }
  ])[0]
  expect(result.rect[0]).toBeLessThanOrEqual(73)
  expect(result.rect[2]).toBeLessThan(380)
})

it('associates a short raster caption across modest typesetting whitespace', () => {
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [],
    graphicsBounds: [{ kind: 'image', normalizedRect: [0.09, 0.09, 0.5, 0.54] }]
  }
  const caption = { page: 1, lines: ['Fig. 1. Study procedure.'], rect: [61, 459, 145, 466] }
  expect(associateFigures(page, [caption])[0].rect).toEqual([54, 72, 300, 432])
  const distant = { ...caption, rect: [61, 490, 145, 497] }
  expect(associateFigures(page, [distant])[0].rect).toBeUndefined()
})

it('joins centered manuscript table numbers to a separate ruled title without absorbing headers', () => {
  const line = (text: string, x: number, y: number, width: number, fontSize = 10): object => ({
    text,
    x,
    y,
    width,
    fontSize,
    height: fontSize
  })
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    lines: [
      line('TABLE 3.', 280, 79, 40, 9),
      line('Patient-reported responses by intervention arm', 78, 96, 350),
      line('From medical record review', 78, 110, 150),
      line('Author Manuscript', 22, 108, 12, 12),
      line('Response', 78, 140, 50, 8),
      line('Treatment', 200, 140, 50, 8)
    ]
  }
  const rules = new Map([
    [
      1,
      [
        [78, 134, 190, 134],
        [190, 134, 300, 134]
      ]
    ]
  ])
  expect(findCaptionCandidates([page], rules)[0].lines).toEqual([
    'TABLE 3.',
    'Patient-reported responses by intervention arm',
    'From medical record review'
  ])
  expect(findCaptionCandidates([page])[0].lines).toEqual(['TABLE 3.'])
})

it('includes repeated right-aligned category labels but excludes justified body text', () => {
  const lines = Array.from({ length: 10 }, (_, i) => ({
    text: 'CATEGORY_' + 'X'.repeat(i * 4),
    x: 100 - i * 4,
    y: 100 + i * 10,
    width: 100 + i * 4,
    height: 6,
    fontSize: 6
  }))
  const caption = { page: 1, lines: ['Figure 2. Category estimates.'], rect: [50, 230, 300, 240] }
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    graphicsBounds: [{ kind: 'path', normalizedRect: [210 / 600, 95 / 800, 290 / 600, 210 / 800] }],
    lines
  }
  expect(associateFigures(page, [caption])[0].rect[0]).toBe(64)
  const prose = {
    ...page,
    lines: lines.map((l) => ({
      ...l,
      text: 'An ordinary sentence describing the findings in the article.',
      x: 20,
      width: 180,
      fontSize: 9,
      height: 9
    }))
  }
  expect(associateFigures(prose, [caption])[0].rect[0]).toBe(210)
})

it('keeps the raised digit with an explicit statistical table note', () => {
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    lines: [
      { text: '1', x: 78, y: 448, width: 6, height: 7.5, fontSize: 7.9 },
      {
        text: 'Values are number (%) unless otherwise indicated',
        x: 82,
        y: 453,
        width: 180,
        height: 7.5,
        fontSize: 7.5
      }
    ]
  }
  const notes = associateTableNotes(page, [{ rect: [78, 120, 360, 440] }])
  expect(notes[0][0].text).toBe('¹ Values are number (%) unless otherwise indicated')
  expect(notes[0][0].rect).toEqual([78, 448, 262, 460.5])
})

it('recognizes spaced NS definitions and two-group sample-size notes below a table', () => {
  const line = (text: string, y: number): object => ({
    text,
    x: 40,
    y,
    width: 240,
    height: 8,
    fontSize: 8
  })
  const page = {
    pageNumber: 1,
    lines: [
      line('NS: not significant.', 105),
      line('GROUP: n = 27; counseling: n = 28; NS: not significant.', 116)
    ]
  }
  expect(
    associateTableNotes(page, [{ rect: [40, 20, 300, 100] }])[0]
      .map((n: { text: string }) => n.text)
      .join(' ')
  ).toContain('GROUP: n = 27; counseling: n = 28; NS: not significant.')
  expect(associateTableNotes(page, [{ rect: [40, 20, 300, 120] }])[0]).toEqual([])
})

it('keeps a hanging decorated title through its sample-size line above the table rule', () => {
  const page = {
    pageNumber: 8,
    width: 600,
    height: 800,
    lines: [
      {
        text: 'Table 4 & Return-to-Work Conditions After',
        x: 65,
        y: 34,
        width: 180,
        height: 14,
        fontSize: 14
      },
      {
        text: 'Tailored Rehabilitation Education',
        x: 109,
        y: 50,
        width: 139,
        height: 10,
        fontSize: 10
      },
      { text: 'Programs (N= 99)', x: 109, y: 62, width: 76, height: 10, fontSize: 10 },
      {
        text: 'Reference text from the neighboring column.',
        x: 305,
        y: 50,
        width: 225,
        height: 10,
        fontSize: 10
      },
      { text: 'Intervention Group (n=49)', x: 109, y: 80, width: 140, height: 10, fontSize: 10 }
    ]
  }
  const rules = new Map([[8, [[26, 78, 280, 78]]]])
  expect(findCaptionCandidates([page], rules)[0].lines).toEqual(
    page.lines.slice(0, 3).map((l) => l.text)
  )
  expect(findCaptionCandidates([page])[0].lines).toEqual([page.lines[0].text])
  const withoutSample = {
    ...page,
    lines: page.lines.map((l, i) => (i === 2 ? { ...l, text: 'Treatment groups' } : l))
  }
  expect(findCaptionCandidates([withoutSample], rules)[0].lines).toEqual([page.lines[0].text])
})

it('associates short captions offset from a wide inset raster without crossing a column', () => {
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [],
    graphicsBounds: [{ kind: 'image', normalizedRect: [0.16, 0.13, 0.85, 0.63] }]
  }
  const caption = { page: 1, lines: ['Figure 1. Flow diagram.'], rect: [60, 68, 155, 77] }
  expect(associateFigures(page, [caption])[0].rect).toBeDefined()
  const otherColumn = { ...caption, rect: [10, 68, 80, 77] }
  const ownCaption = { page: 1, lines: ['Figure 2. Own column.'], rect: [100, 85, 400, 94] }
  expect(associateFigures(page, [otherColumn, ownCaption])[0].rect).toBeUndefined()
})

it('retains hanging figure legends before an image and stops at body paragraphs', () => {
  const line = (text: string, x: number, y: number, width: number): object => ({
    text,
    x,
    y,
    width,
    height: 9,
    fontSize: 9
  })
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    graphicsBounds: [],
    lines: [
      line('Figure 2 Regression analysis and model selection. The horizontal axis', 60, 50, 450),
      line('represents the regularization parameter and the vertical axis', 100, 60, 420),
      line('represents the mean square error.', 100, 70, 210),
      line('The following paragraph describes independent results.', 60, 100, 400)
    ]
  }
  expect(findCaptionCandidates([page])[0].lines).toEqual([
    'Figure 2 Regression analysis and model selection. The horizontal axis',
    'represents the regularization parameter and the vertical axis',
    'represents the mean square error.'
  ])
  const prose = {
    ...page,
    lines: [page.lines[0], line('An unrelated short heading', 100, 90, 210)]
  }
  expect(findCaptionCandidates([prose])[0].lines).toHaveLength(1)
})

it('resolves equally close legends above stacked images using the lower image', () => {
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [],
    graphicsBounds: [
      { kind: 'image', normalizedRect: [0.3, 0.15, 0.7, 0.36] },
      { kind: 'image', normalizedRect: [0.13, 0.48, 0.87, 0.67] }
    ]
  }
  const captions = [
    { page: 1, lines: ['Figure 1. First plot.'], rect: [55, 50, 535, 90] },
    { page: 1, lines: ['Figure 2. Second plot.'], rect: [55, 318, 535, 355] }
  ]
  const result = associateFigures(page, captions)
  expect(result[0].rect).toEqual([180, 120, 420, 288])
  expect(result[1].rect).toEqual([78, 384, 522, 536])
})

it('keeps a captioned neighboring panel from making a raster legend ambiguous', () => {
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [],
    graphicsBounds: [
      { kind: 'path', normalizedRect: [0.07, 0.4, 0.48, 0.61] },
      { kind: 'path', normalizedRect: [0.16, 0.41, 0.46, 0.5] },
      { kind: 'image', normalizedRect: [0.55, 0.09, 0.9, 0.35] }
    ]
  }
  const result = associateFigures(page, [
    { page: 1, lines: ['Figure 1. Left plot.'], rect: [42, 490, 285, 512] },
    { page: 1, lines: ['Figure 2. Right image.'], rect: [312, 290, 553, 400] }
  ])
  expect(result.every((figure: { rect?: number[] }) => figure.rect)).toBe(true)
  expect(result[1].rect[0]).toBeGreaterThan(300)
})

it('excludes an isolated quantized footer frame without losing the plot above its legend', () => {
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: [{ text: 'Journal 309', x: 40, y: 747, width: 520, height: 9, fontSize: 9 }],
    graphicsBounds: [
      { kind: 'path', normalizedRect: [0.52, 0.66, 0.93, 0.86] },
      { kind: 'path', normalizedRect: [0.066, 0.925, 0.936, 0.941] }
    ]
  }
  expect(
    associateFigures(page, [
      { page: 1, lines: ['Figure 1. Results.'], rect: [312, 695, 553, 730] }
    ])[0].rect
  ).toEqual([312, 528, 558, 688])
})

it('keeps close statistical adjustment notes inside a captioned survival plot', () => {
  const caption = {
    page: 1,
    lines: ['Figure 2. Kaplan–Meier survival curves.'],
    rect: [50, 420, 550, 440]
  }
  const notes = [
    {
      text: 'HR adjusted for age, center, tumor size, histology, chemotherapy and baseline components.',
      x: 52,
      y: 392,
      width: 490,
      height: 8,
      fontSize: 8
    },
    {
      text: 'The adjustment also includes hormonal therapy and the number of metabolic syndrome components.',
      x: 52,
      y: 402,
      width: 490,
      height: 8,
      fontSize: 8
    }
  ]
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    lines: notes,
    graphicsBounds: [{ kind: 'image', normalizedRect: [50 / 600, 100 / 800, 550 / 600, 390 / 800] }]
  }
  const found = associateFigures(page, [caption])[0]
  expect(found.rect).toEqual([50, 100, 550, 410])
  expect(
    associateFigures({ ...page, lines: notes.map((l) => ({ ...l, fontSize: 11 })) }, [caption])[0]
      .rect
  ).toBeUndefined()
  expect(
    associateFigures(
      {
        ...page,
        lines: [
          {
            ...notes[0],
            text: 'The overall findings suggest a treatment benefit that requires further investigation in future studies.'
          },
          notes[1]
        ]
      },
      [caption]
    )[0].rect
  ).toBeUndefined()
})

it('excludes a following section heading supported by a continuing body paragraph', () => {
  const line = (text: string, y: number, height = 9): object => ({
    text,
    x: 60,
    y,
    width: 230,
    height,
    fontSize: height
  })
  const page = {
    pageNumber: 1,
    width: 600,
    height: 800,
    invalidGraphicsBounds: 0,
    graphicsBounds: [{ kind: 'image', normalizedRect: [0.1, 0.125, 0.9, 0.4] }],
    lines: [
      line('Conclusions', 330, 11),
      line('This paragraph discusses the implications of the analysis.', 345),
      line('The findings require interpretation in light of the design.', 357),
      line('Further study is needed to evaluate the clinical relevance.', 369)
    ]
  }
  const caption = { page: 1, lines: ['Figure 1. Diagnostic images.'], rect: [60, 70, 540, 90] }
  expect(associateFigures(page, [caption])[0].rect[3]).toBeLessThan(330)
  const label = { ...page, lines: [line('Conclusions', 330, 11)] }
  expect(associateFigures(label, [caption])[0].rect[3]).toBeGreaterThan(330)
})

it('finishes a dangling table title with one bounded hanging line', () => {
  const line = (text: string, x: number, y: number, width: number): object => ({
    text,
    x,
    y,
    width,
    height: 9,
    fontSize: 9
  })
  const start = line('Table 1 Clinical Characteristics and Imaging Features of', 60, 50, 240)
  const tail = line('Patients (n = 493)', 100, 60, 110)
  const header = line('Characteristics Treatment Control', 60, 82, 230)
  expect(findCaptionCandidates([{ pageNumber: 1, lines: [start, tail, header] }])[0].lines).toEqual(
    ['Table 1 Clinical Characteristics and Imaging Features of', 'Patients (n = 493)']
  )
  expect(
    findCaptionCandidates([
      { pageNumber: 1, lines: [line('Table 1. Characteristics.', 60, 50, 240), tail, header] }
    ])[0].lines
  ).toHaveLength(1)
})

it('bounds a double-spaced marked title continuation by the complete native table border', () => {
  const line = (text: string, y: number, width: number): object => ({
    text,
    x: 85,
    y,
    width,
    height: 12,
    fontSize: 12
  })
  const page = {
    pageNumber: 1,
    lines: [
      line('Table1. Patient', 106, 130),
      line('characteristics*', 133, 75),
      line('Control group', 161, 140)
    ]
  }
  const rules = [
    [80, 154, 114, 154],
    [114.4, 154, 220, 154]
  ]
  expect(findCaptionCandidates([page], new Map([[1, rules]]))[0].lines).toEqual([
    'Table1. Patient',
    'characteristics*'
  ])
  expect(findCaptionCandidates([page])[0].lines).toEqual(['Table1. Patient'])
  expect(findCaptionCandidates([page], new Map([[1, [rules[0]]]]))[0].lines).toEqual([
    'Table1. Patient'
  ])
  const complete = { ...page, lines: [line('Table1. Patient.', 106, 130), ...page.lines.slice(1)] }
  expect(findCaptionCandidates([complete], new Map([[1, rules]]))[0].lines).toEqual([
    'Table1. Patient.'
  ])
})

it('rejects running-text references while retaining numbered caption titles', () => {
  for (const text of [
    'Table 1 shows the outcomes.',
    'Fig. 2 presents the study flow.',
    'Figure 3 illustrates the changes.'
  ])
    expect(captionKind(text)).toBeUndefined()
  expect(captionKind('Table 1. Shows and recordings')).toBe('table')
  expect(captionKind('Fig. 2 Study flow')).toBe('figure')
})

it('retains double-spaced manuscript legends only below a legends heading', () => {
  const line = (text: string, y: number): object => ({
    text,
    x: 40,
    y,
    width: 440,
    height: 10,
    fontSize: 10
  })
  const lines = [
    line('LEGENDS', 200),
    line('FIGURE 1: Concentrations after treatment in', 230),
    line('participants and controls; top panel shows', 253),
    line('the mean and bottom panel shows the distribution.', 276)
  ]
  expect(findCaptionCandidates([{ pageNumber: 1, lines }])[0].lines).toHaveLength(3)
  expect(findCaptionCandidates([{ pageNumber: 1, lines: lines.slice(1) }])[0].lines).toHaveLength(1)
})

it('matches a title clipped only by crop padding when a complete source rule separates the data', () => {
  const caption = { page: 1, lines: ['Table 2. Baseline characteristics'], rect: [50, 48, 290, 58] }
  const page = { pageNumber: 1, width: 600, height: 800, lines: [] }
  const table = { rect: [48, 56, 550, 500] }
  expect(associateTableCaptions(page, [table], [caption], [[50, 61, 546, 61]])[0]?.caption).toEqual(
    caption
  )
  expect(associateTableCaptions(page, [table], [caption], [])[0]?.caption).toBeUndefined()
  expect(
    associateTableCaptions(page, [{ rect: [48, 51, 550, 500] }], [caption], [[50, 61, 546, 61]])[0]
      ?.caption
  ).toBeUndefined()
})

it('retains a raised unit exponent whose ascent differs by less than two points', () => {
  const left = { text: '500 mg/m', x: 50, y: 100, width: 45, height: 8, fontSize: 8 }
  const power = { text: '2', x: 95, y: 99, width: 3, height: 5.3, fontSize: 5.3 }
  const right = { text: 'of treatment', x: 99, y: 100, width: 50, height: 8, fontSize: 8 }
  expect(groupPageLines({ lines: [left, power, right] })[0].text).toBe('500 mg/m² of treatment')
  const detached = groupPageLines({ lines: [left, { ...power, x: 200 }, right] })
  expect(detached.some((l: { text: string }) => l.text.includes('²'))).toBe(false)
})

it('associates an explicitly labeled unnumbered table title without inventing a number', () => {
  // 39145953.pdf, PDF page 3: the article has a single table, titled "Table.".
  const text = 'Table. Clinicopathologic Characteristics of Patients in SOFT'
  const page = {
    pageNumber: 3,
    width: 612,
    height: 792,
    lines: [
      { text, x: 311.7826, y: 68.0598, width: 183.7641, height: 7.4835, fontSize: 7.4835 },
      { text: 'No. (%)', x: 397, y: 84, width: 25, height: 7, fontSize: 7 }
    ]
  }
  const candidates = findCaptionCandidates([page])
  expect(candidates).toHaveLength(1)
  expect(candidates[0].lines).toEqual([text])
  const result = associateTableCaptions(page, [{ rect: [308, 77.33, 520.67, 479.11] }], candidates)
  expect(result[0].caption?.lines).toEqual([text])
})

it('requires punctuation and title text for an unnumbered table label', () => {
  expect(captionKind('Table: Baseline characteristics')).toBe('table')
  for (const text of [
    'Table',
    'Table.',
    'Table shows the patient characteristics.',
    'Table. shows the patient characteristics.'
  ]) {
    expect(captionKind(text)).toBeUndefined()
  }
})

it('keeps stacked titles with their tables when a header rule precedes the predicted rows', () => {
  const page = { pageNumber: 173, height: 841.89, lines: [] }
  const tables = [
    { rect: [54, 177.3466, 516, 249.3671] },
    { rect: [56.6667, 311.5507, 516.6667, 754.8172] }
  ]
  const captions = [
    {
      page: 173,
      rect: [60.0015, 154.5002, 427.83135, 163.0002],
      lines: ['TABLE 33 Dose prescriptions']
    },
    {
      page: 173,
      rect: [60.0095, 271.5011, 224.57715, 280.0011],
      lines: ['TABLE 34 Amendments to eligibility criteria']
    }
  ]
  const rule = [63.0015, 307.8927, 512.9995, 307.8927]
  expect(
    associateTableCaptions(page, tables, captions, [rule]).map(
      (m: { caption: unknown }) => m.caption
    )
  ).toEqual(captions)
  expect(associateTableCaptions(page, tables, captions)[1].caption).toBeUndefined()
  expect(
    associateTableCaptions(page, tables, captions, [[230, 307.8927, 300, 307.8927]])[1].caption
  ).toBeUndefined()
})

it.each([
  ['FIG A1. Progression-free survival.', 'figure'],
  ['TABLE A4. Adverse events.', 'table'],
  ['FIG A1 shows the survival results.', undefined],
  ['Table A1 presents the analysis.', undefined]
])(
  'recognizes numbered appendix captions without accepting inline references: %s',
  (text, kind) => {
    expect(captionKind(text)).toBe(kind)
  }
)

it('associates a top-aligned marginal title on either side of a table', () => {
  const page = { pageNumber: 1, height: 800, lines: [] }
  const tables = [{ rect: [200, 100, 450, 300] }]
  for (const rect of [
    [40, 100, 180, 125],
    [475, 100, 590, 125]
  ]) {
    const caption = { page: 1, lines: ['Table 1. Baseline characteristics'], rect }
    expect(associateTableCaptions(page, tables, [caption])[0].caption).toEqual(caption)
    expect(
      associateTableCaptions(page, tables, [{ ...caption, rect: [475, 180, 590, 205] }])[0].caption
    ).toBeUndefined()
  }
})

it('stops a caption at a segmented native border overlapping the next glyph box slightly', () => {
  const line = (text: string, y: number, width: number): object => ({
    text,
    x: 72,
    y,
    width,
    height: 11,
    fontSize: 11
  })
  const page = {
    pageNumber: 1,
    lines: [
      line('Table 1. Definitions of key terms', 71, 245),
      line('Term Definition', 87.26, 213),
      line('Average price Actual price paid for medication', 103.2, 412)
    ]
  }
  const rules = [
    [66, 87.74, 234, 87.74],
    [234.5, 87.74, 545, 87.74]
  ]
  expect(findCaptionCandidates([page], new Map([[1, rules]]))[0].lines).toEqual([
    'Table 1. Definitions of key terms'
  ])
  expect(findCaptionCandidates([page], new Map([[1, [rules[0]]]]))[0].lines.length).toBeGreaterThan(
    1
  )
})
