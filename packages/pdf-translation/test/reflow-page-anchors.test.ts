import {
  PDFDocument,
  PDFObject,
  PDFString,
  StandardFonts,
  rgb,
  pushGraphicsState,
  popGraphicsState,
  rectangle,
  clip,
  endPath
} from 'pdf-lib'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { resolve } from './paths.js'
const { engine } = await import(pathToFileURL(resolve('resources/pdfium.mjs')).href)
const { readBlankPageAnchors, mapBlankPageAnchor } = await import(
  pathToFileURL(resolve('resources/reflow-page-anchors.mjs')).href
)
type Box = { x: number; y: number; width: number; height: number }
type Unit = {
  source: string
  translation: string
  fragments: { pageNumber: number; rect: Box; items: { index: number; text: string }[] }[]
}
type Entry = {
  raw: PDFString
  value: PDFObject
  destination: { pageNumber: number; mode: number; params: (number | null)[] }
}
type HeaderFixture = {
  native: Awaited<ReturnType<typeof engine>>
  source: { doc: number; close: () => void }
  input: { data: Uint8Array; pages: { width: number; height: number }[]; units: Unit[] }
  entries: Entry[]
  geometry: { left: number; top: number; width: number; height: number }[]
  close: () => void
}
async function headers(variant = ''): Promise<HeaderFixture> {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica),
    units: Unit[] = []
  for (let n = 1; n <= 2; n++) {
    const page = pdf.addPage([400, 500])
    if (variant === 'clipped')
      page.pushOperators(pushGraphicsState(), rectangle(35, 450, 25, 25), clip(), endPath())
    page.drawText('ANONYMOUS JOURNAL', { font, size: 10, x: 40, y: 460 })
    if (variant === 'clipped') page.pushOperators(popGraphicsState())
    page.drawText('Author Names', { font, size: 10, x: 260, y: 460 })
    if (variant === 'foreign-white')
      page.drawLine({
        start: { x: 40, y: 482 },
        end: { x: 100, y: 482 },
        thickness: 1,
        color: rgb(1, 1, 1)
      })
    units.push(
      {
        source: 'ANONYMOUS JOURNAL',
        translation: '匿名期刊',
        fragments: [
          {
            pageNumber: n,
            rect: { x: 0.1, y: 0.06, width: 0.4, height: 0.03 },
            items: [{ index: 0, text: 'ANONYMOUS JOURNAL' }]
          }
        ]
      },
      {
        source: 'Author Names',
        translation: 'Author Names',
        fragments: [
          {
            pageNumber: n,
            rect: { x: 0.65, y: 0.06, width: 0.25, height: 0.03 },
            items: [{ index: 1, text: 'Author Names' }]
          }
        ]
      }
    )
  }
  const pdfPages = pdf.getPages()
  const data = await pdf.save(),
    native = await engine(),
    source = native.open(data),
    input = {
      data,
      pages: [
        { width: 400, height: 500 },
        { width: 400, height: 500 }
      ],
      units
    },
    entries = pdfPages.map((p, i) => ({
      raw: PDFString.of(`page.${i + 1}`),
      value: pdf.context.obj([p.ref, 'XYZ', 40, 490, null]),
      destination: { pageNumber: i + 1, mode: 1, params: [40, 490, null] }
    })),
    geometry = [
      { left: 0, top: 500, width: 400, height: 500 },
      { left: 0, top: 500, width: 400, height: 500 }
    ]
  return { input, entries, native, source, geometry, close: () => source.close() }
}

it.each([0, 1])(
  'maps a complete two-field native header only to emitted member %s',
  async (owner) => {
    const f = await headers()
    try {
      const certificates = readBlankPageAnchors(
        f.native,
        f.source,
        f.input,
        f.entries,
        f.geometry,
        new Set()
      )
      expect(certificates.size).toBe(2)
      const rect = { x: 0.1, y: 0.1, width: 0.5, height: 0.03 },
        unit = f.input.units[owner],
        context = new Map([
          [1, { pageNumber: 1, rect, kind: 'line', unitIndex: owner, covered: false }]
        ])
      expect(
        mapBlankPageAnchor(
          f.entries[0],
          certificates,
          context,
          [[1]],
          new Map([[owner, [{ pageNumber: 1, rect, text: unit.translation }]]]),
          new Map([[owner, [{ text: unit.translation }]]]),
          f.input.units
        )
      ).toEqual({ pageNumber: 1, mode: 1, params: [59.528, 757.701, null] })
    } finally {
      f.close()
    }
  }
)

it.each([
  'missing-family',
  'duplicate-owner',
  'duplicate-item',
  'wrong-items',
  'foreign-white',
  'clipped'
])('does not certify incomplete native header closure: %s', async (variant) => {
  const f = await headers(variant)
  try {
    if (variant === 'missing-family') f.entries.pop()
    if (variant === 'duplicate-owner') f.input.units.push(structuredClone(f.input.units[0]))
    if (variant === 'duplicate-item') f.input.units[1].fragments[0].items[0].index = 0
    if (variant === 'wrong-items') f.input.units[1].fragments[0].items[0].text = 'Other author'
    const certificates = readBlankPageAnchors(
      f.native,
      f.source,
      f.input,
      f.entries,
      f.geometry,
      new Set()
    )
    expect(certificates.has(f.entries[0])).toBe(false)
  } finally {
    f.close()
  }
})

it.each(['owner-mutated', 'entry-mutated', 'covered', 'crop', 'nonmember', 'incomplete-text'])(
  'preserves final native-header mapping guards: %s',
  async (variant) => {
    const f = await headers()
    try {
      const certificates = readBlankPageAnchors(
        f.native,
        f.source,
        f.input,
        f.entries,
        f.geometry,
        new Set()
      )
      expect(certificates.size).toBe(2)
      const rect = { x: 0.1, y: 0.1, width: 0.5, height: 0.03 },
        first = { pageNumber: 1, rect, kind: 'line', unitIndex: 0, covered: false },
        lines = new Map([[0, [{ text: f.input.units[0].translation }]]])
      if (variant === 'owner-mutated') f.input.units[1].source = 'Changed author'
      if (variant === 'entry-mutated') f.entries[0].destination.params[0] = 41
      if (variant === 'covered') first.covered = true
      if (variant === 'crop') first.kind = 'crop'
      if (variant === 'nonmember') first.unitIndex = 99
      if (variant === 'incomplete-text') lines.set(0, [{ text: '匿名' }])
      expect(
        mapBlankPageAnchor(
          f.entries[0],
          certificates,
          new Map([[1, first]]),
          [[1]],
          new Map([[0, [{ pageNumber: 1, rect, text: f.input.units[0].translation }]]]),
          lines,
          f.input.units
        )
      ).toBeUndefined()
    } finally {
      f.close()
    }
  }
)
