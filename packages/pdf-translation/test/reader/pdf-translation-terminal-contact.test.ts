import type {
  PdfLayoutPage,
  PdfLayoutTextItem,
  PdfTranslationLayout
} from '../../src/reader/layout.js'
import type { PdfTranslationSource } from '../../src/reader/source.js'
import type { NativeReferenceFontWitness } from '../../src/reader/native-reference-evidence.js'
type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> }
type Fixture = {
  units: Mutable<PdfTranslationSource['units']>
  layout: PdfTranslationLayout
  raw: { pageCount: number; pages: PdfLayoutPage[] }
  evidence: { complete: true; page: number; fonts: Record<string, NativeReferenceFontWitness> }
}
import { terminalContactSources } from '../../src/reader/terminal-contact-source.js'
import { expect, it } from 'vitest'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { extractPdfTranslationSource } from '../../src/reader/extraction.js'

const item = (str: string, y: number, x = 60, width = str.length * 4): PdfLayoutTextItem => ({
  str,
  width,
  height: 10,
  dir: 'ltr',
  transform: [10, 0, 0, 10, x, 800 - y],
  fontName: 'Embedded',
  hasEOL: true
})
function document(): PDFDocumentProxy {
  const pages = [
    [
      item(
        'A complete ordinary paragraph explains the experiment and records the independent result.',
        100
      )
    ],
    [
      item('References', 80),
      item('[1] A. Writer, A theorem, Journal 1 (2020), 1–9.', 120),
      item('Department of Mathematics, Example University,', 160),
      item('Example City, Country', 171),
      item('Email address:', 182, 60, 65),
      item('writer@example.edu', 182, 127)
    ]
  ]
  return {
    numPages: 2,
    fingerprints: ['anonymous-contact'],
    getPage: async (n: number) => ({
      pageNumber: n,
      view: [0, 0, 600, 800],
      commonObjs: {
        has: () => true,
        get: () => ({
          missingFile: false,
          isType3Font: false,
          isInvalidPDFjsFont: false,
          systemFontInfo: null,
          vertical: false,
          ascent: 0.7,
          descent: -0.2
        })
      },
      getTextContent: async () => ({
        items: structuredClone(pages[n - 1]),
        styles: { Embedded: { ascent: 0.7, descent: -0.2, vertical: false, fontFamily: 'serif' } }
      }),
      getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
      getViewport: () => ({
        width: 600,
        height: 800,
        scale: 1,
        rotation: 0,
        transform: [1, 0, 0, -1, 0, 800],
        convertToViewportPoint: (x: number, y: number) => [x, 800 - y]
      })
    })
  } as unknown as PDFDocumentProxy
}

it('restores a proved terminal institution and retains the independent email row literally', async () => {
  const result = await extractPdfTranslationSource({
    document: document(),
    resourceRequestKey: 'anonymous',
    signal: new AbortController().signal
  })
  const institution = result.source.units.find((u) => u.source.startsWith('Department'))!
  const email = result.source.units.find((u) => u.source.startsWith('Email address:'))!
  expect(institution.source).toBe(
    'Department of Mathematics, Example University, Example City, Country'
  )
  expect(institution.sourceOnly).toBeUndefined()
  expect(institution.preserve).toBeUndefined()
  expect(institution.referenceBoundary).toBe(true)
  expect(email.sourceOnly).toBe(true)
  expect(email.preserve).toBe('literal')
  expect(result.source.units.find((u) => u.source.startsWith('[1]'))?.preserve).toBe('reference')
  expect(result.coverage.includedItemCount).toBe(7)
  expect(
    result.source.units.flatMap((u) => u.fragments.flatMap((f) => f.items.map((i) => i.text)))
  ).toEqual([
    'A complete ordinary paragraph explains the experiment and records the independent result.',
    'References',
    '[1] A. Writer, A theorem, Journal 1 (2020), 1–9.',
    'Department of Mathematics, Example University,',
    'Example City, Country',
    'Email address:',
    'writer@example.edu'
  ])
})

function contactFixture(): Fixture {
  const width = 600,
    height = 800,
    font = { ascent: 0.7, descent: -0.2, vertical: false as const, nativeMetrics: true as const }
  const specs: [string, number][] = [
    ['References', 80],
    ['[1] A. Writer, A theorem, Journal 1 (2020), 1–9.', 120],
    ['Department of Mathematics, Example University,', 160],
    ['Example City, Country', 171],
    ['Email address:', 182],
    ['writer@example.edu', 182]
  ]
  const items = specs.map(([str, y]) => ({
    str,
    width: str.length * 4,
    height: 10,
    dir: 'ltr',
    transform: [10, 0, 0, 10, 60, height - y],
    fontName: 'Native',
    fontAscent: 0.7,
    fontDescent: -0.2,
    fontVertical: false,
    hasEOL: true
  }))
  const page = {
    page: 2,
    width,
    height,
    rotation: 0,
    items,
    nativeSectionFontEvidence: { complete: true, fonts: { Native: font } }
  }
  const lines = specs.map(([text, y], index) => ({
    text,
    x: 60,
    y: y - 7,
    right: 60 + text.length * 4,
    bottom: y + 2,
    items: ['2:' + index]
  }))
  lines[4] = {
    text: 'Email address: writer@example.edu',
    x: 60,
    y: 175,
    right: 300,
    bottom: 184,
    items: ['2:4', '2:5']
  }
  lines.splice(5, 1)
  const make = (
    id: string,
    indices: number[]
  ): {
    block: PdfTranslationLayout['pages'][number]['blocks'][number]
    layout: PdfTranslationLayout['units'][number]
    source: Mutable<PdfTranslationSource['units'][number]>
  } => {
    const ls = indices.includes(5) ? [lines[2], lines[3], lines[4]] : indices.map((i) => lines[i]),
      r = {
        x: 60,
        y: ls[0].y,
        right: Math.max(...ls.map((x) => x.right)),
        bottom: ls.at(-1)!.bottom,
        font: 10
      },
      keys = indices.map((i) => '2:' + i),
      originalStrings = indices.map((i) => items[i].str),
      source = ls.map((x) => x.text).join(' '),
      rect = {
        x: r.x / width,
        y: r.y / height,
        width: (r.right - r.x) / width,
        height: (r.bottom - r.y) / height
      }
    return {
      block: { id, page: 2, source, items: keys, originalStrings, rect: r, lines: ls, risks: [] },
      layout: {
        id,
        kind: 'prose-candidate' as const,
        source,
        sourceOnly: true as const,
        preserve: 'reference' as const,
        items: keys,
        originalStrings,
        fragments: [{ id, page: 2, rect: r }],
        risks: []
      },
      source: {
        id,
        source,
        sourceOnly: true,
        preserve: 'reference',
        fragments: [
          {
            pageNumber: 2,
            rect,
            items: indices.map((index) => ({ index, text: items[index].str }))
          }
        ]
      }
    }
  }
  const owners = [make('heading', [0]), make('reference', [1]), make('contact', [2, 3, 4, 5])]
  return {
    units: owners.map((x) => x.source),
    layout: {
      bodyFont: 10,
      pages: [
        { page: 1, width, height, sourceItems: 0, blocks: [] },
        { page: 2, width, height, sourceItems: 5, blocks: owners.map((x) => x.block) }
      ],
      units: owners.map((x) => x.layout),
      joins: []
    },
    raw: { pageCount: 2, pages: [{ page: 1, width, height, rotation: 0, items: [] }, page] },
    evidence: { complete: true, page: 2, fonts: { Native: font } }
  }
}
function changeItem(a: ReturnType<typeof contactFixture>, index: number, text: string): void {
  const p = a.raw.pages.at(-1)!
  p.items[index].str = text
  for (const u of a.units) {
    for (const f of u.fragments)
      for (const i of f.items) if (f.pageNumber === 2 && i.index === index) i.text = text
    const old = a.layout.units.find((v) => v.id === u.id)
    if (old?.items.includes('2:' + index)) {
      const n = old.items.indexOf('2:' + index)
      old.originalStrings[n] = text
      const b = a.layout.pages[1].blocks.find((b) => b.id === old.fragments[0].id)!
      b.originalStrings[n] = text
      for (const l of b.lines)
        if (l.items.includes('2:' + index))
          l.text = l.items.map((k) => p.items[Number(k.split(':')[1])].str).join(' ')
      b.source = b.lines.map((l) => l.text).join(' ')
      old.source = b.source
      u.source = b.source
    }
  }
}

function checkContact(
  name: string,
  mutate?: (a: ReturnType<typeof contactFixture>) => void,
  positive = false
): void {
  it(name, () => {
    const a = contactFixture()
    mutate?.(a)
    const before = structuredClone(a)
    a.raw.pages[1].nativeSectionFontEvidence = a.evidence
    const result = terminalContactSources(a.units, a.layout, a.raw.pages, a.raw.pageCount)
    expect(result !== a.units).toBe(positive)
    expect(a).toEqual({
      ...before,
      raw: {
        ...before.raw,
        pages: [
          before.raw.pages[0],
          { ...before.raw.pages[1], nativeSectionFontEvidence: a.evidence }
        ]
      }
    })
    if (positive) {
      expect(result.find((u) => u.source.startsWith('Department'))?.referenceBoundary).toBe(true)
      expect(result.at(-1)?.preserve).toBe('literal')
    }
  })
}
checkContact('complete-whole-native-institution-and-email', undefined, true)
checkContact('missing-font', (a) => delete a.evidence.fonts.Native)
checkContact('missing-metrics', (a) =>
  Object.assign(a.evidence.fonts.Native, { nativeMetrics: false })
)
checkContact('font-metric-mismatch', (a) => (a.evidence.fonts.Native.ascent = 0.8))
checkContact('vertical-font', (a) => (a.raw.pages[1].items[2].fontVertical = true))
checkContact('nonterminal-page', (a) => (a.raw.pageCount = 3))
checkContact('missing-bibliography', (a) => (a.units[0].source = 'Ordinary heading'))
checkContact('bibliography-after-contact', (a) => (a.units[0].fragments[0].rect.y = 0.95))
checkContact('ordinary-institution-discussion', (a) => {
  changeItem(a, 2, 'The university provides an ordinary explanation.')
  changeItem(a, 3, 'The study records a useful result.')
})
checkContact('ordinary-named-institution-prose', (a) => {
  changeItem(a, 2, 'Example University provides an ordinary explanation.')
  changeItem(a, 3, 'A result follows.')
})
checkContact('mixed-email-prose', (a) =>
  changeItem(a, 5, 'Please send results to writer@example.edu')
)
checkContact('same-item-institution-and-email', (a) =>
  changeItem(a, 5, 'Example University writer@example.edu')
)
checkContact('email-not-terminal-row', (a) => {
  changeItem(a, 3, 'Email address: writer@example.edu')
  changeItem(a, 5, 'An ordinary conclusion.')
})
checkContact('duplicate-native-source-ownership', (a) =>
  a.units.push({ ...structuredClone(a.units[2]), id: 'duplicate' })
)
checkContact('duplicate-unit-id', (a) => a.units.push(structuredClone(a.units[2])))
checkContact('generated-id-collision', (a) =>
  a.units.push({ id: 'contact:contact-1', source: '', fragments: [] })
)
checkContact('independent-figure-owner', (a) => {
  a.units[2].figure = true
})
checkContact('independent-unclipped-navigation', (a) => {
  a.units[2].fragments[0].unclippedRect = a.units[2].fragments[0].rect
})
checkContact('partial-native-item', (a) => (a.units[2].fragments[0].items[0].text = 'Department'))
checkContact(
  'line-does-not-own-whole-item',
  (a) => (a.layout.pages[1].blocks[2].lines[0].items = [])
)
checkContact('unclaimed-tail-native-item', (a) =>
  a.raw.pages[1].items.push({
    ...a.raw.pages[1].items[2],
    str: 'Foreign conclusion',
    transform: [10, 0, 0, 10, 60, 600]
  })
)
checkContact('foreign-interposed-native-item', (a) =>
  a.raw.pages[1].items.push({
    ...a.raw.pages[1].items[2],
    str: 'Foreign',
    transform: [10, 0, 0, 10, 400, 635]
  })
)
checkContact('reference-owner-has-code-protection', (a) => (a.units[2].preserve = 'code'))
checkContact('non-axis-native-matrix', (a) => (a.raw.pages[1].items[2].transform[2] = 1))
checkContact('unsupported-native-direction', (a) => (a.raw.pages[1].items[2].dir = 'rtl'))
checkContact('inconsistent-native-size', (a) => (a.raw.pages[1].items[2].height = 11))
checkContact('layout-risk', (a) => a.layout.units[2].risks.push('unreliable-font-unicode'))
checkContact(
  'advisory-continuation-retained',
  (a) => a.layout.units[2].risks.push('possible-continuation'),
  true
)
checkContact(
  'nonconserved-line-source',
  (a) => (a.layout.pages[1].blocks[2].lines[0].text += ' changed')
)
checkContact('nonadjacent-native-lines', (a) => {
  a.layout.pages[1].blocks[2].lines[1].y += 100
})
checkContact('inconsistent-physical-baseline', (a) => {
  a.raw.pages[1].items[5].transform[5] += 0.1
})
checkContact('item-outside-claimed-line', (a) => {
  a.raw.pages[1].items[2].transform[4] -= 1
})
