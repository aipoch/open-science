import { describe, expect, it } from 'vitest'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { extractPdfTranslationSource } from '../../src/reader/extraction.js'
import type { PdfLayoutTextItem } from '../../src/reader/layout.js'
import { applyPdfContentFirstPolicy } from '../../src/reader/content-policy.js'

// A small native document, rather than a paper snapshot, exercises extraction,
// optional outline/link evidence, the reference interval, and Source ownership.
async function overviewFixture(fault = ''): Promise<{
  document: PDFDocumentProxy
  pages: ReturnType<typeof text>[][]
  name: string
  body: string
}> {
  const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const name = 'Overview of appendices',
    body = 'Appendix A explains methods. Appendix B explains results.'
  const pages = [
    [
      text('References', 60, 50, 100, 12, 'Section'),
      text('[1] A. Author. A complete publication. Journal, 2020.', 60, 100, 410, 8),
      text('[2] B. Writer. Another complete publication. Journal, 2021.', 60, 120, 430, 8)
    ],
    [
      text(name, 60, 80, name.length * 5, 10, 'Title'),
      text(body, 185, 80, body.length * 5),
      text('A', 60, 210, 7, 14, 'Section'),
      text('Methods', 75, 210, 49, 14, 'Section'),
      text(
        'The independent method explains the complete procedure and its reproducible implementation.',
        60,
        240,
        470
      )
    ],
    [text('B', 60, 80, 7, 14, 'Section'), text('Results', 75, 80, 49, 14, 'Section')]
  ]
  pages[1][0].hasEOL = false
  if (fault === 'unfinished-reference') pages[0][2].str = '[2] B. Writer. An unfinished publication'
  if (fault === 'wrong-first-title') pages[1][3].str = 'An unrelated title'
  if (fault === 'wrong-heading') pages[1][0].str = 'A study of appendices'
  const annotations = ['A', 'B'].map((label, index) => ({
    subtype: 'Link',
    rect: [
      185 + body.indexOf('Appendix ' + label) * 5 + 45,
      718,
      185 + body.indexOf('Appendix ' + label) * 5 + 50,
      728
    ],
    dest: 'section-' + index
  }))
  const outline = [
    { title: 'Methods', dest: 'section-0', items: [] },
    { title: 'Results', dest: 'section-1', items: [] }
  ]
  if (fault === 'duplicate-outline') outline.push({ ...outline[0] })
  if (fault === 'missing-link') annotations.pop()
  if (fault === 'reversed-links')
    [annotations[0].dest, annotations[1].dest] = [annotations[1].dest, annotations[0].dest]
  const fonts = Object.fromEntries(
    ['Body', 'Title', 'Section'].map((id) => [
      id,
      {
        missingFile: fault === 'fallback-font' && id === 'Title',
        isType3Font: false,
        isInvalidPDFjsFont: false,
        systemFontInfo: null,
        vertical: false,
        ascent: 0.8,
        descent: -0.2
      }
    ])
  )
  const document = {
    numPages: pages.length,
    fingerprints: ['anonymous-overview-source'],
    getOutline: async () => {
      if (fault === 'source-change') document.fingerprints = ['a-new-document']
      return fault === 'outline-budget' ? Array.from({ length: 257 }, () => outline[0]) : outline
    },
    getDestination: async (name: string) => {
      if (fault === 'outline-change') outline[0].title = 'A changed native outline'
      if (fault === 'annotation-change') annotations[0].rect[0] += 1
      if (fault === 'font-change') fonts.Title.missingFile = true
      return [
        { num: name === 'section-0' || fault === 'same-native-reference' ? 2 : 3, gen: 0 },
        { name: 'XYZ' },
        60,
        name === 'section-0' ? 606 : 736,
        null
      ]
    },
    getPageIndex: async (reference: { num: number }) => reference.num - 1,
    getPage: async (number: number) => ({
      rotate: 0,
      commonObjs: {
        get: (id: string) => fonts[id]
      },
      getViewport: () => ({ width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] }),
      getAnnotations: async () => (number === 2 ? annotations : []),
      getTextContent: async () => {
        if (number === 3 && fault === 'late-source-change')
          document.fingerprints = ['another-late-source']
        if (number === 3 && fault === 'late-outline-change')
          outline[0].title = 'Another late outline'
        return {
          items: pages[number - 1],
          styles: Object.fromEntries(
            ['Body', 'Title', 'Section'].map((font) => [
              font,
              { ascent: 0.8, descent: -0.2, vertical: false }
            ])
          )
        }
      },
      getOperatorList: async () => {
        const item = pages[number - 1][0],
          glyphs = Array.from(item.str).map((unicode, index) => ({
            unicode,
            isInFont: !(fault === 'unmapped-heading' && number === 2 && index === 2),
            width: 500
          }))
        return {
          fnArray: [
            OPS.beginText,
            OPS.setFont,
            OPS.setTextMatrix,
            OPS.setTextRenderingMode,
            OPS.showText
          ],
          argsArray: [
            [],
            [item.fontName, item.height],
            [[1, 0, 0, 1, item.transform[4], item.transform[5]]],
            [fault === 'invisible-heading' && number === 2 ? 3 : 0],
            [glyphs]
          ]
        }
      }
    })
  }
  if (fault === 'no-metadata-api') delete (document as Partial<typeof document>).getOutline
  return { document: document as unknown as PDFDocumentProxy, pages, name, body }
}

describe('native linked appendix overview boundary', () => {
  async function extract(fault = ''): Promise<{
    fixture: Awaited<ReturnType<typeof overviewFixture>>
    extraction: Awaited<ReturnType<typeof extractPdfTranslationSource>>
  }> {
    const fixture = await overviewFixture(fault)
    return {
      fixture,
      extraction: await extractPdfTranslationSource({
        document: fixture.document,
        resourceRequestKey: 'anonymous-overview',
        signal: new AbortController().signal
      })
    }
  }
  it('ends only the preceding reference interval at the complete native overview', async () => {
    const { fixture, extraction } = await extract(),
      unit = extraction.source.units.find((u) => u.source.startsWith(fixture.name))!
    expect(unit).toBeDefined()
    expect(unit.sourceOnly).not.toBe(true)
    expect(unit.preserve).toBeUndefined()
    expect(unit.referenceBoundary).toBe(true)
    expect(
      extraction.source.units.filter((u) => /^\[\d+\]/u.test(u.source)).map((u) => u.preserve)
    ).toEqual(['reference', 'reference'])
    expect(
      extraction.source.units.flatMap((u) =>
        u.fragments.flatMap((f) => f.items.map((i) => [f.pageNumber, i.index, i.text]))
      )
    ).toEqual(fixture.pages.flatMap((p, n) => p.map((i, index) => [n + 1, index, i.str])))
  })
  it.each([
    'unfinished-reference',
    'wrong-first-title',
    'wrong-heading',
    'duplicate-outline',
    'missing-link',
    'reversed-links',
    'source-change',
    'late-source-change',
    'late-outline-change',
    'outline-change',
    'annotation-change',
    'font-change',
    'same-native-reference',
    'outline-budget',
    'fallback-font',
    'unmapped-heading',
    'invisible-heading',
    'no-metadata-api'
  ])('retains the old reference protection for %s', async (fault) => {
    const { fixture, extraction } = await extract(fault),
      unit = extraction.source.units.find((u) => u.source.startsWith(fixture.pages[1][0].str))!
    expect(unit).toBeDefined()
    expect(unit.sourceOnly).toBe(true)
    expect(unit.preserve).toBe('reference')
    expect(unit.referenceBoundary).not.toBe(true)
  })
})

const text = (
  str: string,
  x: number,
  y: number,
  width: number,
  size = 10,
  fontName = 'Body'
): PdfLayoutTextItem & { fontName: string } => ({
  str,
  width,
  height: size,
  dir: 'ltr',
  transform: [size, 0, 0, size, x, 800 - y],
  fontName,
  hasEOL: true
})
const explanation =
  'This independent appendix explains the complete implementation and its reproducible procedure. The ordinary explanation remains separate from the preceding bibliography and the following code.'
function lastCommand(pages: ReturnType<typeof text>[][]): ReturnType<typeof text> {
  return pages.at(-1)!.find((i) => i.str.startsWith('docker load'))!
}
function fixture(
  kind: 'stacked' | 'overlapping',
  fault = ''
): { document: PDFDocumentProxy; pages: ReturnType<typeof text>[][] } {
  const pages = [
    [
      text('1.', 180, 80, 10, 11, 'Number'),
      text('Earlier construction', 195, 80, 210, 11, 'Section'),
      text(explanation, 60, 110, 480),
      text('2.', 180, 170, 10, 11, 'Number'),
      text('Independent measurements', 195, 170, 210, 11, 'Section'),
      text(explanation, 60, 200, 480)
    ],
    [
      text('References', 60, 90, 110, 12, 'Section'),
      text(
        '[1] A. Writer. A complete independent publication. Journal 12, 1–8 (2020).',
        60,
        120,
        230,
        8,
        'Citation'
      ),
      text(
        '[2] B. Author. Another complete publication. Journal 13, 2–9 (2021).',
        60,
        140,
        230,
        8,
        'Citation'
      )
    ]
  ]
  if (kind === 'stacked') {
    pages.push([
      text(
        '[3] C. Writer. Complete publication. Journal 14, 4–8 (2022).',
        60,
        120,
        230,
        8,
        'Citation'
      ),
      text(
        '[4] D. Author. Complete publication. Journal 15, 5–9 (2023).',
        60,
        140,
        230,
        8,
        'Citation'
      ),
      text('A', 400, 60, 7),
      text('PPENDIX', 408, 60, 37, 8),
      text('A', 382.5, 72, 7),
      text('UDIT', 390.5, 72, 22, 8),
      text('A', 417.5, 72, 7),
      text('PPENDIX', 425.5, 72, 37, 8),
      text('A. Overview', 320, 88, 80, 10, 'Subsection'),
      text(explanation, 320, 110, 230),
      text('B. Procedure', 320, 170, 90, 10, 'Subsection'),
      text(
        'A further independent paragraph describes the complete procedure and all ordinary implementation details.',
        320,
        195,
        230
      )
    ])
  } else {
    pages.push([
      text('Running title', 220, 35, 160, 8),
      text('Independent calculation details', 85, 70, 210, 18, 'Title'),
      text('Appendix', 150, 74, 50, 11, 'Section'),
      text('A.', 205, 74, 12, 11, 'Number'),
      text('Independent calculations', 222, 74, 225, 11, 'Section'),
      text('The polynomial profile.', 110, 110, 100, 10, 'Label'),
      text('In[1]:=', 85, 140, 25, 6, 'CodeLabel'),
      text('Expand[(u + 1)^2]', 115, 140, 120, 8, 'Code'),
      text('Out[1]=', 85, 170, 25, 6, 'CodeLabel'),
      text('1 + 2 u + u^2', 115, 170, 90, 8, 'Code')
    ])
  }
  if (kind === 'stacked') {
    pages
      .at(-1)!
      .push(
        text(
          'docker load -i archive.tar',
          320,
          225,
          'docker load -i archive.tar'.length * 8 * 0.6,
          8,
          'Code'
        ),
        text(
          'An ordinary monospaced sentence.',
          320,
          fault === 'mixed-code-prose' ? 250 : 300,
          31 * 8 * 0.6,
          8,
          'Code'
        )
      )
  }
  if (fault === 'command-prefixed-prose') {
    const item = lastCommand(pages)
    item.str = 'docker load uses a local archive.'
    item.width = item.str.length * 8 * 0.6
  }
  if (fault === 'unfinished-command') lastCommand(pages).str += ' \\'
  if (fault === 'output-explanation')
    pages
      .at(-1)!
      .push(
        text(
          'engine: *** exit detected ***',
          320,
          370,
          'engine: *** exit detected ***'.length * 8 * 0.6,
          8,
          'Code'
        ),
        text(
          'Assertion src == dst failed.',
          320,
          382,
          'Assertion src == dst failed.'.length * 8 * 0.6,
          8,
          'Code'
        ),
        text('Aborted', 320, 394, 7 * 8 * 0.6, 8, 'Code'),
        text('A separate explanation follows the diagnostic output.', 320, 430, 230)
      )
  if (kind === 'overlapping') pages.splice(1, 0, pages[0].splice(2))
  const last = pages.at(-1)!
  if (fault === 'citation-title')
    for (const item of last) if (item.str === 'Appendix') item.str = 'A study'
  if (fault === 'missing-section-witness')
    pages[0] = pages[0].filter((i) => i.fontName !== 'Section')
  if (fault === 'ordinary-title')
    for (const item of last) if (item.str === 'PPENDIX') item.str = 'NALYSIS'
  if (fault === 'foreign-prose')
    last.push(text('An unrelated native sentence shares the heading domain.', 320, 66, 190))
  if (fault === 'body-subsection')
    for (const item of last) if (item.fontName === 'Subsection') item.fontName = 'Body'
  const document = {
    numPages: pages.length,
    fingerprints: ['anonymous-compound-boundary'],
    getPage: async (number: number) => ({
      rotate: 0,
      commonObjs: {
        get: (id: string) =>
          id === 'Code' && fault !== 'missing-native-advance'
            ? {
                isMonospace: fault !== 'non-monospace',
                widths: Array.from({ length: 96 }, (_, n) =>
                  fault === 'variable-native-advance' && n === 4 ? 700 : 600
                )
              }
            : undefined
      },
      getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
      getViewport: () => ({ width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] }),
      getTextContent: async () => ({
        items: pages[number - 1],
        styles: Object.fromEntries(
          [
            'Body',
            'Section',
            'Number',
            'Citation',
            'Subsection',
            'Title',
            'Label',
            'CodeLabel',
            'Code'
          ].map((name) => [
            name,
            {
              ascent: fault === 'missing-metrics' && name === 'Body' ? undefined : 0.8,
              descent: -0.2,
              vertical: false
            }
          ])
        )
      })
    })
  } as unknown as PDFDocumentProxy
  return { document, pages }
}

describe('complete native compound appendix boundaries', () => {
  it.each([
    ['./run.sh -a -b value', true],
    ['MODE=x ./run.sh -a -- --b', true],
    [`./r.sh${'\t-A'.repeat(14)}!`, false]
  ] as const)('preserves only complete shell commands: %s', async (command, complete) => {
    const { document, pages } = fixture('stacked')
    const item = lastCommand(pages)
    item.str = command
    item.width = command.length * item.height * 0.6
    const { source } = await extractPdfTranslationSource({
      document,
      resourceRequestKey: 'anonymous',
      signal: new AbortController().signal
    })
    const prepared = applyPdfContentFirstPolicy(source)
    const explanationUnit = prepared.units.find(
      (unit) => unit.source === explanation && unit.fragments[0].pageNumber === document.numPages
    )!
    expect(explanationUnit.preserve === 'reference').toBe(!complete)
    expect(prepared.units.flatMap((unit) => unit.fragments)).toEqual(
      source.units.flatMap((unit) => unit.fragments)
    )
  })

  it.each(['stacked', 'overlapping'] as const)(
    'ends reference carryover at a complete %s appendix',
    async (kind) => {
      const { document } = fixture(kind)
      const extraction = await extractPdfTranslationSource({
        document,
        resourceRequestKey: 'anonymous',
        signal: new AbortController().signal
      })
      const prepared = applyPdfContentFirstPolicy(extraction.source)
      const unit = prepared.units.find((u) =>
        kind === 'stacked'
          ? u.source === explanation && u.fragments[0].pageNumber === document.numPages
          : u.source.includes('Appendix A.')
      )!
      expect(unit).toBeDefined()
      expect(unit.preserve).not.toBe('reference')
      expect(unit.sourceOnly).not.toBe(true)
      if (kind === 'stacked') {
        expect(
          prepared.units.find((u) => u.source === 'docker load -i archive.tar')?.preserve
        ).toBe('code')
        expect(
          prepared.units.find((u) => u.source === 'An ordinary monospaced sentence.')?.sourceOnly
        ).not.toBe(true)
      }
      expect(
        prepared.units.filter((u) => /^\[\d\]/u.test(u.source)).every((u) => u.sourceOnly)
      ).toBe(true)
      expect(
        prepared.units.flatMap((u) =>
          u.fragments.flatMap((f) => f.items.map((i) => [f.pageNumber, i.index, i.text]))
        )
      ).toEqual(
        extraction.source.units.flatMap((u) =>
          u.fragments.flatMap((f) => f.items.map((i) => [f.pageNumber, i.index, i.text]))
        )
      )
    }
  )
  it.each([
    ['stacked', 'ordinary-title'],
    ['stacked', 'foreign-prose'],
    ['stacked', 'body-subsection'],
    ['stacked', 'missing-metrics'],
    ['stacked', 'missing-native-advance'],
    ['stacked', 'variable-native-advance'],
    ['stacked', 'non-monospace'],
    ['stacked', 'unfinished-command'],
    ['stacked', 'command-prefixed-prose'],
    ['stacked', 'mixed-code-prose'],
    ['overlapping', 'citation-title'],
    ['overlapping', 'missing-section-witness']
  ] as const)('refuses an incomplete %s boundary: %s', async (kind, fault) => {
    const { document } = fixture(kind, fault)
    const extraction = await extractPdfTranslationSource({
      document,
      resourceRequestKey: 'anonymous',
      signal: new AbortController().signal
    })
    const prepared = applyPdfContentFirstPolicy(extraction.source)
    const unit = prepared.units.find((u) =>
      kind === 'stacked'
        ? u.source === explanation && u.fragments[0].pageNumber === document.numPages
        : u.source.includes('Independent calculation details')
    )!
    expect(unit).toBeDefined()
    expect(unit.sourceOnly).toBe(true)
  })
})

it('keeps an independent explanation following native diagnostic output eligible', async () => {
  const { document } = fixture('stacked', 'output-explanation')
  const extraction = await extractPdfTranslationSource({
    document,
    resourceRequestKey: 'anonymous',
    signal: new AbortController().signal
  })
  const source = applyPdfContentFirstPolicy(extraction.source)
  const unit = source.units.find(
    (u) => u.source === 'A separate explanation follows the diagnostic output.'
  )!
  expect(unit).toBeDefined()
  expect(unit.sourceOnly).not.toBe(true)
  expect(source.units.find((u) => u.source === 'docker load -i archive.tar')?.preserve).toBe('code')
  expect(source.units.find((u) => u.source.includes('engine: ***'))?.preserve).toBe('code')
})

// Generated native notes/captions keep bibliography continuations independent.
function pairedFigureNotesFixture(fault = ''): PDFDocumentProxy {
  const part = (
    str: string,
    x: number,
    y: number,
    width: number,
    font: string,
    height: number,
    hasEOL = true
  ): PdfLayoutTextItem => ({
    str,
    dir: 'ltr',
    width,
    height,
    transform: [height, 0, 0, height, x, 800 - y],
    fontName: font,
    hasEOL
  })
  const pair = (label: string, top: number): PdfLayoutTextItem[] => [
    part('Notes:', 60, top, 23, 'NoteItalic', 7, false),
    part(
      'The independent figure reports all complete observations from the ordinary experimental procedure',
      86,
      top,
      434,
      'NoteBody',
      7
    ),
    part(
      'and describes the measured outcomes using explicit source data and reproducible comparison methods.',
      60,
      top + 9,
      460,
      'NoteBody',
      7
    ),
    part(
      'Every panel describes a separate condition and all comparisons retain their original context.',
      60,
      top + 18,
      460,
      'NoteBody',
      7
    ),
    part('Fig. ' + label, 60, top + 42, label.length * 5 + 20, 'CaptionLabel', 10, false),
    part(
      ': Complete comparative results across independent experimental conditions',
      60 + label.length * 5 + 20,
      top + 42,
      440 - label.length * 5,
      'CaptionBody',
      10
    )
  ]
  const pages = [
    [...pair('1', 90), ...pair('2', 300)],
    [
      part('References', 60, 70, 120, 'Heading', 14),
      part(
        '[1] A. Author. A complete independent publication. Journal, 2020.',
        60,
        110,
        460,
        'Citation',
        10
      ),
      part(
        '[2] B. Writer. A second complete publication. Journal, 2021.',
        60,
        130,
        460,
        'Citation',
        10
      ),
      part(
        'Fig. A9: A bibliographic title about independent figure construction. Journal, 2022.',
        60,
        150,
        460,
        'Citation',
        10
      )
    ],
    [
      ...pair('A1', 150),
      part(
        '[3] C. Author. The first subsequent true citation. Journal, 2023.',
        60,
        500,
        460,
        'Citation',
        10
      ),
      part(
        '[4] D. Writer. The second subsequent true citation. Journal, 2024.',
        60,
        520,
        460,
        'Citation',
        10
      )
    ],
    [...pair(fault === 'interrupted appendix ordinal' ? 'A4' : 'A2', 150)]
  ]
  if (fault === 'one earlier style') pages[0].splice(6)
  if (fault === 'foreign overlapping source')
    pages[2].push(
      part('An unrelated source intersects the note domain.', 100, 159, 300, 'Citation', 10)
    )
  if (fault === 'cross-page incomplete note') {
    pages[3][2].str = pages[3][2].str.replace(/[.]$/u, ',')
    const tail = pages[3].splice(3, 1)[0]
    pages.push([{ ...tail, transform: [7, 0, 0, 7, 60, 700] }])
  }
  if (fault === 'zero advance source') pages[3][2].width = 0
  const names = ['NoteItalic', 'NoteBody', 'CaptionLabel', 'CaptionBody', 'Heading', 'Citation']
  const styles = Object.fromEntries(
    names.map((name) => [name, { vertical: false, ascent: 0.8, descent: -0.2 }])
  )
  const fonts = Object.fromEntries(
    names.map((name) => [
      name,
      {
        missingFile: false,
        isType3Font: false,
        isInvalidPDFjsFont: false,
        systemFontInfo: null,
        vertical: false,
        ascent: 0.8,
        descent: -0.2
      }
    ])
  )
  if (fault === 'unknown native font')
    delete (fonts.NoteItalic as Partial<typeof fonts.NoteItalic>).descent
  return {
    numPages: pages.length,
    fingerprints: ['anonymous-paired-figure-notes'],
    getPage: async (n: number) => ({
      rotate: 0,
      getViewport: () => ({
        width: 600,
        height: 800,
        rotation: 0,
        scale: 1,
        transform: [1, 0, 0, -1, 0, 800]
      }),
      getTextContent: async () => ({ items: pages[n - 1], styles }),
      getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
      commonObjs: { get: (id: string) => fonts[id], has: (id: string) => id in fonts }
    })
  } as unknown as PDFDocumentProxy
}

describe('complete native paired figure notes after references', () => {
  it.each([
    'complete',
    'one earlier style',
    'interrupted appendix ordinal',
    'unknown native font',
    'foreign overlapping source',
    'cross-page incomplete note',
    'zero advance source'
  ])('restores only independently closed ordinary notes and captions: %s', async (fault) => {
    const extraction = await extractPdfTranslationSource({
      document: pairedFigureNotesFixture(fault),
      resourceRequestKey: 'anonymous-paired-notes',
      signal: new AbortController().signal
    })
    for (const source of [extraction.source, applyPdfContentFirstPolicy(extraction.source)]) {
      const notes = source.units.filter(
        (u) => u.fragments[0].pageNumber === 3 && u.source.startsWith('Notes:')
      )
      const caption = source.units.find(
        (u) => u.fragments[0].pageNumber === 3 && u.source.startsWith('Fig. A1:')
      )!
      expect(notes).toHaveLength(1)
      expect(notes[0].sourceOnly === true).toBe(fault !== 'complete')
      expect(caption.sourceOnly === true).toBe(fault !== 'complete')
      expect(
        source.units
          .filter((u) => /^\[[1-4]\]/u.test(u.source))
          .every((u) => u.sourceOnly && u.preserve === 'reference')
      ).toBe(true)
      for (const index of [6, 7]) {
        const owners = source.units.filter((u) =>
          u.fragments.some((f) => f.pageNumber === 3 && f.items.some((i) => i.index === index))
        )
        expect(owners).toHaveLength(1)
        expect(owners[0].sourceOnly).toBe(true)
        expect(owners[0].preserve).toBe('reference')
      }
      const title = source.units.find((u) =>
        u.fragments.some((f) => f.items.some((i) => i.text.startsWith('Fig. A9:')))
      )!
      expect(title.sourceOnly).toBe(true)
      expect(title.preserve).toBe('reference')
    }
  })
})

async function outlineRestartFixture(fault = ''): Promise<{
  document: PDFDocumentProxy
  heading: string
  body: string
  pages: ReturnType<typeof text>[][]
}> {
  const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const heading = '1 Independent Construction',
    body =
      'This independent explanation describes the complete construction and its reproducible implementation. Its ordinary prose remains distinct from every mathematical expression and from both actual bibliographies.'
  const pages = [
    [text('References', 60, 70, 120, 16, 'Section'), text('1', 295, 760, 5)],
    [
      text(
        'Adams, A. (2020). A complete independent publication explains the earlier construction in detail with useful reproducible examples. Journal, 1:1–9.',
        60,
        100,
        480
      ),
      text(
        'Baker, B. (2021). Another complete independent publication explains the original methods in detail. Journal, 2:10–19.',
        60,
        130,
        480
      ),
      text('2', 295, 760, 5)
    ],
    [
      text('1', 60, 70, 8, 16, 'Section'),
      text(
        'Independent Construction',
        76,
        70,
        'Independent Construction'.length * 8,
        16,
        'Section'
      ),
      text('1.1', 60, 110, 19.5, 13, 'Section'),
      text('Complete Explanation', 93, 110, 'Complete Explanation'.length * 6.5, 13, 'Section'),
      text(body, 60, 150, 480),
      text('∑ x² = 1', 200, 250, 90, 10, 'Math'),
      text('1', 295, 760, 5)
    ],
    [
      text('References', 60, 70, 120, 16, 'Section'),
      text(
        'Clark, C. (2022). A later genuine bibliography entry remains protected after the complete appendix. Journal, 3:20–29.',
        60,
        120,
        480
      ),
      text('2', 295, 760, 5)
    ]
  ]
  pages[2][0].hasEOL = false
  pages[2][2].hasEOL = false
  if (fault === 'unfinished-reference') pages[1][1].str = pages[1][1].str.slice(0, -1)
  if (fault === 'one-reference') pages[1].splice(1, 1)
  if (fault === 'foreign-heading') pages[2].splice(4, 0, text('Unrelated overlay', 76, 70, 120, 8))
  const styles = Object.fromEntries(
      ['Body', 'Section', 'Math'].map((id) => [id, { ascent: 0.8, descent: -0.2, vertical: false }])
    ),
    fonts = Object.fromEntries(
      ['Body', 'Section', 'Math'].map((id) => [
        id,
        {
          missingFile: fault === 'fallback-font' && id === 'Section',
          isType3Font: false,
          isInvalidPDFjsFont: false,
          systemFontInfo: null,
          vertical: false,
          ascent: 0.8,
          descent: -0.2
        }
      ])
    ),
    contents = pages.map((items) => ({ items, styles })),
    subsection = { title: 'Complete Explanation', dest: 'sub', items: [] },
    section = { title: 'Independent Construction', dest: 'section', items: [subsection] },
    branch = { title: 'Second native branch', dest: 'branch', items: [section] },
    outline = [{ title: 'Earlier native branch', dest: 'earlier', items: [] }, branch]
  if (fault === 'duplicate-branch') outline.push(branch)
  const operators: { fnArray: number[]; argsArray: unknown[][] }[] = pages.map((items, n) => {
    const first = items[0],
      second = items[1],
      glyphs = (s: string): object[] =>
        Array.from(s).map((unicode) => ({ unicode, isInFont: true, width: 500 }))
    return n === 2
      ? {
          fnArray: [
            OPS.beginText,
            OPS.setFont,
            OPS.setTextMatrix,
            OPS.showText,
            OPS.moveText,
            OPS.setTextRenderingMode,
            OPS.showText,
            OPS.setFont,
            OPS.setTextMatrix,
            OPS.setTextRenderingMode,
            OPS.showText,
            OPS.moveText,
            OPS.setTextRenderingMode,
            OPS.showText
          ],
          argsArray: [
            [],
            ['Section', 16],
            [[1, 0, 0, 1, 60, 730]],
            [glyphs(first.str)],
            [16, 0],
            [fault === 'invisible-title' ? 3 : 0],
            [glyphs(second.str)],
            ['Section', 13],
            [[1, 0, 0, 1, 60, 690]],
            [fault === 'invisible-subsection-number' ? 3 : 0],
            [glyphs(items[2].str)],
            [33, 0],
            [fault === 'invisible-subsection-title' ? 3 : 0],
            [glyphs(items[3].str)]
          ]
        }
      : { fnArray: [], argsArray: [] }
  })
  if (fault === 'combined-visible') {
    const glyphs = (s: string): object[] =>
      Array.from(s).map((unicode) => ({ unicode, isInFont: true, width: 500 }))
    operators[2] = {
      fnArray: [
        OPS.beginText,
        OPS.setFont,
        OPS.moveText,
        OPS.showText,
        OPS.setFont,
        OPS.moveText,
        OPS.showText
      ],
      argsArray: [
        [],
        ['Section', 16],
        [60, 730],
        [[...glyphs(pages[2][0].str), -500, ...glyphs(pages[2][1].str)]],
        ['Section', 13],
        [0, -40],
        [[...glyphs(pages[2][2].str), (-(33 - 19.5) / 13) * 1000, ...glyphs(pages[2][3].str)]]
      ]
    }
  }
  const document = {
    numPages: 4,
    fingerprints: ['anonymous-outline-restart'],
    getOutline: async () => outline,
    getDestination: async (name: string) => [
      {
        num: name === 'earlier' ? 1 : name === 'sub' && fault === 'wrong-destination' ? 4 : 3,
        gen: 0
      },
      { name: 'XYZ' },
      60,
      730,
      null
    ],
    getPageIndex: async (reference: { num: number }) => reference.num - 1,
    getPage: async (number: number) => ({
      rotate: 0,
      commonObjs: { get: (id: string) => fonts[id] },
      getViewport: () => ({ width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] }),
      getOperatorList: async () => operators[number - 1],
      getTextContent: async () => {
        if (number === 4) {
          if (fault === 'late-outline') branch.items = [...branch.items]
          if (fault === 'late-native-array') contents[2].items = [...contents[2].items]
          if (fault === 'late-operator-array') operators[2].argsArray = [...operators[2].argsArray]
          if (fault === 'late-font') fonts.Section.ascent = 0.7
          if (fault === 'late-fingerprint') document.fingerprints = ['another-native-document']
        }
        return contents[number - 1]
      }
    })
  }
  return { document: document as unknown as PDFDocumentProxy, heading, body, pages }
}

describe('independent native outline restart after a closed bibliography', () => {
  it.each(['', 'combined-visible'])(
    'restores ordinary appendix prose while retaining both bibliographies and mathematics: %s',
    async (fault) => {
      const fixture = await outlineRestartFixture(fault),
        extraction = await extractPdfTranslationSource({
          document: fixture.document,
          resourceRequestKey: 'anonymous-restart',
          signal: new AbortController().signal
        }),
        title = extraction.source.units.find((u) => u.source === fixture.heading)!
      expect(title).toBeDefined()
      expect(title.sourceOnly).not.toBe(true)
      expect(title.referenceBoundary).toBe(true)
      expect(extraction.source.units.find((u) => u.source === fixture.body)?.sourceOnly).not.toBe(
        true
      )
      for (const [pageNumber, index] of [
        [2, 0],
        [2, 1],
        [4, 1]
      ]) {
        const owners = extraction.source.units.filter((u) =>
          u.fragments.some(
            (f) => f.pageNumber === pageNumber && f.items.some((i) => i.index === index)
          )
        )
        expect(owners).toHaveLength(1)
        expect(owners[0].sourceOnly).toBe(true)
        expect(owners[0].preserve).toBe('reference')
      }
      expect(extraction.source.units.find((u) => u.source.includes('∑'))?.sourceOnly).toBe(true)
      expect(
        extraction.source.units.flatMap((u) =>
          u.fragments.flatMap((f) => f.items.map((i) => [f.pageNumber, i.index, i.text]))
        )
      ).toEqual(fixture.pages.flatMap((p, n) => p.map((i, index) => [n + 1, index, i.str])))
    }
  )
  it.each([
    'unfinished-reference',
    'one-reference',
    'foreign-heading',
    'fallback-font',
    'duplicate-branch',
    'wrong-destination',
    'invisible-title',
    'invisible-subsection-number',
    'invisible-subsection-title',
    'late-outline',
    'late-native-array',
    'late-operator-array',
    'late-font',
    'late-fingerprint'
  ])('declines incomplete or stale restart evidence: %s', async (fault) => {
    const fixture = await outlineRestartFixture(fault),
      extraction = await extractPdfTranslationSource({
        document: fixture.document,
        resourceRequestKey: 'anonymous-restart',
        signal: new AbortController().signal
      }),
      title = extraction.source.units.find(
        (u) => u.source === fixture.heading || u.source.startsWith('1 Independent')
      )!
    expect(title).toBeDefined()
    expect(title.sourceOnly).toBe(true)
    expect(title.preserve).toBe('reference')
    expect(title.referenceBoundary).not.toBe(true)
  })
})

async function ruledTableNoteFixture(
  fault = ''
): Promise<{ document: PDFDocumentProxy; pages: ReturnType<typeof text>[][]; note: string }> {
  const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const note = ': Design, notation, and scale values are as in Table A.1.'
  const table = (ordinal: number): ReturnType<typeof text>[] => [
    text(`Table A.${ordinal}: Independent measurements`, 60, 110, 300, 10, 'Title'),
    ...Array.from({ length: 7 }, (_, row) =>
      Array.from({ length: 5 }, (_, col) =>
        text(String(row + col + 1), 70 + col * 105, 210 + row * 55, 4, 8)
      )
    ).flat(),
    text('Note', 60, 620, 16, 8, 'Italic'),
    text(note, 76, 620, note.length * 4, 8),
    text(String(ordinal + 2), 298, 760, 4, 8)
  ]
  const pages = [
    [
      text('References', 60, 80, 100, 12, 'Title'),
      text('[1] A. Author. A complete publication. Journal, 2020.', 60, 110, 400, 8),
      text('[2] B. Writer. Another complete publication. Journal, 2021.', 60, 130, 400, 8)
    ],
    table(1),
    table(fault === 'broken-peer' ? 4 : 2),
    [text('[3] C. Writer. A later complete publication. Journal, 2022.', 60, 110, 400, 8)]
  ]
  const target = pages[2]
  target[36].hasEOL = false
  pages[1][36].hasEOL = false
  if (fault === 'math-note')
    target[37].str = ': Design uses x = 3 and compares all independent values.'
  if (fault === 'zero-width') target[37].width = 0
  if (fault === 'foreign-text') target.splice(38, 0, text('Foreign prose', 80, 625, 80, 8))
  if (fault === 'body-overhang') target[2].transform[4] = 20
  if (fault === 'vertical-overhang') target[35].transform[5] = 201
  const fonts = Object.fromEntries(
    ['Body', 'Title', 'Italic'].map((id) => [
      id,
      {
        missingFile: fault === 'fallback-font' && id === 'Italic',
        isType3Font: false,
        isInvalidPDFjsFont: false,
        systemFontInfo: null,
        vertical: false,
        ascent: 0.8,
        descent: -0.2
      }
    ])
  )
  const document = {
    numPages: pages.length,
    fingerprints: ['anonymous-ruled-tables'],
    getPage: async (number: number) => ({
      rotate: 0,
      commonObjs: { get: (id: string) => fonts[id], has: (id: string) => id in fonts },
      getViewport: () => ({ width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] }),
      getTextContent: async () => ({
        items: pages[number - 1],
        styles: Object.fromEntries(
          Object.keys(fonts).map((id) => [id, { ascent: 0.8, descent: -0.2, vertical: false }])
        )
      }),
      getOperatorList: async () => {
        const fnArray: number[] = [],
          argsArray: unknown[][] = []
        const push = (fn: number, args: unknown[]): void => {
          fnArray.push(fn)
          argsArray.push(args)
        }
        if (number === 2 || number === 3) {
          push(OPS.setLineWidth, [0.5])
          for (const y of [650, 570, ...(fault === 'open-frame' && number === 3 ? [] : [200])])
            push(OPS.constructPath, [
              OPS.stroke,
              [new Float32Array([0, 60, y, 1, 540, y])],
              [60, y, 540, y]
            ])
        }
        for (const [index, item] of pages[number - 1].entries()) {
          push(OPS.beginText, [])
          push(OPS.setFont, [item.fontName, item.height])
          push(OPS.setTextMatrix, [[1, 0, 0, 1, item.transform[4], item.transform[5]]])
          if (fault === 'invisible-note' && number === 3 && index === 37)
            push(OPS.setTextRenderingMode, [3])
          if (fault === 'white-note' && number === 3 && index === 37)
            push(OPS.setFillRGBColor, ['#ffffff'])
          push(OPS.showText, [
            Array.from(item.str).map((unicode) => ({ unicode, isInFont: true, width: 500 }))
          ])
          push(OPS.endText, [])
        }
        return { fnArray, argsArray }
      }
    })
  }
  return { document: document as unknown as PDFDocumentProxy, pages, note: 'Note' + target[37].str }
}

describe('native ordinary Notes below complete appendix tables', () => {
  it('restores only the whole ordinary Note while keeping references and table captions protected', async () => {
    const fixture = await ruledTableNoteFixture(),
      extraction = await extractPdfTranslationSource({
        document: fixture.document,
        resourceRequestKey: 'anonymous-table-notes',
        signal: new AbortController().signal
      })
    const note = extraction.source.units.find(
      (u) => u.source === fixture.note && u.fragments[0].pageNumber === 3
    )!
    expect(note).toBeDefined()
    expect(note.sourceOnly).not.toBe(true)
    expect(note.referenceBoundary).toBe(true)
    expect(extraction.source.units.find((u) => u.source.startsWith('[3]'))?.preserve).toBe(
      'reference'
    )
    expect(extraction.source.units.find((u) => u.source.startsWith('Table A.2'))?.sourceOnly).toBe(
      true
    )
  })
  it.each([
    'broken-peer',
    'math-note',
    'zero-width',
    'foreign-text',
    'body-overhang',
    'vertical-overhang',
    'fallback-font',
    'open-frame',
    'invisible-note',
    'white-note'
  ])('refuses incomplete or nonordinary Notes: %s', async (fault) => {
    const fixture = await ruledTableNoteFixture(fault),
      extraction = await extractPdfTranslationSource({
        document: fixture.document,
        resourceRequestKey: 'anonymous-table-notes',
        signal: new AbortController().signal
      })
    const owner = extraction.source.units.find((u) =>
      u.fragments.some((f) => f.pageNumber === 3 && f.items.some((i) => i.index === 37))
    )!
    expect(owner).toBeDefined()
    expect(owner.sourceOnly).toBe(true)
    expect(owner.referenceBoundary).not.toBe(true)
  })
})

async function onlineAppendixFixture(
  fault = ''
): Promise<{ document: PDFDocumentProxy; heading: string; body: string }> {
  const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const heading = 'Online Appendix',
    introA = 'This appendix records ',
    introB =
      'additional measurements, supporting controls, and reproducible methods for this independent study.',
    sub = 'OA-1. Further methods',
    body =
      'An independent ordinary paragraph explains the full construction and the reproducible measurement procedure, while keeping every original equation and all protected source material separate.'
  const native = (
    s: string,
    x: number,
    y: number,
    size = 10,
    font = 'Body',
    ratio = 1
  ): PdfLayoutTextItem => ({
    str: s,
    dir: 'ltr',
    width: (s.length * 400 * size * ratio) / 1000,
    height: size,
    transform: [size * ratio, 0, 0, size, x, 800 - y],
    fontName: font,
    hasEOL: true
  })
  const citation = (author: string, y: number, year: string): PdfLayoutTextItem[] => {
    const first = native(author + ', Ada, ', 60, y),
      title = native('Complete independent methods,', 60 + first.width, y, 10, 'Italic'),
      end = native(
        'Journal of Reproducible Measurements, ' + year + ', 1–8.',
        70,
        y + 15,
        10,
        'Italic'
      )
    first.hasEOL = false
    return [first, title, end]
  }
  const firstIntro = native(introA, 60, 110, 10, 'Body', 0.98),
    secondIntro = native(introB, 60 + firstIntro.width, 110, 10, 'Italic', 0.98)
  firstIntro.hasEOL = false
  const pages = [
    [
      native('References', 60, 60, 14, 'Section'),
      ...citation('Writer', 110, '2020'),
      ...citation('Author', 160, '2021'),
      native('1', 295, 760)
    ],
    [
      ...citation('Reader', 100, '2022'),
      ...citation('Scholar', 150, '2023'),
      native('2', 295, 760)
    ],
    [
      native(heading, 60, 70, 14, 'Section'),
      firstIntro,
      secondIntro,
      native(sub, 60, 180, 14, 'Section', 0.98),
      native(body, 60, 220),
      native('∑ x² = 1', 200, 260, 10, 'Math'),
      native('1', 295, 760)
    ],
    [
      native(
        'A later ordinary paragraph records the final controls without changing the earlier native proof.',
        60,
        110
      )
    ]
  ]
  pages[2][4].width = 480
  if (fault === 'gutter-outside') pages[1][2].transform[4] = 110
  if (fault === 'missing-source') pages[1][2].transform[0] = 0
  if (fault === 'wrong-switch-origin') pages[2][2].transform[4] += 1
  const styles = Object.fromEntries(
      ['Body', 'Italic', 'Section', 'Math'].map((id) => [
        id,
        { ascent: 0.8, descent: -0.2, vertical: false }
      ])
    ),
    fonts = Object.fromEntries(
      Object.keys(styles).map((id) => [
        id,
        {
          loadedName: id,
          data: new Uint8Array([1, 2, 3, 4]),
          fontMatrix: [0.001, 0, 0, 0.001, 0, 0],
          missingFile: fault === 'fallback-font' && id === 'Section',
          isType3Font: false,
          isInvalidPDFjsFont: false,
          systemFontInfo: null,
          vertical: false,
          ascent: 0.8,
          descent: -0.2
        }
      ])
    ),
    contents = pages.map((items) => ({ items, styles })),
    glyphs = (s: string): { unicode: string; width: number; isInFont: boolean }[] =>
      Array.from(s).map((unicode) => ({ unicode, width: 400, isInFont: true }))
  const operators = {
    fnArray: [
      OPS.beginText,
      OPS.setFont,
      OPS.setTextMatrix,
      OPS.showText,
      OPS.setFont,
      OPS.setTextMatrix,
      OPS.showText,
      OPS.setFont,
      OPS.showText,
      OPS.setFont,
      OPS.setTextMatrix,
      OPS.showText
    ],
    argsArray: [
      [],
      ['Section', 14],
      [new Float32Array([1, 0, 0, 1, 60, 730])],
      [glyphs(heading)],
      ['Body', 10],
      [new Float32Array([fault === 'wrong-scale' ? 0.97 : 0.98, 0, 0, 1, 60, 690])],
      [glyphs(introA)],
      ['Italic', 10],
      [glyphs(introB)],
      ['Section', 14],
      [new Float32Array([0.98, 0, 0, 1, 60, 620])],
      [glyphs(sub)]
    ]
  }
  if (fault === 'prefix-budget') {
    operators.fnArray.unshift(...Array.from({ length: 64 }, () => OPS.dependency))
    operators.argsArray.unshift(...Array.from({ length: 64 }, () => []))
  }
  const proxies: unknown[] = []
  const document = {
    numPages: pages.length,
    fingerprints: ['anonymous-online-boundary'],
    getPage: async (number: number) =>
      (proxies[number - 1] ??= {
        pageNumber: number,
        rotate: 0,
        ref: { num: number, gen: 0 },
        view: [0, 0, 600, 800],
        userUnit: 1,
        commonObjs: { get: (id: string) => fonts[id], has: (id: string) => id in fonts },
        getViewport: () => ({
          width: 600,
          height: 800,
          scale: 1,
          rotation: 0,
          transform: [1, 0, 0, -1, 0, 800]
        }),
        cleanup: () => undefined,
        getOperatorList: async () => (number === 3 ? operators : { fnArray: [], argsArray: [] }),
        getTextContent: async () => {
          if (number === 4 && fault === 'late-font-data') fonts.Section.data[0] = 9
          if (number === 4 && fault === 'replace-font-data')
            fonts.Section.data = fonts.Section.data.slice()
          if (number === 4 && fault === 'late-content') contents[2].items = [...contents[2].items]
          return contents[number - 1]
        }
      })
  }
  return { document: document as unknown as PDFDocumentProxy, heading, body }
}

describe('independent non-isometric native online appendix boundary', () => {
  it('uses the native double cursor across a genuine font switch without rewriting Source', async () => {
    const fixture = await onlineAppendixFixture(),
      result = await extractPdfTranslationSource({
        resourceRequestKey: 'anonymous-online',
        document: fixture.document,
        signal: new AbortController().signal
      }),
      title = result.source.units.find((u) => u.source === fixture.heading),
      body = result.source.units.find((u) => u.source === fixture.body)
    expect(title?.referenceBoundary).toBe(true)
    expect(title?.sourceOnly).not.toBe(true)
    expect(body?.sourceOnly).not.toBe(true)
    expect(result.source.units.find((u) => u.source.includes('Writer, Ada'))?.preserve).toBe(
      'reference'
    )
    expect(result.source.units.find((u) => u.source.includes('∑'))?.preserve).toBe('formula')
  })
  it.each([
    'wrong-scale',
    'wrong-switch-origin',
    'fallback-font',
    'gutter-outside',
    'missing-source',
    'prefix-budget',
    'late-font-data',
    'replace-font-data',
    'late-content'
  ])(
    'retains the original reference protection for incomplete native evidence: %s',
    async (fault) => {
      const fixture = await onlineAppendixFixture(fault),
        result = await extractPdfTranslationSource({
          resourceRequestKey: 'anonymous-online',
          document: fixture.document,
          signal: new AbortController().signal
        }),
        title = result.source.units.find((u) => u.source === fixture.heading)
      expect(title?.referenceBoundary).not.toBe(true)
      expect(title?.sourceOnly).toBe(true)
      expect(title?.preserve).toBe('reference')
    }
  )
})

type OnlineProofContext = Parameters<
  typeof import('../../src/reader/appendix-overview-boundary.js').readNativeOnlineAppendixRestart
>[0] & { unreliable: Set<number> }
type OnlineUnit = ReturnType<
  typeof import('../../src/reader/layout.js').groupPdfTranslationPages
>['units'][number]
async function onlineLiveContext(): Promise<{
  certificate: NonNullable<
    Awaited<
      ReturnType<
        typeof import('../../src/reader/appendix-overview-boundary.js').readNativeOnlineAppendixRestart
      >
    >
  >
  context: OnlineProofContext
  contexts: OnlineProofContext[]
  rawPages: import('../../src/reader/layout.js').PdfLayoutPage[]
  title: () => OnlineUnit | undefined
}> {
  const fixture = await onlineAppendixFixture(),
    rawPages: import('../../src/reader/layout.js').PdfLayoutPage[] = [],
    contexts = [],
    { readNativeReferenceEvidence } = await import('../../src/reader/native-reference-evidence.js'),
    { readNativeSectionFontEvidence } = await import('../../src/reader/wrapped-section-prose.js')
  for (let number = 1; number <= fixture.document.numPages; number++) {
    const page = await fixture.document.getPage(number),
      content = await page.getTextContent(),
      reference = await readNativeReferenceEvidence(page, content),
      fonts = await readNativeSectionFontEvidence(page, content, reference),
      rawPage = {
        page: number,
        width: 600,
        height: 800,
        rotation: 0,
        items: content.items.flatMap((item) =>
          'str' in item
            ? [
                {
                  ...item,
                  fontAscent: content.styles[item.fontName].ascent,
                  fontDescent: content.styles[item.fontName].descent,
                  fontVertical: content.styles[item.fontName].vertical
                }
              ]
            : []
        ),
        nativeSectionFontEvidence: fonts
      }
    rawPages.push(rawPage)
    contexts.push({
      document: fixture.document,
      page,
      content,
      rawPage,
      signal: new AbortController().signal,
      unreliable: new Set<number>(),
      sourceIdentity: { sourceChecksum: 'anonymous-native-book', sourceSizeBytes: 100 }
    })
  }
  const context = contexts[2],
    { readNativeOnlineAppendixRestart } =
      await import('../../src/reader/appendix-overview-boundary.js'),
    { groupPdfTranslationPages } = await import('../../src/reader/layout.js'),
    certificate = await readNativeOnlineAppendixRestart(context, contexts.slice(0, 2))
  expect(certificate).toBeDefined()
  rawPages[2].nativeOnlineAppendixRestart = certificate
  const title = (): OnlineUnit | undefined =>
    groupPdfTranslationPages({ pages: rawPages }).units.find((u) => u.source === fixture.heading)
  expect(title()?.referenceBoundary).toBe(true)
  return { certificate: certificate!, context, contexts, rawPages, title }
}

describe('online appendix live certificate revocation', () => {
  it.each([
    'unreliable-member',
    'unreliable-set',
    'font-view',
    'operator-array',
    'clone-current-page',
    'clone-prior-page',
    'late-prior-content',
    'late-prior-unreliable'
  ])('revokes the actual private proof after %s changes', async (fault) => {
    const { context, contexts, rawPages, title } = await onlineLiveContext()
    if (fault === 'unreliable-member') context.unreliable.add(0)
    if (fault === 'clone-current-page') rawPages[2] = { ...rawPages[2] }
    if (fault === 'clone-prior-page') rawPages[0] = { ...rawPages[0] }
    if (fault === 'late-prior-content') contexts[0].content.items = [...contexts[0].content.items]
    if (fault === 'late-prior-unreliable') contexts[1].unreliable.add(0)
    if (fault === 'unreliable-set') context.unreliable = new Set(context.unreliable)
    if (fault === 'font-view') {
      const font = context.page.commonObjs.get('Section')
      font.data = font.data.slice()
    }
    if (fault === 'operator-array') {
      const operators = await context.page.getOperatorList()
      operators.argsArray = [...operators.argsArray]
    }
    expect(title()?.referenceBoundary).not.toBe(true)
    expect(title()?.preserve).toBe('reference')
  })
})

it('rejects an Online token in the old outline consumer before reading owners', async () => {
  const { certificate, rawPages } = await onlineLiveContext(),
    { groupPdfTranslationPages } = await import('../../src/reader/layout.js'),
    { nativeOutlineRestartBoundary } =
      await import('../../src/reader/appendix-overview-boundary.js'),
    units = groupPdfTranslationPages({ pages: rawPages }).units
  let visited = false
  const observed = new Proxy(units, {
    get(target, key, receiver) {
      if (key === Symbol.iterator) visited = true
      return Reflect.get(target, key, receiver)
    }
  })
  expect(nativeOutlineRestartBoundary(observed, rawPages, rawPages[2], certificate)).toBeUndefined()
  expect(visited).toBe(false)
})

// Generated native text, embedded fonts and real marked/clip operators exercise
// the publisher without paper identifiers, copied bibliography text or JSON proof.
async function taggedTerminalDocument(fault = ''): Promise<{
  document: PDFDocumentProxy
  dispose: () => Promise<void>
}> {
  const [{ PDFDocument, PDFName }, fs, path, module, pdfjs] = await Promise.all([
    import('pdf-lib'),
    import('node:fs'),
    import('node:path'),
    import('node:module'),
    import('pdfjs-dist/legacy/build/pdf.mjs')
  ])
  const require = module.createRequire(import.meta.url),
    assets = path.dirname(require.resolve('pdfjs-dist/package.json')),
    pdf = await PDFDocument.create()
  pdf.registerFontkit(require('fontkit') as Parameters<typeof pdf.registerFontkit>[0])
  const regular = await pdf.embedFont(
      fs.readFileSync(assets + '/standard_fonts/LiberationSans-Regular.ttf')
    ),
    bold = await pdf.embedFont(fs.readFileSync(assets + '/standard_fonts/LiberationSans-Bold.ttf'))
  const pages = [
    [
      ['An independent ordinary statement remains available for translation.', 60, 740],
      ['References', 60, 700],
      ['A. Writer, 2020. A generated book.', 60, 680],
      ['An independently completed publication.', 95.86, 665],
      ['B. Reader, 2021. Another generated book.', 60, 640],
      ['A complete volume with a final period.', 95.86, 625]
    ],
    [
      ['C. Editor, 2022. A generated journal article.', 60, 740],
      ['A complete final bibliographic record.', 95.86, 725]
    ]
  ] as [string, number, number][][]
  if (fault === 'unfinished') pages[1][1][0] = 'An incomplete final bibliographic record'
  if (fault === 'foreign-tail')
    pages[1].push(['Ordinary material follows the bibliography.', 240, 670])
  let mcid = 0
  for (const lines of pages) {
    const page = pdf.addPage([600, 800]),
      normal = page.node.newFontDictionary(regular.name, regular.ref),
      title = page.node.newFontDictionary(bold.name, bold.ref),
      operators: string[] = []
    for (const [text, x, y] of lines) {
      const font = text === 'References' ? bold : regular,
        name = text === 'References' ? title : normal,
        mark = fault === 'unknown-mark' ? 'Artifact' : 'Span',
        id = fault === 'duplicate-mcid' ? 0 : mcid++,
        clip = fault === 'partial-clip' ? '0 0 65 800' : '0 0 600 800'
      operators.push(
        `/${mark} << /MCID ${id} >> BDC q ${clip} re W* n BT ${name} 11 Tf 0 Tc 1 0 0 1 ${x} ${y} Tm ${font.encodeText(text)} Tj ET Q EMC`
      )
    }
    if (fault === 'unsupported-paint') operators.push('0 0 5 5 re f')
    page.node.set(
      PDFName.of('Contents'),
      pdf.context.register(pdf.context.flateStream(operators.join('\n')))
    )
  }
  const loading = pdfjs.getDocument({
      data: await pdf.save(),
      fontExtraProperties: true,
      useSystemFonts: false,
      isEvalSupported: false,
      standardFontDataUrl: assets + '/standard_fonts/'
    }),
    document = await loading.promise
  return { document, dispose: () => loading.destroy() }
}

async function taggedNativeOwners(
  document: PDFDocumentProxy,
  fault = ''
): Promise<{
  reader: ReturnType<
    typeof import('../../src/reader/tagged-reference-packets.js').createNativeTaggedReferenceReader
  >
  pages: import('../../src/reader/layout.js').PdfLayoutPage[]
  units: import('../../src/reader/source.js').PdfTranslationSource['units']
  unreliable: Set<number>[]
  contexts: {
    page: import('pdfjs-dist').PDFPageProxy
    content: Awaited<ReturnType<import('pdfjs-dist').PDFPageProxy['getTextContent']>>
  }[]
}> {
  const { createNativeTaggedReferenceReader } =
      await import('../../src/reader/tagged-reference-packets.js'),
    reader = createNativeTaggedReferenceReader(document, new AbortController().signal),
    pages: import('../../src/reader/layout.js').PdfLayoutPage[] = [],
    unreliable: Set<number>[] = [],
    contexts: {
      page: import('pdfjs-dist').PDFPageProxy
      content: Awaited<ReturnType<import('pdfjs-dist').PDFPageProxy['getTextContent']>>
    }[] = []
  for (let n = 1; n <= document.numPages; n++) {
    const page = await document.getPage(n),
      content = await page.getTextContent(),
      viewport = page.getViewport({ scale: 1 }),
      rawPage = {
        page: n,
        width: viewport.width,
        height: viewport.height,
        rotation: 0,
        items: content.items.map((i) =>
          'str' in i
            ? {
                ...i,
                fontAscent: content.styles[i.fontName].ascent,
                fontDescent: content.styles[i.fontName].descent,
                fontVertical: content.styles[i.fontName].vertical
              }
            : { str: '', width: 0, height: 0, dir: 'ltr', transform: [0, 0, 0, 0, 0, 0] }
        )
      }
    pages.push(rawPage)
    unreliable.push(new Set())
    contexts.push({ page, content })
    const input = { page, content, viewport, rawPage, unreliable: unreliable.at(-1)! }
    if (n === 1 && fault === 'await-hidden')
      Object.defineProperty(content, 'nativeExtra', { value: 1, writable: true })
    if (n === 1 && fault) {
      const get = page.getOperatorList
      page.getOperatorList = async function (...args) {
        const ops = await get.apply(this, args)
        if (fault === 'await-source') {
          const first = content.items.find((i) => 'str' in i && i.str.trim())
          if (first && 'str' in first) first.str += ' changed'
        }
        if (fault === 'await-set') input.unreliable = new Set()
        if (fault === 'await-array-length') rawPage.items.length += 1
        if (fault === 'await-hidden') Object.defineProperty(content, 'nativeExtra', { value: 2 })
        if (fault === 'await-prototype') Object.setPrototypeOf(content, {})
        if (fault === 'await-viewport') viewport.transform[4] += 1
        if (fault === 'operator-budget') {
          const { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
          while (ops.fnArray.length <= 100000) {
            ops.fnArray.push(OPS.dependency)
            ops.argsArray.push([])
          }
        }
        return ops
      }
    }
    await reader.observe(input)
  }
  const units = pages.flatMap((p) =>
    p.items.flatMap((i, index) =>
      i.str.trim()
        ? [
            {
              id: `native-${p.page}-${index}`,
              source: i.str,
              fragments: [
                {
                  pageNumber: p.page,
                  rect: {
                    x: i.transform[4] / p.width,
                    y: (p.height - i.transform[5] - i.height) / p.height,
                    width: i.width / p.width,
                    height: i.height / p.height
                  },
                  items: [{ index, text: i.str }]
                }
              ]
            }
          ]
        : []
    )
  )
  return { reader, pages, units, unreliable, contexts }
}

it('retains a complete tagged terminal bibliography without changing native owners', async () => {
  const { document, dispose } = await taggedTerminalDocument()
  try {
    const native = await taggedNativeOwners(document),
      proved = await native.reader.owners(native.units, native.pages)
    expect(proved.size).toBeGreaterThan(2)
    expect([...proved.keys()]).not.toContain(native.units[0].id)
    const result = await extractPdfTranslationSource({
        document,
        resourceRequestKey: 'generated',
        signal: new AbortController().signal
      }),
      bibliography = result.source.units.filter(
        (u) =>
          u.fragments.some((f) => f.pageNumber === 2) ||
          /References|Writer|Reader|publication|volume/u.test(u.source)
      )
    expect(bibliography.length).toBeGreaterThan(2)
    expect(bibliography.every((u) => u.sourceOnly && u.preserve === 'reference')).toBe(true)
    expect(
      result.source.units.find((u) => u.source.startsWith('An independent ordinary'))?.sourceOnly
    ).not.toBe(true)
    expect(result.coverage.excludedItemCount).toBe(0)
  } finally {
    await dispose()
  }
})

it.each([
  'unfinished',
  'foreign-tail',
  'unknown-mark',
  'duplicate-mcid',
  'partial-clip',
  'unsupported-paint'
])('declines a tagged reference packet with %s without inventing authority', async (fault) => {
  const { document, dispose } = await taggedTerminalDocument(fault)
  try {
    const native = await taggedNativeOwners(document)
    expect((await native.reader.owners(native.units, native.pages)).size).toBe(0)
  } finally {
    await dispose()
  }
})

it.each([
  'unreliable',
  'raw-page-clone',
  'missing-source',
  'font-data-replacement',
  'set-size-mask'
])('revokes a tagged packet after %s without changing Source', async (fault) => {
  const { document, dispose } = await taggedTerminalDocument()
  try {
    const native = await taggedNativeOwners(document),
      before = JSON.stringify(native.units)
    expect((await native.reader.owners(native.units, native.pages)).size).toBeGreaterThan(2)
    if (fault === 'unreliable') native.unreliable[0].add(0)
    if (fault === 'set-size-mask') {
      native.unreliable[0].add(0)
      Object.defineProperty(native.unreliable[0], 'size', { get: () => 0 })
    }
    if (fault === 'font-data-replacement') {
      const { page, content } = native.contexts[0],
        item = content.items.find((i) => 'str' in i && i.str.trim())!
      if ('str' in item) {
        const font = page.commonObjs.get(item.fontName)
        Object.defineProperty(font, 'data', { value: font.data.slice(), configurable: true })
      }
    }
    const pages = fault === 'raw-page-clone' ? native.pages.map((p) => ({ ...p })) : native.pages,
      units = fault === 'missing-source' ? native.units.slice(0, -1) : native.units
    expect(native.reader.currentOwners(units, pages).size).toBe(0)
    expect((await native.reader.owners(units, pages)).size).toBe(0)
    expect(JSON.stringify(native.units)).toBe(before)
  } finally {
    await dispose()
  }
})

it.each([
  'await-source',
  'await-set',
  'await-viewport',
  'operator-budget',
  'await-array-length',
  'await-hidden',
  'await-prototype'
])('declines native input changed during %s before granting a packet', async (fault) => {
  const { document, dispose } = await taggedTerminalDocument()
  try {
    const native = await taggedNativeOwners(document, fault)
    expect((await native.reader.owners(native.units, native.pages)).size).toBe(0)
  } finally {
    await dispose()
  }
})
