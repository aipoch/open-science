/* eslint-disable @typescript-eslint/explicit-function-return-type -- test fixtures */
import { expect, it } from 'vitest'
import {
  PDFDocument,
  StandardFonts,
  rgb,
  setCharacterSqueeze,
  beginText,
  endText,
  setFontAndSize,
  setTextMatrix,
  PDFArray,
  PDFNumber,
  PDFOperator,
  PDFOperatorNames
} from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import * as fontkit from 'fontkit'
import { retainUnstructuredTablePages } from '../../src/reader/unstructured-table-retention.js'
import { createPdfTranslationSource } from '../../src/reader/source.js'
import { applyCachedPdfStructureSources } from '../../src/reader/structure-source.js'
import type { PdfStructureResult } from '@aipoch/pdf-structure/result'

async function setup(
  terminalRule = true,
  wrappedCaption = false,
  filledRails = false,
  openBottom = false,
  headerCase?: string,
  heading = 'Phase A'
) {
  const centered = headerCase?.startsWith('centered'),
    records = [
      ['Setting', heading, 'Phase B'],
      ['Mode', 'Alpha', 'Beta'],
      ['Count', '4', '8'],
      ['Variant', 'Short', 'Long']
    ]
  const pdf = await PDFDocument.create(),
    page = pdf.addPage([200, 200]),
    font = await pdf.embedFont(StandardFonts.Helvetica)
  for (let row = 0; row < 4; row++)
    for (let col = 0; col < 3; col++) {
      if (headerCase === 'centered-shared' && row === 0 && col === 2) continue
      const value = centered
        ? headerCase === 'centered-shared' && row === 0 && col === 1
          ? 'Phases A and B'
          : records[row][col]
        : headerCase && row === 0
          ? ['Type score', 'Rate', 'Group score'][col]
          : `${row + 1}${col + 1}`
      const naturalWidth = font.widthOfTextAtSize(value, 8),
        width = centered && row === 0 && col === 1 ? Math.min(naturalWidth, 32) : naturalWidth
      // Keep the complete hostile heading in its lane, so the native grammar must inspect it.
      if (width < naturalWidth)
        page.pushOperators(setCharacterSqueeze((width / naturalWidth) * 100))
      page.drawText(value, {
        x:
          centered && col > 0
            ? (headerCase === 'centered-shared' && row === 0 ? 127.5 : 100 + (col - 1) * 55) -
              width / 2 +
              (headerCase === 'centered-misaligned' && row === 2 && col === 2 ? 2 : 0)
            : headerCase === 'straddle' && row === 0 && col === 0
              ? 60
              : 25 + col * 50,
        y:
          170 -
          row * 15 -
          (headerCase && !centered && row === 0 && col === 1 && headerCase !== 'same-baseline'
            ? 5
            : 0),
        size: 8,
        font
      })
      if (width < naturalWidth) page.pushOperators(setCharacterSqueeze(100))
    }
  for (const y of openBottom ? [180, 150, 135] : terminalRule ? [180, 135, 120] : [180, 135]) {
    if (filledRails)
      page.drawRectangle({ x: 20, y: y - 0.4, width: 160, height: 0.8, color: rgb(0, 0, 0) })
    else page.drawLine({ start: { x: 20, y }, end: { x: 180, y }, thickness: 0.5 })
  }
  for (const x of centered ? [] : headerCase === 'missing-fence' ? [70] : [70, 120])
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
    body = centered
      ? rows.filter(({ item }) => item.transform[5] >= 125)
      : headerCase
        ? rows.slice(0, 12)
        : rows.filter(({ item }) => /^\d\d$/u.test(item.str)),
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
          issues: (centered
            ? [
                'native-table-structure-ambiguous',
                'no-source-cell-grid',
                'native-centered-headed-record-lanes-collapsed'
              ]
            : ['no-source-cell-grid']
          ).map((code) => ({ code, detail: code }))
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

it('retains independent centered record lanes without native column fences', async () => {
  const f = await setup(true, false, false, false, 'centered')
  try {
    const out = await retainUnstructuredTablePages(f.args),
      bodyIds = f.owners
        .filter((owner) => !owner.id.startsWith('outside-'))
        .map((owner) => owner.id)
    expect(out.retainedUnitIds).toEqual(bodyIds)
    expect(out.retainedSourcePageNumbers).toEqual([1])
    expect(out.extraction.source.originalRegions).toBeUndefined()
    expect(
      out.extraction.source.units.filter((unit) => unit.sourceOnly).map((unit) => unit.id)
    ).toEqual(bodyIds)
    expect(out.extraction.source.units.map((unit) => ({ ...unit, sourceOnly: undefined }))).toEqual(
      f.owners.map((unit) => ({ ...unit, sourceOnly: undefined }))
    )
    const projected = await applyCachedPdfStructureSources({
      ...f.args,
      preserveUnitIdentity: true
    })
    expect(projected.retainedUnitIds).toEqual(bodyIds)
    expect(projected.retainedSourcePageNumbers).toEqual([1])
    expect(projected.extraction.source.originalRegions ?? []).toEqual([])
  } finally {
    await f.task.destroy()
  }
})

it.each([
  ['AB12-3', true],
  ['ÅB2', true],
  ['A12', false],
  ['AB--3', false],
  ['AB' + '0'.repeat(96), true],
  ['AB' + '0'.repeat(96) + '!', false]
] as const)(
  'rechecks complete native heading text before retaining lanes: %s',
  async (heading, expected) => {
    const f = await setup(true, false, false, false, 'centered', heading)
    try {
      const out = await retainUnstructuredTablePages(f.args)
      expect(out.retainedSourcePageNumbers).toEqual(expected ? [1] : [])
      if (!expected) expect(out.extraction).toBe(f.args.extraction)
    } finally {
      await f.task.destroy()
    }
  }
)

it.each(['centered-shared', 'centered-misaligned', 'centered-open-bottom'])(
  'does not trust a centered-lane marker without the native family: %s',
  async (kind) => {
    const f = await setup(kind !== 'centered-open-bottom', false, false, false, kind)
    try {
      const out = await retainUnstructuredTablePages(f.args)
      expect(out.extraction).toBe(f.args.extraction)
      expect(out.retainedUnitIds).toEqual([])
      expect(out.retainedSourcePageNumbers).toEqual([])
    } finally {
      await f.task.destroy()
    }
  }
)

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

type RecordFamily = 'tuple' | 'section' | 'group'
const recordMarkers: Record<RecordFamily, string> = {
  tuple: 'native-fused-tuple-crosses-cell-wall',
  section: 'native-section-label-value-records-merged',
  group: 'native-group-heading-merged-with-record'
}
async function nativeRecordSetup(
  family: RecordFamily,
  broken = false,
  frame = true,
  wrappedField = false,
  inkFrame?: 'inside' | 'outside',
  valueAlignment: 'left' | 'center' | 'right' = 'left'
) {
  const pdf = await PDFDocument.create()
  if (inkFrame) pdf.registerFontkit(fontkit)
  const fonts = join(
      dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
      'standard_fonts'
    ),
    page = pdf.addPage([300, 250]),
    normal = await pdf.embedFont(
      inkFrame ? await readFile(join(fonts, 'LiberationSans-Regular.ttf')) : StandardFonts.Helvetica
    ),
    bold = await pdf.embedFont(
      inkFrame
        ? await readFile(join(fonts, 'LiberationSans-Bold.ttf'))
        : StandardFonts.HelveticaBold
    ),
    punctuation = await pdf.embedFont(StandardFonts.TimesRoman),
    text = (value: string, x: number, y: number, font = normal) => {
      if (inkFrame) {
        // Native positioning spaces avoid the custom font's unmapped space
        // glyph; the strict glyph reader still consumes the complete text show.
        const words = PDFArray.withContext(pdf.context)
        value.split(' ').forEach((word, index) => {
          if (index) words.push(PDFNumber.of((-font.widthOfTextAtSize(' ', 8) * 1000) / 8))
          words.push(font.encodeText(word))
        })
        page.pushOperators(
          beginText(),
          setFontAndSize(page.node.newFontDictionary('F', font.ref), 8),
          setTextMatrix(1, 0, 0, 1, x, y),
          PDFOperator.of(PDFOperatorNames.ShowTextAdjusted, [words]),
          endText()
        )
      } else page.drawText(value, { x, y, size: 8, font })
    }
  if (family === 'tuple') {
    ;['Case', 'First', 'Second'].forEach((v, c) => text(v, [25, 85, 135][c], 200, bold))
    for (let r = 0; r < 2; r++) {
      const y = 185 - r * 15,
        left = `(-${r + 2},0,1`,
        close = 85 + normal.widthOfTextAtSize(left, 8),
        wall = close + punctuation.widthOfTextAtSize(') ', 8) - 1
      text(String(r + 1), 25, y)
      text(left, 85, y)
      text(') (', close, y, punctuation)
      if (!broken) page.drawLine({ start: { x: wall, y: y - 3 }, end: { x: wall, y: y + 9 } })
      text('-1,0,2)', close + punctuation.widthOfTextAtSize(') (', 8), y)
    }
  } else if (family === 'section') {
    ;['Group', 'Setting', 'Value'].forEach((v, c) => text(v, [25, 100, 220][c], 200, bold))
    text('Controls', 25, 190, bold)
    const labels = ['Procedure', 'Step size', 'Window'],
      values = ['Fast', '0.02', '6']
    if (broken) {
      labels.forEach((v, n) => text(v, 100, 178 - n * 12))
      values.forEach((v, n) => text(v, 220, 178 - n * 12))
    } else
      labels.forEach((v, n) => {
        text(v, 100, 178 - n * 12)
        const width = normal.widthOfTextAtSize(values[n], 8)
        const offset =
          valueAlignment === 'right' ? width : valueAlignment === 'center' ? width / 2 : 0
        text(values[n], 220 - offset, 178 - n * 12)
      })
  } else {
    ;['Field', 'Code', 'Meaning', 'Value'].forEach((v, c) =>
      text(v, [25, 90, 160, 240][c], 200, bold)
    )
    for (let n = 0; n < 2; n++) {
      text(n ? 'Second group' : 'First group', 25, 185 - n * 35, broken ? normal : bold)
      ;['Width', 'w', 'Size measure', '4'].forEach((v, c) => {
        if (wrappedField && n === 0 && c === 2) {
          text('A long confi-', 160, 173)
          text('guration field', 160, 161)
        } else text(v, [25, 90, 160, 240][c], 173 - n * 35)
      })
    }
  }
  for (const y of frame ? [210, 120] : [210])
    page.drawLine({
      start: { x: inkFrame === 'inside' ? 25.01 : inkFrame === 'outside' ? 35 : 15, y },
      end: { x: 285, y },
      thickness: 0.5
    })
  text('Table 1: Native fields', 15, 230)
  text('Nearby prose remains eligible.', 15, 65)
  const bytes = await pdf.save(),
    task = getDocument({
      data: bytes.slice(),
      useSystemFonts: true,
      ...(inkFrame ? { fontExtraProperties: true, disableFontFace: true } : {})
    }),
    document = await task.promise,
    native = await document.getPage(1),
    content = await native.getTextContent(),
    rows = content.items.flatMap((item, index) =>
      'str' in item && item.str.trim() ? [{ item, index }] : []
    ),
    body = rows.filter(({ item }) => item.transform[5] >= 120 && item.transform[5] <= 210),
    owner = (id: string, records: typeof rows) => {
      const literal = records.map(({ item }) => item.str).join(' ')
      return {
        id,
        source:
          wrappedField && id === 'packed'
            ? literal.replace('confi- guration', 'configuration')
            : literal,
        fragments: [
          {
            pageNumber: 1,
            rect: {
              x: 0.05,
              y: id === 'packed' ? 0.16 : id === 'caption' ? 0.04 : 0.7,
              width: 0.9,
              height: id === 'packed' ? 0.36 : 0.08
            },
            items: records.map(({ item, index }) => ({ index, text: item.str }))
          }
        ]
      }
    },
    sourceIdentity = {
      sourceChecksum: createHash('sha256').update(bytes).digest('hex'),
      sourceSizeBytes: bytes.length
    },
    units = [
      owner('packed', body),
      ...rows
        .filter((r) => !body.includes(r))
        .map((r) => owner(r.item.str.startsWith('Table') ? 'caption' : 'prose', [r]))
    ],
    source = createPdfTranslationSource({
      resourceRequestKey: 'native-records',
      fingerprint: document.fingerprints[0],
      pages: [{ width: 300, height: 250 }],
      units
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
      pages: [{ page: 1, width: 300, height: 250, rotation: 0 }],
      elements: [
        {
          id: 'unstructured',
          kind: 'table',
          regions: [{ page: 1, x: 0.05, y: 0.16, width: 0.9, height: 0.36 }],
          caption: {
            text: 'Table 1: Native fields',
            regions: [{ page: 1, x: 0.05, y: 0.04, width: 0.9, height: 0.08 }]
          },
          issues: [
            'native-table-structure-ambiguous',
            'no-source-cell-grid',
            recordMarkers[family]
          ].map((code) => ({ code, detail: code }))
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
  return { args, cached, task, body, content }
}

it.each(['tuple', 'section', 'group'] as const)(
  'retains the complete source page for independently proved unstructured %s records',
  async (family) => {
    const f = await nativeRecordSetup(family)
    try {
      if (family === 'tuple') expect(f.body.map(({ item }) => item.str).join('|')).toContain(') (')
      const out = await applyCachedPdfStructureSources({ ...f.args, preserveUnitIdentity: true })
      expect(out.retainedSourcePageNumbers).toEqual([1])
      expect(out.retainedUnitIds).toEqual(['packed'])
      expect(out.extraction.source.originalRegions ?? []).toEqual([])
      expect(out.extraction.source.units).toEqual(
        f.args.extraction.source.units.map((u) =>
          u.id === 'packed' ? { ...u, sourceOnly: true } : u
        )
      )
    } finally {
      await f.task.destroy()
    }
  }
)

it.each(['center', 'right'] as const)(
  'retains unstructured section records with %s-aligned values',
  async (alignment) => {
    const f = await nativeRecordSetup('section', false, true, false, undefined, alignment)
    try {
      const out = await applyCachedPdfStructureSources({ ...f.args, preserveUnitIdentity: true })
      expect(out.retainedSourcePageNumbers).toEqual([1])
      expect(out.retainedUnitIds).toEqual(['packed'])
    } finally {
      await f.task.destroy()
    }
  }
)

it.each(['tuple', 'section', 'group'] as const)(
  'does not trust an unstructured %s marker without the native family',
  async (family) => {
    const f = await nativeRecordSetup(family, true)
    try {
      const out = await retainUnstructuredTablePages(f.args)
      expect(out.extraction).toBe(f.args.extraction)
      expect(out.retainedSourcePageNumbers).toEqual([])
    } finally {
      await f.task.destroy()
    }
  }
)

it.each([
  ['recognized markers', recordMarkers.section, true],
  ['centered and section markers', 'native-centered-headed-record-lanes-collapsed', true],
  ['no matching native family', recordMarkers.group, false],
  ['unrecognized marker', 'unknown-diagnostic', false]
] as const)(
  'validates the native evidence for multiple record diagnostics (%s)',
  async (_name, marker, retained) => {
    const f = await nativeRecordSetup('section')
    try {
      const issues = f.cached.elements[0].issues
      issues[2] = { code: recordMarkers.tuple, detail: '' }
      issues.push({ code: marker, detail: '' })
      if (
        marker === 'unknown-diagnostic' ||
        marker === 'native-centered-headed-record-lanes-collapsed'
      )
        issues.push({ code: recordMarkers.section, detail: '' })
      const out = await retainUnstructuredTablePages(f.args)
      expect(out.retainedSourcePageNumbers).toEqual(retained ? [1] : [])
    } finally {
      await f.task.destroy()
    }
  }
)

it('retains centered lanes when the cache also reports another recognized record conflict', async () => {
  const f = await setup(true, false, false, false, 'centered')
  try {
    f.cached.elements[0].issues.push({ code: recordMarkers.section, detail: '' })
    expect((await retainUnstructuredTablePages(f.args)).retainedSourcePageNumbers).toEqual([1])
  } finally {
    await f.task.destroy()
  }
})

it.each(['tuple', 'section', 'group'] as const)(
  'requires a complete native frame and matching marker for %s records',
  async (family) => {
    const f = await nativeRecordSetup(family, false, false),
      other = await nativeRecordSetup(family)
    try {
      expect((await retainUnstructuredTablePages(f.args)).retainedSourcePageNumbers).toEqual([])
      const marker = other.cached.elements[0].issues.at(-1)!
      marker.code = marker.detail =
        recordMarkers[family === 'tuple' ? 'section' : family === 'section' ? 'group' : 'tuple']
      expect((await retainUnstructuredTablePages(other.args)).retainedSourcePageNumbers).toEqual([])
    } finally {
      await f.task.destroy()
      await other.task.destroy()
    }
  }
)

it.each([
  'checksum',
  'page metadata',
  'partial owner',
  'mixed owner',
  'caption',
  'current page method',
  'unproved zero advance'
])('keeps unstructured record retention transactional for %s', async (fault) => {
  const f = await nativeRecordSetup('group')
  try {
    let args = f.args
    if (fault === 'checksum')
      args = { ...args, sourceIdentity: { ...args.sourceIdentity, sourceChecksum: 'b'.repeat(64) } }
    if (fault === 'page metadata') f.cached.pages[0].width++
    if (fault === 'caption') f.cached.elements[0].caption!.text += ' changed'
    if (fault === 'current page method')
      args = {
        ...args,
        readCached: async () => {
          args.document.getPage = args.document.getPage.bind(args.document)
          return f.cached
        }
      }
    if (fault === 'partial owner' || fault === 'mixed owner') {
      const units = structuredClone(args.extraction.source.units)
      if (fault === 'partial owner') units[0].fragments[0].items.pop()
      else {
        units[0].fragments.push(...units.at(-1)!.fragments)
        units[0].source += ' ' + units.at(-1)!.source
      }
      args = {
        ...args,
        extraction: {
          ...args.extraction,
          source: createPdfTranslationSource({ ...args.extraction.source, units })
        }
      }
    }
    if (fault === 'unproved zero advance') {
      const page = await args.document.getPage(1),
        content = structuredClone(f.content)
      content.items.push({
        ...content.items[0],
        str: 'x',
        width: 0,
        transform: [8, 0, 0, 8, 280, 30]
      } as (typeof content.items)[number])
      page.getTextContent = async () => content
    }
    const out = await retainUnstructuredTablePages(args)
    expect(out.extraction).toBe(args.extraction)
    expect(out.retainedUnitIds).toEqual([])
    expect(out.retainedSourcePageNumbers).toEqual([])
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

it.each(['canonical', 'changed spelling', 'missing line end'])(
  'requires complete native line-end evidence for a canonical record word: %s',
  async (mode) => {
    const f = await nativeRecordSetup('group', false, true, true)
    try {
      let args = f.args
      expect(args.extraction.source.units[0].source).toContain('configuration')
      if (mode === 'changed spelling') {
        const units = structuredClone(args.extraction.source.units)
        units[0].source = units[0].source.replace('configuration', 'configxuration')
        args = {
          ...args,
          extraction: {
            ...args.extraction,
            source: createPdfTranslationSource({ ...args.extraction.source, units })
          }
        }
      }
      if (mode === 'missing line end') {
        const page = await args.document.getPage(1),
          content = structuredClone(f.content)
        for (const item of content.items) if ('hasEOL' in item) item.hasEOL = false
        page.getTextContent = async () => content
      }
      const out = await retainUnstructuredTablePages(args)
      expect(out.retainedSourcePageNumbers).toEqual(mode === 'canonical' ? [1] : [])
      if (mode !== 'canonical') expect(out.extraction).toBe(args.extraction)
    } finally {
      await f.task.destroy()
    }
  }
)

it.each(['inside', 'outside'] as const)(
  'requires complete glyph ink within the unchanged native rails: %s',
  async (kind) => {
    const f = await nativeRecordSetup('group', false, true, false, kind)
    try {
      expect(Math.min(...f.body.map(({ item }) => item.transform[4]))).toBeLessThan(
        kind === 'inside' ? 25.01 : 35
      )
      const out = await retainUnstructuredTablePages(f.args)
      expect(out.retainedSourcePageNumbers).toEqual(kind === 'inside' ? [1] : [])
      expect(out.extraction.source.originalRegions).toBeUndefined()
    } finally {
      await f.task.destroy()
    }
  }
)

it('rejects a glyph outline changed after record proof but before source publication', async () => {
  const f = await nativeRecordSetup('group', false, true, false, 'inside')
  let outline: Float32Array | undefined,
    prior = 0
  try {
    const page = await f.args.document.getPage(1),
      { OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs'),
      operators = await page.getOperatorList(),
      first = f.content.items.find((item) => 'str' in item && item.str.trim())!,
      glyph = operators.argsArray[operators.fnArray.indexOf(OPS.showText)][0].find(
        (g) => typeof g?.fontChar === 'string'
      ),
      font = page.commonObjs.get('fontName' in first ? first.fontName : ''),
      read = f.args.document.getData.bind(f.args.document)
    outline = page.commonObjs.get(font.loadedName + '_path_' + glyph.fontChar).path
    expect(ArrayBuffer.isView(outline)).toBe(true)
    prior = outline![1]
    let reads = 0
    f.args.document.getData = async () => {
      const bytes = await read()
      if (++reads === 2) outline![1] = prior + 1
      return bytes
    }
    const out = await retainUnstructuredTablePages(f.args)
    expect(reads).toBe(2)
    expect(out.extraction).toBe(f.args.extraction)
    expect(out.retainedSourcePageNumbers).toEqual([])
  } finally {
    if (outline) outline[1] = prior
    await f.task.destroy()
  }
})

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
