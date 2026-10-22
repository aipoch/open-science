// @vitest-environment jsdom
import { resolve } from 'node:path'
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { PdfTranslationWriter } from '@aipoch/pdf-translation/writer'
import {
  createPdfTranslationSource,
  extractPdfTranslationSource,
  rememberPdfTranslationExtraction,
  preservePdfFigureSources,
  applyPdfContentFirstPolicy
} from '@aipoch/pdf-translation/reader'
import { usePdfTranslationDocument } from './use-pdf-translation-document'

vi.mock('../pdfjs', async () => {
  const core = await import('pdfjs-dist/legacy/build/pdf.mjs')
  return { pdfjsLib: { getDocument: core.getDocument, OPS: core.OPS } }
})
afterEach(() => vi.unstubAllGlobals())

it.each(['figure', 'reference', 'code', 'literal', 'missing', 'mismatched', 'empty'] as const)(
  'keeps valid accepted translations ahead of derived protection: %s',
  async (kind) => {
    vi.stubGlobal('Uint8Array', Object.getPrototypeOf(Buffer.prototype).constructor)
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica),
      page = pdf.addPage([400, 500]),
      figure = !['reference', 'code', 'literal'].includes(kind),
      valid = !['missing', 'mismatched', 'empty'].includes(kind),
      text =
        kind === 'code'
          ? 'npm install library'
          : kind === 'literal'
            ? 'https://example.org'
            : 'Original label.'
    if (figure)
      page.drawRectangle({ x: 40, y: 300, width: 240, height: 100, color: rgb(0.8, 0.8, 0.8) })
    page.drawText(text, { font, x: 50, y: 340, size: 12 })
    page.drawText('Figure 1. Caption.', { font, x: 40, y: 280, size: 12 })
    const originalTask = getDocument({ data: await pdf.save() }),
      original = await originalTask.promise,
      source = createPdfTranslationSource({
        resourceRequestKey: 'accepted-reflow',
        fingerprint: original.fingerprints[0]!,
        pages: [{ width: 400, height: 500 }],
        units: [
          {
            id: 'accepted',
            source: text,
            ...(kind === 'reference' ? { preserve: 'reference' as const } : {}),
            fragments: [
              { pageNumber: 1, rect: { x: 0.125, y: 0.29, width: 0.5, height: 0.04 }, items: [] }
            ]
          },
          {
            id: 'caption',
            source: 'Figure 1. Caption.',
            fragments: [
              { pageNumber: 1, rect: { x: 0.1, y: 0.42, width: 0.7, height: 0.04 }, items: [] }
            ]
          }
        ]
      })
    const protectedSource = applyPdfContentFirstPolicy(
      (
        await preservePdfFigureSources({
          document: original,
          extraction: { source },
          operators: (await import('pdfjs-dist/legacy/build/pdf.mjs')).OPS,
          signal: new AbortController().signal
        })
      ).source
    )
    expect(protectedSource.units[0].sourceOnly).toBe(true)
    expect(Boolean(protectedSource.units[0].figure)).toBe(figure)
    const writer = new PdfTranslationWriter(() =>
        resolve('packages/pdf-translation/resources/worker.mjs')
      ),
      generatePdf = vi.fn(async (request) =>
        writer.generateDetailed(
          { ...request, data: new Uint8Array(request.data) },
          {
            leaseId: 'accepted-reflow',
            generation: 1,
            signal: new AbortController().signal,
            isCurrent: () => true
          }
        )
      ),
      recordLayout = vi.fn(async () => {})
    vi.stubGlobal('api', {
      pdfTranslation: { generatePdf, recordLayout, cancelPdf: vi.fn(async () => {}) }
    })
    const results = {
      source,
      checkpoint: { key: 'edition', source: 'attachment' },
      units: [
        ...(kind === 'missing'
          ? []
          : [
              {
                id: 'accepted',
                translationSource: kind === 'mismatched' ? 'Different source.' : text,
                translation: kind === 'empty' ? '  ' : 'Accepted translation.'
              }
            ]),
        {
          id: 'caption',
          translationSource: 'Figure 1. Caption.',
          translation: 'Figure 1. Translated caption.'
        }
      ]
    }
    const hook = renderHook(() =>
      usePdfTranslationDocument(
        original,
        results,
        undefined,
        'accepted-reflow',
        undefined,
        'reflow'
      )
    )
    try {
      await waitFor(() => expect(generatePdf).toHaveBeenCalledOnce(), { timeout: 15000 })
      expect(generatePdf.mock.calls[0][0].units[0].translation).toBe(
        valid ? 'Accepted translation.' : text
      )
      await waitFor(() => expect(hook.result.current.state.status).toBe('ready'), {
        timeout: 15000
      })
      const ready = hook.result.current.ready!
      expect(ready.originalUnitCount).toBe(figure && !valid ? 1 : 0)
      expect(ready.retainedUnitIds).toEqual([])
      expect(hook.result.current.unfilledUnitIds).toEqual([])
      const outputText: string[] = []
      for (let number = 1; number <= ready.document.numPages; number++) {
        const content = await (await ready.document.getPage(number)).getTextContent()
        outputText.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' '))
      }
      expect(outputText.join(' ').includes('Accepted translation.')).toBe(valid)
      if (valid)
        expect(recordLayout).toHaveBeenCalledWith(
          expect.objectContaining({
            units: [
              { sourceIndex: 0, source: text, translation: 'Accepted translation.' },
              {
                sourceIndex: 1,
                source: 'Figure 1. Caption.',
                translation: 'Figure 1. Translated caption.'
              }
            ]
          })
        )
      expect(source.units[0].sourceOnly).toBeUndefined()
      expect(results.units.find((unit) => unit.id === 'accepted')?.translation).toBe(
        kind === 'missing' ? undefined : kind === 'empty' ? '  ' : 'Accepted translation.'
      )
    } finally {
      hook.unmount()
      await originalTask.destroy()
    }
  },
  20000
)

it.each([
  { corrupted: false, retained: false },
  { corrupted: true, retained: false },
  { corrupted: false, retained: true }
])(
  'checks reflowed text and explicitly retained originals before display (%j)',
  async ({ corrupted, retained }) => {
    vi.stubGlobal('Uint8Array', Object.getPrototypeOf(Buffer.prototype).constructor)
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica)
    const page = pdf.addPage([400, 500])
    page.drawText('Original.', { font, x: 40, y: 440, size: 12 })
    if (retained) page.setRotation(degrees(90))
    const bytes = await pdf.save(),
      originalTask = getDocument({ data: bytes.slice() }),
      original = await originalTask.promise
    const source = createPdfTranslationSource({
      resourceRequestKey: 'reflow',
      fingerprint: original.fingerprints[0]!,
      pages: [{ width: 400, height: 500 }],
      units: [
        {
          id: 'a',
          source: 'Original.',
          fragments: [
            { pageNumber: 1, rect: { x: 0.1, y: 0.08, width: 0.8, height: 0.05 }, items: [] }
          ]
        }
      ]
    })
    const writer = new PdfTranslationWriter(() =>
      resolve('packages/pdf-translation/resources/worker.mjs')
    )
    const generatePdf = vi.fn(async (request) => {
      const output = await writer.generateDetailed(
        { ...request, data: new Uint8Array(request.data) },
        {
          leaseId: 'reflow-test',
          generation: 1,
          signal: new AbortController().signal,
          isCurrent: () => true
        }
      )
      if (corrupted && output) {
        const changed = await PDFDocument.load(output.data),
          font = await changed.embedFont(StandardFonts.Helvetica)
        changed.getPage(0).drawText('CORRUPTED', { font, size: 10, x: 45, y: 790 })
        return { ...output, data: await changed.save() }
      }
      return output
    })
    vi.stubGlobal('api', { pdfTranslation: { generatePdf, cancelPdf: vi.fn(async () => {}) } })
    const results = {
      source,
      units: [
        { id: 'a', translationSource: 'Original.', translation: '译文应完整排入 PDF。'.repeat(500) }
      ]
    }
    const hook = renderHook(() =>
      usePdfTranslationDocument(original, results, undefined, 'reflow', undefined, 'reflow')
    )
    try {
      await waitFor(() => expect(['ready', 'error']).toContain(hook.result.current.state.status), {
        timeout: 15000
      })
      if (corrupted) {
        expect(hook.result.current.state.status).toBe('error')
        expect(hook.result.current.ready).toBeUndefined()
      } else if (retained) {
        expect(hook.result.current.state.status).toBe('ready')
        expect(hook.result.current.ready!.document.numPages).toBe(1)
        expect(hook.result.current.ready!.retainedUnitIds).toEqual(['a'])
        expect(hook.result.current.layoutFailures.a).toMatchObject({
          code: 'unsupported-layout',
          pageNumbers: [1]
        })
        expect(hook.result.current.unfilledUnitIds).toEqual(['a'])
      } else {
        expect(hook.result.current.state.status).toBe('ready')
        expect(hook.result.current.ready!.document.numPages).toBeGreaterThan(1)
        expect(hook.result.current.unfilledUnitIds).toEqual([])
        expect(hook.result.current.ready!.unitFragments?.a.length).toBeGreaterThan(1)
      }
      expect(generatePdf).toHaveBeenCalledTimes(1)
      const previous = hook.result.current.ready
      act(() => hook.result.current.refresh())
      expect(hook.result.current.ready).toBe(previous)
      await waitFor(() => expect(generatePdf).toHaveBeenCalledTimes(2), { timeout: 15000 })
      await waitFor(
        () => expect(hook.result.current.state.status).toBe(corrupted ? 'error' : 'ready'),
        {
          timeout: 15000
        }
      )
      expect(generatePdf.mock.calls[1][0].units).toEqual(generatePdf.mock.calls[0][0].units)
      if (!corrupted) expect(hook.result.current.ready!.document).not.toBe(previous!.document)
    } finally {
      hook.unmount()
      await originalTask.destroy()
    }
  },
  20000
)

it.each(['rotated-page', 'tilted-text', 'historical-source'])(
  'retains unsafe original content and records fallback without replacing accepted translations: %s',
  async (kind) => {
    vi.stubGlobal('Uint8Array', Object.getPrototypeOf(Buffer.prototype).constructor)
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    const page = pdf.addPage([400, 500])
    page.drawText('Original.', { font, x: 40, y: 440, size: 12 })
    if (kind === 'rotated-page') page.setRotation(degrees(90))
    else
      page.drawText('IMPORTANT EXCLUDED EVIDENCE', {
        font,
        x: 50,
        y: 180,
        size: 12,
        rotate: degrees(30)
      })
    const originalTask = getDocument({ data: await pdf.save() })
    const original = await originalTask.promise
    const source = createPdfTranslationSource({
      resourceRequestKey: 'unsafe-reflow',
      fingerprint: original.fingerprints[0]!,
      pages: [
        { width: kind === 'rotated-page' ? 500 : 400, height: kind === 'rotated-page' ? 400 : 500 }
      ],
      units: [
        {
          id: 'a',
          source: 'Original.',
          fragments: [
            { pageNumber: 1, rect: { x: 0.1, y: 0.08, width: 0.8, height: 0.05 }, items: [] }
          ]
        }
      ]
    })
    if (kind !== 'historical-source') {
      const extraction = await extractPdfTranslationSource({
        document: original,
        resourceRequestKey: 'unsafe-reflow',
        signal: new AbortController().signal
      })
      if (kind === 'tilted-text')
        expect(extraction.source.units).toContainEqual(
          expect.objectContaining({ source: 'IMPORTANT EXCLUDED EVIDENCE', sourceOnly: true })
        )
      rememberPdfTranslationExtraction({ source, coverage: extraction.coverage })
    }
    const writer = new PdfTranslationWriter(() =>
      resolve('packages/pdf-translation/resources/worker.mjs')
    )
    const generatePdf = vi.fn(async (request) =>
      writer.generateDetailed(
        { ...request, data: new Uint8Array(request.data) },
        {
          leaseId: 'unsafe-reflow',
          generation: 1,
          signal: new AbortController().signal,
          isCurrent: () => true
        }
      )
    )
    const recordLayout = vi.fn(async () => {})
    vi.stubGlobal('api', {
      pdfTranslation: { generatePdf, recordLayout, cancelPdf: vi.fn(async () => {}) }
    })
    const results = {
      source,
      checkpoint: { key: 'edition', source: 'attachment' },
      units: [{ id: 'a', translationSource: 'Original.', translation: 'Translated body.' }]
    }
    const hook = renderHook(() =>
      usePdfTranslationDocument(original, results, undefined, 'unsafe-reflow', undefined, 'reflow')
    )
    try {
      await waitFor(() => expect(hook.result.current.state.status).toBe('ready'), {
        timeout: 15000
      })
      expect(hook.result.current.ready!.originalPageNumbers).toEqual([1])
      expect(hook.result.current.unfilledUnitIds).toEqual(['a'])
      expect(hook.result.current.layoutFailures.a).toEqual({
        code: 'unsupported-layout',
        phase: 'planning',
        pageNumbers: [1],
        fragmentCount: 1
      })
      const outputPage = await hook.result.current.ready!.document.getPage(1)
      const text = (await outputPage.getTextContent()).items
        .map((i) => ('str' in i ? i.str : ''))
        .join('')
      expect(text).toContain('Original.')
      if (kind !== 'rotated-page') expect(text).toContain('IMPORTANT EXCLUDED EVIDENCE')
      expect(text).not.toContain('Translated body.')
      expect(recordLayout).toHaveBeenCalledWith(
        expect.objectContaining({
          units: [
            {
              sourceIndex: 0,
              source: 'Original.',
              translation: 'Translated body.',
              failure: hook.result.current.layoutFailures.a
            }
          ]
        })
      )
      expect(results.units[0].translation).toBe('Translated body.')
    } finally {
      hook.unmount()
      await originalTask.destroy()
    }
  },
  20000
)
