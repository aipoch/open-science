/* eslint-disable @typescript-eslint/explicit-function-return-type -- test fixtures */
import { expect, it } from 'vitest'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { createHash } from 'node:crypto'
import { retainUnstructuredTablePages } from '../../src/reader/unstructured-table-retention.js'
import { createPdfTranslationSource } from '../../src/reader/source.js'
import { applyCachedPdfStructureSources } from '../../src/reader/structure-source.js'
import type { PdfStructureResult } from '@aipoch/pdf-structure/result'

async function setup(
  terminalRule = true,
  wrappedCaption = false,
  filledRails = false,
  openBottom = false,
  headerCase?: string
) {
  const pdf = await PDFDocument.create(),
    page = pdf.addPage([200, 200]),
    font = await pdf.embedFont(StandardFonts.Helvetica)
  for (let row = 0; row < 4; row++)
    for (let col = 0; col < 3; col++)
      page.drawText(
        headerCase && row === 0
          ? ['Type score', 'Rate', 'Group score'][col]
          : `${row + 1}${col + 1}`,
        {
          x: headerCase === 'straddle' && row === 0 && col === 0 ? 60 : 25 + col * 50,
          y:
            170 -
            row * 15 -
            (headerCase && row === 0 && col === 1 && headerCase !== 'same-baseline' ? 5 : 0),
          size: 8,
          font
        }
      )
  for (const y of openBottom ? [180, 150, 135] : terminalRule ? [180, 135, 120] : [180, 135]) {
    if (filledRails)
      page.drawRectangle({ x: 20, y: y - 0.4, width: 160, height: 0.8, color: rgb(0, 0, 0) })
    else page.drawLine({ start: { x: 20, y }, end: { x: 180, y }, thickness: 0.5 })
  }
  for (const x of headerCase === 'missing-fence' ? [70] : [70, 120])
    page.drawLine({
      start: { x, y: headerCase === 'partial-band' && x === 120 ? 170 : terminalRule ? 120 : 135 },
      end: { x, y: 180 },
      thickness: 0.5
    })
  if (wrappedCaption) {
    page.drawText('Table 1: Native record classifi-', { x: 20, y: 90, size: 8, font })
    page.drawText('cation values', { x: 20, y: 78, size: 8, font })
  } else page.drawText('Table 1: Native record values', { x: 20, y: 90, size: 8, font })
  page.drawText('Nearby prose remains eligible.', { x: 20, y: 65, size: 8, font })
  const bytes = await pdf.save(),
    task = getDocument({ data: bytes.slice(), useSystemFonts: true }),
    document = await task.promise,
    native = await document.getPage(1),
    content = await native.getTextContent(),
    rows = content.items.flatMap((item, index) =>
      'str' in item && item.str.trim() ? [{ item, index }] : []
    ),
    body = headerCase ? rows.slice(0, 12) : rows.filter(({ item }) => /^\d\d$/u.test(item.str)),
    fragments = (records: typeof body) => [
      {
        pageNumber: 1,
        rect: {
          x: 0.1,
          y: Math.min(...records.map(({ item }) => (200 - item.transform[5] - 8) / 200)),
          width: 0.7,
          height:
            (Math.max(...records.map(({ item }) => 200 - item.transform[5])) -
              Math.min(...records.map(({ item }) => 200 - item.transform[5] - 8))) /
            200
        },
        items: records.map(({ item, index }) => ({ index, text: item.str }))
      }
    ],
    owners = headerCase
      ? [
          {
            id: 'header-packet',
            source: body
              .slice(0, 3)
              .map((r) => r.item.str)
              .join(' '),
            fragments: fragments(body.slice(0, 3))
          },
          ...(headerCase === 'protected-multirow'
            ? [
                {
                  id: 'protected-values',
                  source: body
                    .slice(3, 9)
                    .map((r) => r.item.str)
                    .join(' '),
                  fragments: fragments(body.slice(3, 9)),
                  sourceOnly: true as const
                },
                ...body.slice(9).map((r, index) => ({
                  id: `value-${index}`,
                  source: r.item.str,
                  fragments: fragments([r])
                }))
              ]
            : body.slice(3).map((r, index) => ({
                id: `value-${index}`,
                source: r.item.str,
                fragments: fragments([r])
              }))),
          ...rows
            .filter((r) => !body.includes(r))
            .map((r, index) => ({
              id: `outside-${index}`,
              source: r.item.str,
              fragments: fragments([r])
            }))
        ]
      : [
          ...body.slice(0, 6).map((r, index) => ({
            id: `owner-${index}`,
            source: r.item.str,
            fragments: fragments([r])
          })),
          {
            id: 'packed',
            source: body
              .slice(6)
              .map((r) => r.item.str)
              .join(' '),
            fragments: fragments(body.slice(6))
          },
          ...rows
            .filter((r) => !body.includes(r))
            .map((r, index) => ({
              id: `outside-${index}`,
              source: r.item.str,
              fragments: fragments([r])
            }))
        ],
    sourceIdentity = {
      sourceChecksum: createHash('sha256').update(bytes).digest('hex'),
      sourceSizeBytes: bytes.length
    },
    source = createPdfTranslationSource({
      resourceRequestKey: 'native-records',
      fingerprint: document.fingerprints[0],
      pages: [{ width: 200, height: 200 }],
      units: owners
    }),
    extraction = {
      source,
      coverage: {
        pageCount: 1,
        textItemCount: rows.length,
        includedItemCount: rows.length,
        excludedItemCount: 0,
        pagesWithoutText: [],
        exclusions: [],
        warnings: []
      }
    },
    cached = {
      schemaVersion: 1,
      extractionId: 'native-records',
      engineFingerprint: 'a'.repeat(64),
      ...sourceIdentity,
      pageCount: 1,
      requestedPages: [1],
      processedPages: [1],
      pages: [{ page: 1, width: 200, height: 200, rotation: 0 }],
      elements: [
        {
          id: 'unstructured',
          kind: 'table',
          regions: [{ page: 1, x: 0.1, y: 0.1, width: 0.8, height: headerCase ? 0.305 : 0.28 }],
          caption: {
            text: wrappedCaption
              ? 'Table 1: Native record classification values'
              : 'Table 1: Native record values',
            regions: [{ page: 1, x: 0.1, y: 0.5, width: 0.8, height: wrappedCaption ? 0.13 : 0.06 }]
          },
          issues: [{ code: 'no-source-cell-grid', detail: 'no-source-cell-grid' }]
        }
      ],
      thumbnails: [],
      navigation: [],
      issues: []
    } as unknown as PdfStructureResult,
    args = {
      document,
      extraction,
      sourceIdentity,
      sourceId: 'native-records',
      signal: new AbortController().signal,
      readCached: async () => cached
    }
  return { args, cached, body, task, owners }
}

it('retains complete packed table owners and its source page without inventing a crop', async () => {
  const f = await setup()
  try {
    const out = await retainUnstructuredTablePages(f.args)
    expect(out.retainedSourcePageNumbers).toEqual([1])
    expect(out.retainedUnitIds).toEqual([...f.owners.slice(0, 7)].map((u) => u.id))
    expect(out.extraction.source.originalRegions).toBeUndefined()
    expect(out.extraction.source.units.filter((u) => u.sourceOnly)).toHaveLength(7)
    expect(out.extraction.source.units.slice(7).every((u) => !u.sourceOnly)).toBe(true)
    const projected = await applyCachedPdfStructureSources({
      ...f.args,
      preserveUnitIdentity: true
    })
    expect(projected.retainedSourcePageNumbers).toEqual([1])
    expect(projected.extraction.source.units.map((u) => u.id)).toEqual(f.owners.map((u) => u.id))
    expect(projected.extraction.source.originalRegions ?? []).toEqual([])
  } finally {
    await f.task.destroy()
  }
})

it.each(['partial-owner', 'mixed-owner', 'stale-bytes', 'caption-overlap', 'foreign-origin'])(
  'declines %s evidence atomically',
  async (fault) => {
    const f = await setup()
    try {
      let args = f.args
      if (fault === 'stale-bytes')
        args = {
          ...args,
          sourceIdentity: { ...args.sourceIdentity, sourceChecksum: 'b'.repeat(64) }
        }
      if (fault === 'caption-overlap') f.cached.elements[0].caption!.regions[0].y = 0.3
      if (fault === 'partial-owner' || fault === 'mixed-owner' || fault === 'foreign-origin') {
        const units = JSON.parse(JSON.stringify(args.extraction.source.units))
        if (fault === 'partial-owner') units.find((u) => u.id === 'packed').fragments[0].items.pop()
        if (fault === 'mixed-owner') {
          const outside = units.pop()
          units.find((u) => u.id === 'packed').fragments.push(...outside.fragments)
        }
        if (fault === 'foreign-origin') units[0].fragments[0].items[0].text = 'changed'
        args = {
          ...args,
          extraction: {
            ...args.extraction,
            source: createPdfTranslationSource({ ...args.extraction.source, units })
          }
        }
      }
      const out = await retainUnstructuredTablePages(args)
      expect(out.extraction).toBe(args.extraction)
      expect(out.retainedSourcePageNumbers).toEqual([])
    } finally {
      await f.task.destroy()
    }
  }
)

it('declines a native rule family without its terminal body boundary', async () => {
  const f = await setup(false)
  try {
    const out = await retainUnstructuredTablePages(f.args)
    expect(out.extraction).toBe(f.args.extraction)
    expect(out.retainedSourcePageNumbers).toEqual([])
  } finally {
    await f.task.destroy()
  }
})

it('matches only a witnessed caption word split across native lines', async () => {
  const f = await setup(true, true)
  try {
    expect((await retainUnstructuredTablePages(f.args)).retainedSourcePageNumbers).toEqual([1])
    f.cached.elements[0].caption!.text = 'Table 1: Native record classification-values'
    expect((await retainUnstructuredTablePages(f.args)).retainedSourcePageNumbers).toEqual([])
  } finally {
    await f.task.destroy()
  }
})

it('observes printed filled rectangle rails without inventing table cells', async () => {
  const f = await setup(true, false, true)
  try {
    const out = await retainUnstructuredTablePages(f.args)
    expect(out.retainedSourcePageNumbers).toEqual([1])
    expect(out.retainedUnitIds).toHaveLength(7)
    expect(out.extraction.source.originalRegions).toBeUndefined()
  } finally {
    await f.task.destroy()
  }
})

it('keeps the existing multirow terminal boundary strict when the selection is padded', async () => {
  const f = await setup()
  try {
    f.cached.elements[0].regions[0].height = 0.305
    const out = await applyCachedPdfStructureSources({ ...f.args, preserveUnitIdentity: true })
    expect(out.retainedUnitIds).toEqual([])
    expect(out.retainedSourcePageNumbers ?? []).toEqual([])
  } finally {
    await f.task.destroy()
  }
})

it('retains an open bottom table only with matching complete terminal native rails', async () => {
  const f = await setup(true, false, true, true)
  try {
    expect((await retainUnstructuredTablePages(f.args)).retainedSourcePageNumbers).toEqual([1])
  } finally {
    await f.task.destroy()
  }
})

it('retains only a whole header crossing native fences at two levels through structure preparation', async () => {
  const f = await setup(true, false, false, false, 'protected-multirow')
  try {
    const before = JSON.stringify(f.args.extraction.source)
    for (const preserveUnitIdentity of [false, true]) {
      const out = await applyCachedPdfStructureSources({ ...f.args, preserveUnitIdentity })
      expect(out.retainedSourcePageNumbers).toEqual([1])
      expect(out.retainedUnitIds).toEqual(preserveUnitIdentity ? ['header-packet'] : [])
      expect(out.extraction.source.originalRegions ?? []).toEqual([])
      expect(out.extraction.source.units.map((u) => u.id)).toEqual(f.owners.map((u) => u.id))
      expect(out.extraction.source.units[0]).toEqual({ ...f.owners[0], sourceOnly: true })
      expect(out.extraction.source.units.slice(1)).toEqual(f.owners.slice(1))
      const restored = await applyCachedPdfStructureSources({
        ...f.args,
        extraction: out.extraction,
        preserveUnitIdentity: true
      })
      expect(restored.retainedSourcePageNumbers).toEqual([1])
      expect(restored.retainedUnitIds).toEqual(['header-packet'])
      expect(restored.extraction.source.units).toEqual(out.extraction.source.units)
    }
    expect(JSON.stringify(f.args.extraction.source)).toBe(before)
  } finally {
    await f.task.destroy()
  }
})

it.each([
  'missing-fence',
  'partial-band',
  'straddle',
  'same-baseline',
  'foreign-owner',
  'caption',
  'checksum'
])('does not retain an unproved layered header: %s', async (fault) => {
  const f = await setup(true, false, false, false, fault)
  try {
    let args = f.args
    if (fault === 'checksum')
      args = { ...args, sourceIdentity: { ...args.sourceIdentity, sourceChecksum: 'b'.repeat(64) } }
    if (fault === 'caption') f.cached.elements[0].caption!.regions[0].y = 0.3
    if (fault === 'foreign-owner') {
      const units = structuredClone(args.extraction.source.units)
      const outside = units.pop()!
      units[0].fragments.push(...outside.fragments)
      units[0].source += ' ' + outside.source
      args = {
        ...args,
        extraction: {
          ...args.extraction,
          source: createPdfTranslationSource({ ...args.extraction.source, units })
        }
      }
    }
    const before = JSON.stringify(args.extraction.source)
    const out = await applyCachedPdfStructureSources({ ...args, preserveUnitIdentity: true })
    expect(out.retainedSourcePageNumbers ?? []).toEqual([])
    expect(out.retainedUnitIds).toEqual([])
    expect(out.extraction.source.units).toEqual(args.extraction.source.units)
    expect(JSON.stringify(args.extraction.source)).toBe(before)
  } finally {
    await f.task.destroy()
  }
})
