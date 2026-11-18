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
  'compact-equation',
  'compact-equation-dotted',
  'same-row-section',
  'same-row-section-swapped',
  'same-row-section-overlap',
  'same-row-section-missing',
  'repeated',
  'compact-repeated',
  'compact-swapped-hit',
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
    const section = kind.startsWith('same-row-section'),
      equation = kind.startsWith('compact-equation'),
      allowed = [
        'bare',
        'compact-equation',
        'repeated',
        'compact-repeated',
        'same-row-section'
      ].includes(kind),
      repeated = kind !== 'bare' && !section && !equation,
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
    if (section) {
      sourceRows[0] = 'Table 4 shows the method in Section 2.3.4.'
      targetRows[0] = 'Read Table 4 for the approach described in Section 2.3.4.'
    }
    if (equation) {
      sourceRows[0] =
        kind === 'compact-equation-dotted'
          ? 'See Eq.2.4 for the response.'
          : 'See Eq.4 for the response.'
      targetRows[0] = 'The response follows Eq. 4.'
    }
    const compact =
      kind.startsWith('compact-') && kind !== 'compact-reference-with-unrelated-number'
    if (compact) {
      for (const rows of [sourceRows, targetRows]) {
        for (const [index, row] of rows.entries()) rows[index] = row.replace(/4\(([bc])\)/u, '4$1')
      }
    }
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
        prefixFont = await pdf.embedFont(StandardFonts.HelveticaBold),
        page = pdf.addPage([600, 800]),
        annotations: ReturnType<typeof pdf.context.register>[] = [],
        rectangles: number[][] = []
      for (const [index, row] of (target ? targetRows : sourceRows).entries()) {
        const y = 700 - index * 18,
          matches = [
            ...row.matchAll(
              /Fig\.?\s*(4[bc]?)|Table\s*(4[bc]?)|Section\s*(2\.3\.4)|Eq\.\s*(?:2\.)?(4)/gu
            )
          ]
        if (!target || !matches.length) page.drawText(row, { font: native, x: 60, y, size: 10 })
        let left = 60,
          end = 0
        for (const match of matches) {
          const label = match[1] ?? match[2] ?? match[3] ?? match[4],
            at = match.index + match[0].lastIndexOf(label),
            prefix = row.slice(end, at),
            width = native.widthOfTextAtSize(label, 10),
            x = target
              ? left + prose.widthOfTextAtSize(prefix, 10)
              : 60 + native.widthOfTextAtSize(row.slice(0, at), 10)
          if (target) {
            page.drawText(prefix, { font: prose, x: left, y, size: 10 })
            if (kind === 'same-row-section-overlap' && match[3]) {
              const prefix = label.slice(0, -1)
              page.drawText(prefix, { font: prefixFont, x, y, size: 10 })
              page.drawText(label.slice(-1), {
                font: native,
                x: x + native.widthOfTextAtSize(prefix, 10),
                y,
                size: 10
              })
            } else page.drawText(label, { font: native, x, y, size: 10 })
          }
          rectangles.push([x - 1, y - 1, x + width + 1, y + 11])
          left = x + width
          end = at + label.length
        }
        if (target && end) page.drawText(row.slice(end), { font: prose, x: left, y, size: 10 })
        if (!target && kind === 'duplicate-native-row' && index === 0)
          page.drawText(row, { font: native, x: 60, y, size: 10 })
      }
      if (target && (kind === 'swapped-hit' || kind === 'compact-swapped-hit'))
        [rectangles[0], rectangles[2]] = [rectangles[2], rectangles[0]]
      if (target && kind === 'same-row-section-overlap') {
        const width = rectangles[0][2] - rectangles[0][0]
        const right = rectangles[1][2]
        rectangles[0] = [right - width, rectangles[0][1], right, rectangles[0][3]]
      }
      if (target && kind === 'same-row-section-swapped')
        [rectangles[0], rectangles[1]] = [rectangles[1], rectangles[0]]
      if (target && kind === 'same-row-section-missing') rectangles.pop()
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
      expect((await page.getAnnotations()).length).toBe(section ? 2 : repeated ? 3 : 1)
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
        () => expect(hook.result.current.state.status).toBe(allowed ? 'ready' : 'error'),
        { interval: 10, timeout: 10000 }
      )
      if (!allowed)
        expect(hook.result.current.state).toMatchObject({ failure: { code: 'validation-failed' } })
      hook.unmount()
    } finally {
      await task.destroy()
    }
  }
)
