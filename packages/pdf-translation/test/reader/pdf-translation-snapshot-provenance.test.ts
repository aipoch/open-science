import { expect, it, vi } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { applyPdfContentFirstPolicy } from '../../src/reader/content-policy.js'
import type { PdfTranslationExtraction } from '../../src/reader/extraction.js'
import { createPdfTranslationSource } from '../../src/reader/source.js'
import {
  getPdfTranslationLayoutSnapshot,
  rememberPdfTranslationExtraction,
  restorePdfTranslationExtraction
} from '../../src/reader/snapshot.js'
import {
  type PdfTranslationLayoutSnapshot,
  pdfTranslationLayoutSnapshotSchema
} from '../../src/snapshot.js'
import { applyCachedPdfStructureSources } from '../../src/reader/structure-source.js'
import { extractPdfTranslationSource } from '../../src/reader/extraction.js'

function fixture(): PdfTranslationExtraction {
  return {
    source: createPdfTranslationSource({
      resourceRequestKey: 'anonymous-source',
      fingerprint: 'anonymous-fingerprint',
      pages: [{ width: 600, height: 800 }],
      units: [
        {
          id: 'formula',
          source: 'x = 1',
          preserve: 'formula',
          fragments: [
            {
              pageNumber: 1,
              rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.02 },
              items: [{ index: 0, text: 'x = 1' }]
            }
          ]
        }
      ]
    }),
    coverage: {
      pageCount: 1,
      textItemCount: 1,
      includedItemCount: 1,
      excludedItemCount: 0,
      pagesWithoutText: [],
      exclusions: [],
      warnings: []
    }
  }
}

function historical(): {
  snapshot: PdfTranslationLayoutSnapshot
  extraction: PdfTranslationExtraction
} {
  const { source, coverage } = fixture()
  const snapshot = pdfTranslationLayoutSnapshotSchema.parse({
    version: 1,
    parserVersion: 'historical-parser',
    fingerprint: source.fingerprint,
    pages: [...source.pages],
    units: [...source.units],
    coverage
  })
  return { snapshot, extraction: restorePdfTranslationExtraction(snapshot, 'restored-source') }
}

it('keeps a known historical parser when remembering a policy-derived source', () => {
  const { extraction } = historical(),
    source = applyPdfContentFirstPolicy(extraction.source)
  rememberPdfTranslationExtraction({ ...extraction, source })
  expect(getPdfTranslationLayoutSnapshot(source)?.parserVersion).toBe('historical-parser')
})

it('carries known provenance through consecutive policy derivations', () => {
  const { extraction } = historical(),
    first = applyPdfContentFirstPolicy(extraction.source),
    second = applyPdfContentFirstPolicy(first)
  rememberPdfTranslationExtraction({ ...extraction, source: first })
  rememberPdfTranslationExtraction({ ...extraction, source: second })
  expect(getPdfTranslationLayoutSnapshot(first)?.parserVersion).toBe('historical-parser')
  expect(getPdfTranslationLayoutSnapshot(second)?.parserVersion).toBe('historical-parser')
})

it('snapshots the new policy flags and regions without modifying historical layout', () => {
  const { snapshot, extraction } = historical(),
    before = JSON.stringify(snapshot),
    source = applyPdfContentFirstPolicy(extraction.source)
  rememberPdfTranslationExtraction({ ...extraction, source })
  const derived = getPdfTranslationLayoutSnapshot(source)
  expect(source.units[0].sourceOnly).toBe(true)
  expect(source.originalRegions).toEqual([
    { pageNumber: 1, rect: source.units[0].fragments[0].rect }
  ])
  expect(derived?.units).toBe(source.units)
  expect(derived?.originalRegions).toBe(source.originalRegions)
  expect(derived?.coverage).toBe(snapshot.coverage)
  expect(pdfTranslationLayoutSnapshotSchema.safeParse(derived).success).toBe(true)
  expect(getPdfTranslationLayoutSnapshot(extraction.source)).toBe(snapshot)
  expect(JSON.stringify(snapshot)).toBe(before)
})

it('does not certify unknown derived origins while fresh extraction can still be remembered', () => {
  const extraction = fixture(),
    first = applyPdfContentFirstPolicy(extraction.source),
    second = applyPdfContentFirstPolicy(first)
  rememberPdfTranslationExtraction({ ...extraction, source: first })
  rememberPdfTranslationExtraction({ ...extraction, source: second })
  expect(getPdfTranslationLayoutSnapshot(first)).toBeUndefined()
  expect(getPdfTranslationLayoutSnapshot(second)).toBeUndefined()
  rememberPdfTranslationExtraction(extraction)
  expect(getPdfTranslationLayoutSnapshot(extraction.source)).toBeDefined()
  expect(getPdfTranslationLayoutSnapshot(first)).toBeUndefined()
})

it('retains current provenance after fresh structure preparation is remembered before policy', async () => {
  const extraction = fixture()
  const prepared = await applyCachedPdfStructureSources({
    extraction,
    document: { numPages: 1, fingerprints: [extraction.source.fingerprint], getPage: vi.fn() },
    sourceId: 'anonymous-source',
    sourceIdentity: { sourceChecksum: 'a'.repeat(64), sourceSizeBytes: 1 },
    signal: new AbortController().signal,
    readCached: async () => undefined
  })
  rememberPdfTranslationExtraction(prepared.extraction)
  const current = getPdfTranslationLayoutSnapshot(prepared.extraction.source)
  expect(current).toBeDefined()
  const source = applyPdfContentFirstPolicy(prepared.extraction.source)
  rememberPdfTranslationExtraction({ ...prepared.extraction, source })
  expect(getPdfTranslationLayoutSnapshot(source)?.parserVersion).toBe(current?.parserVersion)
  expect(getPdfTranslationLayoutSnapshot(source)?.units).toBe(source.units)
})

it('marks fresh native provenance without pinning coverage before a policy is remembered', async () => {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica)
  pdf.addPage([600, 800]).drawText('An anonymous paragraph contains ordinary prose.', {
    font,
    x: 60,
    y: 700,
    size: 12
  })
  const task = getDocument({ data: await pdf.save(), useSystemFonts: true })
  try {
    const document = await task.promise,
      extraction = await extractPdfTranslationSource({
        document,
        resourceRequestKey: 'anonymous-fresh-source',
        signal: new AbortController().signal
      })
    expect(getPdfTranslationLayoutSnapshot(extraction.source)).toBeUndefined()
    const source = applyPdfContentFirstPolicy(extraction.source),
      coverage = {
        ...extraction.coverage,
        warnings: [{ unitId: source.units[0].id, reasons: ['possible-continuation'] }]
      }
    rememberPdfTranslationExtraction({ source, coverage })
    const snapshot = getPdfTranslationLayoutSnapshot(source)
    expect(snapshot?.coverage).toBe(coverage)
    expect(snapshot?.units).toBe(source.units)
    expect(pdfTranslationLayoutSnapshotSchema.safeParse(snapshot).success).toBe(true)
    rememberPdfTranslationExtraction(extraction)
    expect(snapshot?.parserVersion).toBe(
      getPdfTranslationLayoutSnapshot(extraction.source)?.parserVersion
    )
    expect(getPdfTranslationLayoutSnapshot(extraction.source)?.coverage).toBe(extraction.coverage)
    expect(snapshot?.coverage).toBe(coverage)
  } finally {
    await task.destroy()
  }
})
