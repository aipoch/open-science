import { expect, it } from 'vitest'
import { readPdfTranslationCases } from '../fixtures/read-cases'
import { groupPdfTranslationPages, type PdfLayoutPage } from '../../src/reader/layout.js'

const wide = readPdfTranslationCases<{
  pages: PdfLayoutPage[]
  source: string
  together: string[][]
  separate: string[][]
}>('wide-caption-cross-page-native.jsonl')[0]
const notes = readPdfTranslationCases<{
  page: PdfLayoutPage
  first: string[]
  second: string[]
  sources: string[]
}>('symbolic-footnote-native-wrap.jsonl')[0]

function extract(pages: PdfLayoutPage[]): ReturnType<typeof groupPdfTranslationPages> {
  const result = groupPdfTranslationPages({ pages }),
    expected = pages.flatMap((page) =>
      page.items.flatMap((part, index) =>
        part.str.trim() ? [[`${page.page}:${index}`, part.str]] : []
      )
    ),
    actual = result.units.flatMap((unit) =>
      unit.items.map((key, index) => [key, unit.originalStrings[index]])
    )
  expect(actual.toSorted((a, b) => a[0].localeCompare(b[0]))).toEqual(
    expected.toSorted((a, b) => a[0].localeCompare(b[0]))
  )
  expect(new Set(actual.map(([key]) => key)).size).toBe(actual.length)
  return result
}

for (const cleared of [false, true]) {
  it(`proves a complete cross-column page sentence while keeping its caption separate, cleared=${cleared}`, () => {
    const pages = structuredClone(wide.pages)
    if (cleared)
      for (const page of pages)
        page.items.splice(0, 0, {
          str: '',
          width: 0,
          height: 0,
          dir: 'ltr',
          hasEOL: true,
          transform: [0, 0, 0, 0, 0, 0]
        })
    const result = extract(pages),
      offset = cleared ? 1 : 0,
      owner = (key: string): (typeof result.units)[number] => {
        const [page, index] = key.split(':').map(Number)
        return result.units.find((unit) => unit.items.includes(`${page}:${index + offset}`))!
      }
    for (const [left, right] of wide.together) expect(owner(left)).toBe(owner(right))
    for (const [left, right] of wide.separate) expect(owner(left)).not.toBe(owner(right))
    expect(owner('1:2').source).toBe(wide.source)
    expect(owner('1:2').kind).toBe('prose-candidate')
    expect(owner('1:2').fragments.map((fragment) => fragment.page)).toEqual([1, 2])
  })
  it(`separates symbolic attribution notes and preserves the complete dedented tail, cleared=${cleared}`, () => {
    const page = structuredClone(notes.page)
    if (cleared)
      page.items.splice(0, 0, {
        str: '',
        width: 0,
        height: 0,
        dir: 'ltr',
        hasEOL: true,
        transform: [0, 0, 0, 0, 0, 0]
      })
    const { units } = extract([page]),
      offset = cleared ? 1 : 0
    for (const [index, keys] of [notes.first, notes.second].entries()) {
      const adjusted = keys.map((key) => `1:${Number(key.split(':')[1]) + offset}`),
        unit = units.find((unit) => unit.items.includes(adjusted[0]))!
      expect(unit.items).toEqual(adjusted)
      expect(unit.source).toBe(notes.sources[index])
    }
  })
}

it.each([
  'finished-tail',
  'no-connector',
  'old-native-body',
  'missing-witness',
  'narrow-caption',
  'unlabelled-caption',
  'incomplete-caption',
  'caption-gap',
  'caption-risk',
  'body-interruption',
  'equation-interruption',
  'foreign-body',
  'missing-font',
  'rotation',
  'raised-scalar',
  'wrong-column',
  'margin-inside-body',
  'wrong-page'
])('rejects an unproven wide-caption page seam: %s', (fault) => {
  const pages = structuredClone(wide.pages),
    old = pages[0].items,
    next = pages[1].items
  if (fault === 'finished-tail') old[2].str += '.'
  if (fault === 'no-connector') old[2].str += ' evidence'
  if (fault === 'old-native-body') old.push({ ...old[2], str: 'Unaccounted body paragraph.' })
  if (fault === 'missing-witness') old[1].width -= 20
  if (fault === 'narrow-caption') for (const item of next.slice(0, 2)) item.width /= 2
  if (fault === 'unlabelled-caption') next[0].str = next[0].str.replace('Figure', 'Diagram')
  if (fault === 'incomplete-caption') next[1].str = next[1].str.replace(/[.]$/u, '')
  if (fault === 'caption-gap') for (const item of next.slice(2, 6)) item.transform[5] -= 30
  if (fault === 'caption-risk') next[1].str += ' undecoded ffi ffi'
  if (fault === 'body-interruption' || fault === 'equation-interruption')
    next.splice(2, 0, {
      ...next[2],
      str: fault === 'body-interruption' ? 'Independent body paragraph.' : 'q = r + s',
      hasEOL: true,
      transform: [10, 0, 0, 10, 40, 595]
    })
  if (fault === 'foreign-body') next[2].fontName = 'unrelated'
  if (fault === 'missing-font') delete next[2].fontName
  if (fault === 'rotation') next[2].transform[1] = 2
  if (fault === 'raised-scalar') next[3].transform[5] += 3
  if (fault === 'wrong-column') for (const item of next.slice(2, 6)) item.transform[4] += 20
  if (fault === 'margin-inside-body') old[3].transform[4] += 40
  if (fault === 'wrong-page') pages[1].page = 3
  const result = extract(pages),
    left = result.units.find((unit) => unit.items.includes('1:2'))!,
    right = result.units.find((unit) =>
      unit.items.includes(
        `${pages[1].page}:${next.indexOf(next.find((part) => part.str === 'a small proportion')!)}`
      )
    )!
  expect(left).not.toBe(right)
})

it.each([
  'single-note',
  'reversed-markers',
  'unknown-marker',
  'body-sized-marker',
  'low-marker',
  'peer-shift',
  'marker-gap',
  'not-at-bottom',
  'body-font',
  'tail-font',
  'tail-size',
  'tail-rotation',
  'native-interruption',
  'closed-sentence',
  'distant-tail',
  'large-leading'
])('rejects an unproven symbolic footnote wrap: %s', (fault) => {
  const page = structuredClone(notes.page),
    items = page.items
  if (fault === 'single-note') items[2].str = 'Unproven'
  if (fault === 'reversed-markers') [items[2].str, items[4].str] = [items[4].str, items[2].str]
  if (fault === 'unknown-marker') items[4].str = '§'
  if (fault === 'body-sized-marker')
    items[4].height = items[4].transform[0] = items[4].transform[3] = 9
  if (fault === 'low-marker') items[4].transform[5] -= 4
  if (fault === 'peer-shift') items[2].transform[4] -= 4
  if (fault === 'marker-gap') items[4].transform[4] -= 3
  if (fault === 'not-at-bottom') for (const item of items.slice(2)) item.transform[5] += 180
  if (fault === 'body-font') items[5].fontName = 'foreign'
  if (fault === 'tail-font') items[6].fontName = 'foreign'
  if (fault === 'tail-size') items[6].height = items[6].transform[0] = items[6].transform[3] = 7
  if (fault === 'tail-rotation') items[6].transform[1] = 2
  if (fault === 'native-interruption')
    items.splice(6, 0, { ...items[5], str: 'Independent note.', transform: [9, 0, 0, 9, 310, 86] })
  if (fault === 'closed-sentence') items[5].str += '.'
  if (fault === 'distant-tail') items[6].transform[4] -= 30
  if (fault === 'large-leading') items[6].transform[5] -= 10
  const result = extract([page]),
    tail = result.units.find((unit) => unit.source.includes('Laboratory.'))!
  expect(tail.items).not.toContain('1:5')
})

function readingLanePage(kind: 'two-column' | 'three-panel'): PdfLayoutPage {
  const native = (
    str: string,
    x: number,
    y: number,
    width: number,
    size = 10,
    bold = false,
    hasEOL = true
  ): PdfLayoutPage['items'][number] => ({
    str,
    width,
    height: size,
    dir: 'ltr',
    fontName: bold ? 'Bold' : 'Body',
    fontAscent: size === 8 ? (bold ? 0.693 : 0.455) : 0.8,
    fontDescent: size === 8 ? (bold ? -0.234 : -0.003) : -0.2,
    fontVertical: false,
    transform: [size, 0, 0, size, x, 800 - y],
    hasEOL
  })
  const paragraph = (title: string, x: number, y: number, count: number): PdfLayoutPage['items'] =>
    Array.from({ length: count }, (_, i) =>
      native(
        i === 0
          ? title + ' The source sentence has ordinary words.'
          : i === count - 1
            ? 'The final source line closes this paragraph.'
            : 'These ordinary words continue the same statement.',
        x,
        y + i * 12,
        230
      )
    )
  const items =
    kind === 'two-column'
      ? [
          native('Table 1: Complete native introductory caption.', 50, 50, 490),
          native('The caption closes before two complete text lanes.', 50, 62, 490),
          ...paragraph('First left paragraph.', 50, 100, 3),
          ...paragraph('Later left paragraph.', 50, 210, 5),
          ...paragraph('First right paragraph.', 310, 100, 4),
          ...paragraph('Later right paragraph.', 310, 300, 4)
        ]
      : ['a', 'b', 'c'].flatMap((label, column) => {
          const x = 50 + column * 145,
            y = column === 1 ? 144 : 100,
            count = [5, 7, 9][column]
          return [
            native('(' + label + ')', x, y, 8, 8, false, false),
            native('Panel ' + label + '.', x + 12, y, 60, 8, true, false),
            native('An ordinary panel explanation', x + 76, y, 63, 8),
            ...Array.from({ length: count - 1 }, (_, row) =>
              native(
                row === count - 2
                  ? 'the final native line closes this description.'
                  : 'ordinary source words continue the same panel',
                x,
                y + (row + 1) * 10,
                139,
                8
              )
            )
          ]
        })
  return { page: 1, width: 600, height: 800, rotation: 0, items }
}

for (const kind of ['two-column', 'three-panel'] as const) {
  it.each(['complete', 'missing-font', 'native-order', 'non-horizontal'] as const)(
    'orders complete native reading lanes without changing source eligibility: ' + kind + ' %s',
    (fault) => {
      const page = readingLanePage(kind)
      if (fault === 'missing-font') delete page.items[2].fontAscent
      if (fault === 'native-order') page.items.reverse()
      if (fault === 'non-horizontal') page.items[2].transform[2] = 1
      const saved = structuredClone(page),
        result = extract([page])
      const words =
        kind === 'two-column'
          ? ['Later left paragraph.', 'First right paragraph.']
          : ['Panel a.', 'Panel b.', 'Panel c.']
      const owners = words.map((word) => result.units.find((unit) => unit.source.includes(word))!)
      const order = owners.map((unit) => result.units.indexOf(unit))
      expect(owners.every((unit) => unit && !unit.sourceOnly)).toBe(true)
      if (kind === 'two-column') expect(order[0] < order[1]).toBe(fault === 'complete')
      else expect(order[1] < order[2]).toBe(fault === 'complete')
      expect(page).toEqual(saved)
    }
  )
}

it.each(['complete', 'finished tail', 'foreign prefix', 'narrow caption', 'shifted body'] as const)(
  'resumes the same body across pages below a spanning figure: %s',
  (shape) => {
    const text = (
      str: string,
      x: number,
      y: number,
      width: number,
      size = 10,
      fontName = 'Body',
      hasEOL = true
    ): PdfLayoutPage['items'][number] => ({
      str,
      width,
      height: size,
      dir: 'ltr',
      hasEOL,
      transform: [size, 0, 0, size, x, 800 - y],
      fontName,
      fontAscent: 0.8,
      fontDescent: -0.2,
      fontVertical: false
    })
    const old = [
      text('We measure the local samples collected for the experiment', 320, 680, 240),
      text('over a range of conditions before changing the settings.', 320, 692, 240),
      text('The comparisons use a repeated independent experiment', 320, 704, 240),
      text('to measure the changes in the observed response', 320, 716, 240, 10, 'Body', false)
    ]
    const lead = text('times before and after the adjustment. Each measurement', 40, 220, 240)
    const caption = text('Fig. 1: An overview of the workflow that aligns', 40, 190, 520)
    const next = [
      text('Input samples', 80, 80, 45, 7, 'Figure'),
      text('Observed response', 400, 125, 55, 7, 'Figure'),
      caption,
      text('the inputs and outputs', 40, 202, 92),
      lead,
      text('was repeated with the same samples to control for noise.', 40, 232, 240),
      text(
        'We report the resulting intervals for each measurement.',
        40,
        244,
        230,
        10,
        'Body',
        false
      )
    ]
    if (shape === 'finished tail') old[3].str += '.'
    if (shape === 'foreign prefix')
      next.splice(4, 0, text('An unrelated observation has more context.', 40, 212, 160))
    if (shape === 'narrow caption') caption.width = 240
    if (shape === 'shifted body') for (const line of next.slice(4)) line.transform[4] += 20
    const pages = [old, next].map((items, index) => ({
      page: index + 1,
      width: 600,
      height: 800,
      rotation: 0,
      items
    }))
    const { units } = extract(pages)
    const oldOwner = units.find((unit) => unit.items.includes('1:3'))!
    const leadOwner = units.find((unit) => unit.items.includes(`2:${next.indexOf(lead)}`))
    expect(leadOwner === oldOwner).toBe(shape === 'complete')
    expect(oldOwner.items).not.toContain('2:2')
  }
)

it.each(['complete', 'unknown-name', 'unrelated-heading'] as const)(
  'joins the named body continuation only past a complete spanning table: %s',
  (proof) => {
    const text = (
      str: string,
      x: number,
      y: number,
      width: number,
      size = 10,
      hasEOL = true
    ): PdfLayoutPage['items'][number] => ({
      str,
      width,
      height: size,
      dir: 'ltr',
      hasEOL,
      transform: [size, 0, 0, size, x, 800 - y],
      fontName: 'Body',
      fontAscent: 0.8,
      fontDescent: -0.2,
      fontVertical: false
    })
    const old = [
      text('We compare the repeated measurements collected from both sites.', 320, 680, 240),
      text('The differences in the mean response time were modest.', 320, 692, 240),
      text('We show the corresponding analysis in Table I, which evaluates', 320, 704, 240),
      text('these variations in the independent trial, particularly for', 320, 716, 240, 10, false)
    ]
    const caption = text('Table I: Results of the comparative analysis', 48, 55, 505)
    const next = [
      caption,
      text('Materials', 50, 70, 57, 7),
      text('First measure', 170, 70, 41, 7),
      text('Second measure', 290, 70, 43, 7),
      text('Third measure', 400, 70, 39, 7),
      ...['Initial', 'Second', 'Third', 'Fourth'].flatMap((label, index) => {
        const y = 83 + 11 * index
        return [
          text(label, 50, y, 52, 7),
          text(String(12 + index), 184, y, 20, 7),
          text(String(24 + index), 304, y, 20, 7),
          text(String(36 + index), 414, y, 20, 7)
        ]
      }),
      text('(a) Collection', 267, 130, 45, 9),
      text(
        'Note 1: The independent means describe the complete set of observations.',
        50,
        145,
        481,
        7
      ),
      text('Note 2: The differences are computed across all independent samples.', 50, 156, 481, 7)
    ]
    if (proof === 'unrelated-heading') next.push(text('A newly started section.', 40, 167, 160))
    const y = 173
    const lead = text(
      `${proof === 'unknown-name' ? 'Replacement' : 'Collection'}, except when the values differ in the experiment,`,
      40,
      y,
      240
    )
    next.push(
      lead,
      text('we report the resulting intervals for each separate case.', 40, y + 12, 240),
      text(
        'This rule controls for the influence of the sampling error.',
        40,
        y + 24,
        230,
        10,
        false
      )
    )
    const pages = [old, next].map((items, index) => ({
      page: index + 1,
      width: 600,
      height: 800,
      rotation: 0,
      items
    }))
    const result = extract(pages)
    const owner = result.units.find((unit) => unit.items.includes('1:3'))!
    const leadOwner = result.units.find((unit) => unit.items.includes(`2:${next.indexOf(lead)}`))
    expect(leadOwner === owner).toBe(proof === 'complete')
    expect(owner.items).not.toContain('2:0')
    expect(result.pages[1].blocks.filter((block) => block.tableCell)).toHaveLength(20)
  }
)

it.each([false, true])(
  'rejoins a word across columns under a spanning figure when native rows are consecutive (interrupted=%s)',
  (interrupted) => {
    const rows: [string, number, number, number][] = [
      [
        'Figure 1: Results of the calibration workflow viewed from several conditions.',
        40,
        445,
        520
      ],
      ['These graphs report a separate comparison observed across the sample.', 40, 456, 520],
      [
        'The calibration trial first establishes a stable baseline for future updates',
        40,
        488,
        254
      ],
      ['and shows how measurements agree under all the selected conditions', 40, 499, 254],
      ['without removing independent checks from the main procedure.', 40, 510, 235],
      ['This provides a broad comparison across the two control settings and', 40, 729, 254],
      ['demonstrates which implementation suffices, but only the software imple-', 40, 740, 254],
      ['mentation can support work on the next trial', 306, 488, 254],
      ['for each sample.', 306, 499, 96],
      ['alongside the fixed method used for comparison across each group', 306, 657, 254],
      ['before other measurements are analyzed separately.', 306, 668, 188],
      ['and compares performance across the full instrument test set', 306, 728, 254],
      ['over the course of the independent study.', 306, 740, 208]
    ]
    if (interrupted) rows.splice(7, 0, ['A separate measurement.', 310, 484, 130])
    const { units } = extract([
      {
        page: 1,
        width: 600,
        height: 840,
        rotation: 0,
        items: rows.map(([str, x, y, width]) => ({
          str,
          width,
          height: 10,
          dir: 'ltr',
          hasEOL: true,
          transform: [10, 0, 0, 10, x, 840 - y],
          fontName: 'roman',
          fontAscent: 0.67,
          fontDescent: -0.22,
          fontVertical: false
        }))
      }
    ])
    const outgoing = units.find((unit) => unit.items.includes('1:6')),
      incoming = units.find((unit) => unit.items.includes(interrupted ? '1:8' : '1:7')),
      caption = units.find((unit) => unit.items.includes('1:0'))
    expect(outgoing).toBeDefined()
    expect(incoming).toBeDefined()
    expect(caption).toBeDefined()
    expect(outgoing).not.toBe(caption)
    expect(incoming).not.toBe(caption)
    if (interrupted) expect(outgoing).not.toBe(incoming)
    else {
      expect(outgoing).toBe(incoming)
      expect(outgoing?.source).toContain('software implementation can support')
      expect(outgoing?.fragments).toHaveLength(2)
    }
  }
)

it.each([
  'same-style caption',
  'right column emitted first',
  'missing earlier caption',
  'different caption font',
  'unclosed left record',
  'skipped right ordinal',
  'intervening right text',
  'caption text overlap'
])('requires a bounded cross-column reference seam before releasing a caption: %s', (shape) => {
  const run = (
    str: string,
    x: number,
    y: number,
    width: number,
    fontName = 'Body',
    height = 9,
    hasEOL = true
  ): PdfLayoutPage['items'][number] => ({
    str,
    dir: 'ltr',
    width,
    height,
    fontName,
    hasEOL,
    transform: [height, 0, 0, height, x, 800 - y],
    fontAscent: 0.715,
    fontDescent: -0.282,
    fontVertical: false
  })
  const body = (x: number, y: number): PdfLayoutPage['items'] => [
    run('The test station records multiple independent measurements at each position.', x, y, 233),
    run(
      'We compare the processed numerical signal with the predicted model response.',
      x,
      y + 11,
      237
    ),
    run('The result supports the reproducibility of these observations.', x, y + 22, 210)
  ]
  const caption = (n: number, y: number, labelFont = 'Label'): PdfLayoutPage['items'] => [
    run(`Fig. ${n}.`, 315, y, 24, labelFont, 8.55, false),
    run('Comparison of repeated observations and numerical', 343, y, 220),
    run('fits for the detector under normal lab illumination.', 315, y + 11, 245),
    run('Reference curves summarize the repeated measurements.', 315, y + 22, 206)
  ]
  const record = (n: number, x: number, y: number, closed = true): PdfLayoutPage['items'] => [
    run(`${n}.`, x, y, 12, 'References', 7.5, false),
    run('A. Example, B. Sample, and C. Example, Methods for', x + 17, y, 219, 'References', 7.5),
    run(
      closed ? 'Experimental Controls 15, 57 (2023).' : 'Experimental Controls',
      x + 17,
      y + 10,
      172,
      'References',
      7.5
    )
  ]
  const earlier = caption(1, 298, shape === 'different caption font' ? 'Other' : 'Label')
  if (shape === 'missing earlier caption') earlier[0].str = 'Measurements'
  const target = caption(2, 429)
  const leftReferences = [
    run('REFERENCES', 42, 420, 65, 'Section', 9.5),
    ...record(4, 42, 442),
    ...record(5, 42, 470, shape !== 'unclosed left record')
  ]
  const rightReferences = [
    ...record(6, 315, 487),
    ...record(shape === 'skipped right ordinal' ? 8 : 7, 315, 514)
  ]
  const rightPrefix = [...body(315, 81), ...target]
  if (shape === 'intervening right text')
    rightPrefix.push(run('An unrelated note occupies this lane.', 325, 470, 180))
  if (shape === 'caption text overlap')
    rightPrefix.push(run('Other text', 350, 437, 48, 'Separate'))
  const current = [
    ...body(42, 80),
    ...body(42, 125),
    ...(shape === 'right column emitted first'
      ? [...rightPrefix, ...leftReferences]
      : [...leftReferences, ...rightPrefix]),
    ...rightReferences
  ]
  const result = extract([
    {
      page: 1,
      width: 612,
      height: 800,
      rotation: 0,
      items: [...body(42, 80), ...body(315, 80), ...earlier]
    },
    { page: 2, width: 612, height: 800, rotation: 0, items: current }
  ])
  const owner = (
    part: PdfLayoutPage['items'][number]
  ): ReturnType<typeof extract>['units'][number] =>
    result.units.find((unit) => unit.items.includes(`2:${current.indexOf(part)}`))!
  const selected = owner(target[0])
  const eligible = shape === 'same-style caption' || shape === 'right column emitted first'
  expect(selected.sourceOnly).toBe(eligible ? undefined : true)
  if (eligible) expect(selected.items).toEqual(target.map((item) => `2:${current.indexOf(item)}`))
  for (const part of [...leftReferences, ...rightReferences]) {
    expect(owner(part).sourceOnly).toBe(true)
    expect(owner(part).preserve).toBe('reference')
  }
})

it.each(['continuous', 'closed sentence', 'intervening body', 'unmatched imprint'])(
  'joins a page sentence below a centered column caption only when the native seam is complete: %s',
  (condition) => {
    const run = (
      str: string,
      x: number,
      y: number,
      width: number,
      fontName = 'Body',
      size = 9,
      hasEOL = true
    ): PdfLayoutPage['items'][number] => ({
      str,
      width,
      height: size,
      fontName,
      fontAscent: 0.7,
      fontDescent: -0.2,
      fontVertical: false,
      dir: 'ltr',
      hasEOL,
      transform: [size, 0, 0, size, x, 800 - y]
    })
    const imprint = 'PROC ’24, May 12, 2024, Example City'
    const before = [
        run(imprint, 54, 68, 102, 'Margin', 7),
        run('A. Example', 502, 68, 44, 'Margin', 7),
        run('Earlier measurements followed the same procedure in both methods.', 54, 170, 237),
        run('The resulting readings stayed stable for the baseline trial.', 54, 181, 212),
        run('The controller compares repeated readings when the timing varies', 307, 677, 239),
        run('so the test team can provide feedback where there is ambiguity', 307, 688, 239),
        run(
          'in the sequence of required changes during later measurements' +
            (condition === 'closed sentence' ? '.' : ''),
          307,
          699,
          238,
          'Body',
          9,
          false
        )
      ],
      after = [
        run('Alternate timing in repeated measurements', 54, 68, 163, 'Margin', 7),
        run(
          condition === 'unmatched imprint' ? imprint.replace('May 12', 'May 13') : imprint,
          444,
          68,
          102,
          'Margin',
          7
        ),
        run('Figure 1: Review workflow', 112, 225, 123, 'Caption'),
        run('and the team has identified several alternatives for the retry.', 54, 253, 238),
        run('The review shows which sequence meets the tolerances and leaves', 54, 264, 239),
        run('room for subsequent checks during operation.', 54, 275, 206)
      ]
    if (condition === 'intervening body')
      after.splice(2, 0, run('Unexpected prose continues on this line.', 54, 192, 202))
    const pages = [before, after].map((items, i) => ({
      page: i + 1,
      width: 600,
      height: 800,
      rotation: 0,
      items
    }))
    const { units } = extract(pages)
    const lhs = units.find((unit) => unit.items.includes('1:6'))!
    const rhs = units.find((unit) =>
      unit.items.includes('2:' + after.findIndex((item) => item.str.startsWith('and the')))
    )!
    const caption = units.find((unit) => unit.source === 'Figure 1: Review workflow')!
    expect(caption.fragments.map(({ page }) => page)).toEqual([2])
    expect(caption).not.toBe(rhs)
    if (condition === 'continuous') {
      expect(lhs).toBe(rhs)
      expect(lhs.fragments.map(({ page }) => page)).toEqual([1, 2])
    } else {
      expect(lhs).not.toBe(rhs)
    }
  }
)

it.each(['end matter', 'unmatched label font', 'missing companion'] as const)(
  'separates a funding run-in from a carried closing sentence: %s',
  (variant) => {
    const run = (
      str: string,
      x: number,
      y: number,
      width: number,
      fontName = 'Body',
      height = 9,
      hasEOL = true
    ): PdfLayoutPage['items'][number] => ({
      str,
      width,
      height,
      dir: 'ltr',
      fontName,
      fontFamily: 'sans-serif',
      fontAscent: 0.71,
      fontDescent: -0.28,
      fontVertical: false,
      hasEOL,
      transform: [height, 0, 0, height, x, y]
    })
    const blank = {
      str: '',
      width: 0,
      height: 0,
      dir: 'ltr',
      transform: [0, 0, 0, 0, 0, 0],
      hasEOL: true
    }
    const items = [
      run('The initial observations were made in a separate room.', 42, 735, 249),
      run('The results were recorded before the apparatus was moved.', 42, 724, 249),
      run('In later measurements the laboratory recorded a steady response', 54, 132, 237),
      run('from each independent trial with sufficient room for further', 42, 121, 249),
      run('observations as we tested the procedure described earlier.', 42, 110, 249),
      run('This demonstrates that the facility can be equipped with this', 42, 99, 249),
      run('new laboratory instrument.', 315, 737.2, 112, 'Body', 9, false),
      blank,
      run(
        'Funding.',
        315,
        722.7,
        39,
        variant === 'unmatched label font' ? 'Body' : 'Bold',
        9,
        false
      ),
      run('Support was provided by a public research council', 359, 722.7, 205, 'Body', 8),
      run(
        'for the extended measurements conducted during the second phase.',
        315,
        712.7,
        249,
        'Body',
        8
      ),
      run('The grant supported equipment and supplies.', 315, 702.7, 169, 'Body', 8, false),
      blank,
      run(
        variant === 'missing companion' ? 'Notes.' : 'Acknowledgements.',
        315,
        688.2,
        79,
        'Bold',
        9,
        false
      ),
      run('The authors thank the technical team for their support.', 400, 688.2, 164, 'Body', 8)
    ]
    const { units } = extract([{ page: 1, width: 612, height: 792, rotation: 0, items }])
    const closing = units.find((unit) => unit.items.includes('1:6'))!
    const funding = units.find((unit) => unit.items.includes('1:8'))!
    if (variant === 'end matter') {
      expect(closing.items).toContain('1:5')
      expect(closing.fragments).toHaveLength(2)
      expect(closing.source).toMatch(/this new laboratory instrument\.$/u)
      expect(funding.source).toMatch(/^Funding\. Support was provided/u)
      expect(funding.fragments).toHaveLength(1)
    } else {
      expect(closing).toBe(funding)
    }
  }
)

it.each([false, true])(
  'resumes a full-width measurement below the opening figure when the body rail matches (shifted=%s)',
  (shifted) => {
    const text = (
      str: string,
      x: number,
      y: number,
      width: number,
      hasEOL = true,
      size = 12,
      fontName = 'Body'
    ): PdfLayoutPage['items'][number] => ({
      str,
      width,
      height: size,
      dir: 'ltr',
      hasEOL,
      transform: [size, 0, 0, size, x, 800 - y],
      fontName,
      fontAscent: 0.8,
      fontDescent: -0.2,
      fontVertical: false
    })
    const header = (number: string): PdfLayoutPage['items'] => [
      text('Notes on sample measurements', 70, 64, 251, false, 12, 'Running'),
      text(number, 504, 64, 6, false)
    ]
    const x = shifted ? 95 : 70
    const pages = [
      [text('Experimental measurements', 70, 90, 330, true, 18, 'Title')],
      [
        ...header('2'),
        text('Results.', 94, 729, 45, false, 12, 'Label'),
        text('The observations are recorded after all samples have stabilized.', 144, 729, 366),
        text(
          'The same procedure is repeated for successive settings, allowing us to',
          70,
          745,
          440
        ),
        text('compare the curves and determine how to measure the peak', 70, 761, 440, false)
      ],
      [
        ...header('3'),
        text('Figure 1.', 140, 319, 48, false, 10, 'Label'),
        text(
          'A schematic showing the layout of the recording equipment',
          195,
          319,
          315,
          true,
          10,
          'Caption'
        ),
        text('and the position of the sensor.', 140, 332, 160, false, 10, 'Caption'),
        text(
          'response for each setting. In Fig. 2, the values are shown as a function',
          x,
          378,
          440
        ),
        text('of the adjustment applied before each independent observation.', x, 394, 440)
      ]
    ].map((items, index): PdfLayoutPage => ({
      page: index + 1,
      width: 600,
      height: 800,
      rotation: 0,
      items
    }))
    const { units } = extract(pages)
    const owner = (key: string): (typeof units)[number] =>
      units.find((unit) => unit.items.includes(key))!
    expect(owner('2:5')).toBeDefined()
    expect(owner('3:5')).toBeDefined()
    expect(owner('2:5') === owner('3:5')).toBe(!shifted)
    expect(owner('3:2')).not.toBe(owner('2:5'))
    if (!shifted) {
      expect(owner('2:5').source).toContain('peak response for each setting.')
      expect(owner('2:5').fragments.map(({ page }) => page)).toEqual([2, 3])
    }
  }
)

it.each([false, true])(
  'continues a conclusion past a web footnote and an opening caption (shifted=%s)',
  (shifted) => {
    const item = (
      str: string,
      x: number,
      y: number,
      width: number,
      hasEOL = true,
      size = 10,
      fontName = 'Body'
    ): PdfLayoutPage['items'][number] => ({
      str,
      width,
      height: size,
      dir: 'ltr',
      hasEOL,
      transform: [size, 0, 0, size, x, y],
      fontName,
      fontAscent: 0.8,
      fontDescent: -0.2,
      fontVertical: false
    })
    const data = [
      [item('Observations of the sample motion', 56, 745, 300, true, 16, 'Title')],
      [
        item('3 Conclusions and outlook', 56, 119, 227, false, 14, 'Heading'),
        item(
          'The measured path depends on both settings in the experiment, which are discussed above.',
          56,
          96,
          499
        ),
        item(
          'On a longer interval the measured paths might change, but for the same conditions their relative',
          56,
          84,
          499,
          false
        ),
        item('1', 68, 68, 4, false, 6, 'Note'),
        item('https://example.org/observations', 72, 65, 140, false, 8, 'Note'),
        item('2', 303.5, 27, 5, false)
      ],
      [
        item('Time interval', 220, 625, 40, false, 7, 'Axis'),
        item(
          'Figure 1: Left panel: the range of the baseline measurements in the selected samples.',
          56,
          542,
          499
        ),
        item(
          'Right panel: the corresponding variation after standardizing the output records.',
          56,
          530,
          499
        ),
        item('Both curves use the same units.', 56, 518, 136),
        item(
          'speed will remain very low during the first stage of the test.',
          shifted ? 82 : 56,
          475,
          420
        ),
        item(
          'Further observations will establish whether the trend extends to a larger group of samples.',
          shifted ? 97 : 71,
          463,
          480
        ),
        item('Acknowledgment', 56, 420, 135, false, 14, 'Heading')
      ]
    ]
    const pages = data.map((items, i): PdfLayoutPage => ({
      page: i + 1,
      width: 612,
      height: 792,
      rotation: 0,
      items
    }))
    const { units } = extract(pages)
    const head = units.find((unit) => unit.items.includes('2:2'))
    expect(head).toBeDefined()
    expect(head?.items.includes('3:4')).toBe(!shifted)
    expect(head?.fragments.map(({ page }) => page)).toEqual(shifted ? [2] : [2, 3])
    expect(units.find((unit) => unit.items.includes('3:1'))).not.toBe(head)
    expect(units.find((unit) => unit.items.includes('2:4'))).not.toBe(head)
  }
)

it.each(['complete', 'foreign-prose', 'unmatched-topic'])(
  'requires the native float stack and topic before joining a page sentence (%s)',
  (variant) => {
    const line = (
      str: string,
      x: number,
      baseline: number,
      width: number,
      size = 9,
      fontName = 'body',
      hasEOL = true
    ): PdfLayoutPage['items'][number] => ({
      str,
      width,
      height: size,
      dir: 'ltr',
      fontName,
      fontVertical: false,
      fontAscent: 0.84,
      fontDescent: -0.26,
      transform: [size, 0, 0, size, x, 792 - baseline],
      hasEOL
    })
    const page = (number: number, items: PdfLayoutPage['items']): PdfLayoutPage => ({
      page: number,
      width: 612,
      height: 792,
      rotation: 0,
      items
    })
    const head = 'Figure 2 illustrates how the three procedures respond to the same observation.'
    const breakLine =
      'One procedure produces a clear signal in the trial. Despite recovering most of the'
    const tail =
      'seasonal variation removed by the simpler procedure, the adjusted estimate remains stable'
    const ending = 'across repeated trials, preserving the measurement accuracy of the study.'
    const title = 'Paired Observations of Coastal Currents'
    const caption = (
      text: string,
      x: number,
      y: number,
      w: number,
      eol = true
    ): PdfLayoutPage['items'][number] => line(text, x, y, w, 8, 'caption', eol)
    const rows = [545, 556, 567, 582, 593, 604].flatMap((y, r) =>
      [151, 240, 295, 350, 406, 461].map((x, c) =>
        line(c ? `${2 + r}.${81 - c}` : `Protocol ${r + 1}`, x, y, c ? 18 : 50, 9, 'body', c === 5)
      )
    )
    const floats = [
      line(title, 73, 78, 184, 9, 'body', false),
      line('2', 498, 78, 4, 9, 'body', false),
      caption('(a) Early sample', 128, 214, 53, false),
      caption('(b) Later sample', 256, 214, 55, false),
      caption('(c) Matched sample', 416, 214, 66),
      caption(
        'Fig. 1. Profiles for the three tidal intervals at the sampled stations.',
        73,
        236,
        429
      ),
      caption('The uncertainty is shown for each profile.', 73, 246, 177, false),
      ...(variant === 'foreign-prose'
        ? [line('An independent paragraph separates the figures.', 73, 318, 260)]
        : []),
      caption('(a) Interval totals', 132, 416, 63, false),
      caption('(b) Corrected estimates', 321, 416, 96),
      caption('Fig. 2. The corrected estimate retains the pattern across trials.', 73, 438, 429),
      caption(
        variant === 'unmatched-topic'
          ? 'It recovers most of the lost measurement precision.'
          : 'It recovers most of the lost seasonal variation.',
        73,
        448,
        227
      ),
      caption('Table 1. Summary of the measurements.', 178, 492, 219),
      ...['Sample', 'Procedure', 'Mean', 'Median', 'Range', 'Spread', 'Score'].map((s, i) =>
        line(s, [78, 151, 240, 295, 350, 406, 461][i], 518, 23, 9, 'bold', i === 6)
      ),
      line('Coast', 78, 556, 24),
      line('Inlet', 78, 593, 20),
      ...rows
    ]
    const pages = [
      page(1, [
        line(
          'A separate preceding paragraph documents the native measurement baseline.',
          110,
          599,
          429
        ),
        line('This paragraph closes before the results are interpreted.', 110, 612, 367),
        line(head, 120, 639, 419),
        line(breakLine, 110, 653, 429, 9, 'body', false)
      ]),
      page(2, [...floats, line(tail, 73, 639, 429), line(ending, 73, 653, 330, 9, 'body', false)]),
      page(3, [line('The next leaf has a separate, complete paragraph.', 110, 105, 310)]),
      page(4, [line(title, 73, 78, 184, 9, 'body', false), line('4', 498, 78, 4)])
    ]
    const { units } = extract(pages)
    const first = units.find((unit) => unit.items.includes('1:2'))
    const second = units.find((unit) => unit.items.includes(`2:${floats.length}`))
    if (variant === 'complete') {
      expect(first).toBe(second)
      expect(first?.source).toBe(`${head} ${breakLine} ${tail} ${ending}`)
      expect(first?.items).toEqual(['1:2', '1:3', `2:${floats.length}`, `2:${floats.length + 1}`])
      expect(first?.fragments.map((fragment) => fragment.page)).toEqual([1, 2])
    } else {
      expect(first).not.toBe(second)
    }
  }
)
