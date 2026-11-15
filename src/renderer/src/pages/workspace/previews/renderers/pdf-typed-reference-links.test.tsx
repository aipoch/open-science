// @vitest-environment jsdom
import { renderHook, waitFor, cleanup } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib'
import { createPdfTranslationSource } from '@aipoch/pdf-translation/reader'
import { usePdfTranslationDocument } from './use-pdf-translation-document'

const { getDocument, operators } = vi.hoisted(() => ({ getDocument: vi.fn(), operators: {} }))
vi.mock('../pdfjs', () => ({ pdfjsLib: { getDocument, OPS: operators } }))
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

it.each([
  'bare',
  'repeated',
  'family',
  'panel',
  'order',
  'action',
  'swapped-hit',
  'same-row-duplicate',
  'compact-reference-with-unrelated-number',
  'shared-owner',
  'missing-claim',
  'stale-claim',
  'duplicate-native-row',
  'outside-hit'
] as const)(
  'binds real digit annotations to native typed-reference occurrences: %s',
  async (kind) => {
    const { getDocument: load, OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    Object.assign(operators, OPS)
    const repeated = kind !== 'bare',
      sourceRows = repeated
        ? [
            'Compare Fig. 4(b) for a first result.',
            'Consider 4 independent trials.',
            'Observe Fig. 4(c) for a control.',
            'Revisit Fig. 4(b) for a final result.'
          ]
        : ['Compare Fig.4 for the result.'],
      targetRows = repeated
        ? [
            'Updated Fig. 4(b) gives a first result.',
            'We consider 4 independent trials.',
            'Updated Fig. 4(c) gives a control.',
            'Updated Fig. 4(b) gives a final result.'
          ]
        : ['Updated Fig.4 gives the result.']
    if (kind === 'family') targetRows[0] = targetRows[0].replace('Fig.', 'Table')
    if (kind === 'panel') targetRows[0] = targetRows[0].replace('(b)', '(B)')
    if (kind === 'order') {
      targetRows[0] = targetRows[0].replace('(b)', '(c)')
      targetRows[2] = targetRows[2].replace('(c)', '(b)')
    }
    if (kind === 'same-row-duplicate') sourceRows[0] += ' Repeat 4 trials.'
    if (kind === 'compact-reference-with-unrelated-number')
      sourceRows[0] = sourceRows[0].replace('Fig. 4', 'Fig.4') + ' Repeat 4 trials.'
    const make = async (target: boolean): Promise<Uint8Array> => {
      const pdf = await PDFDocument.create(),
        native = await pdf.embedFont(StandardFonts.Helvetica),
        prose = await pdf.embedFont(StandardFonts.TimesRoman),
        page = pdf.addPage([600, 800]),
        annotations: ReturnType<typeof pdf.context.register>[] = [],
        rectangles: number[][] = []
      for (const [index, row] of (target ? targetRows : sourceRows).entries()) {
        const y = 700 - index * 18,
          match = /Fig\.?\s*(4)|Table\s*(4)/u.exec(row),
          at = match ? match.index + match[0].lastIndexOf('4') : -1
        if (!target || at < 0) page.drawText(row, { font: native, x: 60, y, size: 10 })
        else {
          const x = 60 + prose.widthOfTextAtSize(row.slice(0, at), 10)
          page.drawText(row.slice(0, at), { font: prose, x: 60, y, size: 10 })
          page.drawText('4', {
            font: native,
            x,
            y,
            size: 10
          })
          page.drawText(row.slice(at + 1), {
            font: prose,
            x: x + native.widthOfTextAtSize('4', 10),
            y,
            size: 10
          })
        }
        if (!target && kind === 'duplicate-native-row' && index === 0)
          page.drawText(row, { font: native, x: 60, y, size: 10 })
        if (at >= 0) {
          const x = 60 + (target ? prose : native).widthOfTextAtSize(row.slice(0, at), 10)
          rectangles.push([x - 1, y - 1, x + native.widthOfTextAtSize('4', 10) + 1, y + 11])
        }
      }
      if (target && kind === 'swapped-hit')
        [rectangles[0], rectangles[2]] = [rectangles[2], rectangles[0]]
      if (target && kind === 'outside-hit')
        rectangles[0] = rectangles[0].map((v, i) => (i % 2 ? v : v + 30))
      for (const [index, rect] of rectangles.entries())
        annotations.push(
          pdf.context.register(
            pdf.context.obj({
              Type: 'Annot',
              Subtype: 'Link',
              Rect: rect,
              A: {
                S: 'URI',
                URI: `https://example.invalid/plot-${target && kind === 'action' && index === 0 ? 'other' : index}`
              }
            })
          )
        )
      page.node.set(PDFName.of('Annots'), pdf.context.obj(annotations))
      return pdf.save()
    }
    const sourceBytes = await make(false),
      data = await make(true),
      task = load({ data: sourceBytes.slice(), useSystemFonts: true }),
      original = await task.promise,
      fingerprint = original.fingerprints[0]
    if (!fingerprint) throw new Error('Expected a generated PDF fingerprint')
    try {
      const page = await original.getPage(1),
        content = await page.getTextContent(),
        claimed = content.items.flatMap((item, index) =>
          'str' in item && item.str.trim() ? [{ index, text: item.str }] : []
        )
      expect(claimed).toHaveLength(sourceRows.length + (kind === 'duplicate-native-row' ? 1 : 0))
      expect((await page.getAnnotations()).length).toBe(repeated ? 3 : 1)
      if (kind === 'missing-claim') claimed.shift()
      if (kind === 'stale-claim') claimed[0].text += ' changed'
      const unit = {
          id: 'prose',
          source: sourceRows.join(' '),
          fragments: [
            {
              pageNumber: 1,
              rect: { x: 0.09, y: 0.1, width: 0.8, height: 0.3 },
              items: claimed
            }
          ]
        },
        source = createPdfTranslationSource({
          resourceRequestKey: 'typed-native-links',
          fingerprint,
          pages: [{ width: 600, height: 800 }],
          units: kind === 'shared-owner' ? [unit, { ...unit, id: 'other' }] : [unit]
        }),
        results = {
          source,
          units: source.units.map((u) => ({
            id: u.id,
            translationSource: u.source,
            translation: targetRows.join(' ')
          }))
        },
        artifact = { results, data }
      getDocument.mockImplementation((options) => load({ ...options, useSystemFonts: true }))
      const hook = renderHook(() =>
        usePdfTranslationDocument(original, results, artifact, 'typed-native-links')
      )
      await waitFor(
        () =>
          expect(hook.result.current.state.status).toBe(
            ['bare', 'repeated'].includes(kind) ? 'ready' : 'error'
          ),
        { interval: 10, timeout: 10000 }
      )
      if (!['bare', 'repeated'].includes(kind))
        expect(hook.result.current.state).toMatchObject({ failure: { code: 'validation-failed' } })
      hook.unmount()
    } finally {
      await task.destroy()
    }
  }
)
